import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  create,
  evaluateSlackProvisioningOutcome,
  shouldInvokeSlackProvisioning,
} from "./create.mjs";

function createNoopDeps(overrides = {}) {
  return {
    checkPrereqs: async () => {},
    resolveScope: async () => {
      throw new Error("scope should be provided");
    },
    readVercelToken: () => "token-test",
    getTeamBySlug: async () => ({ id: "team_test" }),
    getUser: async () => null,
    setActiveTeam: () => true,
    findAvailableProjectName: async () => ({ name: "vercel-openclaw-52", baseTaken: true }),
    findAvailableFriendlyProjectName: async () => ({ name: "openclaw-bright-anchor", baseTaken: false }),
    cloneRepo: async (dir) => dir,
    linkProject: async () => ({ projectId: "prj_test", teamId: "team_test" }),
    provisionRedis: async () => {},
    configureProjectProtection: async () => ({
      protectionBypassSecret: null,
      protectionFreshlyApplied: false,
    }),
    getProject: async () => ({ targets: { production: { alias: [] } } }),
    readProtectionState: () => ({ enabled: false, activeTypes: [] }),
    ensureAutomationBypassSecret: async () => ({ secret: null, created: false }),
    resolveCreateBundleUrl: async () => undefined,
    pushEnvVars: async () => {},
    writeLocalDebugEnv: () => ({ envPath: ".env.local", keys: [] }),
    deploy: async () => {
      throw new Error("deploy should be skipped");
    },
    readLinkedProject: () => ({ projectId: "prj_test", teamId: "team_test" }),
    waitForDeploymentReady: async () => ({ ready: true }),
    getDeployment: async () => ({}),
    getProductionAlias: async () => null,
    runVerify: async () => {},
    connectTelegram: async () => ({ ok: true }),
    provisionSlack: async () => ({ branch: "skip", ok: true, configured: false }),
    registerClaw: () => {},
    writeManagedWorkspaceMetadata: () => {},
    openInBrowser: () => {},
    ...overrides,
  };
}

test("create --auto-project-name accepts a friendly available project name without --yes", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "vclaw-auto-project-name-"));
  let linkedName;
  let envProjectName;

  await create(
    [
      "--scope",
      "vercel-internal-playground",
      "--dir",
      projectDir,
      "--skip-clone",
      "--skip-redis",
      "--skip-deploy",
      "--admin-secret",
      "vercel-admin-secret",
      "--no-bundle",
      "--auto-project-name",
    ],
    createNoopDeps({
      linkProject: async (_dir, name) => {
        linkedName = name;
        return { projectId: "prj_test", teamId: "team_test" };
      },
      pushEnvVars: async (_dir, vars) => {
        envProjectName = vars.VCLAW_PROJECT_NAME.value;
      },
    }),
  );

  assert.equal(linkedName, "openclaw-bright-anchor");
  assert.equal(envProjectName, "openclaw-bright-anchor");
});


test("create --auto-link writes local debug env after pushing managed env vars", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "vclaw-auto-link-"));
  let wroteVars;

  await create(
    [
      "--scope",
      "vercel-internal-playground",
      "--dir",
      projectDir,
      "--skip-clone",
      "--skip-redis",
      "--skip-deploy",
      "--admin-secret",
      "vercel-admin-secret",
      "--protection-bypass-secret",
      "bypass-secret",
      "--no-bundle",
      "--auto-link",
      "--auto-project-name",
    ],
    createNoopDeps({
      configureProjectProtection: async () => ({
        protectionBypassSecret: "bypass-secret",
        protectionFreshlyApplied: false,
      }),
      writeLocalDebugEnv: (_dir, vars) => {
        wroteVars = vars;
        return { envPath: join(projectDir, ".env.local"), keys: Object.keys(vars) };
      },
    }),
  );

  assert.equal(wroteVars.ADMIN_SECRET.value, "vercel-admin-secret");
  assert.equal(wroteVars.VERCEL_AUTOMATION_BYPASS_SECRET.value, "bypass-secret");
  assert.equal(wroteVars.VCLAW_PROJECT_NAME.value, "openclaw-bright-anchor");
});


test("create --slack-bot-name forwards botName to Slack create provisioning", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "vclaw-slack-bot-name-"));
  let provisionArgs;

  await create(
    [
      "--scope",
      "vercel-internal-playground",
      "--dir",
      projectDir,
      "--skip-clone",
      "--skip-redis",
      "--admin-secret",
      "vercel-admin-secret",
      "--no-bundle",
      "--auto-project-name",
      "--slack-config-token",
      "xoxe.xoxp-config",
      "--slack-app-name",
      "OpenClaw Support",
      "--slack-bot-name",
      "support-bot",
    ],
    createNoopDeps({
      deploy: async () => "https://openclaw.example",
      provisionSlack: async (_url, _adminSecret, args) => {
        provisionArgs = args;
        return {
          branch: "create",
          ok: true,
          configured: true,
          connected: true,
          deliveryReady: true,
        };
      },
    }),
  );

  assert.equal(provisionArgs.appName, "OpenClaw Support");
  assert.equal(provisionArgs.botName, "support-bot");
});

test("create rejects --name with --auto-project-name", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "vclaw-auto-project-conflict-"));
  await assert.rejects(
    create(
      [
        "--scope",
        "vercel-internal-playground",
        "--dir",
        projectDir,
        "--skip-clone",
        "--skip-redis",
        "--skip-deploy",
        "--admin-secret",
        "vercel-admin-secret",
        "--name",
        "vercel-openclaw-explicit",
        "--auto-project-name",
      ],
      createNoopDeps(),
    ),
    /Pass only one of --name or --auto-project-name/,
  );
});

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
