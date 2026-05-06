import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// Redirect the slack credential cache to a per-process temp dir BEFORE
// importing modules that reach for it. Otherwise the create branch would
// clobber the user's real ~/.config/vclaw/slack.json with smoke fixture data.
process.env.VCLAW_SLACK_CACHE_PATH = join(
  mkdtempSync(join(tmpdir(), "vclaw-slack-cache-")),
  "slack.json",
);

const { create } = await import("./create.mjs");
const { provisionSlack } = await import("../steps/provision-slack.mjs");
const { runVerify } = await import("../steps/run-verify.mjs");

const ADMIN_SECRET = "admin-smoke";
const SLACK_SIGNING_SECRET = "slack-signing-smoke";
const BUNDLE_URL = "https://github.com/vercel-labs/openclaw-sandbox/releases/download/v-smoke/openclaw.bundle.mjs";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function requireAdmin(req, res) {
  if (req.headers.authorization !== `Bearer ${ADMIN_SECRET}`) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

function isValidSlackSignature({ rawBody, timestamp, signature, signingSecret }) {
  if (!timestamp || !signature) return false;
  const expected = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  const expectedHeader = `v0=${expected}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function startFakeOpenClawDeployment() {
  const state = {
    pushedEnv: null,
    slack: { configured: false, connected: false, deliveryReady: false },
    summaryPolls: 0,
    asleep: false,
    wakeCalls: 0,
    handledMessages: [],
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/api/admin/preflight") {
      if (!requireAdmin(req, res)) return;
      json(res, 200, { ok: true, actions: [] });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/launch-verify") {
      if (!requireAdmin(req, res)) return;
      assert.equal(state.pushedEnv.OPENCLAW_BUNDLE_URL.value, BUNDLE_URL);
      assert.equal(
        state.pushedEnv.OPENCLAW_BUNDLE_UI_URL.value,
        "https://github.com/vercel-labs/openclaw-sandbox/releases/download/v-smoke/control-ui.tar.gz",
      );
      json(res, 200, {
        ok: true,
        bundle: {
          url: state.pushedEnv.OPENCLAW_BUNDLE_URL.value,
          uiUrl: state.pushedEnv.OPENCLAW_BUNDLE_UI_URL.value,
          installed: true,
          sidecarsPresent: true,
        },
      });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/channels/slack") {
      if (!requireAdmin(req, res)) return;
      const body = JSON.parse(await readBody(req));
      assert.equal(body.botToken, "xoxb-smoke");
      assert.equal(body.signingSecret, SLACK_SIGNING_SECRET);
      state.slack = { configured: true, connected: true, deliveryReady: true };
      json(res, 200, { ok: true, team: "T-smoke", user: "U-bot" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/channels/summary") {
      if (!requireAdmin(req, res)) return;
      state.summaryPolls += 1;
      json(res, 200, { slack: state.slack });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/channels/slack/events") {
      const rawBody = await readBody(req);
      const valid = isValidSlackSignature({
        rawBody,
        timestamp: req.headers["x-slack-request-timestamp"],
        signature: req.headers["x-slack-signature"],
        signingSecret: SLACK_SIGNING_SECRET,
      });
      if (!valid) {
        json(res, 401, { ok: false, error: "invalid_signature" });
        return;
      }
      const body = JSON.parse(rawBody);
      if (body.type === "url_verification") {
        json(res, 200, { challenge: body.challenge });
        return;
      }
      if (state.asleep) {
        state.asleep = false;
        state.wakeCalls += 1;
      }
      state.handledMessages.push(body.event);
      json(res, 200, { ok: true, accepted: true });
      return;
    }

    json(res, 404, { ok: false, error: "not_found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    state,
    baseUrl,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function signedSlackRequest(body) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
    },
  };
}

test("create smoke installs the release bundle, connects Slack, and wakes on a signed Slack event", async () => {
  const fake = await startFakeOpenClawDeployment();
  const projectDir = await mkdtemp(join(tmpdir(), "vclaw-create-smoke-"));
  const registered = [];
  try {
    const deps = {
      checkPrereqs: async () => {},
      resolveScope: async () => {
        throw new Error("scope should be provided in smoke test");
      },
      readVercelToken: () => "token-smoke",
      getTeamBySlug: async () => ({ id: "team_smoke" }),
      getUser: async () => null,
      setActiveTeam: () => true,
      findAvailableProjectName: async () => ({ name: "vclaw-smoke", baseTaken: false }),
      cloneRepo: async () => projectDir,
      linkProject: async () => ({ projectId: "prj_smoke", teamId: "team_smoke" }),
      provisionRedis: async () => {},
      configureProjectProtection: async () => ({
        protectionBypassSecret: null,
        protectionFreshlyApplied: false,
      }),
      getProject: async () => ({ targets: { production: { alias: [] } } }),
      readProtectionState: () => ({ enabled: false, activeTypes: [] }),
      ensureAutomationBypassSecret: async () => ({ secret: null, created: false }),
      resolveCreateBundleUrl: async () => BUNDLE_URL,
      pushEnvVars: async (_dir, vars) => {
        fake.state.pushedEnv = vars;
      },
      deploy: async () => fake.baseUrl,
      readLinkedProject: () => ({ projectId: "prj_smoke", teamId: "team_smoke" }),
      waitForDeploymentReady: async () => ({
        ready: true,
        deployment: {
          url: fake.baseUrl,
          alias: [],
          aliasAssigned: false,
          readyState: "READY",
        },
      }),
      getDeployment: async () => ({}),
      getProductionAlias: async () => fake.baseUrl,
      runVerify,
      connectTelegram: async () => ({ ok: true }),
      provisionSlack: (url, adminSecret, options) =>
        provisionSlack(url, adminSecret, {
          ...options,
          connectReadyTimeoutMs: 1_000,
          connectReadyPollIntervalMs: 0,
        }),
      registerClaw: (name, payload) => registered.push({ name, payload }),
      writeManagedWorkspaceMetadata: () => {},
      openInBrowser: () => {},
    };

    await create(
      [
        "--yes",
        "--name",
        "vclaw-smoke",
        "--claw-name",
        "vclaw_smoke",
        "--scope",
        "smoke-team",
        "--admin-secret",
        ADMIN_SECRET,
        "--skip-redis",
        "--slack-bot-token",
        "xoxb-smoke",
        "--slack-signing-secret",
        SLACK_SIGNING_SECRET,
      ],
      deps,
    );

    assert.equal(fake.state.summaryPolls >= 2, true);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].payload.channels.slack.status, "connected");
    assert.equal(registered[0].payload.verifiedUrl, fake.baseUrl);

    fake.state.asleep = true;
    const signed = signedSlackRequest({
      type: "event_callback",
      team_id: "T-smoke",
      event: {
        type: "app_mention",
        channel: "C-smoke",
        user: "U-smoke",
        text: "wake up from smoke",
        ts: "1710000000.000100",
      },
    });
    const res = await fetch(`${fake.baseUrl}/api/channels/slack/events`, {
      method: "POST",
      headers: signed.headers,
      body: signed.rawBody,
    });

    assert.equal(res.status, 200);
    assert.equal(fake.state.wakeCalls, 1);
    assert.equal(fake.state.handledMessages[0].text, "wake up from smoke");
  } finally {
    await fake.close();
    await rm(projectDir, { recursive: true, force: true });
  }
});
