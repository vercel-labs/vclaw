import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readVercelToken,
  upsertProjectEnv,
} from "../vercel-api.mjs";
import { step, success, dim } from "../ui.mjs";

const TARGETS = ["production", "preview"];

/**
 * Push required env vars to the Vercel project.
 * Returns the admin secret (generated or provided) and a `{[key]: {value, type}}`
 * map ready for `pushEnvVars`.
 *
 * Secrets go in as `sensitive`; per-project identity goes in as `plain` so
 * operators can read them in the Vercel UI and the server can echo them
 * back in Slack manifests / admin surfaces.
 */
export function buildManagedEnvVars({
  adminSecret,
  cronSecret,
  protectionBypassSecret,
  projectScope,
  projectName,
}) {
  const resolvedAdminSecret = adminSecret || randomBytes(32).toString("hex");
  const vars = {
    ADMIN_SECRET: { value: resolvedAdminSecret, type: "sensitive" },
  };

  if (cronSecret) {
    vars.CRON_SECRET = { value: cronSecret, type: "sensitive" };
  }

  if (protectionBypassSecret) {
    vars.VERCEL_AUTOMATION_BYPASS_SECRET = {
      value: protectionBypassSecret,
      type: "sensitive",
    };
  }

  if (projectScope) {
    vars.VCLAW_PROJECT_SCOPE = { value: projectScope, type: "plain" };
  }

  if (projectName) {
    vars.VCLAW_PROJECT_NAME = { value: projectName, type: "plain" };
  }

  return {
    adminSecret: resolvedAdminSecret,
    vars,
  };
}

export async function pushEnvVars(projectDir, vars /* , scope */) {
  step("Configuring environment variables");

  const token = readVercelToken();
  if (!token) {
    throw new Error(
      "Could not find Vercel auth token. Run `vercel login` or set VERCEL_TOKEN."
    );
  }
  const { projectId, teamId } = readLinkedProject(projectDir);

  const entries = Object.entries(vars).map(([key, entry]) => {
    const value = typeof entry === "string" ? entry : entry.value;
    const type = typeof entry === "string" ? "sensitive" : (entry.type ?? "sensitive");
    return { key, value, target: TARGETS, type };
  });

  await upsertProjectEnv(token, projectId, teamId, entries);

  success(
    `Environment variables set ${dim(`(${Object.keys(vars).join(", ")})`)}`
  );
}

export function readLinkedProject(projectDir) {
  const raw = readFileSync(join(projectDir, ".vercel", "project.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.projectId) {
    throw new Error(
      `No projectId in ${projectDir}/.vercel/project.json — linking may have failed.`
    );
  }
  // orgId holds team_xxx for team projects and user_xxx for personal.
  // Vercel's REST API expects teamId only for team-owned projects.
  const teamId =
    typeof parsed.orgId === "string" && parsed.orgId.startsWith("team_")
      ? parsed.orgId
      : undefined;
  return { projectId: parsed.projectId, teamId };
}
