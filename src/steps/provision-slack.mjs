import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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

  // Resolve branch. Precedence: explicit preselected > explicit flags > prompt > skip.
  const branch =
    preselectedBranch ||
    (configTokenInput ? "create" : null) ||
    (botToken && signingSecret ? "connect" : null) ||
    (canPrompt ? await promptBranch() : "skip");

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
  step("Opening Slack OAuth install in your browser");
  log(dim(`  If nothing opens, visit: ${installUrl}`));
  openBrowser(installUrl);

  const configured = await waitForSlackConfigured(url, adminSecret, {
    protectionBypassSecret,
    timeoutMs: pollTimeoutMs,
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

// ── Poll admin/status until Slack.configured === true ──

export async function waitForSlackConfigured(
  url,
  adminSecret,
  {
    protectionBypassSecret,
    timeoutMs = 180_000,
    pollIntervalMs = isReplay() ? 0 : 3_000,
  } = {},
) {
  const base = url.replace(/\/+$/, "");
  const endpoint = `${base}/api/admin/status`;
  const headers = buildAuthHeaders(adminSecret, protectionBypassSecret);

  const spin = spinner("Waiting for Slack OAuth to complete in your browser");
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      const configured = await readSlackConfigured(endpoint, headers);
      if (configured === true) {
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
    return false;
  }
}

async function readSlackConfigured(endpoint, headers) {
  try {
    const res = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const slack = body?.channels?.slack;
    if (slack && typeof slack.configured === "boolean") {
      return slack.configured;
    }
    return null;
  } catch {
    return null;
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
