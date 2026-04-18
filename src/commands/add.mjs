import { parseArgs } from "node:util";
import { connectDiscord } from "../steps/connect-discord.mjs";
import { connectTelegram } from "../steps/connect-telegram.mjs";
import { connectWhatsApp } from "../steps/connect-whatsapp.mjs";
import { provisionSlack } from "../steps/provision-slack.mjs";
import { resolveDeploymentContext } from "../steps/resolve-deployment-context.mjs";
import {
  dim,
  isInteractive,
  log,
  prompt,
  promptMasked,
  step,
  success,
  warn,
} from "../ui.mjs";

const CHANNELS = ["slack", "telegram", "discord", "whatsapp"];

const usage = `
  vclaw add <channel> [options]

  Attach a channel (slack | telegram | discord | whatsapp) to an
  already-deployed vercel-openclaw project.

  Project discovery (precedence: flag → .vercel/project.json → prompt):
    --url <url>                  Deployment URL
    --project <name>             Vercel project name (if not in linked dir)
    --scope <slug>               Vercel team scope
    --dir <path>                 Directory containing .vercel/project.json (default: cwd)

  Secret discovery (precedence: flag → Vercel project env → prompt):
    --admin-secret <secret>
    --protection-bypass <secret>

  Slack options:
    --branch <create|connect|skip>
    --bot-token <token>
    --signing-secret <secret>
    --config-token <token>
    --refresh-token <token>

  Telegram / Discord options:
    --bot-token <token>

  Discord extras:
    --no-auto-configure-endpoint
    --no-auto-register-command
    --force-overwrite-endpoint

  WhatsApp options:
    --phone-number-id <id>
    --access-token <token>
    --verify-token <token>
    --app-secret <secret>
    --business-account-id <id>
`;

export async function add(argv) {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    console.log(usage);
    return;
  }

  const channel = argv[0];
  if (!CHANNELS.includes(channel)) {
    throw new Error(
      `Unknown channel "${channel}". Supported: ${CHANNELS.join(", ")}.`,
    );
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      url: { type: "string" },
      project: { type: "string" },
      scope: { type: "string" },
      dir: { type: "string" },
      "admin-secret": { type: "string" },
      "protection-bypass": { type: "string" },
      // Slack
      branch: { type: "string" },
      "bot-token": { type: "string" },
      "signing-secret": { type: "string" },
      "config-token": { type: "string" },
      "refresh-token": { type: "string" },
      // Discord
      "auto-configure-endpoint": { type: "boolean" },
      "auto-register-command": { type: "boolean" },
      "force-overwrite-endpoint": { type: "boolean" },
      "no-auto-configure-endpoint": { type: "boolean" },
      "no-auto-register-command": { type: "boolean" },
      // WhatsApp
      "phone-number-id": { type: "string" },
      "access-token": { type: "string" },
      "verify-token": { type: "string" },
      "app-secret": { type: "string" },
      "business-account-id": { type: "string" },
    },
    allowPositionals: false,
  });

  log(`vclaw add ${channel} — resolving deployment\n`);

  const ctx = await resolveDeploymentContext({
    dir: values.dir,
    url: values.url,
    project: values.project,
    scope: values.scope,
    adminSecret: values["admin-secret"],
    protectionBypassSecret: values["protection-bypass"],
  });

  step(`Target: ${ctx.url}`);
  if (ctx.projectId) {
    log(dim(`  project: ${ctx.projectId}${ctx.teamId ? ` · team: ${ctx.teamId}` : ""}`));
  }

  switch (channel) {
    case "slack":
      return await addSlack(ctx, values);
    case "telegram":
      return await addTelegram(ctx, values);
    case "discord":
      return await addDiscord(ctx, values);
    case "whatsapp":
      return await addWhatsApp(ctx, values);
    default:
      throw new Error(`Unhandled channel: ${channel}`);
  }
}

