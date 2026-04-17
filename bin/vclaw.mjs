#!/usr/bin/env node

import { installFetchShim, mode as tapeMode, scrubTapeFile } from "../src/tape.mjs";
installFetchShim();

import { init } from "../src/commands/init.mjs";
import { verify } from "../src/commands/verify.mjs";
import { doctor } from "../src/commands/doctor.mjs";
import { setDebug } from "../src/debug.mjs";

const usage = `
  vclaw - set up and deploy vercel-openclaw with one command

  Usage:
    vclaw init   [options]       Clone, provision, and deploy openclaw
    vclaw verify [options]       Run launch verification against a deployment
    vclaw doctor                 Check local prerequisites and project health
    vclaw tape scrub <path>      Redact secrets from a record/replay tape file

  Init options:
    --name <name>            Vercel project name (prompted; default: vercel-openclaw)
    --scope <scope>          Vercel team scope
    --team <slug>            Deprecated alias for --scope
    --dir <path>             Clone destination (prompted; default: ./vercel-openclaw)
    --admin-secret <hex>     Use a specific admin secret (auto-generated if omitted)
    --cron-secret <hex>      Optional dedicated cron secret
    --deployment-protection <none|sso|password>
                              Optional Vercel deployment protection mode
    --protection-bypass-secret <secret>
                              Optional automation bypass secret (generated when protection is enabled)
    --skip-deploy            Stop after provisioning, don't deploy
    --yes                    Skip confirmation prompts

  Verify options:
    --url <url>              Deployment URL to verify
    --destructive            Run destructive verification phases
    --admin-secret <secret>  Admin secret for auth
    --protection-bypass <s>  Deployment protection bypass secret

  Global options:
    --debug, --verbose       Print detailed logs (also VCLAW_DEBUG=1)

  Environment:
    VERCEL_TOKEN             Optional alternative to \`vercel login\`
    VERCEL_AUTOMATION_BYPASS_SECRET
                              Optional default protection bypass secret for \`verify\`
    VCLAW_DEBUG              Set to 1 to enable debug logging
`;

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--debug") || rawArgs.includes("--verbose")) {
  setDebug(true);
}
if (tapeMode() !== "off") {
  console.log(`\x1b[2m[tape: ${tapeMode()} ${process.env.VCLAW_RECORD || process.env.VCLAW_REPLAY}]\x1b[0m`);
}
const filteredArgs = rawArgs.filter(
  (a) => a !== "--debug" && a !== "--verbose"
);
const command = filteredArgs[0];

if (!command || command === "--help" || command === "-h") {
  console.log(usage);
  process.exit(0);
}

if (command === "tape") {
  const sub = filteredArgs[1];
  if (sub !== "scrub") {
    console.error(`Unknown tape subcommand: ${sub ?? "(none)"}\n`);
    console.log(usage);
    process.exit(1);
  }
  const tapePath = filteredArgs[2];
  if (!tapePath) {
    console.error("Usage: vclaw tape scrub <path>");
    process.exit(1);
  }
  try {
    const n = scrubTapeFile(tapePath);
    console.log(`\x1b[32m✓\x1b[0m Scrubbed ${n} event${n === 1 ? "" : "s"} in ${tapePath}`);
    process.exit(0);
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Could not scrub ${tapePath}: ${err.message}`);
    process.exit(1);
  }
}

const commands = { init, verify, doctor };
const handler = commands[command];

if (!handler) {
  console.error(`Unknown command: ${command}\n`);
  console.log(usage);
  process.exit(1);
}

const commandArgs = filteredArgs.slice(1);
if (commandArgs[0] === "--help" || commandArgs[0] === "-h") {
  console.log(usage);
  process.exit(0);
}

// Clean Ctrl+C: clear any in-flight spinner line, print a message, exit 130.
process.on("SIGINT", () => {
  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[2K");
  }
  console.error("\n\x1b[33mCancelled.\x1b[0m");
  process.exit(130);
});

try {
  await handler(commandArgs);
} catch (err) {
  const raw = err?.message || String(err);
  const debugEnabled = Boolean(process.env.VCLAW_DEBUG);
  const { headline, detail } = formatError(raw);
  console.error(`\n\x1b[31m✗\x1b[0m vclaw ${command} failed: ${headline}`);
  if (detail) {
    console.error(debugEnabled ? detail : indent(detail));
  }
  if (!debugEnabled) {
    console.error(
      "\n\x1b[2mRe-run with --debug for full output.\x1b[0m"
    );
  } else if (err?.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}

function formatError(raw) {
  const lines = raw.split(/\r?\n/);
  const headline = lines[0] || raw;
  const rest = lines.slice(1).join("\n").trim();
  if (!rest) return { headline, detail: "" };
  // Truncate JSON-ish bodies in non-debug mode so the user sees a readable error.
  if (rest.length > 500 && !process.env.VCLAW_DEBUG) {
    return { headline, detail: `${rest.slice(0, 500)}…` };
  }
  return { headline, detail: rest };
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
