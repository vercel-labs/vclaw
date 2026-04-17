import { readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { debug } from "./debug.mjs";

const API = "https://api.vercel.com";

function configPath() {
  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "com.vercel.cli",
      "config.json"
    );
  }
  if (platform() === "win32") {
    if (process.env.APPDATA) {
      return join(process.env.APPDATA, "com.vercel.cli", "config.json");
    }
  }
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, "com.vercel.cli", "config.json");
}

export function setActiveTeam(teamId) {
  const path = configPath();
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (teamId) {
    config.currentTeam = teamId;
  } else {
    delete config.currentTeam;
  }
  try {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readVercelToken() {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;

  const candidates = [];
  if (platform() === "darwin") {
    candidates.push(
      join(homedir(), "Library", "Application Support", "com.vercel.cli", "auth.json")
    );
  } else if (platform() === "win32") {
    if (process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, "com.vercel.cli", "auth.json"));
    }
  } else {
    const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    candidates.push(join(xdg, "com.vercel.cli", "auth.json"));
  }

  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (raw?.token) return raw.token;
    } catch {
      // try next
    }
  }
  return null;
}

async function api(token, path, init = {}) {
  const method = init.method || "GET";
  const startedAt = Date.now();
  debug(`api ${method} ${path}`, init.body ? { body: init.body } : undefined);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  debug(
    `api ${method} ${path} → ${res.status} (${Date.now() - startedAt}ms)`,
    typeof body === "object" && body !== null
      ? summarize(body)
      : body
  );
  return { status: res.status, ok: res.ok, body };
}

