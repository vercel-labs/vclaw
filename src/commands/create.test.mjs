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
    result: { branch: "create", ok: true, configured: true, deliveryReady: true },
  });
  assert.equal(decision.kind, "ok");
});

test("evaluateSlackProvisioningOutcome: explicit Slack with credentials but no delivery readiness is fatal", () => {
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: true,
    result: {
      branch: "create",
      ok: true,
      configured: true,
      deliveryReady: false,
      diagnostics: {
        deliveryReady: false,
        routeReady: false,
        liveConfigFresh: false,
        readiness: {
          configSyncOutcome: "failed",
          reason: "Slack route did not become ready after config sync restart",
        },
      },
    },
  });
  assert.equal(decision.kind, "throw");
  assert.equal(decision.code, "explicit-delivery-not-ready");
  assert.match(decision.message, /Slack delivery is not ready/);
  assert.match(decision.message, /routeReady=false/);
  assert.match(decision.message, /Slack route did not become ready/);
});

test("evaluateSlackProvisioningOutcome: configured+connected without deliveryReady is soft-fail (warn) by default", () => {
  // The new degraded-mode path: gateway sync (liveConfigFresh) hasn't flipped
  // yet on a cold deploy, but credentials are saved and auth.test passed.
  // We must NOT fail the entire deploy — warn and continue.
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: true,
    result: {
      branch: "create",
      ok: true,
      configured: true,
      connected: true,
      deliveryReady: false,
      diagnostics: {
        deliveryReady: false,
        routeReady: false,
        liveConfigFresh: false,
      },
    },
  });
  assert.equal(decision.kind, "warn");
  assert.equal(decision.code, "delivery-pending");
  assert.match(decision.message, /delivery is still propagating/i);
  assert.match(decision.message, /VCLAW_STRICT_SLACK_DELIVERY/);
  assert.match(decision.message, /liveConfigFresh=false/);
});

test("evaluateSlackProvisioningOutcome: configured+connected without deliveryReady is fatal under strictDelivery", () => {
  // CI sets VCLAW_STRICT_SLACK_DELIVERY=1 to restore the old fail-closed behavior.
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: true,
    strictDelivery: true,
    result: {
      branch: "create",
      ok: true,
      configured: true,
      connected: true,
      deliveryReady: false,
      diagnostics: { deliveryReady: false, routeReady: false },
    },
  });
  assert.equal(decision.kind, "throw");
  assert.equal(decision.code, "explicit-delivery-not-ready");
});

test("evaluateSlackProvisioningOutcome: configured but never connected stays fatal (real auth failure, not propagation lag)", () => {
  // The hard-fail path must still fire when connected never flipped — that's
  // a real misconfiguration (bad bot token, auth.test failed), not a slow gateway.
  const decision = evaluateSlackProvisioningOutcome({
    slackExplicit: true,
    result: {
      branch: "create",
      ok: true,
      configured: true,
      connected: false,
      deliveryReady: false,
      diagnostics: { deliveryReady: false },
    },
  });
  assert.equal(decision.kind, "throw");
  assert.equal(decision.code, "explicit-delivery-not-ready");
});
