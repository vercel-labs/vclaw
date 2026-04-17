import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { debug } from "../debug.mjs";
import { isReplay } from "../tape.mjs";
import { dim, log, prompt, promptMasked, spinner, step, warn } from "../ui.mjs";
import { buildAuthHeaders } from "./run-verify.mjs";
import { createSlackApp } from "./create-slack-app.mjs";
import { connectSlack } from "./connect-slack.mjs";

const SLACK_CACHE_PATH = resolve(
  homedir(),
  ".config",
  "vclaw",
  "slack.json",
);

/**
 * Orchestrate Slack provisioning for a freshly-deployed openclaw instance.
 *
 * Three branches:
 *   1. "create" — POST /api/channels/slack/app with a config token, then open
 *      the returned OAuth installUrl in the browser and poll admin/status
 *      until Slack flips to configured.
 *   2. "connect" — PUT /api/channels/slack with a bot token + signing secret
 *      (existing path for operators who already have a Slack app).
 *   3. "skip" — do nothing.
 *
 * The branch is chosen by:
 *   - Explicit flag input when the caller provides configToken / botToken etc.
 *   - Otherwise an interactive menu when canPrompt.
 *   - Otherwise skip (non-interactive, no flags = no-op).
 *
 * Returns { branch, ok, configured }.
 */
