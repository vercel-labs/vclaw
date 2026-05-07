import test from "node:test";
import assert from "node:assert/strict";
import {
  githubRepoFromRemoteUrl,
  REQUIRED_BUNDLE_ASSETS,
  selectLatestCompatibleBundleRelease,
} from "./bundle.mjs";

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

test("selectLatestCompatibleBundleRelease skips drafts and incomplete releases", () => {
  const completeAssets = REQUIRED_BUNDLE_ASSETS.map((name) => ({
    name,
    browser_download_url: `https://example.test/${name}`,
  }));
  const selected = selectLatestCompatibleBundleRelease({
    repo: "vercel-labs/openclaw-sandbox",
    releases: [
      {
        draft: true,
        tag_name: "v-draft",
        published_at: "2026-05-05T00:00:00Z",
        assets: completeAssets,
      },
      {
        draft: false,
        tag_name: "v-incomplete",
        published_at: "2026-05-04T00:00:00Z",
        assets: completeAssets.filter((asset) => asset.name !== "control-ui.tar.gz"),
      },
      {
        draft: false,
        tag_name: "v-compatible",
        published_at: "2026-05-03T00:00:00Z",
        assets: completeAssets,
      },
    ],
  });

  assert.equal(selected.tag, "v-compatible");
  assert.equal(selected.repo, "vercel-labs/openclaw-sandbox");
  assert.equal(selected.url, "https://example.test/openclaw.bundle.mjs");
  assert.deepEqual(selected.assetNames, [...REQUIRED_BUNDLE_ASSETS].sort());
});
