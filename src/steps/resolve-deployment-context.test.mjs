import test from "node:test";
import assert from "node:assert/strict";
import { resolveDeploymentContext } from "./resolve-deployment-context.mjs";

// resolveDeploymentContext touches the filesystem (.vercel/project.json) and
// the Vercel API. To test the verifiedUrl precedence we exercise the case
// where:
//   - no projectId/teamId is plumbed in (so we don't hit the Vercel env API)
//   - --url flag is absent
//   - admin secret is provided via flag (so we don't try to load it from env)
//
// Under those conditions the only URL source is the registry verifiedUrl,
// which proves the new path bypasses getProductionAlias() entirely.

test("resolveDeploymentContext prefers verifiedUrl over getProductionAlias when no --url", async () => {
  const ctx = await resolveDeploymentContext({
    dir: "/tmp/no-such-vclaw-dir",
    adminSecret: "admin-from-flag",
    verifiedUrl: "https://my-claw.example.app",
  });
  assert.equal(ctx.url, "https://my-claw.example.app");
  assert.equal(ctx.urlSource, "registry");
  assert.equal(ctx.adminSecret, "admin-from-flag");
});

test("resolveDeploymentContext: --url overrides verifiedUrl from registry", async () => {
  const ctx = await resolveDeploymentContext({
    dir: "/tmp/no-such-vclaw-dir",
    url: "https://override.example.app",
    adminSecret: "admin-from-flag",
    verifiedUrl: "https://stale-from-registry.example.app",
  });
  assert.equal(ctx.url, "https://override.example.app");
  assert.equal(ctx.urlSource, "flag");
});

test("resolveDeploymentContext: throws when no URL source is available", async () => {
  await assert.rejects(
    () =>
      resolveDeploymentContext({
        dir: "/tmp/no-such-vclaw-dir",
        adminSecret: "admin-from-flag",
        // no urlFlag, no verifiedUrl, no projectId
      }),
    /Could not resolve a deployment URL/,
  );
});
