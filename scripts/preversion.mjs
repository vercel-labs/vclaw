#!/usr/bin/env node
// Gate for `npm version` → refuse to bump/tag if the tree is dirty or
// the tests are red. Runs as the `preversion` lifecycle script, so a
// failure here aborts the version bump before it creates a commit or
// tag. That keeps bad releases from ever being pushed to origin.
//
// Ignores untracked files (the repo has test-clone directories like
// vercel-openclaw/ that shouldn't block a release).

import { execSync } from "node:child_process";
import { exit, stderr, stdout } from "node:process";

function run(cmd, { capture = false } = {}) {
  try {
    return execSync(cmd, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
    });
  } catch (err) {
    if (!capture) exit(err.status ?? 1);
    throw err;
  }
}

// 1. Tracked working tree must be clean. Untracked files are fine.
try {
  execSync("git diff-index --quiet HEAD --", { stdio: "ignore" });
} catch {
  stderr.write(
    "✗ preversion: tracked files have uncommitted changes. " +
      "Commit or stash before `npm version`.\n",
  );
  const status = run("git status --porcelain --untracked-files=no", {
    capture: true,
  });
  stderr.write(status);
  exit(1);
}

// 2. Must be on main (catch accidental bumps on feature branches).
const branch = run("git rev-parse --abbrev-ref HEAD", { capture: true }).trim();
if (branch !== "main") {
  stderr.write(
    `✗ preversion: refusing to version-bump on branch "${branch}". ` +
      "Switch to main first.\n",
  );
  exit(1);
}

// 3. Must be in sync with origin/main (no unpushed commits, no fetch lag).
try {
  execSync("git fetch origin main --quiet", { stdio: "ignore" });
} catch {
  stderr.write(
    "✗ preversion: could not fetch origin/main. Check your network + remote.\n",
  );
  exit(1);
}
const local = run("git rev-parse HEAD", { capture: true }).trim();
const remote = run("git rev-parse origin/main", { capture: true }).trim();
if (local !== remote) {
  stderr.write(
    "✗ preversion: local main is not in sync with origin/main.\n" +
      `  local:  ${local}\n  remote: ${remote}\n` +
      "  Run `git pull --rebase` or push your commits first.\n",
  );
  exit(1);
}

// 4. Tests must pass.
stdout.write("▸ preversion: running tests…\n");
run("npm test");
stdout.write("✓ preversion: clean tree, in sync with origin, tests pass\n");
