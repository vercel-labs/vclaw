import { isReplay } from "../tape.mjs";
import { spinner, warn, log, dim, fail } from "../ui.mjs";
import { buildAuthHeaders } from "./run-verify.mjs";

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;

/**
 * Call POST /api/channels/slack/app on the deployed vercel-openclaw admin API.
 *
 * This mints a brand-new Slack app via `apps.manifest.create`, persists the
 * returned credentials to Redis, and returns a one-time `installUrl` that
 * starts the OAuth install flow without requiring an admin cookie.
 *
 * Request body:
 *   { configToken, refreshToken?, appName? }
 *
 * Response (success):
 *   { appId, appName, installUrl, installToken, oauthAuthorizeUrl, credentialsSource, tokenRotated }
 *
 * Bot handle and the slash command are derived from the owning Vercel
 * project (VCLAW_PROJECT_SCOPE / VCLAW_PROJECT_NAME env vars on the
 * deployment) so multiple projects can coexist in one Slack workspace. The
 * optional `appName` overrides only the human-facing display_information.name.
 *
 * Returns `{ ok, status, body }`. Never throws on HTTP errors.
 */
export async function createSlackApp(
  url,
  adminSecret,
  {
    configToken,
    refreshToken,
    appName,
    protectionBypassSecret,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  if (!url) throw new Error("createSlackApp: deployment url is required");
  if (!adminSecret) throw new Error("createSlackApp: adminSecret is required");
  if (!configToken) throw new Error("createSlackApp: configToken is required");

  const base = url.replace(/\/+$/, "");
  const endpoint = `${base}/api/channels/slack/app`;
  const headers = {
    ...buildAuthHeaders(adminSecret, protectionBypassSecret),
    "Content-Type": "application/json",
  };
  const payload = {
    configToken,
    refreshToken: refreshToken || undefined,
    appName: appName || undefined,
  };

  const spin = spinner("Creating Slack app via apps.manifest.create");

  let res;
  let raw = "";
  let body = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      spin.update(
        `Retrying Slack app creation (attempt ${attempt}/${MAX_ATTEMPTS}) — previous call was rejected with 401`,
      );
      const delay = isReplay() ? 0 : RETRY_BASE_MS * (attempt - 1);
      await sleep(delay);
    }

    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Network / DNS / connect failures are deterministic at the CLI level —
      // retrying in-process won't fix them. Surface immediately.
      spin.fail("Slack app creation failed (network error)");
      return { ok: false, status: 0, body: null, error: err };
    }

    raw = await res.text();
    body = parseJson(raw);

    if (res.ok) {
      const name = body?.appName || "Slack app";
      const rotated = body?.tokenRotated ? " · config token rotated" : "";
      spin.succeed(`Slack app created (${name}${rotated})`);
      return { ok: true, status: res.status, body };
    }

    // Only 401 is worth retrying — we see it on cold-start env-propagation
    // races where the function instance boots before ADMIN_SECRET is wired
    // in. Everything else (400 bad token, 5xx, etc.) is deterministic.
    if (res.status !== 401) break;
  }

  spin.fail(`Slack app creation returned ${res.status}`);

  if (res.status === 401) {
    printUnauthorizedDiagnostics({
      endpoint,
      adminSecret,
      protectionBypassSecret,
      raw,
      body,
      attempts: MAX_ATTEMPTS,
    });
    return { ok: false, status: res.status, body };
  }

  const hint = describeFailure(res.status, body);
  if (hint) warn(hint);
  if (body?.error?.message) {
    warn(`  ${body.error.message}`);
  } else if (raw) {
    log(dim(truncate(raw, 500)));
  } else {
    log(dim("(empty response body)"));
  }
  return { ok: false, status: res.status, body };
}

