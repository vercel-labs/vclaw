import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the slack credential cache to a per-process temp dir BEFORE
// importing provision-slack, so tests that exercise the create branch don't
// clobber the user's real ~/.config/vclaw/slack.json with fixture data.
process.env.VCLAW_SLACK_CACHE_PATH = join(
  mkdtempSync(join(tmpdir(), "vclaw-slack-cache-")),
  "slack.json",
);

const { provisionSlack } = await import("./provision-slack.mjs");

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

test("provisionSlack: connect branch routes to PUT /api/channels/slack and polls summary", async () => {
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/channels/slack")) {
      return jsonResponse(200, { team: "T", user: "u", botId: "B1" });
    }
    if (url.endsWith("/api/channels/summary")) {
      // connectSlack now polls summary after a successful PUT and requires
      // two consecutive delivery-ready reads.
      return jsonResponse(200, {
        slack: { configured: true, connected: true, deliveryReady: true },
      });
    }
    return jsonResponse(404, {});
  });
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      branch: "connect",
      botToken: "xoxb-abc",
      signingSecret: "sig",
      connectReadyTimeoutMs: 5_000,
    });
    assert.equal(res.branch, "connect");
    assert.equal(res.ok, true);
    assert.equal(res.configured, true);
    const putCall = stub.calls.find((c) =>
      c.url.endsWith("/api/channels/slack"),
    );
    assert.ok(putCall, "expected PUT /api/channels/slack");
    assert.equal(putCall.init.method, "PUT");
    const summaryCalls = stub.calls.filter((c) =>
      c.url.endsWith("/api/channels/summary"),
    );
    assert.ok(
      summaryCalls.length >= 2,
      `expected at least two summary polls for stable readiness, got ${summaryCalls.length}`,
    );
  } finally {
    stub.restore();
  }
});

test("provisionSlack: connect branch fails when summary never reports connected===true", async () => {
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/channels/slack")) {
      return jsonResponse(200, { team: "T", user: "u", botId: "B1" });
    }
    if (url.endsWith("/api/channels/summary")) {
      return jsonResponse(200, {
        slack: { configured: true, connected: false, deliveryReady: false },
      });
    }
    return jsonResponse(404, {});
  });
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      branch: "connect",
      botToken: "xoxb-abc",
      signingSecret: "sig",
      connectReadyTimeoutMs: 50, // tight bound so the test finishes fast
    });
    // Server-side auth.test never passed, so connect should fail even
    // though the PUT succeeded.
    assert.equal(res.branch, "connect");
    assert.equal(res.ok, false);
    assert.equal(res.configured, false);
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
        appName: "my-bot (vercel-labs)",
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
          slack: { configured: true, connected: true, deliveryReady: true },
        });
      }
      return jsonResponse(200, {
        slack: { configured: false, connected: false, deliveryReady: false },
      });
    }
    return jsonResponse(404, {});
  });
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      configToken: "xoxe.xoxp-abc",
      refreshToken: "xoxe-1-def",
      appName: "My Custom Bot",
      botName: "custom-bot",
      pollTimeoutMs: 5_000,
      // The create-branch readiness gate now requires TWO consecutive
      // delivery-ready reads (same as connect-branch). Use a tight
      // interval so all three polls (1× negative, 2× positive) fit within
      // the 5s budget.
      pollIntervalMs: 50,
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
    assert.equal(body.appName, "My Custom Bot");
    assert.equal(body.botName, "custom-bot");
  } finally {
    stub.restore();
  }
});

