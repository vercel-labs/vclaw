import { exec } from "../shell.mjs";
import { dim, success, warn } from "../ui.mjs";

export const OFFICIAL_OPENCLAW_BUNDLE_REPO = "vercel-labs/openclaw";
export const BUNDLE_ASSET_NAME = "openclaw.bundle.mjs";
export const OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE =
  "OPENCLAW_BUNDLE_COMPATIBILITY_MISMATCH";
export const REQUIRED_RUNTIME_BUNDLE_ASSETS = [
  BUNDLE_ASSET_NAME,
  "channel-catalog.json",
  "workspace-templates.tar.gz",
  "channels.tar.gz",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "control-ui.tar.gz",
];
export const REQUIRED_BUNDLE_METADATA_ASSETS = [
  "asset-manifest.json",
  "bundle-contract.json",
  "release.json",
  "checksums.sha256",
];
export const REQUIRED_MANIFEST_RECORDED_ASSETS = [
  ...REQUIRED_RUNTIME_BUNDLE_ASSETS,
  "bundle-contract.json",
  "release.json",
];
export const OPTIONAL_BUNDLE_ASSETS = ["channel-shared-chunks.tar.gz"];
export const REQUIRED_BUNDLE_ASSETS = REQUIRED_RUNTIME_BUNDLE_ASSETS;

async function fetchJson(url) {
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    const ghToken = await exec("gh", ["auth", "token"]);
    if (ghToken.code === 0 && ghToken.stdout.trim()) {
      token = ghToken.stdout.trim();
    }
  }
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "vclaw-bundle-resolver",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${url}${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

function issue(reason, detail) {
  return { code: OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE, reason, detail };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateAssetManifestForBundleResolver(manifest, availableAssetNames = []) {
  if (!isObject(manifest)) {
    return { ok: false, issue: issue("invalid-json", "asset-manifest.json must be an object") };
  }
  if (manifest.schemaVersion !== 1) {
    return {
      ok: false,
      issue: issue("schema-version", "asset-manifest.json schemaVersion must be 1"),
    };
  }
  if (manifest.name !== "openclaw-sandbox-bundle" || manifest.profile !== "sandbox") {
    return {
      ok: false,
      issue: issue("name-profile", "asset-manifest.json must describe the sandbox bundle"),
    };
  }
  if (!isObject(manifest.assets)) {
    return { ok: false, issue: issue("assets-missing", "asset-manifest.json lacks assets") };
  }

  const availableAssets = new Set(availableAssetNames);
  for (const assetName of [...REQUIRED_RUNTIME_BUNDLE_ASSETS, ...REQUIRED_BUNDLE_METADATA_ASSETS]) {
    if (availableAssets.size > 0 && !availableAssets.has(assetName)) {
      return {
        ok: false,
        issue: issue("required-asset-missing", `GitHub release lacks ${assetName}`),
      };
    }
  }

  for (const assetName of REQUIRED_MANIFEST_RECORDED_ASSETS) {
    const record = manifest.assets[assetName];
    if (!isObject(record)) {
      return {
        ok: false,
        issue: issue("required-asset-missing", `asset-manifest.json lacks assets.${assetName}`),
      };
    }
    if (typeof record.bytes !== "number" || record.bytes <= 0 || typeof record.sha256 !== "string") {
      return {
        ok: false,
        issue: issue("asset-record-invalid", `asset-manifest.json has invalid record for ${assetName}`),
      };
    }
  }

  const warnings = [];
  for (const assetName of OPTIONAL_BUNDLE_ASSETS) {
    if (!manifest.assets[assetName]) {
      warnings.push({ reason: "optional-asset-missing", detail: `${assetName} is absent` });
    }
  }
  return { ok: true, warnings };
}

export function selectLatestCompatibleBundleRelease({ repo, releases }) {
  if (!Array.isArray(releases)) return null;

  for (const release of releases) {
    if (release?.draft) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const assetByName = new Map(
      assets
        .filter((a) => a?.name && a?.browser_download_url)
        .map((a) => [a.name, a]),
    );
    const manifestAsset = assetByName.get("asset-manifest.json");
    if (manifestAsset) {
      const manifestResult = validateAssetManifestForBundleResolver(
        manifestAsset.content,
        [...assetByName.keys()],
      );
      if (!manifestResult.ok) continue;
      const asset = assetByName.get(BUNDLE_ASSET_NAME);
      return {
        repo,
        tag: release.tag_name,
        publishedAt: release.published_at || release.created_at || "",
        url: asset.browser_download_url,
        assetNames: [...assetByName.keys()].sort((a, b) => a.localeCompare(b)),
        compatibilitySource: "asset-manifest",
        compatibilityWarnings: manifestResult.warnings ?? [],
      };
    }

    const missingAssets = REQUIRED_RUNTIME_BUNDLE_ASSETS.filter((name) => !assetByName.has(name));
    if (missingAssets.length > 0) continue;
    const asset = assetByName.get(BUNDLE_ASSET_NAME);
    return {
      repo,
      tag: release.tag_name,
      publishedAt: release.published_at || release.created_at || "",
      url: asset.browser_download_url,
      assetNames: [...assetByName.keys()].sort((a, b) => a.localeCompare(b)),
      compatibilitySource: "legacy-asset-list",
      compatibilityWarnings: [
        {
          reason: "manifest-missing",
          detail: "asset-manifest.json is absent; using legacy bundle compatibility checklist",
        },
      ],
    };
  }
  return null;
}

async function latestBundleReleaseForRepo(repo) {
  const releases = await fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=30`,
  );
  if (Array.isArray(releases)) {
    for (const release of releases) {
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const manifestAsset = assets.find((asset) => asset?.name === "asset-manifest.json");
      if (!manifestAsset?.browser_download_url) continue;
      try {
        manifestAsset.content = await fetchJson(manifestAsset.browser_download_url);
      } catch (err) {
        manifestAsset.content = {
          schemaVersion: "invalid-fetch",
          __fetchError: err.message,
        };
      }
    }
  }
  return selectLatestCompatibleBundleRelease({ repo, releases });
}

export async function resolveLatestPublishedBundleUrl({
  repo = OFFICIAL_OPENCLAW_BUNDLE_REPO,
  onWarn = warn,
} = {}) {
  const candidate = await latestBundleReleaseForRepo(repo);
  if (!candidate) {
    throw new Error(
        `No compatible published OpenClaw bundle release found in official GitHub repo ${repo}. ` +
        `Required assets: ${REQUIRED_RUNTIME_BUNDLE_ASSETS.join(", ")}.`,
    );
  }
  for (const warning of candidate.compatibilityWarnings ?? []) {
    onWarn?.(`OpenClaw bundle ${candidate.tag} from ${repo}: ${warning.detail}`);
  }
  return candidate;
}

export async function resolveCreateBundleUrl({ explicitUrl, skipDefault = false } = {}) {
  if (explicitUrl) return explicitUrl;
  if (skipDefault) return undefined;

  try {
    const bundle = await resolveLatestPublishedBundleUrl();
    success(
      `Using OpenClaw bundle ${bundle.tag} from ${bundle.repo} ${dim(`(${BUNDLE_ASSET_NAME})`)}`,
    );
    return bundle.url;
  } catch (err) {
    warn(`Could not resolve latest OpenClaw bundle: ${err.message}`);
    warn("Continuing without OPENCLAW_BUNDLE_URL; deployment will use the app's default install path.");
    return undefined;
  }
}