function summarize(obj) {
  const keys = Object.keys(obj).slice(0, 10);
  const out = {};
  for (const key of keys) {
    const v = obj[key];
    if (Array.isArray(v)) out[key] = `Array(${v.length})`;
    else if (v && typeof v === "object") out[key] = "[object]";
    else out[key] = typeof v === "string" && v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  return out;
}

function teamQuery(teamId) {
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

export async function getUser(token) {
  const { ok, body, status } = await api(token, "/v2/user");
  if (!ok) throw new Error(`GET /v2/user failed (${status}): ${stringify(body)}`);
  return body.user || body;
}

export async function listTeams(token) {
  const teams = [];
  let until;
  for (let page = 0; page < 20; page += 1) {
    const qs = new URLSearchParams();
    qs.set("limit", "100");
    if (until) qs.set("until", until);
    const { ok, body, status } = await api(token, `/v2/teams?${qs.toString()}`);
    if (!ok) throw new Error(`GET /v2/teams failed (${status}): ${stringify(body)}`);
    for (const team of body?.teams || []) {
      if (team?.id && team?.slug) {
        teams.push({ id: team.id, slug: team.slug, name: team.name || team.slug });
      }
    }
    const next = body?.pagination?.next;
    if (!next || next === until) break;
    until = next;
  }
  return teams;
}

export async function getTeamBySlug(token, slug) {
  const { ok, body, status } = await api(
    token,
    `/v2/teams?slug=${encodeURIComponent(slug)}`
  );
  if (!ok) throw new Error(`GET /v2/teams?slug=${slug} failed (${status}): ${stringify(body)}`);
  return body || null;
}

export async function getProject(token, name, teamId) {
  const { ok, body, status } = await api(
    token,
    `/v9/projects/${encodeURIComponent(name)}${teamQuery(teamId)}`
  );
  if (status === 404) return null;
  if (!ok) throw new Error(`GET /v9/projects/${name} failed (${status}): ${stringify(body)}`);
  return body;
}

export async function updateProject(token, projectId, teamId, patch) {
  const { ok, body, status } = await api(
    token,
    `/v9/projects/${encodeURIComponent(projectId)}${teamQuery(teamId)}`,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
  if (!ok) {
    throw new Error(
      `PATCH /v9/projects/${projectId} failed (${status}): ${stringify(body)}`
    );
  }
  return body;
}

export async function listProjects(token, { teamId, ownerId } = {}) {
  const names = new Set();
  let until;
  for (let page = 0; page < 20; page += 1) {
    const qs = new URLSearchParams();
    if (teamId) qs.set("teamId", teamId);
    qs.set("limit", "100");
    if (until) qs.set("until", until);
    const { ok, body, status } = await api(token, `/v9/projects?${qs.toString()}`);
    if (!ok) throw new Error(`GET /v9/projects failed (${status}): ${stringify(body)}`);
    const projects = body?.projects || [];
    for (const p of projects) {
      if (!p?.name) continue;
      if (ownerId && p.accountId !== ownerId) continue;
      names.add(p.name);
    }
    const next = body?.pagination?.next;
    if (!next || next === until) break;
    until = next;
  }
  return names;
}

/**
 * Bulk upsert env vars. Bypasses `vercel env add`, which silently skips
 * writes when its "Add to which Git branch?" prompt fires despite --yes.
 * https://vercel.com/docs/rest-api/endpoints/projects#create-one-or-more-environment-variables
 */
export async function upsertProjectEnv(token, projectId, teamId, entries) {
  const qs = new URLSearchParams();
  if (teamId) qs.set("teamId", teamId);
  qs.set("upsert", "true");
  const { ok, body, status } = await api(
    token,
    `/v10/projects/${encodeURIComponent(projectId)}/env?${qs.toString()}`,
    { method: "POST", body: JSON.stringify(entries) }
  );
  if (!ok) {
    throw new Error(
      `POST /v10/projects/${projectId}/env failed (${status}): ${stringify(body)}`
    );
  }
  return body;
}

/**
 * Decrypt and read one env var's value. Used to alias marketplace-provisioned
 * secrets under canonical names.
 */
export async function getProjectEnvValue(token, projectId, teamId, envId) {
  const { ok, body, status } = await api(
    token,
    `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}${teamQuery(teamId)}`
  );
  if (!ok) {
    throw new Error(
      `GET /v1/projects/${projectId}/env/${envId} failed (${status}): ${stringify(body)}`
    );
  }
  return body;
}

export async function listProjectEnvs(token, projectId, teamId) {
  const qs = new URLSearchParams();
  if (teamId) qs.set("teamId", teamId);
  qs.set("decrypt", "true");
  const { ok, body, status } = await api(
    token,
    `/v9/projects/${encodeURIComponent(projectId)}/env?${qs.toString()}`
  );
  if (!ok) {
    throw new Error(
      `GET /v9/projects/${projectId}/env failed (${status}): ${stringify(body)}`
    );
  }
  return Array.isArray(body?.envs) ? body.envs : [];
}

/**
 * Resolve a project's canonical production URL. The deploy CLI returns a
 * unique deployment URL (e.g. `*-xyz-team.vercel.app`) which is gated by
 * Vercel Standard Protection SSO — verify hits can't reach it. The project's
 * `targets.production.alias` list holds the stable public URLs (custom domain
 * first if configured, otherwise `<project>.vercel.app`), which aren't
 * SSO-gated.
 *
 * Returns the best canonical URL or null when nothing is aliased yet.
 */
export async function getProductionAlias(token, projectId, teamId) {
  const project = await getProject(token, projectId, teamId);
  const aliases = project?.targets?.production?.alias;
  if (!Array.isArray(aliases) || aliases.length === 0) return null;
  // Prefer a custom domain (anything not on *.vercel.app) so previews on
  // branded instances go through the canonical host.
  const custom = aliases.find((a) => typeof a === "string" && !a.endsWith(".vercel.app"));
  const pick = custom || aliases.find((a) => typeof a === "string");
  return pick ? `https://${pick}` : null;
}

/**
 * Distill the three protection fields on a project body into a normalized
 * summary. Each field is either `null` (off) or an object (on). Used to
 * auto-trigger bypass-secret creation when a reused project already has
 * Vercel Auth / Password Protection enabled — in that case launch verify
 * can't reach the admin routes without a bypass header.
 */
export function readProtectionState(project) {
  const sso = project?.ssoProtection ?? null;
  const password = project?.passwordProtection ?? null;
  const delegated = project?.delegatedProtection ?? null;
  return {
    sso,
    password,
    delegated,
    enabled: Boolean(sso || password || delegated),
    activeTypes: [
      sso ? "sso" : null,
      password ? "password" : null,
      delegated ? "delegated" : null,
    ].filter(Boolean),
  };
}

/**
 * PATCH /v1/projects/{id}/protection-bypass. With an empty body this acts as
 * a "read current set" no-op that returns the existing bypass map. With
 * `{ generate: { note } }` it creates a new one. The response map keys ARE
 * the bypass secrets, scoped by `.scope` (we care about `automation-bypass`).
 */
export async function patchProtectionBypass(token, projectId, teamId, body = {}) {
  const { ok, body: res, status } = await api(
    token,
    `/v1/projects/${encodeURIComponent(projectId)}/protection-bypass${teamQuery(teamId)}`,
    { method: "PATCH", body: JSON.stringify(body) }
  );
  if (!ok) {
    throw new Error(
      `PATCH /v1/projects/${projectId}/protection-bypass failed (${status}): ${stringify(res)}`
    );
  }
  return res?.protectionBypass || {};
}

/**
 * Return existing automation-bypass secret (first match) or null.
 */
export async function findAutomationBypassSecret(token, projectId, teamId) {
  const map = await patchProtectionBypass(token, projectId, teamId, {});
  for (const [secret, meta] of Object.entries(map)) {
    if (meta?.scope === "automation-bypass") return { secret, meta };
  }
  return null;
}

/**
 * Return an existing automation-bypass secret if one is configured; create a
 * new one otherwise. Cheap read-then-write so repeat invocations don't churn
 * through secrets.
 */
export async function ensureAutomationBypassSecret(
  token,
  projectId,
  teamId,
  { note = "vclaw automation" } = {}
) {
  const existing = await findAutomationBypassSecret(token, projectId, teamId);
  if (existing) return { ...existing, created: false };
  const fresh = await patchProtectionBypass(token, projectId, teamId, {
    generate: { note },
  });
  for (const [secret, meta] of Object.entries(fresh)) {
    if (meta?.scope === "automation-bypass") {
      return { secret, meta, created: true };
    }
  }
  throw new Error(
    `PATCH protection-bypass returned no automation-bypass entry for project ${projectId}.`
  );
}

export async function createProject(token, name, teamId, extra = {}) {
  const { ok, body, status } = await api(token, `/v11/projects${teamQuery(teamId)}`, {
    method: "POST",
    body: JSON.stringify({ name, ...extra }),
  });
  if (!ok) {
    throw new Error(
      `POST /v11/projects (create "${name}") failed (${status}): ${stringify(body)}`
    );
  }
  return body;
}

function stringify(value) {
  if (value === null || value === undefined) return "<empty>";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