export async function provisionSlack(
  url,
  adminSecret,
  {
    canPrompt = false,
    branch: preselectedBranch,
    configToken: configTokenInput,
    refreshToken: refreshTokenInput,
    appName: appNameInput,
    botToken,
    signingSecret,
    protectionBypassSecret,
    pollTimeoutMs = 180_000,
    openBrowser = defaultOpenBrowser,
  } = {},
) {
  if (!url) throw new Error("provisionSlack: deployment url is required");
  if (!adminSecret) throw new Error("provisionSlack: adminSecret is required");

  debug("provisionSlack.start", {
    url,
    canPrompt,
    preselectedBranch,
    hasConfigToken: Boolean(configTokenInput),
    hasRefreshToken: Boolean(refreshTokenInput),
    appName: appNameInput || null,
    hasBotToken: Boolean(botToken),
    hasSigningSecret: Boolean(signingSecret),
    hasProtectionBypass: Boolean(protectionBypassSecret),
    pollTimeoutMs,
  });

  // Resolve branch. Precedence: explicit preselected > explicit flags > prompt > skip.
  const branch =
    preselectedBranch ||
    (configTokenInput ? "create" : null) ||
    (botToken && signingSecret ? "connect" : null) ||
    (canPrompt ? await promptBranch() : "skip");

  debug("provisionSlack.branch", { branch });

  if (branch === "skip") {
    return { branch: "skip", ok: true, configured: false };
  }

  if (branch === "connect") {
    const bot = (botToken ?? "").trim();
    const sig = (signingSecret ?? "").trim();
    if (!bot || !sig) {
      const { botToken: b, signingSecret: s } = canPrompt
        ? await promptConnectCredentials({ existingBot: bot, existingSig: sig })
        : { botToken: "", signingSecret: "" };
      if (!b || !s) {
        warn(
          "Skipping Slack — bot token and signing secret are both required for --slack.",
        );
        return { branch: "connect", ok: false, configured: false };
      }
      const res = await connectSlack(url, adminSecret, {
        botToken: b,
        signingSecret: s,
        protectionBypassSecret,
      });
      return { branch: "connect", ok: res.ok, configured: res.ok };
    }
    const res = await connectSlack(url, adminSecret, {
      botToken: bot,
      signingSecret: sig,
      protectionBypassSecret,
    });
    return { branch: "connect", ok: res.ok, configured: res.ok };
  }

  // branch === "create"
  const cache = readSlackCache();
  const configToken = (
    configTokenInput ??
    (canPrompt ? await promptConfigToken(openBrowser) : "")
  ).trim();
  if (!configToken) {
    warn(
      "Skipping Slack — no config token supplied. Re-run with --slack-config-token <token> or use the interactive prompt.",
    );
    return { branch: "create", ok: false, configured: false };
  }

  let refreshToken = (refreshTokenInput ?? "").trim();
  if (!refreshToken && cache?.refreshToken) {
    refreshToken = cache.refreshToken;
    log(dim("  (using refresh token from ~/.config/vclaw/slack.json)"));
  } else if (!refreshToken && canPrompt) {
    const answer = await promptMasked(
      "Slack App Refresh Token (optional, press Enter to skip)",
    );
    refreshToken = answer.trim();
  }

  let appName = (appNameInput ?? "").trim();
  if (!appName && canPrompt) {
    const answer = await prompt("Slack app display name", "VClaw");
    appName = answer.trim();
  }

  const created = await createSlackApp(url, adminSecret, {
    configToken,
    refreshToken: refreshToken || undefined,
    appName: appName || undefined,
    protectionBypassSecret,
  });

  debug("provisionSlack.createSlackApp.result", {
    ok: created.ok,
    status: created.status,
    hasInstallUrl: Boolean(created.body?.installUrl),
    hasInstallToken: Boolean(created.body?.installToken),
    appId: created.body?.appId ?? null,
    appName: created.body?.appName ?? null,
    tokenRotated: created.body?.tokenRotated ?? null,
  });

  if (!created.ok || !created.body?.installUrl) {
    return { branch: "create", ok: false, configured: false };
  }

  writeSlackCache({
    appId: created.body.appId ?? null,
    appName: created.body.appName ?? null,
    refreshToken: refreshToken || cache?.refreshToken || null,
    updatedAt: new Date().toISOString(),
  });

  const installUrl = created.body.installUrl;
  const installTokenPrefix = (created.body.installToken ?? "").slice(0, 6);
  const mintedAt = Date.now();

  // These debug lines are load-bearing for diagnosis. If the browser later
  // lands on `install_token_invalid`, the server-side log shows the UA of
  // whoever burned the token first. If vclaw consumes it here, clientKind
  // will be `node-fetch`; if a browser consumes it, `browser`. Anything
  // between `provisionSlack.installUrl.minted` and
  // `provisionSlack.installUrl.browser_open` on the vclaw side is suspect.
  debug("provisionSlack.installUrl.minted", {
    tokenPrefix: installTokenPrefix,
    mintedAt,
    installUrlPreview: installUrl.replace(/install_token=[^&]+/, "install_token=<redacted>"),
    note: "vclaw MUST NOT fetch this URL — the server consumes the token on any GET",
  });

  step("Opening Slack OAuth install in your browser");
  log(dim(`  If nothing opens, visit: ${installUrl}`));
  debug("provisionSlack.installUrl.browser_open", {
    tokenPrefix: installTokenPrefix,
    ageMs: Date.now() - mintedAt,
  });
  openBrowser(installUrl);
  debug("provisionSlack.installUrl.browser_open.returned", {
    tokenPrefix: installTokenPrefix,
    ageMs: Date.now() - mintedAt,
  });

  const configured = await waitForSlackConfigured(url, adminSecret, {
    protectionBypassSecret,
    timeoutMs: pollTimeoutMs,
    installTokenPrefix,
    mintedAt,
  });

  return {
    branch: "create",
    ok: true,
    configured,
    installUrl,
    appId: created.body.appId ?? null,
    appName: created.body.appName ?? null,
  };
}

// ── Branch prompt ──

async function promptBranch() {
  log("");
  log("How would you like to connect Slack?");
  log("  1) Create a new Slack app (recommended)");
  log("  2) Use an existing Slack app");
  log("  3) Skip — I'll do it later from the admin panel");
  log("");
  const answer = await prompt("Pick an option [1-3]", "1");
  const idx = Number.parseInt(answer, 10);
  if (idx === 2) return "connect";
  if (idx === 3) return "skip";
  return "create";
}

