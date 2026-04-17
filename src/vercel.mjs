import { exec, spawn } from "./shell.mjs";

function withGlobalArgs(args, { scope, nonInteractive = false } = {}) {
  const fullArgs = [];
  if (scope) {
    fullArgs.push("--scope", scope);
  }
  if (nonInteractive) {
    fullArgs.push("--non-interactive");
  }
  fullArgs.push(...args);
  return fullArgs;
}

function formatCommand(args) {
  return `vercel ${args.join(" ")}`.trim();
}

export async function vercelExec(args, opts = {}) {
  return exec("vercel", withGlobalArgs(args, opts), opts);
}

/**
 * Run vercel with stdio inherited so the user can answer interactive prompts
 * (Y/n, multi-choice lists) directly. Use this for any `vercel` subcommand
 * that reads from a TTY — notably `integration add`, which asks "Do you want
 * to link this resource to the current project?" and bails silently with
 * code 0 when stdin is piped.
 */
export async function vercelSpawn(args, opts = {}) {
  return spawn("vercel", withGlobalArgs(args, opts), {
    cwd: opts.cwd,
    env: opts.env,
  });
}

export async function vercelRun(args, opts = {}) {
  const result = await vercelExec(args, opts);
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout;
    throw new Error(
      `\`${formatCommand(withGlobalArgs(args, opts))}\` exited with code ${result.code}${detail ? `:\n${detail}` : ""}`
    );
  }
  return result;
}

export async function vercelJson(args, opts = {}) {
  const result = await vercelRun(args, opts);
  return parseJsonOutput(result.stdout, formatCommand(withGlobalArgs(args, opts)));
}

export function parseJsonOutput(stdout, label = "vercel command") {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${label} did not return valid JSON.\nOutput:\n${stdout || "<empty>"}`
    );
  }
}

export function extractDeploymentUrl(stdout) {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^https?:\/\//.test(line)) {
      return line;
    }
  }

  throw new Error(
    `Could not find a deployment URL in Vercel output.\nOutput:\n${stdout || "<empty>"}`
  );
}

// Vercel project naming rules: lowercase letters, digits, hyphens and
// underscores, 1–100 chars, no leading/trailing hyphen. See
// https://vercel.com/docs/projects/overview#project-name
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,98}[a-z0-9]$|^[a-z0-9]$/;

export function validateProjectName(name) {
  if (typeof name !== "string" || name.length === 0) {
    return "Project name is required.";
  }
  if (name.length > 100) {
    return "Project name must be 100 characters or fewer.";
  }
  if (name !== name.toLowerCase()) {
    return "Project name must be lowercase.";
  }
  if (!NAME_RE.test(name)) {
    return "Project name must use only lowercase letters, digits, hyphens, and underscores, and must not start or end with a hyphen.";
  }
  return null;
}

export function getAutomationBypassSecret(protectionBypass) {
  if (!protectionBypass || typeof protectionBypass !== "object") {
    return undefined;
  }

  return Object.keys(protectionBypass).find((secret) => {
    const config = protectionBypass[secret];
    return config?.scope === "automation-bypass";
  });
}