test("provisionSlack: configured and connected without deliveryReady does NOT report success", async () => {
  const openedUrls = [];
  let statusCalls = 0;
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/channels/slack/app")) {
      return jsonResponse(200, {
        appId: "A1",
        appName: "my-bot",
        installUrl: "https://openclaw.example/install-url",
      });
    }
    if (url.endsWith("/api/channels/summary")) {
      statusCalls += 1;
      // OAuth callback finished writing the redis token (configured=true)
      // but Slack auth.test against the bot token has not succeeded yet.
      // The poll must keep waiting until connected flips true; if the poll
      // window expires first, the result reports configured=false.
      return jsonResponse(200, {
        slack: { configured: true, connected: false, deliveryReady: false },
      });
    }
    return jsonResponse(404, {});
  });
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      configToken: "xoxe.xoxp-abc",
      pollTimeoutMs: 50,
      openBrowser: (url) => openedUrls.push(url),
    });
    assert.equal(res.branch, "create");
    assert.equal(res.configured, true);
    assert.equal(
      res.deliveryReady,
      false,
      "summary reporting credentials without delivery readiness must not be treated as ready"
    );
    assert.ok(statusCalls > 0, "expected the summary poll to actually run");
  } finally {
    stub.restore();
  }
});

test("provisionSlack: create branch surfaces connected:true when delivery lag prevents deliveryReady (soft-fail diagnostics)", async () => {
  // Gateway sync is slow on a cold deploy: configured+connected flip true,
  // but liveConfigFresh/deliveryReady stay false within the poll window.
  // The result must surface connected:true so the caller can distinguish
  // "real auth failure" from "propagation lag" and pick the soft-fail path.
  const openedUrls = [];
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/channels/slack/app")) {
      return jsonResponse(200, {
        appId: "A1",
        appName: "my-bot",
        installUrl: "https://openclaw.example/install-url",
      });
    }
    if (url.endsWith("/api/channels/summary")) {
      return jsonResponse(200, {
        slack: {
          configured: true,
          connected: true,
          deliveryReady: false,
          routeReady: false,
          liveConfigFresh: false,
        },
      });
    }
    return jsonResponse(404, {});
  });
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      configToken: "xoxe.xoxp-abc",
      pollTimeoutMs: 50,
      pollIntervalMs: 5,
      openBrowser: (url) => openedUrls.push(url),
    });
    assert.equal(res.branch, "create");
    assert.equal(res.ok, true);
    assert.equal(res.configured, true);
    assert.equal(
      res.connected,
      true,
      "connected must be surfaced so callers can pick the soft-fail (delivery-pending) path",
    );
    assert.equal(res.deliveryReady, false);
    assert.ok(res.diagnostics, "diagnostics from the last poll must be returned");
  } finally {
    stub.restore();
  }
});

test("provisionSlack: gateway-not-ready timeout emits actionable diagnostic pointing at vclaw doctor", async () => {
  // The hung-gateway regression: webhook accepted, workflow started, but
  // routeReady/liveConfigFresh never flip. configured && connected are true;
  // deliveryReady stays false. The diagnostic must mention `vclaw doctor`.
  const openedUrls = [];
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/channels/slack/app")) {
      return jsonResponse(200, {
        appId: "A1",
        appName: "my-bot",
        installUrl: "https://openclaw.example/install-url",
      });
    }
    if (url.endsWith("/api/channels/summary")) {
      return jsonResponse(200, {
        slack: {
          configured: true,
          connected: true,
          deliveryReady: false,
          routeReady: false,
          liveConfigFresh: false,
        },
      });
    }
    return jsonResponse(404, {});
  });
  const originalLog = console.log;
  const captured = [];
  console.log = (msg) => {
    captured.push(typeof msg === "string" ? msg : String(msg));
  };
  try {
    const res = await provisionSlack("https://openclaw.example", "admin", {
      configToken: "xoxe.xoxp-abc",
      pollTimeoutMs: 50,
      pollIntervalMs: 5,
      openBrowser: (url) => openedUrls.push(url),
    });
    assert.equal(res.deliveryReady, false);
    assert.equal(res.connected, true);
    const joined = captured.join("\n");
    assert.match(
      joined,
      /vclaw doctor/,
      "diagnostic must point operators at `vclaw doctor` when gateway delivery never becomes ready",
    );
    assert.match(
      joined,
      /Verifying config/,
      "diagnostic should reference the user-visible Slack symptom",
    );
  } finally {
    console.log = originalLog;
    stub.restore();
  }
});

test("provisionSlack: create branch returns configured:false when status poll times out", async () => {
  const openedUrls = [];
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/channels/slack/app")) {
      return jsonResponse(200, {
        appId: "A1",
        appName: "my-bot (vercel-labs)",
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
