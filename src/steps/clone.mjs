import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { exec, run } from "../shell.mjs";
import { spinner } from "../ui.mjs";

const REPO = "https://github.com/vercel-labs/vercel-openclaw.git";

export async function cloneRepo(dir) {
  const target = resolve(dir);

  if (existsSync(target)) {
    return updateExistingDir(target);
  }

  const spin = spinner(`Cloning vercel-openclaw → ${target}`);
  try {
    await run("git", ["clone", REPO, target]);
    spin.succeed(`Cloned vercel-openclaw → ${target}`);
    return target;
  } catch (err) {
    spin.fail(`Clone failed: ${err.message}`);
    throw err;
  }
}

async function updateExistingDir(target) {
  if (!existsSync(join(target, ".git"))) {
    const entries = safeReaddir(target);
    if (entries.length === 0) {
      const spin = spinner(`Cloning vercel-openclaw → ${target}`);
      try {
        await run("git", ["clone", REPO, target]);
        spin.succeed(`Cloned vercel-openclaw → ${target}`);
        return target;
      } catch (err) {
        spin.fail(`Clone failed: ${err.message}`);
        throw err;
      }
    }
    throw new Error(
      `${target} already exists and is not a git checkout. Pass --dir to pick a different path, or delete the existing folder.`
    );
  }

  const remoteCheck = await exec("git", [
    "-C",
    target,
    "config",
    "--get",
    "remote.origin.url",
  ]);
  if (remoteCheck.code !== 0 || !remoteCheck.stdout.includes("vercel-openclaw")) {
    throw new Error(
      `${target} is a git repo but doesn't look like vercel-openclaw (remote: ${remoteCheck.stdout || "unknown"}). Pass --dir to pick a different path.`
    );
  }

  const spin = spinner(`Updating vercel-openclaw → ${target}`);
  const pull = await exec("git", ["-C", target, "pull", "--ff-only"]);
  if (pull.code === 0) {
    spin.succeed(`Updated existing checkout at ${target}`);
    return target;
  }

  const detail = (pull.stderr || pull.stdout).trim();
  spin.fail(`git pull --ff-only failed in ${target}`);
  throw new Error(
    `Could not fast-forward ${target}:\n${detail}\n\n` +
      `This usually means the checkout has local commits or uncommitted changes. ` +
      `Fix the checkout (git status, git stash, git reset) or pass --dir to clone somewhere fresh.`
  );
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
