import { spinner, warn, log, dim } from "../ui.mjs";
import { buildAuthHeaders } from "./run-verify.mjs";

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
 * Returns `{ ok, status, body }`. Never throws on HTTP errors.
 */
export async function createSlackApp(
  url,
  adminSecret,
  { configToken, refreshToken, appName, protectionBypassSecret } = {},
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

  const spin = spinner("Creating Slack app via apps.manifest.create");

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        configToken,
        refreshToken: refreshToken || undefined,
        appName: appName || undefined,
      }),
    });
  } catch (err) {
    spin.fail("Slack app creation failed (network error)");
    return { ok: false, status: 0, body: null, error: err };
  }

  const raw = await res.text();
  const body = parseJson(raw);

  if (res.ok) {
    const name = body?.appName || "Slack app";
    const rotated = body?.tokenRotated ? " · config token rotated" : "";
    spin.succeed(`Slack app created (${name}${rotated})`);
    return { ok: true, status: res.status, body };
  }

  spin.fail(`Slack app creation returned ${res.status}`);
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
