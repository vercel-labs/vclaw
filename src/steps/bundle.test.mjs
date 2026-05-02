import test from "node:test";
import assert from "node:assert/strict";
import { githubRepoFromRemoteUrl, REQUIRED_BUNDLE_ASSETS } from "./bundle.mjs";

test("githubRepoFromRemoteUrl parses git@github.com remotes", () => {
  assert.equal(
    githubRepoFromRemoteUrl("git@github.com:vercel-labs/openclaw-sandbox.git"),
    "vercel-labs/openclaw-sandbox",
  );
});

test("githubRepoFromRemoteUrl parses https GitHub remotes", () => {
  assert.equal(
    githubRepoFromRemoteUrl("https://github.com/openclaw/openclaw.git"),
    "openclaw/openclaw",
  );
});

test("githubRepoFromRemoteUrl ignores non-GitHub remotes", () => {
  assert.equal(githubRepoFromRemoteUrl("git://100.115.163.9/openclaw"), null);
});

test("REQUIRED_BUNDLE_ASSETS tracks vercel-openclaw bundle bootstrap sidecars", () => {
  assert.deepEqual(REQUIRED_BUNDLE_ASSETS, [
    "openclaw.bundle.mjs",
    "channel-catalog.json",
    "workspace-templates.tar.gz",
    "channels.tar.gz",
    "bundle-deps.tar.gz",
    "bundle-openclaw-pkg.tar.gz",
    "channel-shared-chunks.tar.gz",
    "control-ui.tar.gz",
  ]);
});
