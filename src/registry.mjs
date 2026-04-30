import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const REGISTRY_DIR = join(homedir(), ".vclaw");
const REGISTRY_FILE = join(REGISTRY_DIR, "registry.json");

export function registryPath() {
  return REGISTRY_FILE;
}

export function readRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeRegistry(data) {
  mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
  writeFileSync(REGISTRY_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function registerClaw(name, entry) {
  const reg = readRegistry();
  reg[name] = { ...entry, createdAt: entry.createdAt || new Date().toISOString() };
  writeRegistry(reg);
}

export function unregisterClaw(name) {
  const reg = readRegistry();
  if (!(name in reg)) return false;
  delete reg[name];
  writeRegistry(reg);
  return true;
}

export function listClaws() {
  const reg = readRegistry();
  return Object.entries(reg)
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getClaw(name) {
  const reg = readRegistry();
  return reg[name] || null;
}

/**
 * Reverse lookup: find a registry entry whose projectId matches. Used by
 * `vclaw chat` when running from a linked project directory so the
 * end-to-end-verified URL still wins over a fresh getProductionAlias() call.
 * Returns `{ name, ...entry }` or null.
 */
export function getClawByProjectId(projectId, teamId) {
  if (!projectId) return null;
  const reg = readRegistry();
  for (const [name, entry] of Object.entries(reg)) {
    if (entry?.projectId !== projectId) continue;
    // teamId is optional in the registry (personal projects have undefined),
    // so a registry entry with no teamId matches any team query and vice
    // versa. Only fail when both sides are set and disagree.
    if (entry.teamId && teamId && entry.teamId !== teamId) continue;
    return { name, ...entry };
  }
  return null;
}

const CLAW_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export function validateClawName(name) {
  if (typeof name !== "string" || name.length === 0) {
    return "Claw name is required.";
  }
  if (name.length > 64) {
    return "Claw name must be 64 characters or fewer.";
  }
  if (name !== name.toLowerCase()) {
    return "Claw name must be lowercase.";
  }
  if (!CLAW_NAME_RE.test(name)) {
    return "Claw name must use only lowercase letters, digits, hyphens, and underscores, and must not start or end with a hyphen.";
  }
  return null;
}

export function suggestClawName(vercelProjectName) {
  let name = vercelProjectName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  name = name.replace(/^vercel-/, "");
  name = name.replace(/^-+|-+$/g, "");
  return name || "my-claw";
}
