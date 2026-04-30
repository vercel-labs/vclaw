import test from "node:test";
import assert from "node:assert/strict";
import { connectDiscord } from "./connect-discord.mjs";

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

test("connectDiscord reports ok when both endpoint and command are configured", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, {
      botUsername: "openclaw#1234",
      endpointConfigured: true,
      commandRegistered: true,
    }),
  );
  try {
    const res = await connectDiscord(
      "https://x",
      "admin",
      "DISCORD_BOT_TOKEN_xxx",
    );
    assert.equal(res.ok, true);
  } finally {
    stub.restore();
  }
});

test("connectDiscord fails when endpointConfigured is false (auto-config requested)", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, {
      botUsername: "openclaw#1234",
      endpointConfigured: false,
      endpointError: "PUBLIC_KEY_MISMATCH",
      commandRegistered: true,
    }),
  );
  try {
    const res = await connectDiscord("https://x", "admin", "tok");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "channel-setup-incomplete");
  } finally {
    stub.restore();
  }
});

test("connectDiscord fails when commandRegistered is false (auto-register requested)", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, {
      botUsername: "openclaw#1234",
      endpointConfigured: true,
      commandRegistered: false,
    }),
  );
  try {
    const res = await connectDiscord("https://x", "admin", "tok");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "channel-setup-incomplete");
  } finally {
    stub.restore();
  }
});

test("connectDiscord respects autoConfigureEndpoint=false (does not require endpoint setup)", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, {
      botUsername: "openclaw#1234",
      endpointConfigured: false,
      commandRegistered: true,
    }),
  );
  try {
    const res = await connectDiscord("https://x", "admin", "tok", {
      autoConfigureEndpoint: false,
    });
    assert.equal(res.ok, true);
  } finally {
    stub.restore();
  }
});

test("connectDiscord respects autoRegisterCommand=false", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, {
      botUsername: "openclaw#1234",
      endpointConfigured: true,
      commandRegistered: false,
    }),
  );
  try {
    const res = await connectDiscord("https://x", "admin", "tok", {
      autoRegisterCommand: false,
    });
    assert.equal(res.ok, true);
  } finally {
    stub.restore();
  }
});
