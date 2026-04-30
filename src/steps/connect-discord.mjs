import { spinner, warn, log, dim } from "../ui.mjs";
import { buildAuthHeaders } from "./run-verify.mjs";

/**
 * Register a Discord bot against the deployed vercel-openclaw admin API.
 *
 * Wraps `PUT /api/channels/discord` which:
 *   - validates the bot token via Discord `/users/@me`
 *   - fetches the application identity (applicationId, publicKey)
 *   - optionally configures the Interactions Endpoint URL
 *   - optionally registers the `/ask` slash command
 *   - persists the config to Redis
 *
 * Returns `{ ok, status, body }`. Does not throw on HTTP errors so the
 * caller can decide whether to fail the whole run or keep going.
 */
export async function connectDiscord(
  url,
  adminSecret,
  botToken,
  {
    protectionBypassSecret,
    autoConfigureEndpoint,
    autoRegisterCommand,
    forceOverwriteEndpoint,
  } = {},
) {
  if (!url) throw new Error("connectDiscord: deployment url is required");
  if (!adminSecret) throw new Error("connectDiscord: adminSecret is required");
  if (!botToken) throw new Error("connectDiscord: botToken is required");

  const base = url.replace(/\/+$/, "");
  const endpoint = `${base}/api/channels/discord`;
  const headers = {
    ...buildAuthHeaders(adminSecret, protectionBypassSecret),
    "Content-Type": "application/json",
  };

  const payload = { botToken };
  if (typeof autoConfigureEndpoint === "boolean") {
    payload.autoConfigureEndpoint = autoConfigureEndpoint;
  }
  if (typeof autoRegisterCommand === "boolean") {
    payload.autoRegisterCommand = autoRegisterCommand;
  }
  if (typeof forceOverwriteEndpoint === "boolean") {
    payload.forceOverwriteEndpoint = forceOverwriteEndpoint;
  }

  const spin = spinner("Connecting Discord bot");

  let res;
  try {
    res = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    spin.fail("Discord connect failed (network error)");
    return { ok: false, status: 0, body: null, error: err };
  }

  const raw = await res.text();
  const body = parseJson(raw);

  if (res.ok) {
    const endpointRequested = autoConfigureEndpoint !== false;
    const commandRequested = autoRegisterCommand !== false;
    const reasons = [];
    if (endpointRequested && body?.endpointConfigured !== true) {
      reasons.push(
        body?.endpointError
          ? `interactions endpoint not configured: ${body.endpointError}`
          : "interactions endpoint not configured",
      );
    }
    if (commandRequested && body?.commandRegistered !== true) {
      reasons.push("slash command /ask not registered");
    }

    if (reasons.length > 0) {
      const username = pickUsername(body);
      spin.fail(
        username
          ? `Discord auth ok (${username}) but setup incomplete`
          : "Discord auth ok but setup incomplete",
      );
      for (const r of reasons) warn(`  ${r}`);
      log(
        dim(
          "  Re-run with --discord-bot-token plus --auto-configure-endpoint / --auto-register-command, " +
            "or set both up manually in the Discord developer portal and re-run with --discord-bot-token.",
        ),
      );
      return {
        ok: false,
        status: res.status,
        body,
        reason: "channel-setup-incomplete",
      };
    }

    const username = pickUsername(body);
    spin.succeed(
      username ? `Discord connected as ${username}` : "Discord connected",
    );
    return { ok: true, status: res.status, body };
  }

  if (res.status === 409 && body?.error?.code === "DISCORD_ENDPOINT_CONFLICT") {
    spin.fail("Discord endpoint already points elsewhere");
    if (body?.error?.currentUrl && body?.error?.desiredUrl) {
      warn(`  current: ${body.error.currentUrl}`);
      warn(`  desired: ${body.error.desiredUrl}`);
    }
    log(
      dim(
        "  Re-run with --force-overwrite-endpoint to replace the existing Interactions Endpoint URL.",
      ),
    );
    return { ok: false, status: 409, body };
  }

  if (res.status === 409 && body?.error?.code === "CHANNEL_CONNECT_BLOCKED") {
    spin.fail("Discord connect blocked by deployment readiness checks");
    const issues = body.connectability?.issues ?? [];
    for (const issue of issues) {
      const id = issue.id ?? "blocker";
      const msg = issue.message ?? JSON.stringify(issue);
      warn(`  ${id}: ${msg}`);
    }
    return { ok: false, status: 409, body };
  }

  spin.fail(`Discord connect returned ${res.status}`);
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
  if (typeof body.appName === "string" && body.appName.length > 0) {
    return body.appName;
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
  if (status === 400 && body?.error?.code === "INVALID_DISCORD_BOT_TOKEN") {
    return "Bot token rejected by Discord. Confirm the token from the Discord developer portal.";
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
