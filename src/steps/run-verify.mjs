import { isReplay } from "../tape.mjs";
import { spinner, warn, fail, log, dim } from "../ui.mjs";

/**
 * Poll preflight, then run launch verification against a live deployment.
 */
export function buildAuthHeaders(adminSecret, protectionBypassSecret) {
  const headers = {
    Authorization: `Bearer ${adminSecret}`,
  };

  if (protectionBypassSecret) {
    headers["x-vercel-protection-bypass"] = protectionBypassSecret;
  }

  return headers;
}

export async function runVerify(
  url,
  adminSecret,
  { destructive = false, protectionBypassSecret } = {}
) {
  const base = url.replace(/\/+$/, "");
  const authHeaders = buildAuthHeaders(adminSecret, protectionBypassSecret);

  // 1. Wait for preflight to be reachable
  const readySpin = spinner("Waiting for deployment to be reachable");
  try {
    await pollUntilReady(`${base}/api/admin/preflight`, authHeaders, {
      onTick: (elapsedSec) =>
        readySpin.update(`Waiting for deployment (${elapsedSec}s)`),
    });
    readySpin.succeed("Deployment reachable");
  } catch (err) {
    readySpin.fail(err.message);
    throw err;
  }

  // 2. Run preflight check
  const preflightSpin = spinner("Running preflight check — 0s");
  const preflightStart = Date.now();
  const preflightTick = setInterval(() => {
    const s = Math.round((Date.now() - preflightStart) / 1000);
    preflightSpin.update(`Running preflight check — ${s}s`);
  }, 500);
  let preflight;
  try {
    preflight = await fetchJson(`${base}/api/admin/preflight`, {
      headers: authHeaders,
    });
    if (preflight.ok) {
      preflightSpin.succeed("Preflight passed");
    } else {
      preflightSpin.fail("Preflight has issues");
    }
  } catch (err) {
    preflightSpin.fail("Preflight failed");
    throw err;
  } finally {
    clearInterval(preflightTick);
  }

  if (!preflight.ok) {
    for (const action of preflight.actions ?? []) {
      if (action.status === "fail") {
        fail(`  ${action.id}: ${action.message}`);
      } else if (action.status === "warn") {
        warn(`  ${action.id}: ${action.message}`);
      }
    }
  }

  // 3. Launch verification (safe mode by default)
  const verifyLabel = `Running launch verification${destructive ? " (destructive)" : ""}`;
  const verifySpin = spinner(`${verifyLabel} — 0s`);
  const verifyStart = Date.now();
  const verifyTick = setInterval(() => {
    const s = Math.round((Date.now() - verifyStart) / 1000);
    verifySpin.update(`${verifyLabel} — ${s}s${verifyHint(s)}`);
  }, 500);
  const verifyEndpoint = `${base}/api/admin/launch-verify`;
  let verifyRes;
  try {
    verifyRes = await fetch(verifyEndpoint, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ destructive }),
    });
  } catch (err) {
    verifySpin.fail("Launch verification failed");
    clearInterval(verifyTick);
    throw err;
  }
  clearInterval(verifyTick);

  // Read body as text first — the endpoint can return 204/empty or an HTML
  // error page. Calling res.json() directly crashes on either.
  const raw = await verifyRes.text();
  let result = null;
  if (raw) {
    try {
      result = JSON.parse(raw);
    } catch {
      // fall through — surface the raw body below
    }
  }

  if (!verifyRes.ok) {
    verifySpin.fail(`Launch verification returned ${verifyRes.status}`);
    const hint = describeVerifyFailure(verifyRes.status, raw, result);
    if (hint) warn(hint);
    if (raw) log(dim(truncate(raw, 800)));
    else log(dim("(empty response body)"));
    return { ok: false, status: verifyRes.status, body: raw, hint };
  }

  if (result === null) {
    verifySpin.fail(
      "Launch verification returned a non-JSON response (empty or unexpected content)."
    );
    if (raw) log(dim(truncate(raw, 800)));
    else log(dim("(empty response body)"));
    return { ok: false, status: verifyRes.status, body: raw };
  }

  if (result.ok) {
    verifySpin.succeed("Launch verification passed");
  } else {
    verifySpin.fail("Launch verification returned issues");
    log(dim(JSON.stringify(result, null, 2)));
  }

  return result;
}

function verifyHint(elapsed) {
  // These are time-bucket labels, not real phase events — the endpoint
  // returns one JSON payload at the end. Buckets are calibrated to a typical
  // first-boot: the sandbox launches in a couple seconds, then the long
  // stretch is `npm install` of OpenClaw, then probes, then finalizing.
  if (elapsed < 3) return " · launching sandbox";
  if (elapsed < 55) return " · installing OpenClaw from npm";
  if (elapsed < 80) return " · running launch probes";
  if (elapsed < 120) return " · finalizing";
  return " · still working";
}

function truncate(text, max) {
  if (typeof text !== "string") return text;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function describeVerifyFailure(status, raw, parsed) {
  if (status === 401 || status === 403) {
    return `Authentication rejected (${status}). Confirm ADMIN_SECRET on the deployment matches the one passed to \`vclaw verify\`, and that deployment protection bypass (if any) is correct.`;
  }
  if (status >= 500) {
    if (parsed && typeof parsed.message === "string") {
      return `Deployment returned ${status}: ${parsed.message}`;
    }
    if (!raw) {
      return `Deployment returned ${status} with an empty body. Check deployment runtime logs (\`vercel logs <url>\`). This is usually an unhandled throw in the admin route handler.`;
    }
    return `Deployment returned ${status}. The body above is the runtime error.`;
  }
  return null;
}

async function pollUntilReady(url, headers, { timeoutMs = 300_000, onTick } = {}) {
  const start = Date.now();
  const pollIntervalMs = isReplay() ? 0 : 3_000;
  let lastStatus = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      lastStatus = res.status;
      // 401/403 with an admin bearer means the admin secret is wrong or
      // deployment protection is blocking us. Retrying won't help.
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Deployment returned ${res.status} on /api/admin/preflight. ` +
            `Check that the admin secret matches ADMIN_SECRET on the deployment` +
            (res.status === 403
              ? `, and that deployment protection bypass is configured if protection is enabled.`
              : `.`)
        );
      }
    } catch (err) {
      if (err && err.message && err.message.startsWith("Deployment returned")) {
        throw err;
      }
      // network / timeout — keep polling
    }
    if (onTick) onTick(Math.round((Date.now() - start) / 1000));
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  const suffix = lastStatus ? ` (last status: ${lastStatus})` : "";
  throw new Error(
    `Deployment not reachable after ${Math.round(timeoutMs / 1000)}s${suffix}`
  );
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
