import { spinner, warn, log, dim } from "../ui.mjs";
import { buildAuthHeaders } from "./run-verify.mjs";

/**
 * Register a Slack app against the deployed vercel-openclaw admin API.
 *
 * Wraps `PUT /api/channels/slack` which:
 *   - validates the bot token via Slack `auth.test`
 *   - persists `{ signingSecret, botToken, team, user, botId }` to Redis
 *
 * The Slack webhook URL is the one printed in the admin UI; operators still
 * have to paste it into their Slack app's Event Subscriptions page (Slack has
 * no API for that outside the OAuth install flow). `--slack` just gets the
 * credentials in place so the app can verify incoming requests.
 *
 * Returns `{ ok, status, body }`. Never throws on HTTP errors.
 */
export async function connectSlack(
  url,
  adminSecret,
  { botToken, signingSecret, protectionBypassSecret } = {},
) {
  if (!url) throw new Error("connectSlack: deployment url is required");
  if (!adminSecret) throw new Error("connectSlack: adminSecret is required");
  if (!botToken) throw new Error("connectSlack: botToken is required");
  if (!signingSecret) throw new Error("connectSlack: signingSecret is required");

  const base = url.replace(/\/+$/, "");
  const endpoint = `${base}/api/channels/slack`;
  const headers = {
    ...buildAuthHeaders(adminSecret, protectionBypassSecret),
    "Content-Type": "application/json",
  };

  const spin = spinner("Connecting Slack app");

  let res;
  try {
    res = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({ botToken, signingSecret }),
    });
  } catch (err) {
    spin.fail("Slack connect failed (network error)");
    return { ok: false, status: 0, body: null, error: err };
  }

  const raw = await res.text();
  const body = parseJson(raw);

  if (res.ok) {
    const label = describeSuccess(body);
    spin.succeed(label ? `Slack connected (${label})` : "Slack connected");
    return { ok: true, status: res.status, body };
  }

  if (res.status === 409 && body?.error?.code === "CHANNEL_CONNECT_BLOCKED") {
    spin.fail("Slack connect blocked by deployment readiness checks");
    const issues = body.connectability?.issues ?? [];
    for (const issue of issues) {
      const id = issue.id ?? "blocker";
      const msg = issue.message ?? JSON.stringify(issue);
      warn(`  ${id}: ${msg}`);
    }
    return { ok: false, status: 409, body };
  }

  spin.fail(`Slack connect returned ${res.status}`);
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

function describeSuccess(body) {
  if (!body || typeof body !== "object") return null;
  const team = typeof body.team === "string" && body.team.length > 0 ? body.team : null;
  const user = typeof body.user === "string" && body.user.length > 0 ? body.user : null;
  if (team && user) return `${team} as ${user}`;
  if (team) return team;
  if (user) return user;
  return null;
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
  if (status === 400 && typeof code === "string" && code.startsWith("INVALID_")) {
    return `Slack rejected the credentials (${code}). Re-check bot token and signing secret.`;
  }
  if (status === 400) {
    return "Slack auth.test rejected the bot token. Confirm the token starts with `xoxb-` and has been installed to the workspace.";
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
