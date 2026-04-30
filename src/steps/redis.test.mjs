import test from "node:test";
import assert from "node:assert/strict";
import {
  findAnyRedisResource,
  findReadyRedisResource,
  findRedisEnvKey,
  hasRedisEnvVars,
  waitForRedisEnvs,
  waitForRedisResource,
} from "./redis.mjs";

const REDIS_URL = "rediss://default:abc@example.upstash.io:6379";
const KV_URL = "redis://default:def@kv.example.com:6379";

test("hasRedisEnvVars detects REDIS_URL with resolved redis:// value", () => {
  assert.equal(
    hasRedisEnvVars({ envs: [{ key: "REDIS_URL", value: REDIS_URL }] }),
    true
  );
});

test("hasRedisEnvVars detects KV_URL alias with resolved value", () => {
  assert.equal(
    hasRedisEnvVars({ envs: [{ key: "KV_URL", value: KV_URL }] }),
    true
  );
});

test("hasRedisEnvVars detects Redis integration-store secret entries", () => {
  assert.equal(
    hasRedisEnvVars({
      envs: [
        {
          key: "REDIS_URL",
          type: "encrypted",
          value: "encrypted-store-reference",
          contentHint: { type: "integration-store-secret" },
        },
      ],
    }),
    true
  );
});

test("findRedisEnvKey waits for fresh Redis integration-store secret entries to settle", () => {
  const now = () => 120_000;
  const entry = {
    key: "REDIS_URL",
    type: "encrypted",
    value: "encrypted-store-reference",
    contentHint: { type: "integration-store-secret" },
    updatedAt: 90_000,
  };

  assert.equal(findRedisEnvKey({ envs: [entry] }, { now }), null);
  assert.equal(
    findRedisEnvKey(
      { envs: [{ ...entry, updatedAt: 50_000 }] },
      { now },
    ),
    "REDIS_URL",
  );
});

test("hasRedisEnvVars rejects placeholder value while marketplace is provisioning", () => {
  assert.equal(
    hasRedisEnvVars({
      envs: [{ key: "REDIS_URL", value: "database_provisioning_in_progress" }],
    }),
    false
  );
});

test("hasRedisEnvVars rejects placeholder integration-store secret entries", () => {
  assert.equal(
    hasRedisEnvVars({
      envs: [
        {
          key: "REDIS_URL",
          type: "encrypted",
          value: "database_provisioning_in_progress",
          contentHint: { type: "integration-store-secret" },
        },
      ],
    }),
    false
  );
});

test("hasRedisEnvVars rejects empty/missing values", () => {
  assert.equal(hasRedisEnvVars({ envs: [{ key: "REDIS_URL" }] }), false);
  assert.equal(hasRedisEnvVars({ envs: [{ key: "REDIS_URL", value: "" }] }), false);
});

test("findRedisEnvKey prefers REDIS_URL when both have resolved values", () => {
  assert.equal(
    findRedisEnvKey({
      envs: [
        { key: "KV_URL", value: KV_URL },
        { key: "REDIS_URL", value: REDIS_URL },
      ],
    }),
    "REDIS_URL"
  );
});

test("findRedisEnvKey falls through to KV_URL when REDIS_URL is still a placeholder", () => {
  assert.equal(
    findRedisEnvKey({
      envs: [
        { key: "REDIS_URL", value: "database_provisioning_in_progress" },
        { key: "KV_URL", value: KV_URL },
      ],
    }),
    "KV_URL"
  );
});

test("hasRedisEnvVars returns false when neither key is present", () => {
  assert.equal(
    hasRedisEnvVars({
      envs: [
        { key: "UPSTASH_REDIS_REST_URL", value: "https://example.upstash.io" },
        { key: "UPSTASH_REDIS_REST_TOKEN", value: "tok" },
        { key: "KV_REST_API_URL", value: "https://example.upstash.io" },
        { key: "KV_REST_API_TOKEN", value: "tok" },
      ],
    }),
    false
  );
});

test("hasRedisEnvVars handles missing envs array", () => {
  assert.equal(hasRedisEnvVars({}), false);
  assert.equal(hasRedisEnvVars(null), false);
});

