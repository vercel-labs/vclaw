import { extractDeploymentUrl, vercelRun } from "../vercel.mjs";
import { step, success, log, dim } from "../ui.mjs";

export async function deploy(projectDir, scope, yes = false) {
  step("Deploying to Vercel (production)");
  log(dim("  This may take a few minutes..."));

  const args = ["deploy", "--prod"];
  if (yes) args.push("--yes");

  const result = await vercelRun(args, { cwd: projectDir, scope });
  const url = extractDeploymentUrl(result.stdout);
  success(`Deployed: ${url}`);
  return url;
}
