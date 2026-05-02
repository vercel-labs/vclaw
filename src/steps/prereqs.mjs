import { exec } from "../shell.mjs";
import { getUser, readVercelTokenWithSource } from "../vercel-api.mjs";
import { step, success, fail, warn } from "../ui.mjs";

export function formatVercelAuthError({ source, path, detail } = {}) {
  const summary = summarizeVercelAuthDetail(detail);
  if (source === "env") {
    return (
      "VERCEL_TOKEN is set, but Vercel rejected it.\n" +
      "Unset VERCEL_TOKEN or replace it with a valid token, then retry.\n" +
      "You can also run `vercel login` and rerun without VERCEL_TOKEN.\n" +
      (summary ? `\nVercel response: ${summary}` : "")
    );
  }
  if (source === "cli") {
    return (
      "Your Vercel CLI login has expired or is invalid.\n" +
      (path ? `\nAuth file:\n  ${path}` : "") +
      (summary ? `\nVercel response: ${summary}` : "") +
      "\n\nRun `vercel login`, then rerun `vclaw create`."
    );
  }
  return "You are not logged in to Vercel. Run `vercel login`, then rerun `vclaw create`.";
}

function summarizeVercelAuthDetail(detail) {
  if (!detail) return "";
  const status = String(detail).match(/failed \((\d+)\)/)?.[1];
  const jsonStart = String(detail).indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(String(detail).slice(jsonStart));
      const code = body?.error?.code;
      const message = body?.error?.message;
      const invalidToken = body?.error?.invalidToken ? " invalidToken" : "";
      return [status && `${status}`, code, message, invalidToken.trim()]
        .filter(Boolean)
        .join(" - ");
    } catch {
      // fall through to raw detail
    }
  }
  return String(detail);
}

export async function checkPrereqs({ requireVercelAuth = false } = {}) {
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
  const { token, source, path } = readVercelTokenWithSource();
  if (token) {
    try {
      const user = await getUser(token);
      const who = user?.username || user?.email || "unknown";
      success(`authenticated as ${who}`);
      return;
    } catch (err) {
      const message = formatVercelAuthError({
        source,
        path,
        detail: err.message,
      });
      if (requireVercelAuth) {
        throw new Error(message);
      }
      warn(message);
      return;
    }
  }

  const whoami = await exec("vercel", ["whoami"]);
  if (whoami.code === 0 && whoami.stdout.trim()) {
    success(`authenticated as ${whoami.stdout.trim()}`);
  } else {
    const message = formatVercelAuthError({ source: "none" });
    if (requireVercelAuth) {
      throw new Error(message);
    }
    warn(message);
  }
}
