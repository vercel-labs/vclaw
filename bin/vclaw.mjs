#!/usr/bin/env node

import { installFetchShim, mode as tapeMode, scrubTapeFile } from "../src/tape.mjs";
installFetchShim();

import { add } from "../src/commands/add.mjs";
import { chat } from "../src/commands/chat.mjs";
import { create } from "../src/commands/create.mjs";
import { verify } from "../src/commands/verify.mjs";
import { doctor } from "../src/commands/doctor.mjs";
import { setDebug } from "../src/debug.mjs";

const usage = `
  vclaw - set up and deploy vercel-openclaw with one command

  Usage:
    vclaw create [options]       Clone, provision, and deploy openclaw
    vclaw add <channel>          Attach slack|telegram|discord|whatsapp to a deployed project
    vclaw chat [options]         Open a terminal chat against a deployed openclaw
    vclaw verify [options]       Run launch verification against a deployment
    vclaw doctor                 Check local prerequisites and project health
    vclaw tape scrub <path>      Redact secrets from a record/replay tape file

  Create options:
    --name <name>            Vercel project name (prompted; default: vercel-openclaw)
    --claw-name <name>       Friendly alias for this claw (prompted; e.g. "builder_bot")
    --scope <scope>          Vercel team scope
    --team <slug>            Deprecated alias for --scope
    --dir <path>             Clone destination (prompted; default: ./vercel-openclaw)
    --admin-secret <secret>  Admin dashboard password (prompted masked + confirmed when omitted interactively; required non-interactively)
    --cron-secret <hex>      Optional dedicated cron secret
    --deployment-protection <none|sso|password>
                              Optional Vercel deployment protection mode
    --protection-bypass-secret <secret>
                              Optional automation bypass secret (generated when protection is enabled)
    --bundle-url <url>       Use pre-built esbuild bundle instead of npm install
    --skip-clone             Use --dir as-is without cloning or pulling
    --skip-redis             Skip Redis provisioning (use existing)
    --skip-deploy            Stop after provisioning, don't deploy
    --yes                    Skip confirmation prompts

  Verify options:
    --url <url>              Deployment URL to verify
    --destructive            Run destructive verification phases
    --admin-secret <secret>  Admin secret for auth
    --protection-bypass <s>  Deployment protection bypass secret

  Chat options:
    --name <claw>            Claw name from registry (see vclaw create; picker shown when omitted)
    --dir <path>             Path to linked vercel-openclaw clone (default: cwd)
    --project <name>         Vercel project name (alternative to --dir)
    --scope <slug>           Vercel team scope (use with --project)
    --url <url>              Deployment URL (auto-discovered when omitted)
    --admin-secret <secret>  Admin secret (auto-pulled from Vercel env / prompted)
    --protection-bypass <s>  Deployment protection bypass secret
                             (auto-pulled from Vercel project when omitted)
    --no-ensure              Skip the sandbox wake step (/api/admin/ensure?wait=1)
    --no-refresh             Skip the AI Gateway OIDC refresh (/api/admin/refresh-token)
    --openclaw-spec <spec>   Override npx spec (default: openclaw@latest)

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

const commands = { create, add, chat, verify, doctor };
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
