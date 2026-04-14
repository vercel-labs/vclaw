import { vercelRun } from "../vercel.mjs";
import { step, success } from "../ui.mjs";

export async function linkProject(projectDir, name, scope, yes = false) {
  step(`Linking Vercel project "${name}"`);

  const args = ["link", "--project", name];
  if (yes) args.push("--yes");

  await vercelRun(args, { cwd: projectDir, scope });
  success(`Linked to Vercel project: ${name}`);
}