test("waitForRedisEnvs waits past placeholder until resolved redis:// URL appears", async () => {
  const payloads = [
    { envs: [] },
    { envs: [{ key: "KV_REST_API_URL", value: "https://example.upstash.io" }] },
    { envs: [{ key: "REDIS_URL", value: "database_provisioning_in_progress" }] },
    { envs: [{ key: "REDIS_URL", value: REDIS_URL }] },
  ];
  let attempts = 0;
  const result = await waitForRedisEnvs({
    read: async () => payloads[attempts++] ?? payloads[payloads.length - 1],
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result, true);
  assert.equal(attempts, 4);
});

test("waitForRedisEnvs waits for integration-store secret entries to settle", async () => {
  let currentTime = 0;
  let attempts = 0;
  const result = await waitForRedisEnvs({
    read: async () => {
      attempts += 1;
      return {
        envs: [
          {
            key: "REDIS_URL",
            type: "encrypted",
            value: "encrypted-store-reference",
            contentHint: { type: "integration-store-secret" },
            updatedAt: 1,
          },
        ],
      };
    },
    timeoutMs: 90_000,
    intervalMs: 10_000,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms;
    },
  });

  assert.equal(result, true);
  assert.equal(attempts, 8);
});

test("waitForRedisEnvs ignores transient errors and keeps polling", async () => {
  let calls = 0;
  const result = await waitForRedisEnvs({
    read: async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return { envs: [{ key: "REDIS_URL", value: REDIS_URL }] };
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

test("findReadyRedisResource returns the available resource", () => {
  const payload = {
    resources: [
      { id: "store_a", status: "provisioning", product: "Redis" },
      { id: "store_b", status: "available", product: "Redis", name: "redis-1" },
    ],
  };
  const ready = findReadyRedisResource(payload);
  assert.equal(ready?.id, "store_b");
});

test("findReadyRedisResource returns null when nothing is available", () => {
  const payload = {
    resources: [{ id: "store_a", status: "provisioning", product: "Redis" }],
  };
  assert.equal(findReadyRedisResource(payload), null);
});

test("findReadyRedisResource handles empty/missing resources", () => {
  assert.equal(findReadyRedisResource({}), null);
  assert.equal(findReadyRedisResource({ resources: [] }), null);
  assert.equal(findReadyRedisResource(null), null);
});

test("findAnyRedisResource returns the first resource regardless of status", () => {
  const payload = {
    resources: [
      { id: "store_a", status: "provisioning", product: "Redis" },
      { id: "store_b", status: "available", product: "Redis" },
    ],
  };
  assert.equal(findAnyRedisResource(payload)?.id, "store_a");
});

test("waitForRedisResource resolves once status becomes available", async () => {
  let attempt = 0;
  const result = await waitForRedisResource({
    read: async () => {
      attempt += 1;
      if (attempt < 3) {
        return { resources: [{ id: "store_a", status: "provisioning", product: "Redis" }] };
      }
      return { resources: [{ id: "store_a", status: "available", product: "Redis", name: "ready" }] };
    },
    timeoutMs: 1000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result?.status, "available");
  assert.equal(result?.name, "ready");
});

test("waitForRedisResource ignores transient errors and keeps polling", async () => {
  let attempt = 0;
  const observedAttempts = [];
  const result = await waitForRedisResource({
    read: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return { resources: [{ id: "store_a", status: "available", product: "Redis" }] };
    },
    timeoutMs: 1000,
    intervalMs: 0,
    sleep: async () => {},
    onTick: (n, observed) => {
      observedAttempts.push({ n, observed });
    },
  });
  assert.equal(result?.id, "store_a");
  // First attempt errored — onTick should report the error.
  assert.ok(observedAttempts[0]?.observed?.error?.includes("network down"));
});

test("waitForRedisResource times out when resource never becomes available", async () => {
  let currentTime = 0;
  const result = await waitForRedisResource({
    read: async () => ({ resources: [{ id: "store_a", status: "provisioning", product: "Redis" }] }),
    timeoutMs: 50,
    intervalMs: 10,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms;
    },
  });
  assert.equal(result, null);
});
