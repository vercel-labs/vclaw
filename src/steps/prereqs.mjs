import { exec } from "../shell.mjs";
import { getUser, readVercelToken } from "../vercel-api.mjs";
import { step, success, fail, warn } from "../ui.mjs";

export async function checkPrereqs() {
  const checks = [
    {
      name: "git",
      test: () => exec("git", ["--version"]),
      fix: "Install git: https://git-scm.com",
    },
    {
      name: "node >= 20",
      test: async () => {
        const result = await exec("node", ["--version"]);
        const major = parseInt(result.stdout.replace("v", ""), 10);
        if (major < 20) throw new Error(`Node ${result.stdout} — need >= 20`);
        return result;
      },
      fix: "Install Node.js 20+: https://nodejs.org",
    },
    {
      name: "vercel CLI",
      test: () => exec("vercel", ["--version"]),
      fix: "Install the Vercel CLI: npm i -g vercel",
    },
  ];

  let allPassed = true;
  for (const check of checks) {
    step(`Checking ${check.name}`);
    try {
      await check.test();
      success(check.name);
    } catch (err) {
      fail(`${check.name}: ${err.message}`);
      console.error(`  Fix: ${check.fix}\n`);
      allPassed = false;
    }
  }

  if (!allPassed) {
    throw new Error("Prerequisites not met. Fix the issues above and retry.");
  }

  step("Checking Vercel authentication");
  const token = readVercelToken();
  if (token) {
    try {
      const user = await getUser(token);
      const who = user?.username || user?.email || "unknown";
      success(`authenticated as ${who}`);
      return;
    } catch (err) {
      warn(
        `Vercel token found but /v2/user rejected it: ${err.message}. Run \`vercel login\` or set a fresh VERCEL_TOKEN.`
      );
      return;
    }
  }

  const whoami = await exec("vercel", ["whoami"]);
  if (whoami.code === 0 && whoami.stdout.trim()) {
    success(`authenticated as ${whoami.stdout.trim()}`);
  } else {
    warn(
      "Not authenticated yet. `vclaw init` will rely on `vercel login` or VERCEL_TOKEN when it needs access."
    );
  }
}
