import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_VCLAW_HOME = "~/.vclaw";

function expandHome(path) {
  if (!path || path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function workspaceSegment(value, fallback = "default") {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return raw || fallback;
}

export function resolveManagedWorkspace({ scope, projectName, home } = {}) {
  const root = expandHome(home || process.env.VCLAW_HOME || DEFAULT_VCLAW_HOME);
  const owner = workspaceSegment(scope, "personal");
  const project = workspaceSegment(projectName, "vercel-openclaw");
  const workspaceDir = join(root, owner, project);
  return {
    root,
    owner,
    project,
    workspaceDir,
    appDir: join(workspaceDir, "app"),
    metadataPath: join(workspaceDir, "vclaw.json"),
  };
}

export function writeManagedWorkspaceMetadata(workspace, metadata) {
  mkdirSync(workspace.workspaceDir, { recursive: true });
  writeFileSync(
    workspace.metadataPath,
    `${JSON.stringify({ schemaVersion: 1, ...metadata }, null, 2)}\n`,
    "utf8",
  );
}

