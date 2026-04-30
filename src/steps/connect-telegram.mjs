import { spinner, warn, log, dim } from "../ui.mjs";
import { buildAuthHeaders } from "./run-verify.mjs";

/**
 * Register a Telegram bot against the deployed vercel-openclaw admin API.
 *
 * Wraps `PUT /api/channels/telegram` which:
 *   - validates the token via Telegram `getMe`
 *   - generates a webhook secret
 *   - calls `setWebhook` so Telegram POSTs to /api/channels/telegram/webhook
 *   - syncs `/` slash commands
 *   - persists the config to Redis
 *
 * Returns `{ ok, status, body }`. Does not throw on HTTP errors so the
 * caller can decide whether to fail the whole run or keep going.
 */
export async function connectTelegram(
  url,
  adminSecret,
  botToken,
  { protectionBypassSecret } = {},
) {
  if (!url) throw new Error("connectTelegram: deployment url is required");
  if (!adminSecret) throw new Error("connectTelegram: adminSecret is required");
  if (!botToken) throw new Error("connectTelegram: botToken is required");

  const base = url.replace(/\/+$/, "");
  const endpoint = `${base}/api/channels/telegram`;
  const headers = {
    ...buildAuthHeaders(adminSecret, protectionBypassSecret),
    "Content-Type": "application/json",
  };

  const spin = spinner("Connecting Telegram bot");

  let res;
  try {
    res = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({ botToken }),
    });
  } catch (err) {
    spin.fail("Telegram connect failed (network error)");
    return { ok: false, status: 0, body: null, error: err };
  }

  const raw = await res.text();
  const body = parseJson(raw);

  if (res.ok) {
    const reasons = [];
    if (body?.webhookConfigured === false) {
      reasons.push("telegram setWebhook did not succeed");
    }
    const lastErrorMessage = body?.webhookInfo?.last_error_message;
    if (typeof lastErrorMessage === "string" && lastErrorMessage.length > 0) {
      reasons.push(`telegram getWebhookInfo reports last_error_message: ${lastErrorMessage}`);
    }

    if (reasons.length > 0) {
      const username = pickUsername(body);
      spin.fail(
        username
          ? `Telegram auth ok (@${username}) but webhook is not serviceable`
          : "Telegram auth ok but webhook is not serviceable",
      );
      for (const r of reasons) warn(`  ${r}`);
      return {
        ok: false,
        status: res.status,
        body,
        reason: "channel-setup-incomplete",
      };
    }

    const username = pickUsername(body);
    spin.succeed(
      username ? `Telegram connected as @${username}` : "Telegram connected",
    );
    const commandSync = body?.commandSyncStatus;
    if (commandSync === "error" && body?.commandSyncError) {
      // Slash command sync is best-effort and not on the message-delivery
      // path — keep this as a warn, not a hard failure.
      warn(`Slash command sync failed: ${body.commandSyncError}`);
    }
    return { ok: true, status: res.status, body };
  }

  if (res.status === 409 && body?.error?.code === "CHANNEL_CONNECT_BLOCKED") {
    spin.fail("Telegram connect blocked by deployment readiness checks");
    const issues = body.connectability?.issues ?? [];
    for (const issue of issues) {
      const id = issue.id ?? "blocker";
      const msg = issue.message ?? JSON.stringify(issue);
      warn(`  ${id}: ${msg}`);
    }
    return { ok: false, status: 409, body };
  }

  spin.fail(`Telegram connect returned ${res.status}`);
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

function pickUsername(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.botUsername === "string" && body.botUsername.length > 0) {
    return body.botUsername;
  }
  if (typeof body.state?.botUsername === "string" && body.state.botUsername.length > 0) {
    return body.state.botUsername;
  }
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
  if (status === 400 && body?.error?.code === "INVALID_BOT_TOKEN") {
    return "Bot token rejected by Telegram. Confirm the token from @BotFather.";
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
