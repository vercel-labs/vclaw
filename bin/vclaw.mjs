#!/usr/bin/env node

import { init } from "../src/commands/init.mjs";
import { verify } from "../src/commands/verify.mjs";
import { doctor } from "../src/commands/doctor.mjs";

const usage = `
  vclaw - set up and deploy vercel-openclaw with one command

  Usage:
    vclaw init   [options]   Clone, provision, and deploy openclaw
    vclaw verify [options]   Run launch verification against a deployment
    vclaw doctor             Check local prerequisites and project health

  Init options:
    --name <name>            Vercel project name (default: openclaw)
    --scope <scope>          Vercel team scope
    --team <slug>            Deprecated alias for --scope
    --dir <path>             Clone destination (default: ./vercel-openclaw)
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

  Environment:
    VERCEL_TOKEN             Optional alternative to \`vercel login\`
    VERCEL_AUTOMATION_BYPASS_SECRET
                              Optional default protection bypass secret for \`verify\`
`;

const command = process.argv[2];

if (!command || command === "--help" || command === "-h") {
  console.log(usage);
  process.exit(0);
}

const commands = { init, verify, doctor };
const handler = commands[command];

if (!handler) {
  console.error(`Unknown command: ${command}\n`);
  console.log(usage);
  process.exit(1);
}

if (process.argv[3] === "--help" || process.argv[3] === "-h") {
  console.log(usage);
  process.exit(0);
}

try {
  await handler(process.argv.slice(3));
} catch (err) {
  console.error(`\nvclaw ${command} failed:`, err.message);
  process.exit(1);
}
