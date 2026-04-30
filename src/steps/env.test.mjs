import test from "node:test";
import assert from "node:assert/strict";
import {
  buildManagedEnvVars,
  findManagedEnvIssues,
  waitForManagedEnvVars,
} from "./env.mjs";

const TARGETS = ["production", "preview"];

function makeEntry({ key, value = "", type = "plain", updatedAt }) {
  return {
    key,
    value,
    type,
    target: TARGETS,
    updatedAt: updatedAt ?? Date.now(),
  };
}

test("buildManagedEnvVars marks plain identity vars as plain and secrets as sensitive", () => {
  const { adminSecret, vars } = buildManagedEnvVars({
    adminSecret: "given-admin",
    cronSecret: "cron",
    protectionBypassSecret: "bypass",
    projectScope: "team-slug",
    projectName: "vercel-openclaw",
    bundleUrl: "https://x.public.blob.vercel-storage.com/openclaw.bundle.mjs",
  });
  assert.equal(adminSecret, "given-admin");
  assert.equal(vars.ADMIN_SECRET.type, "sensitive");
  assert.equal(vars.CRON_SECRET.type, "sensitive");
  assert.equal(vars.VERCEL_AUTOMATION_BYPASS_SECRET.type, "sensitive");
  assert.equal(vars.VCLAW_PROJECT_SCOPE.type, "plain");
  assert.equal(vars.VCLAW_PROJECT_NAME.type, "plain");
  assert.equal(vars.OPENCLAW_BUNDLE_URL.type, "plain");
  assert.equal(
    vars.OPENCLAW_BUNDLE_UI_URL.value,
    "https://x.public.blob.vercel-storage.com/control-ui.tar.gz"
  );
});

test("findManagedEnvIssues returns empty when every key is present and matches", () => {
  const expected = {
    ADMIN_SECRET: { value: "abc", type: "sensitive" },
    OPENCLAW_BUNDLE_URL: { value: "https://example/openclaw.bundle.mjs", type: "plain" },
  };
  const envs = [
    // Vercel redacts sensitive values, but the entry still exists with target.
    makeEntry({ key: "ADMIN_SECRET", value: "", type: "sensitive" }),
    makeEntry({
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://example/openclaw.bundle.mjs",
      type: "plain",
    }),
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), []);
});

test("findManagedEnvIssues flags missing keys", () => {
  const expected = { ADMIN_SECRET: { value: "abc", type: "sensitive" } };
  assert.deepEqual(findManagedEnvIssues({ envs: [], expected }), [
    { key: "ADMIN_SECRET", reason: "missing" },
  ]);
});

test("findManagedEnvIssues flags missing target coverage", () => {
  const expected = { ADMIN_SECRET: { value: "abc", type: "sensitive" } };
  const envs = [
    { key: "ADMIN_SECRET", value: "", type: "sensitive", target: ["production"] },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), [
    { key: "ADMIN_SECRET", reason: "missing-target:preview" },
  ]);
});

test("findManagedEnvIssues rejects placeholder values like database_provisioning_in_progress", () => {
  const expected = {
    REDIS_URL: { value: "rediss://example", type: "plain" },
  };
  const envs = [
    makeEntry({
      key: "REDIS_URL",
      value: "database_provisioning_in_progress",
      type: "plain",
    }),
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), [
    { key: "REDIS_URL", reason: "placeholder" },
  ]);
});

test("findManagedEnvIssues flags plain value mismatch (caught a stale upsert)", () => {
  const expected = {
    OPENCLAW_BUNDLE_URL: {
      value: "https://example/new.bundle.mjs",
      type: "plain",
    },
  };
  const envs = [
    makeEntry({
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://example/old.bundle.mjs",
      type: "plain",
    }),
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), [
    { key: "OPENCLAW_BUNDLE_URL", reason: "value-mismatch" },
  ]);
});

test("findManagedEnvIssues flags plain entries with empty value (not yet propagated)", () => {
  const expected = {
    VCLAW_PROJECT_NAME: { value: "vercel-openclaw", type: "plain" },
  };
  const envs = [
    { key: "VCLAW_PROJECT_NAME", value: "", type: "plain", target: TARGETS },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), [
    { key: "VCLAW_PROJECT_NAME", reason: "missing-value" },
  ]);
});

