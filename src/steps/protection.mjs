import { randomBytes } from "node:crypto";
import { vercelJson } from "../vercel.mjs";
import { step, success } from "../ui.mjs";

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
    bypassSecret: enableBypass
      ? providedBypassSecret || randomBytes(24).toString("hex")
      : undefined,
  };
}

export async function configureProjectProtection(
  projectDir,
  projectName,
  scope,
  plan
) {
  if (!plan.enableBypass && plan.mode === "none") {
    return { protectionBypassSecret: undefined };
  }

  step("Configuring Vercel project protection");

  if (plan.mode === "sso") {
    await vercelJson(
      [
        "project",
        "protection",
        "enable",
        projectName,
        "--sso",
        "--format",
        "json",
      ],
      { cwd: projectDir, scope }
    );
  } else if (plan.mode === "password") {
    await vercelJson(
      [
        "project",
        "protection",
        "enable",
        projectName,
        "--password",
        "--format",
        "json",
      ],
      { cwd: projectDir, scope }
    );
  }

  if (plan.enableBypass) {
    await vercelJson(
      [
        "project",
        "protection",
        "enable",
        projectName,
        "--protection-bypass",
        "--protection-bypass-secret",
        plan.bypassSecret,
        "--format",
        "json",
      ],
      { cwd: projectDir, scope }
    );
  }

  const summary = [];
  if (plan.mode !== "none") summary.push(plan.mode);
  if (plan.enableBypass) summary.push("automation bypass");
  success(`Project protection configured${summary.length ? ` (${summary.join(", ")})` : ""}`);

  return { protectionBypassSecret: plan.bypassSecret };
}
