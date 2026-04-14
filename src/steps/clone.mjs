import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "../shell.mjs";
import { step, success, warn } from "../ui.mjs";

const REPO = "https://github.com/vercel-labs/vercel-openclaw.git";

export async function cloneRepo(dir) {
  const target = resolve(dir);
  step(`Cloning vercel-openclaw → ${target}`);

  if (existsSync(target)) {
    warn(`Directory already exists: ${target} — pulling latest`);
    await run("git", ["-C", target, "pull", "--ff-only"]);
  } else {
    await run("git", ["clone", REPO, target]);
  }

  success("Repository ready");
  return target;
}