test("findManagedEnvIssues tolerates redacted sensitive values (empty value, no mismatch)", () => {
  const expected = {
    ADMIN_SECRET: { value: "abc", type: "sensitive" },
  };
  const envs = [
    // Vercel returns no plaintext for sensitive entries even with decrypt=true.
    { key: "ADMIN_SECRET", value: "", type: "sensitive", target: TARGETS },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), []);
});

test("findManagedEnvIssues normalizes mixed-case target arrays", () => {
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/y.mjs", type: "plain" },
  };
  const envs = [
    {
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/y.mjs",
      type: "plain",
      target: ["Production", "Preview"],
    },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), []);
});

test("findManagedEnvIssues accepts target as a string instead of array", () => {
  const expected = {
    PROD_ONLY: { value: "v", type: "plain" },
  };
  const envs = [
    { key: "PROD_ONLY", value: "v", type: "plain", target: "production" },
  ];
  // Single-target entries fail target coverage by default (we want both
  // production+preview), but the string-vs-array shape should be
  // recognized — confirm by checking the reason is target coverage, not
  // a structural failure to parse.
  const issues = findManagedEnvIssues({ envs, expected });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, "missing-target:preview");
});

test("findManagedEnvIssues catches per-target divergence: fresh preview value cannot mask stale production value (R3 race)", () => {
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/new.mjs", type: "plain" },
  };
  const envs = [
    {
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/old.mjs",
      type: "plain",
      target: ["production"],
      updatedAt: 100,
    },
    {
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/new.mjs",
      type: "plain",
      target: ["preview"],
      updatedAt: 200,
    },
  ];
  // The deploy goes to production. If we collapse these into a synthesized
  // "freshest" entry the gate would pass — but production still serves the
  // stale value. Validation must be per-target.
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), [
    { key: "OPENCLAW_BUNDLE_URL", reason: "value-mismatch:production" },
  ]);
});

test("findManagedEnvIssues passes when both targets carry the expected value in separate entries", () => {
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/new.mjs", type: "plain" },
  };
  const envs = [
    {
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/new.mjs",
      type: "plain",
      target: ["production"],
      updatedAt: 200,
    },
    {
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/new.mjs",
      type: "plain",
      target: ["preview"],
      updatedAt: 200,
    },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), []);
});

test("findManagedEnvIssues per-target staleness: fresh preview + stale production fails for production only", () => {
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/y.mjs", type: "plain" },
  };
  // findManagedEnvIssues allows a 5-second clock-skew buffer, so use values
  // far enough apart that production's updatedAt is unambiguously stale.
  const startedAt = 1_000_000;
  const envs = [
    {
      // production is from before our upsert started, well outside the 5s
      // clock-skew buffer
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/y.mjs",
      type: "plain",
      target: ["production"],
      updatedAt: 100,
    },
    {
      // preview was just upserted
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/y.mjs",
      type: "plain",
      target: ["preview"],
      updatedAt: 1_000_500,
    },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected, startedAt }), [
    { key: "OPENCLAW_BUNDLE_URL", reason: "stale-timestamp:production" },
  ]);
});

test("findManagedEnvIssues picks the freshest entry per target when multiple cover the same target", () => {
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/y.mjs", type: "plain" },
  };
  const envs = [
    // Two entries both cover production+preview; pick the freshest for each.
    {
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/old.mjs",
      type: "plain",
      target: ["production", "preview"],
      updatedAt: 100,
    },
    {
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/y.mjs",
      type: "plain",
      target: ["production", "preview"],
      updatedAt: 200,
    },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), []);
});

test("findManagedEnvIssues flags type mismatch (expected sensitive but observed plain)", () => {
  const expected = {
    ADMIN_SECRET: { value: "abc", type: "sensitive" },
  };
  const envs = [
    {
      key: "ADMIN_SECRET",
      value: "wrong-old-value",
      type: "plain",
      target: TARGETS,
    },
  ];
  const issues = findManagedEnvIssues({ envs, expected });
  assert.equal(issues.length, 1);
  assert.match(issues[0].reason, /^type-mismatch:plain$/);
});

test("findManagedEnvIssues parses ISO-string timestamps", () => {
  const startedAt = Date.parse("2026-01-01T00:00:00Z");
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/y.mjs", type: "plain" },
  };
  const envs = [
    {
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/y.mjs",
      type: "plain",
      target: TARGETS,
      // Vercel sometimes returns ISO strings instead of epoch ms.
      updatedAt: "2026-01-01T00:00:01Z",
    },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected, startedAt }), []);
});