async function addSlack(ctx, values) {
  const branch = values.branch;
  if (branch && !["create", "connect", "skip"].includes(branch)) {
    throw new Error(
      `--branch must be one of create|connect|skip (got "${branch}").`,
    );
  }

  const result = await provisionSlack(ctx.url, ctx.adminSecret, {
    canPrompt: isInteractive(),
    preselectedBranch: branch || null,
    botToken: values["bot-token"] || null,
    signingSecret: values["signing-secret"] || null,
    configToken: values["config-token"] || null,
    refreshToken: values["refresh-token"] || null,
    protectionBypassSecret: ctx.protectionBypassSecret || undefined,
  });

  if (result.ok === false) {
    throw new Error(
      `Slack provisioning failed${result.branch ? ` (branch: ${result.branch})` : ""}.`,
    );
  }
  if (result.configured === false && result.branch === "create") {
    warn(
      "Slack app was created but OAuth install did not complete — finish from the admin panel or re-run `vclaw add slack`.",
    );
  } else {
    success("Slack added.");
  }
}

async function addTelegram(ctx, values) {
  let botToken = values["bot-token"];
  if (!botToken) {
    if (!isInteractive()) {
      throw new Error(
        "--bot-token is required for `add telegram` in non-interactive mode.",
      );
    }
    log(dim("  Get a bot token from @BotFather in Telegram."));
    botToken = await promptMasked("Telegram bot token");
  }
  if (!botToken) throw new Error("Telegram bot token is required.");

  const result = await connectTelegram(ctx.url, ctx.adminSecret, botToken, {
    protectionBypassSecret: ctx.protectionBypassSecret || undefined,
  });
  if (!result.ok) {
    throw new Error(`Telegram connect failed (status ${result.status}).`);
  }
  success("Telegram added.");
}

async function addDiscord(ctx, values) {
  let botToken = values["bot-token"];
  if (!botToken) {
    if (!isInteractive()) {
      throw new Error(
        "--bot-token is required for `add discord` in non-interactive mode.",
      );
    }
    log(
      dim(
        "  Get a bot token from the Discord developer portal → your app → Bot → Reset Token.",
      ),
    );
    botToken = await promptMasked("Discord bot token");
  }
  if (!botToken) throw new Error("Discord bot token is required.");

  const autoConfigureEndpoint = values["no-auto-configure-endpoint"]
    ? false
    : values["auto-configure-endpoint"];
  const autoRegisterCommand = values["no-auto-register-command"]
    ? false
    : values["auto-register-command"];

  const result = await connectDiscord(ctx.url, ctx.adminSecret, botToken, {
    protectionBypassSecret: ctx.protectionBypassSecret || undefined,
    autoConfigureEndpoint,
    autoRegisterCommand,
    forceOverwriteEndpoint: values["force-overwrite-endpoint"],
  });
  if (!result.ok) {
    throw new Error(`Discord connect failed (status ${result.status}).`);
  }
  success("Discord added.");
}

async function addWhatsApp(ctx, values) {
  const interactive = isInteractive();
  let phoneNumberId = values["phone-number-id"];
  let accessToken = values["access-token"];
  let verifyToken = values["verify-token"];
  let appSecret = values["app-secret"];
  const businessAccountId = values["business-account-id"] || null;

  if (!phoneNumberId && interactive) {
    phoneNumberId = await prompt("WhatsApp phone number ID");
  }
  if (!accessToken && interactive) {
    accessToken = await promptMasked("WhatsApp access token");
  }
  if (!verifyToken && interactive) {
    verifyToken = await promptMasked("WhatsApp webhook verify token");
  }
  if (!appSecret && interactive) {
    appSecret = await promptMasked("WhatsApp app secret");
  }

  const missing = [];
  if (!phoneNumberId) missing.push("--phone-number-id");
  if (!accessToken) missing.push("--access-token");
  if (!verifyToken) missing.push("--verify-token");
  if (!appSecret) missing.push("--app-secret");
  if (missing.length) {
    throw new Error(
      `Missing WhatsApp credentials: ${missing.join(", ")}${interactive ? "" : " (stdin is not a TTY — pass flags)"}.`,
    );
  }

  const result = await connectWhatsApp(ctx.url, ctx.adminSecret, {
    phoneNumberId,
    accessToken,
    verifyToken,
    appSecret,
    businessAccountId: businessAccountId || undefined,
    protectionBypassSecret: ctx.protectionBypassSecret || undefined,
  });
  if (!result.ok) {
    throw new Error(`WhatsApp connect failed (status ${result.status}).`);
  }
  success("WhatsApp added.");
}
