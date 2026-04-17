import test from "node:test";
import assert from "node:assert/strict";
import { provisionSlack } from "./provision-slack.mjs";

function installFetchStub(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: typeof url === "string" ? url : String(url), init });
    return handler(calls[calls.length - 1].url, init);
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

test("provisionSlack: skip branch short-circuits without any network calls", async () => {
  const stub = installFetchStub(() => jsonResponse(200, {}));
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      branch: "skip",
    });
    assert.equal(res.branch, "skip");
    assert.equal(res.ok, true);
    assert.equal(res.configured, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("provisionSlack: connect branch routes to PUT /api/channels/slack", async () => {
  const stub = installFetchStub(() =>
    jsonResponse(200, { team: "T", user: "u", botId: "B1" }),
  );
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      branch: "connect",
      botToken: "xoxb-abc",
      signingSecret: "sig",
    });
    assert.equal(res.branch, "connect");
    assert.equal(res.ok, true);
    assert.equal(res.configured, true);
    assert.equal(stub.calls.length, 1);
    assert.equal(
      stub.calls[0].url,
      "https://openclaw.example/api/channels/slack",
    );
    assert.equal(stub.calls[0].init.method, "PUT");
  } finally {
    stub.restore();
  }
});

test("provisionSlack: explicit configToken selects create branch, calls POST /api/channels/slack/app, opens install URL, polls status", async () => {
  const openedUrls = [];
  let statusCalls = 0;
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/channels/slack/app")) {
      return jsonResponse(200, {
        appId: "A1",
        appName: "VClaw",
        installUrl: "https://openclaw.example/api/channels/slack/install?install_token=t",
        installToken: "t",
        oauthAuthorizeUrl: "https://slack.com/oauth/v2/authorize?x=y",
        credentialsSource: "redis",
        tokenRotated: false,
      });
    }
    if (url.endsWith("/api/channels/summary")) {
      statusCalls += 1;
      if (statusCalls >= 2) {
        return jsonResponse(200, {
          slack: { configured: true, connected: true },
        });
      }
      return jsonResponse(200, {
        slack: { configured: false, connected: false },
      });
    }
    return jsonResponse(404, {});
  });
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      configToken: "xoxe.xoxp-abc",
      refreshToken: "xoxe-1-def",
      appName: "VClaw",
      pollTimeoutMs: 5_000,
      openBrowser: (url) => openedUrls.push(url),
    });
    assert.equal(res.branch, "create");
    assert.equal(res.ok, true);
    assert.equal(res.configured, true);
    assert.equal(res.appId, "A1");
    assert.equal(
      res.installUrl,
      "https://openclaw.example/api/channels/slack/install?install_token=t",
    );
    assert.deepEqual(openedUrls, [res.installUrl]);

    const appCall = stub.calls.find((c) =>
      c.url.endsWith("/api/channels/slack/app"),
    );
    assert.ok(appCall, "expected a POST to /api/channels/slack/app");
    assert.equal(appCall.init.method, "POST");
    const body = JSON.parse(appCall.init.body);
    assert.equal(body.configToken, "xoxe.xoxp-abc");
    assert.equal(body.refreshToken, "xoxe-1-def");
    assert.equal(body.appName, "VClaw");
  } finally {
    stub.restore();
  }
});

test("provisionSlack: create branch returns configured:false when status poll times out", async () => {
  const openedUrls = [];
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/channels/slack/app")) {
      return jsonResponse(200, {
        appId: "A1",
        appName: "VClaw",
        installUrl: "https://openclaw.example/install-url",
      });
    }
    if (url.endsWith("/api/admin/status")) {
      return jsonResponse(200, {
        channels: { slack: { configured: false } },
      });
    }
    return jsonResponse(404, {});
  });
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      configToken: "xoxe.xoxp-abc",
      pollTimeoutMs: 0,
      openBrowser: (url) => openedUrls.push(url),
    });
    assert.equal(res.branch, "create");
    assert.equal(res.ok, true);
    assert.equal(res.configured, false);
  } finally {
    stub.restore();
  }
});

test("provisionSlack: missing bot/signing on connect branch returns ok:false without prompting (non-interactive)", async () => {
  const stub = installFetchStub(() => jsonResponse(200, {}));
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      branch: "connect",
      canPrompt: false,
    });
    assert.equal(res.branch, "connect");
    assert.equal(res.ok, false);
    assert.equal(res.configured, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("provisionSlack: missing config token on create branch returns ok:false without network calls (non-interactive)", async () => {
  const stub = installFetchStub(() => jsonResponse(200, {}));
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      branch: "create",
      canPrompt: false,
    });
    assert.equal(res.branch, "create");
    assert.equal(res.ok, false);
    assert.equal(res.configured, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("provisionSlack: validates required arguments", async () => {
  await assert.rejects(
    () => provisionSlack("", "admin", { branch: "skip" }),
    /deployment url is required/,
  );
  await assert.rejects(
    () => provisionSlack("https://x", "", { branch: "skip" }),
    /adminSecret is required/,
  );
});
