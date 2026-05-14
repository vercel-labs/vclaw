import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_OPENCLAW_BUNDLE_REPO,
  OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE,
  REQUIRED_BUNDLE_ASSETS,
  REQUIRED_MANIFEST_RECORDED_ASSETS,
  REQUIRED_BUNDLE_METADATA_ASSETS,
  REQUIRED_RUNTIME_BUNDLE_ASSETS,
  selectLatestCompatibleBundleRelease,
  validateAssetManifestForBundleResolver,
} from "./bundle.mjs";

test("automatic bundle resolution uses the official OpenClaw bundle repo", () => {
  assert.equal(OFFICIAL_OPENCLAW_BUNDLE_REPO, "vercel-labs/openclaw");
});

test("REQUIRED_BUNDLE_ASSETS tracks vercel-openclaw bundle bootstrap sidecars", () => {
  assert.deepEqual(REQUIRED_RUNTIME_BUNDLE_ASSETS, [
    "openclaw.bundle.mjs",
    "channel-catalog.json",
    "workspace-templates.tar.gz",
    "channels.tar.gz",
    "bundle-deps.tar.gz",
    "bundle-openclaw-pkg.tar.gz",
    "control-ui.tar.gz",
  ]);
  assert.deepEqual(REQUIRED_BUNDLE_ASSETS, REQUIRED_RUNTIME_BUNDLE_ASSETS);
  assert.deepEqual(REQUIRED_BUNDLE_METADATA_ASSETS, [
    "asset-manifest.json",
    "bundle-contract.json",
    "release.json",
    "checksums.sha256",
  ]);
  assert.deepEqual(REQUIRED_MANIFEST_RECORDED_ASSETS, [
    ...REQUIRED_RUNTIME_BUNDLE_ASSETS,
    "bundle-contract.json",
    "release.json",
  ]);
});

function asset(name) {
  return { name, browser_download_url: `https://example.test/${name}` };
}

function manifest(assetNames = REQUIRED_MANIFEST_RECORDED_ASSETS) {
  return {
    schemaVersion: 1,
    name: "openclaw-sandbox-bundle",
    profile: "sandbox",
    assets: Object.fromEntries(
      assetNames.map((name) => [name, { role: name, bytes: 1, sha256: "a".repeat(64) }]),
    ),
  };
}

test("validateAssetManifestForBundleResolver accepts the existing OpenClaw release manifest boundary", () => {
  const assetNames = [...REQUIRED_RUNTIME_BUNDLE_ASSETS, ...REQUIRED_BUNDLE_METADATA_ASSETS];
  const releaseManifest = manifest();
  const result = validateAssetManifestForBundleResolver(releaseManifest, assetNames);

  assert.equal(result.ok, true);
  assert.equal(releaseManifest.assets["asset-manifest.json"], undefined);
  assert.equal(releaseManifest.assets["checksums.sha256"], undefined);
});

test("validateAssetManifestForBundleResolver rejects releases missing checksum sidecar", () => {
  const assetNames = [...REQUIRED_RUNTIME_BUNDLE_ASSETS, ...REQUIRED_BUNDLE_METADATA_ASSETS].filter(
    (name) => name !== "checksums.sha256",
  );
  const result = validateAssetManifestForBundleResolver(manifest(), assetNames);

  assert.equal(result.ok, false);
  assert.equal(result.issue.reason, "required-asset-missing");
  assert.equal(result.issue.detail, "GitHub release lacks checksums.sha256");
});

test("validateAssetManifestForBundleResolver rejects malformed manifests with shared error code", () => {
  const result = validateAssetManifestForBundleResolver({ schemaVersion: 2 });

  assert.equal(result.ok, false);
  assert.equal(result.issue.code, OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE);
  assert.equal(result.issue.reason, "schema-version");
});

test("selectLatestCompatibleBundleRelease skips drafts and incomplete releases", () => {
  const completeAssets = REQUIRED_RUNTIME_BUNDLE_ASSETS.map(asset);
  const selected = selectLatestCompatibleBundleRelease({
    repo: OFFICIAL_OPENCLAW_BUNDLE_REPO,
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
  assert.equal(selected.repo, OFFICIAL_OPENCLAW_BUNDLE_REPO);
  assert.equal(selected.url, "https://example.test/openclaw.bundle.mjs");
  assert.equal(selected.compatibilitySource, "legacy-asset-list");
  assert.equal(selected.compatibilityWarnings[0].reason, "manifest-missing");
  assert.deepEqual(selected.assetNames, [...REQUIRED_RUNTIME_BUNDLE_ASSETS].sort());
});

test("selectLatestCompatibleBundleRelease selects manifest-backed releases", () => {
  const names = [...REQUIRED_RUNTIME_BUNDLE_ASSETS, ...REQUIRED_BUNDLE_METADATA_ASSETS];
  const selected = selectLatestCompatibleBundleRelease({
    repo: OFFICIAL_OPENCLAW_BUNDLE_REPO,
    releases: [
      {
        draft: false,
        tag_name: "v-manifest",
        published_at: "2026-05-05T00:00:00Z",
        assets: names.map((name) => ({
          ...asset(name),
          content: name === "asset-manifest.json" ? manifest() : undefined,
        })),
      },
    ],
  });

  assert.equal(selected.tag, "v-manifest");
  assert.equal(selected.compatibilitySource, "asset-manifest");
  assert.equal(selected.compatibilityWarnings[0].reason, "optional-asset-missing");
});

test("selectLatestCompatibleBundleRelease rejects manifest releases missing actual assets", () => {
  const names = [...REQUIRED_RUNTIME_BUNDLE_ASSETS, ...REQUIRED_BUNDLE_METADATA_ASSETS];
  const selected = selectLatestCompatibleBundleRelease({
    repo: OFFICIAL_OPENCLAW_BUNDLE_REPO,
    releases: [
      {
        draft: false,
        tag_name: "v-bad-manifest",
        published_at: "2026-05-05T00:00:00Z",
        assets: names
          .filter((name) => name !== "control-ui.tar.gz")
          .map((name) => ({
            ...asset(name),
            content: name === "asset-manifest.json" ? manifest() : undefined,
          })),
      },
    ],
  });

  assert.equal(selected, null);
});

test("selectLatestCompatibleBundleRelease keeps legacy fallback for releases without manifest", () => {
  const selected = selectLatestCompatibleBundleRelease({
    repo: OFFICIAL_OPENCLAW_BUNDLE_REPO,
    releases: [
      {
        draft: false,
        tag_name: "v-legacy",
        published_at: "2026-05-05T00:00:00Z",
        assets: REQUIRED_RUNTIME_BUNDLE_ASSETS.map(asset),
      },
    ],
  });

  assert.equal(selected.tag, "v-legacy");
  assert.equal(selected.compatibilitySource, "legacy-asset-list");
  assert.equal(selected.compatibilityWarnings[0].reason, "manifest-missing");
});
