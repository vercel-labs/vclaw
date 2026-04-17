import test from "node:test";
import assert from "node:assert/strict";
import { connectSlack } from "./connect-slack.mjs";

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

test("connectSlack sends bearer auth + botToken + signingSecret on 200", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, {
      team: "OpenClaw Workspace",
      user: "oc_bot",
      botId: "B0123",
    }),
  );
  try {
    const res = await connectSlack(
      "https://my-openclaw.vercel.app/",
      "admin-secret-xyz",
      { botToken: "xoxb-abc", signingSecret: "sig-123" },
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.body.team, "OpenClaw Workspace");

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, "https://my-openclaw.vercel.app/api/channels/slack");
    assert.equal(call.init.method, "PUT");
    assert.equal(call.init.headers.Authorization, "Bearer admin-secret-xyz");
    assert.deepEqual(JSON.parse(call.init.body), {
      botToken: "xoxb-abc",
      signingSecret: "sig-123",
    });
    assert.equal(call.init.headers["x-vercel-protection-bypass"], undefined);
  } finally {
    stub.restore();
  }
});

test("connectSlack forwards the protection bypass header when provided", async () => {
  const stub = installFetchStub(() => jsonResponse(200, { team: "T", user: "u" }));
  try {
    await connectSlack("https://my-openclaw.vercel.app", "admin-secret", {
      botToken: "xoxb-abc",
      signingSecret: "sig",
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

test("connectSlack surfaces CHANNEL_CONNECT_BLOCKED as a structured failure", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(409, {
      error: {
        code: "CHANNEL_CONNECT_BLOCKED",
        message: "Cannot connect slack until deployment blockers are resolved.",
      },
      connectability: {
        channel: "slack",
        canConnect: false,
        status: "fail",
        webhookUrl: null,
        issues: [
          { id: "ai-gateway", message: "AI Gateway OIDC unavailable" },
        ],
      },
    }),
  );
  try {
    const res = await connectSlack("https://x", "admin", {
      botToken: "xoxb-abc",
      signingSecret: "sig",
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CHANNEL_CONNECT_BLOCKED");
  } finally {
    stub.restore();
  }
});

test("connectSlack reports a rejected bot token without throwing", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(400, {
      error: {
        code: "invalid_auth",
        message: "invalid_auth",
      },
    }),
  );
  try {
    const res = await connectSlack("https://x", "admin", {
      botToken: "xoxb-bad",
      signingSecret: "sig",
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "invalid_auth");
  } finally {
    stub.restore();
  }
});

test("connectSlack returns ok:false on a network error without throwing", async () => {
  const stub = installFetchStub(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const res = await connectSlack("https://x", "admin", {
      botToken: "xoxb-abc",
      signingSecret: "sig",
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.ok(res.error instanceof Error);
  } finally {
    stub.restore();
  }
});

test("connectSlack validates required arguments", async () => {
  await assert.rejects(
    () => connectSlack("", "admin", { botToken: "xoxb", signingSecret: "sig" }),
    /deployment url is required/,
  );
  await assert.rejects(
    () => connectSlack("https://x", "", { botToken: "xoxb", signingSecret: "sig" }),
    /adminSecret is required/,
  );
  await assert.rejects(
    () => connectSlack("https://x", "admin", { signingSecret: "sig" }),
    /botToken is required/,
  );
  await assert.rejects(
    () => connectSlack("https://x", "admin", { botToken: "xoxb" }),
    /signingSecret is required/,
  );
});
