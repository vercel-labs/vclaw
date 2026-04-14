import test from "node:test";
import assert from "node:assert/strict";
import { hasUpstashEnvVars } from "./upstash.mjs";

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
