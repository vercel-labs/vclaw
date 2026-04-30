import test from "node:test";
import assert from "node:assert/strict";
import { connectWhatsApp } from "./connect-whatsapp.mjs";

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

const baseArgs = {
  phoneNumberId: "p",
  accessToken: "a",
  verifyToken: "v",
  appSecret: "s",
};

test("connectWhatsApp reports ok on a clean 200 with no lastError", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, { displayName: "OpenClaw" }),
  );
  try {
    const res = await connectWhatsApp("https://x", "admin", baseArgs);
    assert.equal(res.ok, true);
  } finally {
    stub.restore();
  }
});

test("connectWhatsApp fails when server reports a lastError", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, {
      displayName: "OpenClaw",
      lastError: "phone_number_not_authorized",
    }),
  );
  try {
    const res = await connectWhatsApp("https://x", "admin", baseArgs);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "channel-setup-incomplete");
  } finally {
    stub.restore();
  }
});

test("connectWhatsApp fails when connected===false", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, { connected: false }),
  );
  try {
    const res = await connectWhatsApp("https://x", "admin", baseArgs);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "channel-setup-incomplete");
  } finally {
    stub.restore();
  }
});

test("connectWhatsApp fails when webhookVerified===false", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, { webhookVerified: false }),
  );
  try {
    const res = await connectWhatsApp("https://x", "admin", baseArgs);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "channel-setup-incomplete");
  } finally {
    stub.restore();
  }
});
