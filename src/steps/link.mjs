import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createProject,
  getProject,
  getTeamBySlug,
  getUser,
  readVercelToken,
  updateProject,
} from "../vercel-api.mjs";
import { spinner, warn } from "../ui.mjs";

/**
 * Create (if needed) and link a Vercel project by writing .vercel/project.json
 * directly. We bypass `vercel link` because it silently no-ops when the
 * project doesn't exist under the active CLI team.
 */
export async function linkProject(projectDir, name, scope) {
  const spin = spinner(`Linking Vercel project "${name}"`);

  try {
    const token = readVercelToken();
    if (!token) {
      throw new Error(
        "Could not find Vercel auth token. Run `vercel login` or set VERCEL_TOKEN."
      );
    }

    const { ownerId, teamId } = await resolveOwner(token, scope);

    // Look up only within the intended scope. If the API returns a project
    // owned by a different account (e.g. a same-named project in a team the
    // user also belongs to), treat it as not-found so we create a fresh one
    // under the correct scope.
    let project = await getProject(token, name, teamId);
    if (project && project.accountId && project.accountId !== ownerId) {
      project = null;
    }

    let existed = false;
    if (!project) {
      spin.update(`Creating Vercel project "${name}"`);
      try {
        // vercel-openclaw is a Next.js app. Setting framework up front means
        // the first deploy doesn't trip the "projectSettings required for new
        // projects" guard from Vercel's deploy API.
        project = await createProject(token, name, teamId, {
          framework: "nextjs",
        });
      } catch (err) {
        // Vercel enforces unique names across all orgs the user can access,
        // not just the target scope. Surface a clear, actionable error.
        if (/409/.test(err.message) && /already exists/i.test(err.message)) {
          throw new Error(
            `A project named "${name}" already exists in another team you can access. ` +
              `Pick a different name and rerun \`vclaw create\` (or pass --name).`
          );
        }
        throw err;
      }
    } else {
      existed = true;
    }

    const projectId = project.id || project.projectId;
    const resolvedOrgId = project.accountId || ownerId;
    if (!projectId) {
      throw new Error(
        `Vercel API returned no project id for "${name}". Response: ${JSON.stringify(project)}`
      );
    }

    // Backfill framework on pre-existing projects so the first deploy doesn't
    // trip Vercel's "projectSettings required" guard.
    if (!project.framework) {
      try {
        await updateProject(token, projectId, teamId, { framework: "nextjs" });
      } catch {
        // non-fatal — deploy may still succeed
      }
    }

    writeProjectJson(projectDir, { projectId, orgId: resolvedOrgId });
    if (existed) {
      const envCount = Array.isArray(project.env) ? project.env.length : 0;
      spin.succeed(`Linked to existing Vercel project: ${name}`);
      warn(
        `Project "${name}" already existed with ${envCount} env var(s). ` +
          `Any pre-existing secrets (e.g. from a prior init) will be inherited. ` +
          `If you want a clean slate, cancel and rerun with --name <fresh-name>.`
      );
    } else {
      spin.succeed(`Linked to Vercel project: ${name}`);
    }
    return { projectId, teamId, existed };
  } catch (err) {
    spin.fail(`Link failed for "${name}"`);
    throw err;
  }
}

async function resolveOwner(token, scope) {
  if (scope) {
    const team = await getTeamBySlug(token, scope);
    if (!team?.id) {
      throw new Error(
        `Could not resolve Vercel team "${scope}". Check \`vercel teams ls\` and confirm you have access.`
      );
    }
    return { ownerId: team.id, teamId: team.id };
  }
  const user = await getUser(token);
  const userId = user?.id || user?.uid;
  if (!userId) {
    throw new Error("Could not resolve your Vercel user id from /v2/user.");
  }
  return { ownerId: userId, teamId: undefined };
}

function writeProjectJson(projectDir, payload) {
  const dir = join(projectDir, ".vercel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
}
