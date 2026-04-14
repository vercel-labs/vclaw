import { parseArgs } from "node:util";
import { checkPrereqs } from "../steps/prereqs.mjs";
import { cloneRepo } from "../steps/clone.mjs";
import { linkProject } from "../steps/link.mjs";
import { provisionUpstash } from "../steps/upstash.mjs";
import { buildManagedEnvVars, pushEnvVars } from "../steps/env.mjs";
import { deploy } from "../steps/deploy.mjs";
import { runVerify } from "../steps/run-verify.mjs";
import {
  configureProjectProtection,
  resolveProtectionPlan,
} from "../steps/protection.mjs";
import { log, success, warn } from "../ui.mjs";

export async function init(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string", default: "openclaw" },
      scope: { type: "string" },
      team: { type: "string" },
      dir: { type: "string", default: "./vercel-openclaw" },
      "admin-secret": { type: "string" },
      "cron-secret": { type: "string" },
      "deployment-protection": { type: "string", default: "none" },
      "protection-bypass-secret": { type: "string" },
      "skip-deploy": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
  });

  if (values.team && values.scope && values.team !== values.scope) {
    throw new Error("Pass only one of --scope or deprecated --team.");
  }

  const scope = values.scope || values.team;
  if (values.team) {
    warn("`--team` is deprecated. Use `--scope`.");
  }

  const protectionPlan = resolveProtectionPlan(
    values["deployment-protection"],
    values["protection-bypass-secret"]
  );

  log("vclaw init — setting up vercel-openclaw\n");

  // 1. Check local prereqs
  await checkPrereqs();

  // 2. Clone
  const projectDir = await cloneRepo(values.dir);

  // 3. Link to Vercel
  await linkProject(projectDir, values.name, scope, values.yes);

  // 4. Provision Upstash Redis
  await provisionUpstash(projectDir, scope, values.yes);

  // 5. Configure project protection when requested
  const { protectionBypassSecret } = await configureProjectProtection(
    projectDir,
    values.name,
    scope,
    protectionPlan
  );

  // 6. Generate and push env vars
  const { adminSecret, vars } = buildManagedEnvVars({
    adminSecret: values["admin-secret"],
    cronSecret: values["cron-secret"],
    protectionBypassSecret,
  });
  await pushEnvVars(projectDir, vars, scope);

  if (values["skip-deploy"]) {
    warn("Skipping deploy (--skip-deploy). Run `vclaw verify` after deploying.");
    return;
  }

  // 7. Deploy
  const url = await deploy(projectDir, scope, values.yes);

  // 8. Verify
  await runVerify(url, adminSecret, { protectionBypassSecret });

  success(`\nDone! Your OpenClaw instance is live at ${url}`);
  log(`Admin secret: ${adminSecret}`);
  if (protectionBypassSecret) {
    log(`Protection bypass secret: ${protectionBypassSecret}`);
  }
  log("Save this secret — it won't be shown again.\n");
  log("Next steps:");
  log("  • Open the admin UI at the URL above");
  log("  • Connect Slack/Telegram channels from the admin panel");
  if (!protectionBypassSecret) {
    log("  • If you later enable Vercel Deployment Protection, also set VERCEL_AUTOMATION_BYPASS_SECRET");
  }
  log("  • See https://github.com/vercel-labs/vercel-openclaw for docs");
}
