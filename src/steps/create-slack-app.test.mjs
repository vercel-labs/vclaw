import test from "node:test";
import assert from "node:assert/strict";
import { createSlackApp } from "./create-slack-app.mjs";

function installFetchStub(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("createSlackApp POSTs to /api/channels/slack/app with bearer auth + config token", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, {
      appId: "A123",
      appName: "VClaw",
      installUrl: "https://openclaw.example/api/channels/slack/install?install_token=t",
      installToken: "t",
      oauthAuthorizeUrl: "https://slack.com/oauth/v2/authorize?client_id=...",
      credentialsSource: "redis",
      tokenRotated: false,
    }),
  );
  try {
    const res = await createSlackApp(
      "https://openclaw.example/",
      "admin-secret-xyz",
      { configToken: "xoxe.xoxp-abc", refreshToken: "xoxe-1-def", appName: "VClaw" },
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.body.appId, "A123");

    const [call] = stub.calls;
    assert.equal(call.url, "https://openclaw.example/api/channels/slack/app");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.Authorization, "Bearer admin-secret-xyz");
    assert.deepEqual(JSON.parse(call.init.body), {
      configToken: "xoxe.xoxp-abc",
      refreshToken: "xoxe-1-def",
      appName: "VClaw",
    });
  } finally {
    stub.restore();
  }
});

test("createSlackApp omits undefined refresh token and app name from body", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, { appId: "A1", appName: "X", installUrl: "https://x/y" }),
  );
  try {
    await createSlackApp("https://x", "admin", { configToken: "xoxe.xoxp-abc" });
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.configToken, "xoxe.xoxp-abc");
    assert.ok(!("refreshToken" in body) || body.refreshToken === undefined);
    assert.ok(!("appName" in body) || body.appName === undefined);
  } finally {
    stub.restore();
  }
});

test("createSlackApp forwards the protection bypass header when provided", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, { appId: "A1", appName: "X", installUrl: "https://x/y" }),
  );
  try {
    await createSlackApp("https://x", "admin", {
      configToken: "xoxe.xoxp-abc",
      protectionBypassSecret: "bypass-abc",
    });
    assert.equal(
      stub.calls[0].init.headers["x-vercel-protection-bypass"],
      "bypass-abc",
    );
  } finally {
    stub.restore();
  }
});

test("createSlackApp surfaces TOKEN_EXPIRED as a structured failure", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(400, {
      error: { code: "TOKEN_EXPIRED", message: "Config token is expired." },
    }),
  );
  try {
    const res = await createSlackApp("https://x", "admin", {
      configToken: "xoxe.xoxp-old",
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "TOKEN_EXPIRED");
  } finally {
    stub.restore();
  }
});

test("createSlackApp returns ok:false on a network error without throwing", async () => {
  const stub = installFetchStub(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const res = await createSlackApp("https://x", "admin", {
      configToken: "xoxe.xoxp-abc",
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.ok(res.error instanceof Error);
  } finally {
    stub.restore();
  }
});

test("createSlackApp validates required arguments", async () => {
  await assert.rejects(
    () => createSlackApp("", "admin", { configToken: "xoxe.xoxp-abc" }),
    /deployment url is required/,
  );
  await assert.rejects(
    () => createSlackApp("https://x", "", { configToken: "xoxe.xoxp-abc" }),
    /adminSecret is required/,
  );
  await assert.rejects(
    () => createSlackApp("https://x", "admin", {}),
    /configToken is required/,
  );
});
