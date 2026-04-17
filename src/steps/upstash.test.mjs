import test from "node:test";
import assert from "node:assert/strict";
import {
  findMarketplacePrefix,
  hasUpstashEnvVars,
  waitForUpstashEnvs,
} from "./upstash.mjs";

test("hasUpstashEnvVars detects a fully provisioned Upstash environment", () => {
  assert.equal(
    hasUpstashEnvVars({
      envs: [
        { key: "UPSTASH_REDIS_REST_URL" },
        { key: "UPSTASH_REDIS_REST_TOKEN" },
      ],
    }),
    true
  );
});

test("hasUpstashEnvVars requires both Upstash keys", () => {
  assert.equal(
    hasUpstashEnvVars({
      envs: [{ key: "UPSTASH_REDIS_REST_URL" }],
    }),
    false
  );
});

test("hasUpstashEnvVars detects marketplace-prefixed KV vars", () => {
  assert.equal(
    hasUpstashEnvVars({
      envs: [
        { key: "VERCEL_OPENCLAW_7_KV_REST_API_URL" },
        { key: "VERCEL_OPENCLAW_7_KV_REST_API_TOKEN" },
        { key: "VERCEL_OPENCLAW_7_KV_URL" },
      ],
    }),
    true
  );
});

test("findMarketplacePrefix returns matched keys for marketplace layout", () => {
  const match = findMarketplacePrefix({
    envs: [
      { key: "VERCEL_OPENCLAW_7_KV_REST_API_URL" },
      { key: "VERCEL_OPENCLAW_7_KV_REST_API_TOKEN" },
    ],
  });
  assert.deepEqual(match, {
    url: "VERCEL_OPENCLAW_7_KV_REST_API_URL",
    token: "VERCEL_OPENCLAW_7_KV_REST_API_TOKEN",
  });
});

test("findMarketplacePrefix detects bare KV_REST_API_URL/TOKEN (late-2025 marketplace layout)", () => {
  const match = findMarketplacePrefix({
    envs: [
      { key: "KV_REST_API_URL" },
      { key: "KV_REST_API_TOKEN" },
      { key: "KV_URL" },
      { key: "REDIS_URL" },
      { key: "KV_REST_API_READ_ONLY_TOKEN" },
    ],
  });
  assert.deepEqual(match, {
    url: "KV_REST_API_URL",
    token: "KV_REST_API_TOKEN",
  });
});

test("hasUpstashEnvVars detects the bare marketplace layout", () => {
  assert.equal(
    hasUpstashEnvVars({
      envs: [{ key: "KV_REST_API_URL" }, { key: "KV_REST_API_TOKEN" }],
    }),
    true
  );
});

test("findMarketplacePrefix ignores orphaned _URL without matching _TOKEN", () => {
  assert.equal(
    findMarketplacePrefix({
      envs: [{ key: "VERCEL_OPENCLAW_6_KV_REST_API_URL" }],
    }),
    null
  );
});

test("waitForUpstashEnvs resolves once both keys appear", async () => {
  const payloads = [
    { envs: [] },
    { envs: [{ key: "UPSTASH_REDIS_REST_URL" }] },
    {
      envs: [
        { key: "UPSTASH_REDIS_REST_URL" },
        { key: "UPSTASH_REDIS_REST_TOKEN" },
      ],
    },
  ];
  let attempts = 0;
  const result = await waitForUpstashEnvs({
    read: async () => payloads[attempts++] ?? payloads[payloads.length - 1],
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result, true);
  assert.equal(attempts, 3);
});

test("waitForUpstashEnvs ignores transient errors and keeps polling", async () => {
  let calls = 0;
  const result = await waitForUpstashEnvs({
    read: async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return {
        envs: [
          { key: "UPSTASH_REDIS_REST_URL" },
          { key: "UPSTASH_REDIS_REST_TOKEN" },
        ],
      };
    },
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result, true);
  assert.ok(calls >= 3);
});

test("waitForUpstashEnvs times out when envs never appear", async () => {
  let currentTime = 0;
  const result = await waitForUpstashEnvs({
    read: async () => ({ envs: [] }),
    timeoutMs: 50,
    intervalMs: 10,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms;
    },
  });
  assert.equal(result, false);
});
