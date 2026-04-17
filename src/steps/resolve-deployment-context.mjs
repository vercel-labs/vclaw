import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findAutomationBypassSecret,
  getProductionAlias,
  getProjectEnvValue,
  getTeamBySlug,
  listProjectEnvs,
  readVercelToken,
} from "../vercel-api.mjs";
import { readLinkedProject } from "./env.mjs";
import { debug } from "../debug.mjs";
import { dim, isInteractive, log, promptMasked, warn } from "../ui.mjs";

/**
 * Resolve everything a post-create channel command needs to talk to a
 * live openclaw deployment:
 *
 *   { url, adminSecret, protectionBypassSecret, projectId, teamId }
 *
 * Precedence for each field:
 *   1. explicit flag (--url / --admin-secret / --protection-bypass)
 *   2. the linked Vercel project at <dir>/.vercel/project.json  (+ Vercel env API)
 *   3. $VERCEL_AUTOMATION_BYPASS_SECRET for bypass only
 *   4. interactive prompt (admin secret only — never prompt for URL)
 *
 * Throws when a required field can't be resolved.
 */
export async function resolveDeploymentContext({
  dir = process.cwd(),
  url: urlFlag,
  project: projectFlag,
  scope: scopeFlag,
  adminSecret: adminSecretFlag,
  protectionBypassSecret: bypassFlag,
} = {}) {
  const projectDir = resolve(dir);
  const linkedPath = join(projectDir, ".vercel", "project.json");
  const hasLinkedProject = existsSync(linkedPath);

  debug("resolveDeploymentContext.start", {
    dir: projectDir,
    hasLinkedProject,
    urlFlag: urlFlag ?? null,
    projectFlag: projectFlag ?? null,
    scopeFlag: scopeFlag ?? null,
    hasAdminSecretFlag: Boolean(adminSecretFlag),
    hasBypassFlag: Boolean(bypassFlag),
  });

  let projectId = null;
  let teamId;
  if (hasLinkedProject) {
    const linked = readLinkedProject(projectDir);
    projectId = linked.projectId;
    teamId = linked.teamId;
  }

  // If both --project and --scope were given explicitly, fall back to those
  // to resolve via the Vercel API.
  if (!projectId && projectFlag) {
    const token = readVercelToken();
    if (!token) {
      throw new Error(
        "No Vercel auth token — run `vercel login` or set VERCEL_TOKEN.",
      );
    }
    if (scopeFlag) {
      const team = await getTeamBySlug(token, scopeFlag);
      if (team?.id) teamId = team.id;
    }
    // Lazy: do not fetch projectId by name here — getProject by name returns
    // the full project object and we only need an alias.
    // We can fetch via getProject(token, projectFlag, teamId) → project.id.
    const { getProject } = await import("../vercel-api.mjs");
    const project = await getProject(token, projectFlag, teamId);
    if (!project?.id) {
      throw new Error(
        `Could not find Vercel project "${projectFlag}" in scope ${scopeFlag ?? "(default)"}.`,
      );
    }
    projectId = project.id;
  }

  // Resolve URL
  let url = urlFlag || null;
  if (!url && projectId) {
    const token = readVercelToken();
    if (!token) {
      throw new Error(
        "No Vercel auth token — run `vercel login` or set VERCEL_TOKEN.",
      );
    }
    url = await getProductionAlias(token, projectId, teamId);
    if (!url) {
      throw new Error(
        `Project ${projectId} has no production alias yet — deploy it first, or pass --url.`,
      );
    }
  }
  if (!url) {
    throw new Error(
      "Could not resolve a deployment URL. Run from a linked openclaw project directory, or pass --url, --project, or --scope.",
    );
  }

  // Resolve admin secret. The Vercel env API explicitly refuses to return
  // the value of `sensitive`-typed vars (ADMIN_SECRET is created as sensitive
  // by `vclaw create`), so the env API is only useful when vars were stored
  // as `encrypted`. Precedence: flag → $ADMIN_SECRET → Vercel env → prompt.
  let adminSecret = adminSecretFlag || process.env.ADMIN_SECRET || null;
  let protectionBypassSecret =
    bypassFlag || process.env.VERCEL_AUTOMATION_BYPASS_SECRET || null;

  if ((!adminSecret || !protectionBypassSecret) && projectId) {
    const token = readVercelToken();
    if (!token) {
      throw new Error(
        "No Vercel auth token — run `vercel login` or set VERCEL_TOKEN.",
      );
    }
    try {
      const envs = await listProjectEnvs(token, projectId, teamId);
      if (!adminSecret) {
        const entry = envs.find((e) => e.key === "ADMIN_SECRET");
        if (entry) {
          const value = await resolveEnvEntryValue(token, projectId, teamId, entry);
          if (value) {
            adminSecret = value;
            debug("resolveDeploymentContext.adminSecret", { source: "vercel-env" });
          }
        }
      }
      if (!protectionBypassSecret) {
        const entry = envs.find(
          (e) => e.key === "VERCEL_AUTOMATION_BYPASS_SECRET",
        );
        if (entry) {
          const value = await resolveEnvEntryValue(token, projectId, teamId, entry);
          if (value) {
            protectionBypassSecret = value;
            debug("resolveDeploymentContext.bypass", { source: "vercel-env" });
          }
        }
      }
      if (!protectionBypassSecret) {
        const found = await findAutomationBypassSecret(token, projectId, teamId);
        if (found?.secret) {
          protectionBypassSecret = found.secret;
          debug("resolveDeploymentContext.bypass", {
            source: "protection-bypass-api",
          });
        }
      }
    } catch (err) {
      debug("resolveDeploymentContext.env_lookup_failed", {
        error: err?.message ?? String(err),
      });
      // Non-fatal — fall through to prompting for adminSecret.
    }
  }

  if (!adminSecret) {
    if (!isInteractive()) {
      throw new Error(
        "Could not resolve ADMIN_SECRET. Pass --admin-secret, set $ADMIN_SECRET, " +
          "or run interactively so vclaw can prompt. (The Vercel API refuses to " +
          "return the value of a `sensitive`-typed env var by design.)",
      );
    }
    log(
      dim(
        "  The Vercel API won't return ADMIN_SECRET because it's stored as `sensitive`.",
      ),
    );
    adminSecret = await promptMasked("Admin secret");
    if (!adminSecret) {
      throw new Error("Admin secret is required.");
    }
  }

  if (!protectionBypassSecret) {
    // Not always required — deployments without protection won't need it.
    // Emit a dim note so the operator knows in case of a 401 later.
    debug("resolveDeploymentContext.no_bypass", {
      note: "no VERCEL_AUTOMATION_BYPASS_SECRET found; only relevant when deployment protection is on",
    });
  }

  debug("resolveDeploymentContext.result", {
    url,
    projectId,
    teamId: teamId ?? null,
    hasAdminSecret: Boolean(adminSecret),
    hasBypass: Boolean(protectionBypassSecret),
  });

  return {
    url,
    adminSecret,
    protectionBypassSecret,
    projectId,
    teamId,
  };
}

/**
 * `listProjectEnvs` returns values inline for `encrypted` entries but omits
 * them for `sensitive` entries — those require a per-id GET against
 * `/v1/projects/{id}/env/{envId}` which returns the decrypted value.
 */
async function resolveEnvEntryValue(token, projectId, teamId, entry) {
  if (typeof entry?.value === "string" && entry.value.length > 0) {
    return entry.value;
  }
  if (!entry?.id) return null;
  try {
    const detail = await getProjectEnvValue(token, projectId, teamId, entry.id);
    return typeof detail?.value === "string" && detail.value.length > 0
      ? detail.value
      : null;
  } catch (err) {
    debug("resolveDeploymentContext.env_value_fetch_failed", {
      key: entry.key,
      id: entry.id,
      error: err?.message ?? String(err),
    });
    return null;
  }
}
