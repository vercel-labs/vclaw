import { exec } from "./shell.mjs";

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

export function getAutomationBypassSecret(protectionBypass) {
  if (!protectionBypass || typeof protectionBypass !== "object") {
    return undefined;
  }

  return Object.keys(protectionBypass).find((secret) => {
    const config = protectionBypass[secret];
    return config?.scope === "automation-bypass";
  });
}
