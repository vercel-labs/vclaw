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

export class VerifyFailedError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "VerifyFailedError";
    this.result = result;
  }
}

export async function runVerify(
  url,
  adminSecret,
  {
    destructive = false,
    protectionBypassSecret,
    // When true, deployment protection and/or its automation-bypass secret was
    // just configured in this same run. The Vercel project API can ack the
    // change before the edge actually honors the bypass header, so 401/403
    // responses during the initial wait window are a propagation artifact —
    // not a permanent misconfiguration. Retry within a bounded grace period.
    protectionFreshlyApplied = false,
    // When true, runVerify resolves with a result object even when preflight
    // or launch-verify fails. Default behavior throws so callers cannot
    // accidentally print "complete" after a failed verification (the previous
    // contract returned `{ ok: false, ... }` and most callers ignored it).
    allowFailure = false,
  } = {}
) {
  const base = url.replace(/\/+$/, "");
  const authHeaders = buildAuthHeaders(adminSecret, protectionBypassSecret);

  // 1. Wait for preflight to be reachable
  const readySpin = spinner("Waiting for deployment to be reachable");
  try {
    await pollUntilReady(`${base}/api/admin/preflight`, authHeaders, {
      retryAuthFailuresUntilMs:
        protectionFreshlyApplied && protectionBypassSecret ? 120_000 : 0,
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
    if (!allowFailure) {
      throw new VerifyFailedError(
        "Preflight reported issues. Re-run after addressing the failures above, or pass allowFailure to inspect the result programmatically.",
        { stage: "preflight", preflight }
      );
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
      // The route reads `body.mode`; sending `{ destructive: true }` was
      // silently ignored, so wakeFromSleep / restorePrepared phases never ran.
      body: JSON.stringify({ mode: destructive ? "destructive" : "safe" }),
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
    const failure = { ok: false, status: verifyRes.status, body: raw, hint };
    if (!allowFailure) {
      throw new VerifyFailedError(
        `Launch verification returned HTTP ${verifyRes.status}.`,
        failure
      );
    }
    return failure;
  }

  if (result === null) {
    verifySpin.fail(
      "Launch verification returned a non-JSON response (empty or unexpected content)."
    );
    if (raw) log(dim(truncate(raw, 800)));
    else log(dim("(empty response body)"));
    const failure = { ok: false, status: verifyRes.status, body: raw };
    if (!allowFailure) {
      throw new VerifyFailedError(
        "Launch verification returned a non-JSON response.",
        failure
      );
    }
    return failure;
  }

  if (result.ok) {
    verifySpin.succeed("Launch verification passed");
    return result;
  }

  verifySpin.fail("Launch verification returned issues");
  log(dim(JSON.stringify(result, null, 2)));
  if (!allowFailure) {
    throw new VerifyFailedError(
      "Launch verification reported {ok:false}. See output above for details.",
      result
    );
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

export async function pollUntilReady(
  url,
  headers,
  {
    timeoutMs = 300_000,
    retryAuthFailuresUntilMs = 0,
    onTick,
    fetchImpl = fetch,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs,
  } = {}
) {
  const start = now();
  const interval = pollIntervalMs ?? (isReplay() ? 0 : 3_000);
  let lastStatus = null;
  while (now() - start < timeoutMs) {
    try {
      const res = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) {
        // 401/403 normally signals a permanent misconfiguration (wrong admin
        // secret, missing bypass) and we fail fast. But when caller signals
        // protection was JUST applied, the bypass header may not yet be
        // honored at the edge — keep polling within the grace window.
        const elapsed = now() - start;
        if (elapsed >= retryAuthFailuresUntilMs) {
          throw new Error(
            `Deployment returned ${res.status} on /api/admin/preflight. ` +
              `Check that the admin secret matches ADMIN_SECRET on the deployment` +
              (res.status === 403
                ? `, and that deployment protection bypass is configured if protection is enabled.`
                : `.`)
          );
        }
        // fall through and continue polling
      }
    } catch (err) {
      if (err && err.message && err.message.startsWith("Deployment returned")) {
        throw err;
      }
      // network / timeout — keep polling
    }
    if (onTick) onTick(Math.round((now() - start) / 1000));
    await sleep(interval);
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
