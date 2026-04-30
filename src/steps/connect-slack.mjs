import { spinner, warn, log, dim } from "../ui.mjs";
import { buildAuthHeaders } from "./run-verify.mjs";
import { isReplay } from "../tape.mjs";

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
 *
 * When `waitForReady: true`, after a 2xx PUT the helper polls
 * `/api/channels/summary` until Slack reports `configured && connected` for
 * two consecutive polls (server-side `auth.test` succeeded), and returns
 * `{ ok: false, reason: "channel-setup-incomplete" }` if the poll times out.
 * Default `false` keeps backward compatibility with existing call sites.
 */
export async function connectSlack(
  url,
  adminSecret,
  {
    botToken,
    signingSecret,
    protectionBypassSecret,
    waitForReady = false,
    readyPollTimeoutMs = 30_000,
    readyPollIntervalMs,
    fetchImpl = fetch,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
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
    if (waitForReady) {
      const ready = await waitForSlackReady({
        url: base,
        headers,
        timeoutMs: readyPollTimeoutMs,
        intervalMs: readyPollIntervalMs ?? (isReplay() ? 0 : 2_000),
        fetchImpl,
        now,
        sleep,
      });
      if (!ready.ok) {
        const label = describeSuccess(body);
        spin.fail(
          label
            ? `Slack auth ok (${label}) but server is not yet ready`
            : "Slack auth ok but server is not yet ready",
        );
        warn(
          `  Slack ${ready.reason} — \`/api/channels/summary\` did not report configured && connected within ${Math.round(readyPollTimeoutMs / 1000)}s.`,
        );
        return {
          ok: false,
          status: res.status,
          body,
          reason: "channel-setup-incomplete",
          summary: ready.lastSummary,
        };
      }
    }

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

/**
 * Poll /api/channels/summary until Slack reports `configured && connected`
 * for two consecutive polls. The two-consecutive requirement guards against
 * a transient `connected: true` flicker during token rotation or summary
 * cache convergence — Oracle's audit specifically called out the single-
 * sample race in the create branch.
 */
async function waitForSlackReady({
  url,
  headers,
  timeoutMs,
  intervalMs,
  fetchImpl,
  now,
  sleep,
}) {
  const endpoint = `${url}/api/channels/summary`;
  const deadline = now() + timeoutMs;
  let consecutive = 0;
  let lastSummary = null;
  let lastReason = "summary-poll-timeout";
  while (now() < deadline) {
    try {
      const res = await fetchImpl(endpoint, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const body = await res.json().catch(() => null);
          const slack = body?.slack;
          lastSummary = slack ?? null;
          if (slack?.configured === true && slack?.connected === true) {
            consecutive += 1;
            if (consecutive >= 2) return { ok: true };
          } else {
            consecutive = 0;
            if (slack?.configured === false) lastReason = "not-configured";
            else if (slack?.connected === false) lastReason = "not-connected";
            else lastReason = "missing-slack-fields";
          }
        } else {
          lastReason = "non-json-summary";
          consecutive = 0;
        }
      } else {
        lastReason = `summary-status-${res.status}`;
        consecutive = 0;
      }
    } catch (err) {
      lastReason = `summary-fetch-${err?.message ?? "error"}`;
      consecutive = 0;
    }
    await sleep(intervalMs);
  }
  return { ok: false, reason: lastReason, lastSummary };
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
