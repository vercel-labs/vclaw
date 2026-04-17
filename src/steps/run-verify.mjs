import { isReplay } from "../tape.mjs";
import { spinner, step, success, warn, fail, log, dim } from "../ui.mjs";

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
  step("Running preflight check");
  const preflight = await fetchJson(`${base}/api/admin/preflight`, {
    headers: authHeaders,
  });

  if (preflight.ok) {
    success("Preflight passed");
  } else {
    warn("Preflight has issues:");
    for (const action of preflight.actions ?? []) {
      if (action.status === "fail") {
        fail(`  ${action.id}: ${action.message}`);
      } else if (action.status === "warn") {
        warn(`  ${action.id}: ${action.message}`);
      }
    }
  }

  // 3. Launch verification (safe mode by default)
  step(`Running launch verification${destructive ? " (destructive)" : ""}`);
  const verifyEndpoint = `${base}/api/admin/launch-verify`;
  const verifyRes = await fetch(verifyEndpoint, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ destructive }),
  });

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
    fail(`Launch verification returned ${verifyRes.status}`);
    const hint = describeVerifyFailure(verifyRes.status, raw, result);
    if (hint) warn(hint);
    if (raw) log(dim(truncate(raw, 800)));
    else log(dim("(empty response body)"));
    return { ok: false, status: verifyRes.status, body: raw, hint };
  }

  if (result === null) {
    // 2xx with empty/non-JSON body. The admin handler is supposed to return
    // a JSON payload; an empty body usually means the runtime died between
    // phases. Treat as failure so the caller doesn't silently move on.
    fail(
      "Launch verification returned a non-JSON response (empty or unexpected content)."
    );
    if (raw) log(dim(truncate(raw, 800)));
    else log(dim("(empty response body)"));
    return { ok: false, status: verifyRes.status, body: raw };
  }

  if (result.ok) {
    success("Launch verification passed");
  } else {
    warn("Launch verification returned issues");
    log(dim(JSON.stringify(result, null, 2)));
  }

  return result;
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
