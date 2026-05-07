#!/usr/bin/env node
// Provision a single-purpose "vclaw-tester" Slack app and mint a user OAuth
// token with messaging scopes (chat:write, im:write, im:history,
// channels:history, groups:history). The token is saved to .env.local for
// reuse by the rest of the qa/slack-e2e harness.
//
// Inputs:
//   --config-token <xoxe.xoxp-...>   App Configuration Token from
//                                    https://api.slack.com/apps (12hr expiry)
//   $SLACK_APP_CONFIG_TOKEN           Same, via env
//
// One-time setup. Re-run any time the token expires (Slack rotates after
// rotation period; for tests, just re-run if the saved token stops working).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, ".env.local");
const PORT = 3737;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
// Each fresh provision uses a timestamped name to avoid name_taken collisions
// with previous failed attempts. If you have an existing vclaw-tester app you
// want to keep, delete it via https://api.slack.com/apps before re-running.
const APP_NAME = `vclaw-tester-${Date.now().toString(36)}`;

// Minimal scope set for DM-only testing. channels:history and groups:history
// are commonly blocked on Slack Enterprise Grid (scope_not_allowed_on_enterprise);
// we don't need them for DM-based send-and-verify flows.
const USER_SCOPES = [
  "chat:write",
  "im:write",
  "im:history",
  "users:read",
];

async function readConfigToken() {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf("--config-token");
  if (flagIdx >= 0 && args[flagIdx + 1]) return args[flagIdx + 1];
  if (process.env.SLACK_APP_CONFIG_TOKEN) return process.env.SLACK_APP_CONFIG_TOKEN;
  const rl = createInterface({ input, output });
  const ans = await rl.question(
    "Paste your App Configuration Token (xoxe.xoxp-… from https://api.slack.com/apps): ",
  );
  rl.close();
  return ans.trim();
}

const MANIFEST = {
  display_information: { name: APP_NAME, description: "vclaw E2E test harness" },
  features: { bot_user: { display_name: APP_NAME, always_online: false } },
  oauth_config: {
    redirect_urls: [REDIRECT_URI],
    scopes: { bot: ["chat:write"], user: USER_SCOPES },
  },
  settings: {
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    is_hosted: false,
    token_rotation_enabled: false,
  },
};

async function api(method, token, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${JSON.stringify(json)}`);
  return json;
}

async function apiForm(method, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${JSON.stringify(json)}`);
  return json;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
  child.unref();
}

async function readEnvLocal() {
  try {
    const text = await readFile(ENV_PATH, "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch { return {}; }
}

async function createOrUpdateApp(configToken) {
  const cached = await readEnvLocal();
  const cachedAppId = cached.VCLAW_TEST_APP_ID;

  if (cachedAppId) {
    console.log(`→ updating existing app ${cachedAppId} via apps.manifest.update…`);
    try {
      const updated = await api("apps.manifest.update", configToken, {
        app_id: cachedAppId,
        manifest: MANIFEST,
      });
      // apps.manifest.update doesn't always return credentials — fetch them.
      const exp = await api("apps.manifest.export", configToken, { app_id: cachedAppId });
      return {
        app_id: cachedAppId,
        credentials: updated.credentials ?? exp.credentials ?? null,
        oauth_authorize_url: updated.oauth_authorize_url,
      };
    } catch (err) {
      console.warn(`  update failed (${err.message.slice(0, 200)}…) — falling back to create`);
    }
  }

  console.log("→ creating app via apps.manifest.create…");
  return api("apps.manifest.create", configToken, { manifest: MANIFEST });
}

async function exchangeCode({ clientId, clientSecret, code }) {
  return apiForm("oauth.v2.access", {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
  });
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:2rem"><h1>${
        code ? "✓ Captured. You can close this tab." : "✗ " + (error ?? "unknown error")
      }</h1></body>`);
      server.close();
      if (code) resolve(code); else reject(new Error(`oauth_error: ${error}`));
    });
    server.listen(PORT, () => console.log(`→ listening for OAuth redirect on ${REDIRECT_URI}`));
    setTimeout(() => { server.close(); reject(new Error("oauth timeout (5min)")); }, 5 * 60_000);
  });
}

async function writeEnvLocal(token, extras = {}) {
  let existing = "";
  try { existing = await readFile(ENV_PATH, "utf8"); } catch {}
  const without = existing
    .split("\n")
    .filter((line) => !/^VCLAW_TEST_USER_TOKEN=|^VCLAW_TEST_APP_ID=|^VCLAW_TEST_TEAM_ID=/.test(line))
    .filter(Boolean);
  const next = [
    ...without,
    `VCLAW_TEST_USER_TOKEN=${token}`,
    ...(extras.appId ? [`VCLAW_TEST_APP_ID=${extras.appId}`] : []),
    ...(extras.teamId ? [`VCLAW_TEST_TEAM_ID=${extras.teamId}`] : []),
    "",
  ].join("\n");
  await writeFile(ENV_PATH, next, { mode: 0o600 });
  console.log(`✓ wrote ${ENV_PATH}`);
}

async function main() {
  const configToken = await readConfigToken();
  if (!configToken?.startsWith("xoxe.")) {
    console.error("error: config token should start with xoxe.");
    process.exit(2);
  }

  const created = await createOrUpdateApp(configToken);
  const { app_id, credentials } = created;
  const clientId = credentials?.client_id;
  const clientSecret = credentials?.client_secret;
  if (!clientId || !clientSecret) {
    console.error("error: missing client_id/client_secret in apps.manifest.create response", created);
    process.exit(1);
  }
  console.log(`✓ app created (${app_id})`);

  const installUrl = new URL("https://slack.com/oauth/v2/authorize");
  installUrl.searchParams.set("client_id", clientId);
  installUrl.searchParams.set("user_scope", USER_SCOPES.join(","));
  installUrl.searchParams.set("scope", "chat:write");
  installUrl.searchParams.set("redirect_uri", REDIRECT_URI);

  console.log(`→ opening install URL in your browser`);
  console.log(`  if it doesn't open, visit: ${installUrl.toString()}`);
  openBrowser(installUrl.toString());

  const code = await waitForCode();
  console.log("✓ captured code, exchanging for tokens…");
  const exchange = await exchangeCode({ clientId, clientSecret, code });
  const userToken = exchange.authed_user?.access_token;
  if (!userToken) {
    console.error("error: no authed_user.access_token in oauth.v2.access response", exchange);
    process.exit(1);
  }
  await writeEnvLocal(userToken, { appId: app_id, teamId: exchange.team?.id });
  console.log(`\nDone. User token saved. Use it via:`);
  console.log(`  set -a && source ${ENV_PATH} && set +a`);
  console.log(`Or rely on the harness scripts which auto-load it.`);
}

main().catch((err) => {
  console.error("provision-test-token failed:", err.message);
  process.exit(1);
});
