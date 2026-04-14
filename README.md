# vclaw

CLI to set up and deploy [vercel-openclaw](https://github.com/vercel-labs/vercel-openclaw) with one command.

## Quick start

```bash
npx vclaw init --scope my-team
```

This will:

1. Check prerequisites (git, node >= 20, vercel CLI)
2. Clone `vercel-labs/vercel-openclaw`
3. Create and link a Vercel project
4. Provision Upstash Redis via the Vercel Marketplace
5. Optionally configure Vercel deployment protection and automation bypass
6. Generate an `ADMIN_SECRET` and push managed env vars
7. Deploy to production
8. Run launch verification

## Commands

### `vclaw init`

Full setup from zero to deployed.

```
Options:
  --name <name>            Vercel project name (default: openclaw)
  --scope <scope>          Vercel team scope
  --team <slug>            Deprecated alias for --scope
  --dir <path>             Clone destination (default: ./vercel-openclaw)
  --admin-secret <hex>     Provide a specific admin secret
  --cron-secret <hex>      Optional dedicated cron secret
  --deployment-protection <none|sso|password>
                           Optional Vercel deployment protection mode
  --protection-bypass-secret <secret>
                           Optional automation bypass secret
  --skip-deploy            Stop after provisioning
  --yes                    Skip confirmation prompts
```

### `vclaw verify`

Run launch verification against an existing deployment.

```
Options:
  --url <url>              Deployment URL (required)
  --admin-secret <secret>  Admin secret (required)
  --destructive            Include destructive phases
  --protection-bypass <s>  Deployment protection bypass secret
```

### `vclaw doctor`

Check local prerequisites without changing anything.

## Prerequisites

- Node.js >= 20
- git
- [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`)
- Vercel auth via `vercel login` or `VERCEL_TOKEN`

## Notes

- `vclaw` is a workflow wrapper around the installed Vercel CLI, not a replacement for it.
- For deploy-button parity, the default path only requires `ADMIN_SECRET`; Upstash is provisioned through the Marketplace integration.
- If you enable deployment protection through `vclaw`, it also configures `VERCEL_AUTOMATION_BYPASS_SECRET` so protected webhooks can still reach OpenClaw.

## License

MIT
