import { randomBytes } from "node:crypto";
import { vercelRun } from "../vercel.mjs";
import { step, success, dim } from "../ui.mjs";

const ENVIRONMENTS = ["production", "preview", "development"];

/**
 * Push required env vars to the Vercel project.
 * Returns the admin secret (generated or provided).
 */
export function buildManagedEnvVars({
  adminSecret,
  cronSecret,
  protectionBypassSecret,
}) {
  const resolvedAdminSecret = adminSecret || randomBytes(32).toString("hex");
  const vars = {
    ADMIN_SECRET: resolvedAdminSecret,
  };

  if (cronSecret) {
    vars.CRON_SECRET = cronSecret;
  }

  if (protectionBypassSecret) {
    vars.VERCEL_AUTOMATION_BYPASS_SECRET = protectionBypassSecret;
  }

  return {
    adminSecret: resolvedAdminSecret,
    vars,
  };
}

export async function pushEnvVars(projectDir, vars, scope) {
  step("Configuring environment variables");

  for (const [key, value] of Object.entries(vars)) {
    for (const env of ENVIRONMENTS) {
      await setEnvVar(projectDir, key, value, env, scope);
    }
  }

  success(
    `Environment variables set ${dim(`(${Object.keys(vars).join(", ")})`)}`
  );
}

async function setEnvVar(projectDir, key, value, environment, scope) {
  await vercelRun(
    [
      "env",
      "add",
      key,
      environment,
      "--sensitive",
      "--value",
      value,
      "--yes",
      "--force",
    ],
    {
      cwd: projectDir,
      scope,
    }
  );
}
