import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthHeaders,
  pollUntilReady,
  runVerify,
  VerifyFailedError,
} from "./run-verify.mjs";

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

test("buildAuthHeaders includes the admin bearer token", () => {
  assert.deepEqual(buildAuthHeaders("admin-secret"), {
    Authorization: "Bearer admin-secret",
  });
});

test("buildAuthHeaders includes deployment protection bypass when provided", () => {
  assert.deepEqual(buildAuthHeaders("admin-secret", "bypass-secret"), {
    Authorization: "Bearer admin-secret",
    "x-vercel-protection-bypass": "bypass-secret",
  });
});

function fakeFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  };
}

test("pollUntilReady fails fast on 401 when protection is not freshly applied", async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 401 }]);
  let currentTime = 0;
  await assert.rejects(
    pollUntilReady("https://example.com/api/admin/preflight", {}, {
      timeoutMs: 60_000,
      pollIntervalMs: 0,
      retryAuthFailuresUntilMs: 0,
      fetchImpl,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      },
    }),
    /returned 401/
  );
});

test("pollUntilReady retries 401 within the grace window when freshly applied", async () => {
  const responses = [
    { ok: false, status: 401 },
    { ok: false, status: 401 },
    { ok: false, status: 403 },
    { ok: true, status: 200 },
  ];
  const fetchImpl = fakeFetch(responses);
  let currentTime = 0;
  await pollUntilReady("https://example.com/api/admin/preflight", {}, {
    timeoutMs: 60_000,
    pollIntervalMs: 5_000,
    retryAuthFailuresUntilMs: 60_000,
    fetchImpl,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms;
    },
  });
});

test("pollUntilReady fails on 401 once the auth-grace window has elapsed", async () => {
  const fetchImpl = fakeFetch([
    { ok: false, status: 401 },
    { ok: false, status: 401 },
  ]);
  let currentTime = 0;
  await assert.rejects(
    pollUntilReady("https://example.com/api/admin/preflight", {}, {
      timeoutMs: 60_000,
      pollIntervalMs: 30_000,
      retryAuthFailuresUntilMs: 10_000,
      fetchImpl,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      },
    }),
    /returned 401/
  );
});

test("runVerify throws VerifyFailedError when launch-verify returns 5xx", async () => {
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/admin/preflight")) {
      return jsonResponse(200, { ok: true, actions: [] });
    }
    if (url.endsWith("/api/admin/launch-verify")) {
      return jsonResponse(500, { error: "internal" });
    }
    return jsonResponse(404, {});
  });
  try {
    await assert.rejects(
      () => runVerify("https://example.com", "admin"),
      (err) => err instanceof VerifyFailedError && /HTTP 500/.test(err.message)
    );
  } finally {
    stub.restore();
  }
});

test("runVerify throws when launch-verify returns JSON {ok:false}", async () => {
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/admin/preflight")) {
      return jsonResponse(200, { ok: true, actions: [] });
    }
    if (url.endsWith("/api/admin/launch-verify")) {
      return jsonResponse(200, { ok: false, issues: ["redis ping failed"] });
    }
    return jsonResponse(404, {});
  });
  try {
    await assert.rejects(
      () => runVerify("https://example.com", "admin"),
      (err) =>
        err instanceof VerifyFailedError && /reported \{ok:false\}/.test(err.message)
    );
  } finally {
    stub.restore();
  }
});

test("runVerify throws when preflight reports !ok", async () => {
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/admin/preflight")) {
      return jsonResponse(200, {
        ok: false,
        actions: [{ id: "redis", status: "fail", message: "no REDIS_URL" }],
      });
    }
    return jsonResponse(404, {});
  });
  try {
    await assert.rejects(
      () => runVerify("https://example.com", "admin"),
      (err) => err instanceof VerifyFailedError && err.result?.stage === "preflight"
    );
  } finally {
    stub.restore();
  }
});

test("runVerify with allowFailure:true returns failure object instead of throwing", async () => {
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/admin/preflight")) {
      return jsonResponse(200, { ok: true, actions: [] });
    }
    if (url.endsWith("/api/admin/launch-verify")) {
      return jsonResponse(200, { ok: false, issues: ["x"] });
    }
    return jsonResponse(404, {});
  });
  try {
    const result = await runVerify("https://example.com", "admin", {
      allowFailure: true,
    });
    assert.equal(result.ok, false);
  } finally {
    stub.restore();
  }
});

test("runVerify resolves with the success body when launch-verify returns {ok:true}", async () => {
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/admin/preflight")) {
      return jsonResponse(200, { ok: true, actions: [] });
    }
    if (url.endsWith("/api/admin/launch-verify")) {
      return jsonResponse(200, { ok: true, summary: { passed: 5 } });
    }
    return jsonResponse(404, {});
  });
  try {
    const result = await runVerify("https://example.com", "admin");
    assert.equal(result.ok, true);
    assert.equal(result.summary.passed, 5);
  } finally {
    stub.restore();
  }
});

test("runVerify posts {mode:'safe'} by default", async () => {
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/admin/preflight")) {
      return jsonResponse(200, { ok: true, actions: [] });
    }
    if (url.endsWith("/api/admin/launch-verify")) {
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, {});
  });
  try {
    await runVerify("https://example.com", "admin");
    const launchCall = stub.calls.find((c) => c.url.endsWith("/api/admin/launch-verify"));
    assert.ok(launchCall, "launch-verify should have been called");
    assert.deepEqual(JSON.parse(launchCall.init.body), { mode: "safe" });
  } finally {
    stub.restore();
  }
});

test("runVerify posts {mode:'destructive'} when destructive=true", async () => {
  const stub = installFetchStub((url) => {
    if (url.endsWith("/api/admin/preflight")) {
      return jsonResponse(200, { ok: true, actions: [] });
    }
    if (url.endsWith("/api/admin/launch-verify")) {
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, {});
  });
  try {
    await runVerify("https://example.com", "admin", { destructive: true });
    const launchCall = stub.calls.find((c) => c.url.endsWith("/api/admin/launch-verify"));
    assert.ok(launchCall, "launch-verify should have been called");
    assert.deepEqual(JSON.parse(launchCall.init.body), { mode: "destructive" });
  } finally {
    stub.restore();
  }
});

test("pollUntilReady tolerates network errors and resolves on a later 200", async () => {
  const fetchImpl = fakeFetch([
    new Error("network refused"),
    { ok: false, status: 503 },
    { ok: true, status: 200 },
  ]);
  let currentTime = 0;
  await pollUntilReady("https://example.com/api/admin/preflight", {}, {
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
    fetchImpl,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms;
    },
  });
});
