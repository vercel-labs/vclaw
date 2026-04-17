import test from "node:test";
import assert from "node:assert/strict";
import {
  findRedisEnvKey,
  hasRedisEnvVars,
  waitForRedisEnvs,
} from "./redis.mjs";

test("hasRedisEnvVars detects REDIS_URL", () => {
  assert.equal(
    hasRedisEnvVars({ envs: [{ key: "REDIS_URL" }] }),
    true
  );
});

test("hasRedisEnvVars detects KV_URL alias", () => {
  assert.equal(
    hasRedisEnvVars({ envs: [{ key: "KV_URL" }] }),
    true
  );
});

test("hasRedisEnvVars prefers REDIS_URL when both present", () => {
  assert.equal(
    findRedisEnvKey({
      envs: [{ key: "KV_URL" }, { key: "REDIS_URL" }],
    }),
    "REDIS_URL"
  );
});

test("hasRedisEnvVars returns false when neither key is present", () => {
  assert.equal(
    hasRedisEnvVars({
      envs: [
        { key: "UPSTASH_REDIS_REST_URL" },
        { key: "UPSTASH_REDIS_REST_TOKEN" },
        { key: "KV_REST_API_URL" },
        { key: "KV_REST_API_TOKEN" },
      ],
    }),
    false
  );
});

test("hasRedisEnvVars handles missing envs array", () => {
  assert.equal(hasRedisEnvVars({}), false);
  assert.equal(hasRedisEnvVars(null), false);
});

test("waitForRedisEnvs resolves once REDIS_URL appears", async () => {
  const payloads = [
    { envs: [] },
    { envs: [{ key: "KV_REST_API_URL" }] },
    { envs: [{ key: "REDIS_URL" }] },
  ];
  let attempts = 0;
  const result = await waitForRedisEnvs({
    read: async () => payloads[attempts++] ?? payloads[payloads.length - 1],
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result, true);
  assert.equal(attempts, 3);
});

test("waitForRedisEnvs ignores transient errors and keeps polling", async () => {
  let calls = 0;
  const result = await waitForRedisEnvs({
    read: async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return { envs: [{ key: "REDIS_URL" }] };
    },
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result, true);
  assert.ok(calls >= 3);
});

test("waitForRedisEnvs times out when envs never appear", async () => {
  let currentTime = 0;
  const result = await waitForRedisEnvs({
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