async function promptConfigToken(openBrowser = defaultOpenBrowser) {
  const tokenUrl = "https://api.slack.com/apps";
  log("");
  log("To create your Slack app, we need an App Configuration Token.");
  log(dim(`  Opening ${tokenUrl} in your browser…`));
  log(dim("  1. Sign in and pick the workspace you want to install into."));
  log(dim("  2. Under \"Your App Configuration Tokens\", click Generate Token."));
  log(dim("  3. Copy the xoxe.xoxp-… token and paste it here."));
  log(dim("  Tokens expire after 12 hours — we only use it once."));
  try {
    openBrowser(tokenUrl);
  } catch {
    // best-effort — instructions above still point at the URL
  }
  log("");
  const token = await promptMasked("Slack App Configuration Token");
  return token;
}

async function promptConnectCredentials({ existingBot = "", existingSig = "" } = {}) {
  const botToken =
    existingBot || (await promptMasked("Slack Bot Token (xoxb-...)"));
  const signingSecret =
    existingSig || (await promptMasked("Slack Signing Secret"));
  return { botToken, signingSecret };
}

// ── Poll /api/channels/summary until slack.configured === true ──

export async function waitForSlackConfigured(
  url,
  adminSecret,
  {
    protectionBypassSecret,
    timeoutMs = 180_000,
    pollIntervalMs = isReplay() ? 0 : 3_000,
    installTokenPrefix = null,
    mintedAt = null,
  } = {},
) {
  const base = url.replace(/\/+$/, "");
  const endpoint = `${base}/api/channels/summary`;
  const headers = buildAuthHeaders(adminSecret, protectionBypassSecret);

  debug("waitForSlackConfigured.start", {
    endpoint,
    timeoutMs,
    pollIntervalMs,
    installTokenPrefix,
    mintedAt,
    ageMsAtStart: mintedAt ? Date.now() - mintedAt : null,
  });

  const spin = spinner("Waiting for Slack OAuth to complete in your browser");
  const start = Date.now();
  let attempt = 0;
  try {
    while (Date.now() - start < timeoutMs) {
      attempt += 1;
      const poll = await readSlackConfigured(endpoint, headers);
      debug("waitForSlackConfigured.poll", {
        attempt,
        elapsedMs: Date.now() - start,
        ...poll,
      });
      if (poll.configured === true) {
        spin.succeed("Slack connected");
        return true;
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      spin.update(`Waiting for Slack OAuth — ${elapsed}s`);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    spin.fail("Slack did not finish connecting in time");
    warn(
      "You can always finish the install later from the admin panel — the app was created and credentials are stored.",
    );
    return false;
  } catch (err) {
    spin.fail(`Slack status poll failed: ${err?.message ?? err}`);
    debug("waitForSlackConfigured.error", { error: err?.message ?? String(err) });
    return false;
  }
}

async function readSlackConfigured(endpoint, headers) {
  try {
    const res = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { configured: null, status: res.status, reason: "non-ok-status" };
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      // Next.js serves the admin page HTML with 200 when a route doesn't exist.
      // Treat that as a configuration error, not "not configured yet".
      return {
        configured: null,
        status: res.status,
        reason: "non-json-response",
        contentType,
      };
    }
    const body = await res.json().catch(() => null);
    const slack = body?.slack;
    if (slack && typeof slack.configured === "boolean") {
      return {
        configured: slack.configured,
        status: res.status,
        connected: slack.connected ?? null,
      };
    }
    return {
      configured: null,
      status: res.status,
      reason: "missing-slack-field",
      bodyKeys: body && typeof body === "object" ? Object.keys(body) : null,
    };
  } catch (err) {
    return { configured: null, status: 0, reason: err?.message ?? String(err) };
  }
}

// ── Cache ──

export function readSlackCache() {
  try {
    if (!existsSync(SLACK_CACHE_PATH)) return null;
    const raw = readFileSync(SLACK_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeSlackCache(payload) {
  try {
    const dir = dirname(SLACK_CACHE_PATH);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(SLACK_CACHE_PATH, JSON.stringify(payload, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    warn(`Could not write ${SLACK_CACHE_PATH}: ${err?.message ?? err}`);
  }
}

export function slackCachePath() {
  return SLACK_CACHE_PATH;
}

// ── Default browser opener ──

function defaultOpenBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort — operator can click the URL printed above
  }
}
