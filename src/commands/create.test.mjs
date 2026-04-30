import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSlackProvisioningOutcome,
  shouldInvokeSlackProvisioning,
} from "./create.mjs";

test("shouldInvokeSlackProvisioning skips Slack when no Slack flag was passed", () => {
  assert.equal(
    shouldInvokeSlackProvisioning({
      preselectedBranch: null,
      slackRequested: false,
    }),
    false,
  );
});

test("shouldInvokeSlackProvisioning runs Slack for explicit Slack requests", () => {
  assert.equal(
    shouldInvokeSlackProvisioning({
      preselectedBranch: null,
      slackRequested: true,
    }),
    true,
  );
  assert.equal(
    shouldInvokeSlackProvisioning({
      preselectedBranch: "create",
      slackRequested: false,
    }),
    true,
  );
});

test("evaluateSlackProvisioningOutcome: explicit --slack with no creds and no prompt is fatal (R4 silent-skip)", () => {
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: true,
    result: { branch: "skip", ok: true, configured: false },
  });
  assert.equal(decision.kind, "throw");
  assert.equal(decision.code, "explicit-skip");
  assert.match(decision.message, /no usable credentials/i);
});

test("evaluateSlackProvisioningOutcome: non-explicit skip is silently OK", () => {
  // Interactive user picked 'skip' from the menu — that's a deliberate choice.
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: false,
    result: { branch: "skip", ok: true, configured: false },
  });
  assert.equal(decision.kind, "ok");
});

test("evaluateSlackProvisioningOutcome: explicit branch !== skip with ok:false is fatal", () => {
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: true,
    result: { branch: "connect", ok: false, configured: false },
  });
  assert.equal(decision.kind, "throw");
  assert.equal(decision.code, "explicit-not-ok");
});

test("evaluateSlackProvisioningOutcome: non-explicit branch !== skip with ok:false warns", () => {
  // Interactive user attempted connect, server rejected — keep going.
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: false,
    result: { branch: "connect", ok: false, configured: false },
  });
  assert.equal(decision.kind, "warn");
});

test("evaluateSlackProvisioningOutcome: explicit create branch with ok:true / configured:false is fatal (OAuth never finished)", () => {
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: true,
    result: { branch: "create", ok: true, configured: false },
  });
  assert.equal(decision.kind, "throw");
  assert.equal(decision.code, "explicit-not-configured");
  assert.match(decision.message, /OAuth did not finish/i);
});

test("evaluateSlackProvisioningOutcome: success returns ok", () => {
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: true,
    result: { branch: "create", ok: true, configured: true },
  });
  assert.equal(decision.kind, "ok");
});
