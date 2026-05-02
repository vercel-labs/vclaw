import { exec } from "../shell.mjs";
import { dim, success, warn } from "../ui.mjs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_OPENCLAW_REPO_DIR = "~/dev/openclaw";
export const BUNDLE_ASSET_NAME = "openclaw.bundle.mjs";
export const REQUIRED_BUNDLE_ASSETS = [
  BUNDLE_ASSET_NAME,
  "channel-catalog.json",
  "workspace-templates.tar.gz",
  "channels.tar.gz",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "channel-shared-chunks.tar.gz",
  "control-ui.tar.gz",
];

function expandHome(path) {
  if (!path || path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function githubRepoFromRemoteUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  const raw = url.trim();

  const ssh = raw.match(/^(?:[^@/:]+@)?github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
  } catch {
    return null;
  }
}

async function readGithubRemotes(repoDir) {
  const result = await exec("git", ["remote", "-v"], { cwd: repoDir });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git remote -v failed in ${repoDir}`);
  }
  const repos = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const [, url] = line.trim().split(/\s+/);
    const repo = githubRepoFromRemoteUrl(url);
    if (repo) repos.add(repo);
  }
  return [...repos];
}

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

async function latestBundleReleaseForRepo(repo) {
  const releases = await fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=30`,
  );
  if (!Array.isArray(releases)) return null;

  for (const release of releases) {
    if (release?.draft) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const assetByName = new Map(
      assets
        .filter((a) => a?.name && a?.browser_download_url)
        .map((a) => [a.name, a]),
    );
    const missingAssets = REQUIRED_BUNDLE_ASSETS.filter((name) => !assetByName.has(name));
    if (missingAssets.length > 0) continue;
    const asset = assetByName.get(BUNDLE_ASSET_NAME);
    return {
      repo,
      tag: release.tag_name,
      publishedAt: release.published_at || release.created_at || "",
      url: asset.browser_download_url,
      assetNames: [...assetByName.keys()].sort((a, b) => a.localeCompare(b)),
    };
  }
  return null;
}

export async function resolveLatestPublishedBundleUrl({
  openclawDir = process.env.OPENCLAW_REPO_DIR || DEFAULT_OPENCLAW_REPO_DIR,
  onWarn = warn,
} = {}) {
  const repoDir = expandHome(openclawDir);
  const repos = await readGithubRemotes(repoDir);
  if (repos.length === 0) {
    throw new Error(`No GitHub remotes found in ${repoDir}.`);
  }

  const candidates = [];
  const errors = [];
  for (const repo of repos) {
    try {
      const candidate = await latestBundleReleaseForRepo(repo);
      if (candidate) candidates.push(candidate);
    } catch (err) {
      errors.push(`${repo}: ${err.message}`);
    }
  }

  if (candidates.length === 0) {
    if (errors.length > 0 && onWarn) {
      onWarn(`Could not inspect some OpenClaw remotes: ${errors.join("; ")}`);
    }
    throw new Error(
      `No compatible published OpenClaw bundle release found on GitHub remotes from ${repoDir}. ` +
        `Required assets: ${REQUIRED_BUNDLE_ASSETS.join(", ")}.`,
    );
  }

  candidates.sort((a, b) => {
    const byTime = Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0);
    if (byTime) return byTime;
    return a.repo.localeCompare(b.repo);
  });
  return candidates[0];
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
