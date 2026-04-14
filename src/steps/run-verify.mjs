import { step, success, warn, fail, log, dim } from "../ui.mjs";

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
  step("Waiting for deployment to be reachable...");
  await pollUntilReady(`${base}/api/admin/preflight`, authHeaders);
  success("Deployment reachable");

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
  const verifyUrl = `${base}/api/admin/launch-verify`;
  const verifyRes = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ destructive }),
  });

  const result = await verifyRes.json();

  if (result.ok) {
    success("Launch verification passed");
  } else {
    warn("Launch verification returned issues");
    log(dim(JSON.stringify(result, null, 2)));
  }

  return result;
}

async function pollUntilReady(url, headers, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`Deployment not reachable after ${timeoutMs / 1000}s`);
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
