<p align="center">
  <img src="https://raw.githubusercontent.com/vercel-labs/vclaw/HEAD/assets/openclaw-logo.svg" width="96" height="96" alt="OpenClaw logo" />
</p>

<h1 align="center">vclaw</h1>

<p align="center">
  Deploy <a href="https://github.com/vercel-labs/vercel-openclaw">vercel-openclaw</a> from the command line.
</p>

`vclaw` is a workflow wrapper around the installed Vercel CLI. It automates the same high-level setup path as the OpenClaw deploy button:

- clone `vercel-labs/vercel-openclaw`
- link a Vercel project
- provision Redis via the Vercel Marketplace
- configure managed environment variables
- optionally enable deployment protection plus automation bypass
- deploy
- run launch verification

## Install

Run without installing:

```bash
npx @vercel/vclaw create --scope my-team
```

Or install globally:

```bash
npm i -g @vercel/vclaw
vclaw create --scope my-team
```

## Prerequisites

- Node.js `>=20`
- `git`
- the Vercel CLI installed: `npm i -g vercel`
- Vercel auth via `vercel login` or `VERCEL_TOKEN`

You can check your environment first:

```bash
vclaw doctor
```

## Quick Start

Deploy OpenClaw into a Vercel team:

```bash
npx @vercel/vclaw create --scope my-team
```

This will:

1. check local prerequisites
2. pick a Vercel team scope (interactive when you have more than one)
3. clone `vercel-labs/vercel-openclaw`
4. create and link a Vercel project (prompts if the default name is taken)
5. provision Redis via the Vercel Marketplace (Redis Cloud)
6. optionally configure Vercel Deployment Protection
7. prompt for the `ADMIN_SECRET` (the admin-dashboard password)
8. push managed env vars (`ADMIN_SECRET`, `CRON_SECRET`, `VERCEL_AUTOMATION_BYPASS_SECRET`)
9. deploy to production
10. run launch verification against the new deployment

## Common Flows

Basic deploy:

```bash
vclaw create --scope my-team
```

Choose a project name and target directory:

```bash
vclaw create --scope my-team --name my-openclaw --dir ~/dev/my-openclaw
```

Use your own admin secret:

```bash
vclaw create --scope my-team --admin-secret "$(openssl rand -hex 32)"
```

Set a dedicated cron secret:

```bash
vclaw create --scope my-team --cron-secret "$(openssl rand -hex 32)"
```

Enable deployment protection and configure webhook bypass automatically:

```bash
vclaw create --scope my-team --deployment-protection sso
```

Or password protection:

```bash
vclaw create --scope my-team --deployment-protection password
```

Prepare everything but stop before deploy:

```bash
vclaw create --scope my-team --skip-deploy
```

## Commands

### `vclaw create`

Full setup from zero to deployed.

> When invoked interactively without `--admin-secret`, `vclaw create` prompts for the admin-dashboard password (masked, confirmed) — this is the value the user will later type into the deployed admin UI, so it isn't auto-generated.

```text
--name <name>                      Vercel project name (default: openclaw)
--scope <scope>                    Vercel team scope
--team <slug>                      Deprecated alias for --scope
--dir <path>                       Clone destination (default: ./vercel-openclaw)
--admin-secret <hex>               Use a specific admin secret
--cron-secret <hex>                Optional dedicated cron secret
--deployment-protection <mode>     Optional protection mode: none | sso | password
--protection-bypass-secret <s>     Optional automation bypass secret
--skip-deploy                      Stop after provisioning
--yes                              Skip confirmation prompts where possible
```

Notes:

- `--yes` does not bypass first-time marketplace terms acceptance if the integration requires a browser step.
- `--deployment-protection` also injects `VERCEL_AUTOMATION_BYPASS_SECRET` so protected incoming webhooks can still reach OpenClaw.
- `ADMIN_SECRET` is the password you'll type into the deployed admin dashboard. When running interactively without `--admin-secret`, `vclaw create` prompts for it (masked, confirmed). Pass `--admin-secret <value>` for non-interactive runs.

### `vclaw verify`

Run launch verification against an existing deployment.

```text
--url <url>                        Deployment URL
--admin-secret <secret>            Admin secret for auth
--destructive                      Run destructive verification phases
--protection-bypass <secret>       Deployment protection bypass secret
```

Example:

```bash
vclaw verify \
  --url https://my-openclaw.vercel.app \
  --admin-secret "$ADMIN_SECRET"
```

Protected deployment:

```bash
vclaw verify \
  --url https://my-openclaw.vercel.app \
  --admin-secret "$ADMIN_SECRET" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"
```

### `vclaw doctor`

Check local prerequisites and current Vercel authentication status.

## Managed Environment Variables

`vclaw` manages these variables directly:

- `ADMIN_SECRET`
- `CRON_SECRET` when you provide `--cron-secret`
- `VERCEL_AUTOMATION_BYPASS_SECRET` when deployment protection or an explicit bypass secret is configured

It relies on the Vercel Marketplace Redis integration to supply:

- `REDIS_URL` (a Redis wire-protocol URL; `KV_URL` is also accepted as an alias)

## Behavior Notes

- `vclaw` assumes you already have the Vercel CLI installed.
- `vclaw` does not replace `vercel`; it orchestrates it.
- deploys are production deploys
- verification calls OpenClaw’s admin preflight and launch-verify endpoints
- if deployment protection is enabled, verify requests include the `x-vercel-protection-bypass` header when available

## Development

Run tests:

```bash
npm test
```

Preview the npm payload:

```bash
npm pack --dry-run
```

## Repository

- GitHub: `vercel-labs/vclaw`
- Source project deployed by this CLI: `vercel-labs/vercel-openclaw`

## License

MIT