test("findManagedEnvIssues flags sensitive entry without fresh timestamp when startedAt is provided", () => {
  const expected = {
    ADMIN_SECRET: { value: "abc", type: "sensitive" },
  };
  // Sensitive entry exists with right key/target but no timestamp at all —
  // could be a leftover from a previous run with a different ADMIN_SECRET.
  const envs = [
    { key: "ADMIN_SECRET", value: "", type: "sensitive", target: TARGETS },
  ];
  const issues = findManagedEnvIssues({
    envs,
    expected,
    startedAt: Date.now(),
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, "sensitive-without-fresh-timestamp");
});

test("findManagedEnvIssues sensitive freshness check can be opted out", () => {
  const expected = {
    ADMIN_SECRET: { value: "abc", type: "sensitive" },
  };
  const envs = [
    { key: "ADMIN_SECRET", value: "", type: "sensitive", target: TARGETS },
  ];
  // When the caller can't get timestamps, opt out of the freshness gate.
  assert.deepEqual(
    findManagedEnvIssues({
      envs,
      expected,
      startedAt: Date.now(),
      requireFreshTimestampForSensitive: false,
    }),
    []
  );
});

test("findManagedEnvIssues rejects placeholder with surrounding whitespace", () => {
  const expected = { REDIS_URL: { value: "rediss://x", type: "plain" } };
  const envs = [
    {
      key: "REDIS_URL",
      value: "  database_provisioning_in_progress  ",
      type: "plain",
      target: TARGETS,
    },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected }), [
    { key: "REDIS_URL", reason: "placeholder" },
  ]);
});

test("findManagedEnvIssues flags entries with stale updatedAt before startedAt", () => {
  const startedAt = 1_000_000;
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/y.mjs", type: "plain" },
  };
  const envs = [
    {
      key: "OPENCLAW_BUNDLE_URL",
      value: "https://x/y.mjs",
      type: "plain",
      target: TARGETS,
      updatedAt: startedAt - 60_000,
    },
  ];
  assert.deepEqual(findManagedEnvIssues({ envs, expected, startedAt }), [
    { key: "OPENCLAW_BUNDLE_URL", reason: "stale-timestamp" },
  ]);
});

test("waitForManagedEnvVars resolves once round-trip is consistent", async () => {
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/y.mjs", type: "plain" },
  };
  const payloads = [
    [],
    [{ key: "OPENCLAW_BUNDLE_URL", value: "", type: "plain", target: TARGETS }],
    [makeEntry({ key: "OPENCLAW_BUNDLE_URL", value: "https://x/y.mjs", type: "plain" })],
  ];
  let attempts = 0;
  const result = await waitForManagedEnvVars({
    read: async () => payloads[attempts++] ?? payloads[payloads.length - 1],
    expected,
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 3);
});

test("waitForManagedEnvVars waits past placeholder until real value lands", async () => {
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/y.mjs", type: "plain" },
  };
  const payloads = [
    [makeEntry({ key: "OPENCLAW_BUNDLE_URL", value: "pending", type: "plain" })],
    [makeEntry({ key: "OPENCLAW_BUNDLE_URL", value: "https://x/y.mjs", type: "plain" })],
  ];
  let attempts = 0;
  const result = await waitForManagedEnvVars({
    read: async () => payloads[attempts++] ?? payloads[payloads.length - 1],
    expected,
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 2);
});

test("waitForManagedEnvVars times out and returns last issues", async () => {
  let currentTime = 0;
  const result = await waitForManagedEnvVars({
    read: async () => [],
    expected: { ADMIN_SECRET: { value: "abc", type: "sensitive" } },
    timeoutMs: 50,
    intervalMs: 10,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms;
    },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues, [{ key: "ADMIN_SECRET", reason: "missing" }]);
});

test("waitForManagedEnvVars survives transient read errors", async () => {
  const expected = {
    OPENCLAW_BUNDLE_URL: { value: "https://x/y.mjs", type: "plain" },
  };
  let calls = 0;
  const result = await waitForManagedEnvVars({
    read: async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return [
        makeEntry({
          key: "OPENCLAW_BUNDLE_URL",
          value: "https://x/y.mjs",
          type: "plain",
        }),
      ];
    },
    expected,
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.ready, true);
  assert.ok(calls >= 3);
});
