<p align="center">
  <img src="https://raw.githubusercontent.com/vercel-labs/vclaw/HEAD/assets/openclaw-logo.svg" width="96" height="96" alt="OpenClaw logo" />
</p>

<h1 align="center">vclaw</h1>

<p align="center">
  Deploy <a href="https://github.com/vercel-labs/vercel-openclaw">vercel-openclaw</a> from the command line.
</p>

## Quick Start

```bash
npx @vercel/vclaw create
```

`vclaw` creates a managed workspace under `~/.vclaw`, links a Vercel project, provisions Redis, grabs the latest published OpenClaw bundle, deploys to production, and runs launch verification.

### With a Telegram bot

Get a token from [@BotFather](https://t.me/BotFather) (`/newbot`), then:

```bash
npx @vercel/vclaw create --telegram "123456:AA...BotFatherToken"
```

Same flow as above, plus registers the Telegram webhook after verify — no admin-panel clicks.

### See all options

```bash
npx @vercel/vclaw --help
```

## Prerequisites

- Node.js `>=20`, `git`
- Vercel CLI: `npm i -g vercel`
- Logged in via `vercel login` (or `VERCEL_TOKEN`)

Check with:

```bash
npx @vercel/vclaw doctor
```

## Common Options

Pick a team or project name:

```bash
npx @vercel/vclaw create --scope my-team --name my-openclaw --telegram "<token>"
```

Add Slack alongside Telegram (both require the signing secret from your Slack app):

```bash
npx @vercel/vclaw create \
  --telegram "<token>" \
  --slack "xoxb-..." \
  --slack-signing-secret "abcd1234..."
```

Enable Vercel Deployment Protection (auto-wires the automation bypass):

```bash
npx @vercel/vclaw create --telegram "<token>" --deployment-protection sso
```

Stop before deploying:

```bash
npx @vercel/vclaw create --skip-deploy
```

## Commands

### `vclaw create`

```text
--name <name>                      Vercel project name (default: openclaw)
--scope <scope>                    Vercel team scope
--dir <path>                       Use an existing local vercel-openclaw project directory
--clone                            Clone/update vercel-openclaw into --dir or managed workspace
--bundle-url <url>                 Use a specific published OpenClaw bundle
--no-bundle                        Do not auto-use the latest published OpenClaw bundle
--admin-secret <hex>               Admin-dashboard password (prompted if omitted)
--cron-secret <hex>                Optional dedicated cron secret
--deployment-protection <mode>     none | sso | password
--protection-bypass-secret <s>     Optional automation bypass secret
--skip-deploy                      Stop after provisioning
--telegram <botToken>              Wire a Telegram bot after verify
--slack <botToken>                 Wire a Slack bot (requires --slack-signing-secret)
--slack-signing-secret <secret>    Slack signing secret (paired with --slack)
--yes                              Skip confirmation prompts where possible
```

`--telegram` and `--slack` are mutually exclusive with `--skip-deploy`.

### `vclaw verify`

Run launch verification against an existing deployment:

```bash
npx @vercel/vclaw verify --url https://my-openclaw.vercel.app --admin-secret "$ADMIN_SECRET"
```

Add `--protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` for protected deployments.

### `vclaw doctor`

Check local prerequisites and Vercel auth.

## Managed Environment Variables

`vclaw` sets:

- `ADMIN_SECRET` — the admin-dashboard password
- `CRON_SECRET` — when `--cron-secret` is passed
- `VERCEL_AUTOMATION_BYPASS_SECRET` — when deployment protection is enabled

Redis (`REDIS_URL` / `KV_URL`) comes from the Vercel Marketplace integration.

## Repository

- GitHub: `vercel-labs/vclaw`
- Source project: `vercel-labs/vercel-openclaw`

## License

MIT
