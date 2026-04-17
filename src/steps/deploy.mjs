import { extractDeploymentUrl, vercelRun } from "../vercel.mjs";
import { spinner } from "../ui.mjs";

export async function deploy(projectDir, scope, yes = false) {
  const args = ["deploy", "--prod"];
  if (yes) args.push("--yes");

  const spin = spinner("Deploying to Vercel (production) — 0s");
  const start = Date.now();
  const tick = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    spin.update(`Deploying to Vercel (production) — ${elapsed}s`);
  }, 1000);

  try {
    const result = await vercelRun(args, { cwd: projectDir, scope });
    const url = extractDeploymentUrl(result.stdout);
    spin.succeed(`Deployed: ${url}`);
    return url;
  } catch (err) {
    spin.fail("Deploy failed");
    throw err;
  } finally {
    clearInterval(tick);
  }
}
