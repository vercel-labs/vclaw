import { step, success } from "../ui.mjs";
import {
  ensureAutomationBypassSecret,
  readVercelToken,
  updateProject,
} from "../vercel-api.mjs";

export const DEPLOYMENT_PROTECTION_MODES = new Set([
  "none",
  "sso",
  "password",
]);

export function resolveProtectionPlan(mode = "none", providedBypassSecret) {
  if (!DEPLOYMENT_PROTECTION_MODES.has(mode)) {
    throw new Error(
      `Invalid --deployment-protection value: ${mode}. Use one of: none, sso, password.`
    );
  }

  const enableBypass = mode !== "none" || !!providedBypassSecret;
  return {
    mode,
    enableBypass,
    providedBypassSecret: providedBypassSecret || undefined,
  };
}

export async function configureProjectProtection(linked, plan, promptForPassword) {
  if (!plan.enableBypass && plan.mode === "none") {
    return { protectionBypassSecret: undefined };
  }

  if (!linked?.projectId) {
    throw new Error(
      "Project is not linked yet. Cannot configure protection without a projectId."
    );
  }

  const token = readVercelToken();
  if (!token) {
    throw new Error(
      "Could not read Vercel auth token. Run `vercel login` and retry."
    );
  }

  step("Configuring Vercel project protection");

  if (plan.mode === "sso") {
    await updateProject(token, linked.projectId, linked.teamId, {
      ssoProtection: { deploymentType: "all" },
    });
  } else if (plan.mode === "password") {
    const password = typeof promptForPassword === "function"
      ? await promptForPassword()
      : undefined;
    if (!password) {
      throw new Error(
        "Password protection requires a password. Provide one via the prompt or disable protection."
      );
    }
    await updateProject(token, linked.projectId, linked.teamId, {
      passwordProtection: { deploymentType: "all", password },
    });
  }

  let protectionBypassSecret;
  if (plan.enableBypass) {
    const { secret } = await ensureAutomationBypassSecret(
      token,
      linked.projectId,
      linked.teamId,
      { note: "vclaw create" }
    );
    protectionBypassSecret = secret;
  }

  const summary = [];
  if (plan.mode !== "none") summary.push(plan.mode);
  if (plan.enableBypass) summary.push("automation bypass");
  success(
    `Project protection configured${summary.length ? ` (${summary.join(", ")})` : ""}`
  );

  return { protectionBypassSecret };
}
