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

test("createSlackApp retries on 401 and succeeds on a later attempt", async () => {
  let call = 0;
  const stub = installFetchStub(() => {
    call += 1;
    if (call < 3) {
      return jsonResponse(401, {
        error: "UNAUTHORIZED",
        message: "Authentication required.",
      });
    }
    return jsonResponse(200, {
      appId: "A1",
      appName: "VClaw",
      installUrl: "https://x/y",
    });
  });
  try {
    const res = await createSlackApp("https://x", "admin", {
      configToken: "xoxe.xoxp-abc",
      sleep: async () => {},
    });
    assert.equal(res.ok, true);
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test("createSlackApp gives up on 401 after MAX_ATTEMPTS and returns ok:false", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(401, {
      error: "UNAUTHORIZED",
      message: "Authentication required.",
    }),
  );
  const originalReplay = process.env.VCLAW_REPLAY;
  process.env.VCLAW_REPLAY = "1";
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (msg) => logs.push(String(msg));
  console.error = (msg) => logs.push(String(msg));
  try {
    const res = await createSlackApp("https://openclaw.example/", "admin-xyz", {
      configToken: "xoxe.xoxp-abc",
      protectionBypassSecret: "bypass-secret-xyz",
      sleep: async () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.equal(stub.calls.length, 3);
    const combined = logs.join("\n");
    assert.ok(
      combined.includes("rejected with 401"),
      "expected rejection line in diagnostics",
    );
    assert.ok(
      combined.includes("POST https://openclaw.example/api/channels/slack/app"),
      "expected URL in diagnostics",
    );
    assert.ok(
      combined.includes("admin-auth.ts"),
      "expected openclaw admin-auth attribution in diagnostics",
    );
    assert.ok(
      combined.includes("curl -i"),
      "expected reproducible curl command in diagnostics",
    );
    assert.ok(
      !combined.includes("admin-xyz") && !combined.includes("bypass-secret-xyz")
        ? false
        : true,
      "curl command should include secrets for user reproducibility",
    );
  } finally {
    console.log = origLog;
    console.error = origErr;
    stub.restore();
  }
});

test("createSlackApp does not retry on non-401 errors", async () => {
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
    assert.equal(stub.calls.length, 1);
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
