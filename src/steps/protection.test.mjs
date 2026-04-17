import test from "node:test";
import assert from "node:assert/strict";
import { resolveProtectionPlan } from "./protection.mjs";

test("resolveProtectionPlan leaves protection disabled by default", () => {
  const plan = resolveProtectionPlan();
  assert.deepEqual(plan, {
    mode: "none",
    enableBypass: false,
    providedBypassSecret: undefined,
  });
});

test("resolveProtectionPlan enables bypass when protection is set", () => {
  const plan = resolveProtectionPlan("sso");
  assert.equal(plan.mode, "sso");
  assert.equal(plan.enableBypass, true);
  assert.equal(plan.providedBypassSecret, undefined);
});

test("resolveProtectionPlan preserves an explicit bypass secret hint", () => {
  const plan = resolveProtectionPlan("none", "my-secret");
  assert.deepEqual(plan, {
    mode: "none",
    enableBypass: true,
    providedBypassSecret: "my-secret",
  });
});
