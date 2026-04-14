import test from "node:test";
import assert from "node:assert/strict";
import { resolveProtectionPlan } from "./protection.mjs";

test("resolveProtectionPlan leaves protection disabled by default", () => {
  const plan = resolveProtectionPlan();
  assert.deepEqual(plan, {
    mode: "none",
    enableBypass: false,
    bypassSecret: undefined,
  });
});

test("resolveProtectionPlan generates a bypass secret when protection is enabled", () => {
  const plan = resolveProtectionPlan("sso");
  assert.equal(plan.mode, "sso");
  assert.equal(plan.enableBypass, true);
  assert.match(plan.bypassSecret, /^[a-f0-9]{48}$/);
});

test("resolveProtectionPlan preserves an explicit bypass secret", () => {
  const plan = resolveProtectionPlan("none", "my-secret");
  assert.deepEqual(plan, {
    mode: "none",
    enableBypass: true,
    bypassSecret: "my-secret",
  });
});
