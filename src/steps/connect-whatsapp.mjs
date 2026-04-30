import { spinner, warn, log, dim } from "../ui.mjs";
import { buildAuthHeaders } from "./run-verify.mjs";

/**
 * Register a WhatsApp Business phone number against the deployed
 * vercel-openclaw admin API.
 *
 * Wraps `PUT /api/channels/whatsapp` which accepts a partial config and
 * merges it with any existing config. For a first-time attach, all four
 * of phoneNumberId / accessToken / verifyToken / appSecret are needed.
 *
 * Returns `{ ok, status, body }`. Does not throw on HTTP errors so the
 * caller can decide whether to fail the whole run or keep going.
 */
export async function connectWhatsApp(
  url,
  adminSecret,
  {
    phoneNumberId,
    accessToken,
    verifyToken,
    appSecret,
    businessAccountId,
    enabled,
    protectionBypassSecret,
  } = {},
) {
  if (!url) throw new Error("connectWhatsApp: deployment url is required");
  if (!adminSecret) throw new Error("connectWhatsApp: adminSecret is required");
  if (!phoneNumberId) throw new Error("connectWhatsApp: phoneNumberId is required");
  if (!accessToken) throw new Error("connectWhatsApp: accessToken is required");
  if (!verifyToken) throw new Error("connectWhatsApp: verifyToken is required");
  if (!appSecret) throw new Error("connectWhatsApp: appSecret is required");

  const base = url.replace(/\/+$/, "");
  const endpoint = `${base}/api/channels/whatsapp`;
  const headers = {
    ...buildAuthHeaders(adminSecret, protectionBypassSecret),
    "Content-Type": "application/json",
  };

  const payload = {
    phoneNumberId,
    accessToken,
    verifyToken,
    appSecret,
  };
  if (businessAccountId) payload.businessAccountId = businessAccountId;
  if (typeof enabled === "boolean") payload.enabled = enabled;

  const spin = spinner("Connecting WhatsApp");

  let res;
  try {
    res = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    spin.fail("WhatsApp connect failed (network error)");
    return { ok: false, status: 0, body: null, error: err };
  }

  const raw = await res.text();
  const body = parseJson(raw);

  if (res.ok) {
    const reasons = [];
    if (body?.lastError) {
      reasons.push(`whatsapp reported error: ${body.lastError}`);
    }
    if (body?.connected === false) {
      reasons.push("whatsapp not connected (server reports connected=false)");
    }
    if (body?.webhookVerified === false) {
      reasons.push("whatsapp webhook not verified");
    }

    if (reasons.length > 0) {
      const label = pickDisplayName(body);
      spin.fail(
        label
          ? `WhatsApp auth ok (${label}) but channel is not serviceable`
          : "WhatsApp auth ok but channel is not serviceable",
      );
      for (const r of reasons) warn(`  ${r}`);
      return {
        ok: false,
        status: res.status,
        body,
        reason: "channel-setup-incomplete",
      };
    }

    const label = pickDisplayName(body);
    spin.succeed(label ? `WhatsApp connected (${label})` : "WhatsApp connected");
    return { ok: true, status: res.status, body };
  }

  if (res.status === 409 && body?.error?.code === "CHANNEL_CONNECT_BLOCKED") {
    spin.fail("WhatsApp connect blocked by deployment readiness checks");
    const issues = body.connectability?.issues ?? [];
    for (const issue of issues) {
      const id = issue.id ?? "blocker";
      const msg = issue.message ?? JSON.stringify(issue);
      warn(`  ${id}: ${msg}`);
    }
    return { ok: false, status: 409, body };
  }

  spin.fail(`WhatsApp connect returned ${res.status}`);
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

function pickDisplayName(body) {
  if (!body || typeof body !== "object") return null;
  if (typeof body.displayName === "string" && body.displayName.length > 0) {
    return body.displayName;
  }
  if (typeof body.linkedPhone === "string" && body.linkedPhone.length > 0) {
    return body.linkedPhone;
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
  const code = body?.error?.code;
  if (status === 400 && typeof code === "string" && code.startsWith("INVALID_")) {
    const field = code.replace(/^INVALID_/, "").toLowerCase();
    return `${field} rejected — re-check the value from the WhatsApp Business dashboard.`;
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