function printUnauthorizedDiagnostics({
  endpoint,
  adminSecret,
  protectionBypassSecret,
  raw,
  body,
  attempts,
}) {
  const baseOrigin = new URL(endpoint).origin;
  const preflightUrl = `${baseOrigin}/api/admin/preflight`;
  const isOpenclawAuth =
    body?.error === "UNAUTHORIZED" && body?.message === "Authentication required.";
  const isVercelSso = /^\s*<!doctype html/i.test(raw);

  log("");
  fail("Slack app creation was rejected with 401 after " + attempts + " attempts.");
  log("");
  log(dim("── What vclaw sent ──"));
  log(`  URL:       POST ${endpoint}`);
  log(
    `  Auth:      Authorization: Bearer ${maskSecret(adminSecret)} (admin secret, ${adminSecret?.length ?? 0} chars)`,
  );
  if (protectionBypassSecret) {
    log(
      `  Bypass:    x-vercel-protection-bypass: ${maskSecret(protectionBypassSecret)} (${protectionBypassSecret.length} chars)`,
    );
  } else {
    log(dim("  Bypass:    (none — no VERCEL_AUTOMATION_BYPASS_SECRET wired)"));
  }
  log("");
  log(dim("── Response ──"));
  log(`  Status:    401`);
  log(`  Body:      ${truncate(raw || "(empty)", 400)}`);
  log("");
  log(dim("── Where this 401 came from ──"));
  if (isVercelSso) {
    log(
      "  HTML body — this is Vercel's Deployment Protection SSO gate. The",
    );
    log(
      "  x-vercel-protection-bypass header is missing or doesn't match the",
    );
    log(
      "  bypass secret configured on the project. Run `vercel env ls` and",
    );
    log("  confirm VERCEL_AUTOMATION_BYPASS_SECRET matches the project's");
    log(
      "  Automation Bypass secret in Settings → Deployment Protection.",
    );
  } else if (isOpenclawAuth) {
    log(
      "  JSON body matches openclaw's admin-auth.ts unauthorizedResponse().",
    );
    log(
      "  The bearer token did NOT match the deployed ADMIN_SECRET. Either",
    );
    log(
      "  the env var didn't propagate to this function instance, or the",
    );
    log("  string vclaw sent differs from what's live on the deployment.");
  } else {
    log(
      "  Unknown 401 shape — print the body above and compare to openclaw's",
    );
    log("  admin-auth.ts and Vercel's SSO response for a match.");
  }
  log("");
  log(dim("── Verify it yourself ──"));
  log("  # Preflight should 200 — uses the same auth as the Slack route:");
  log(`  curl -i "${preflightUrl}" \\`);
  log(`    -H "Authorization: Bearer ${adminSecret}" \\`);
  if (protectionBypassSecret) {
    log(`    -H "x-vercel-protection-bypass: ${protectionBypassSecret}"`);
  } else {
    log(`    # (no bypass header — add x-vercel-protection-bypass if needed)`);
  }
  log("");
  log("  # If preflight 200s but the above call 401s, it's a cold-start race");
  log("  # — retry in a few seconds. If preflight also 401s with the SSO HTML,");
  log("  # the bypass secret is wrong. If preflight 401s with the openclaw");
  log("  # JSON shape, ADMIN_SECRET on the deployment doesn't match.");
  log("");
  log(dim("── Useful commands ──"));
  log("  vercel env ls           # confirm ADMIN_SECRET + VERCEL_AUTOMATION_BYPASS_SECRET");
  log(`  vercel logs ${baseOrigin}   # look for auth.admin_secret_unavailable`);
  log("");
}

function maskSecret(value) {
  if (typeof value !== "string" || value.length === 0) return "(empty)";
  if (value.length <= 8) return `${value[0]}…${value[value.length - 1]}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function describeFailure(status, body) {
  const code = body?.error?.code;
  if (status === 400 && code === "INVALID_CONFIGTOKEN") {
    return "The config token is missing or empty. Paste a token that starts with `xoxe.xoxp-`.";
  }
  if (status === 400 && code === "TOKEN_EXPIRED") {
    return "The config token is expired. Slack config tokens last 12 hours — generate a new one at api.slack.com/apps and retry.";
  }
  if (status === 400 && code === "INVALID_AUTH") {
    return "Slack rejected the config token. Confirm it was copied in full and still valid.";
  }
  if (status === 400 && code === "INVALID_MANIFEST") {
    return "Slack rejected the manifest. This usually means another app with the same slug already exists in the workspace.";
  }
  if (status === 401 || status === 403) {
    return "Authentication rejected. Check ADMIN_SECRET and the deployment protection bypass secret.";
  }
  if (status >= 500) {
    return "Deployment returned a server error. Check `vercel logs` for the admin route trace.";
  }
  return null;
}

function truncate(text, max) {
  if (typeof text !== "string") return text;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
