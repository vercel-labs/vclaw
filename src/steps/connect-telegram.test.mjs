import test from "node:test";
import assert from "node:assert/strict";
import { connectTelegram } from "./connect-telegram.mjs";

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

test("connectTelegram sends bearer auth + botToken and returns ok on 200", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, {
      botUsername: "oc_test_bot",
      commandSyncStatus: "synced",
    }),
  );
  try {
    const res = await connectTelegram(
      "https://my-openclaw.vercel.app/",
      "admin-secret-xyz",
      "12345:token",
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.body.botUsername, "oc_test_bot");

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(
      call.url,
      "https://my-openclaw.vercel.app/api/channels/telegram",
    );
    assert.equal(call.init.method, "PUT");
    assert.equal(call.init.headers.Authorization, "Bearer admin-secret-xyz");
    assert.equal(call.init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(call.init.body), { botToken: "12345:token" });
    assert.equal(call.init.headers["x-vercel-protection-bypass"], undefined);
  } finally {
    stub.restore();
  }
});

test("connectTelegram forwards the protection bypass header when provided", async () => {
  const stub = installFetchStub(() => jsonResponse(200, { botUsername: "b" }));
  try {
    await connectTelegram(
      "https://my-openclaw.vercel.app",
      "admin-secret",
      "t",
      { protectionBypassSecret: "bypass-abc" },
    );
    assert.equal(
      stub.calls[0].init.headers["x-vercel-protection-bypass"],
      "bypass-abc",
    );
  } finally {
    stub.restore();
  }
});

test("connectTelegram surfaces CHANNEL_CONNECT_BLOCKED as a structured failure", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(409, {
      error: {
        code: "CHANNEL_CONNECT_BLOCKED",
        message: "Cannot connect telegram until deployment blockers are resolved.",
      },
      connectability: {
        channel: "telegram",
        canConnect: false,
        status: "fail",
        webhookUrl: null,
        issues: [
          { id: "public-origin", message: "Public HTTPS origin not resolvable" },
        ],
      },
    }),
  );
  try {
    const res = await connectTelegram("https://x", "admin", "token");
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CHANNEL_CONNECT_BLOCKED");
  } finally {
    stub.restore();
  }
});

test("connectTelegram reports an invalid bot token without throwing", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(400, {
      error: {
        code: "INVALID_BOT_TOKEN",
        message: "botToken must be a non-empty string",
      },
    }),
  );
  try {
    const res = await connectTelegram("https://x", "admin", "bad");
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_BOT_TOKEN");
  } finally {
    stub.restore();
  }
});

test("connectTelegram returns ok:false on a network error without throwing", async () => {
  const stub = installFetchStub(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const res = await connectTelegram("https://x", "admin", "t");
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.ok(res.error instanceof Error);
  } finally {
    stub.restore();
  }
});

test("connectTelegram validates required arguments", async () => {
  await assert.rejects(
    () => connectTelegram("", "admin", "token"),
    /deployment url is required/,
  );
  await assert.rejects(
    () => connectTelegram("https://x", "", "token"),
    /adminSecret is required/,
  );
  await assert.rejects(
    () => connectTelegram("https://x", "admin", ""),
    /botToken is required/,
  );
});
