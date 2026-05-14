# AGENTS.md

This repo owns the `vclaw` CLI. Read `README.md`, `bin/vclaw.mjs`, and the command implementation under `src/commands/` before changing setup behavior.

## vclaw create source selection

`vclaw create` has two different source modes, and agents must choose intentionally:

- Default / no `--dir`: creates or updates a managed workspace under `~/.vclaw/<scope>/<project>/app` and deploys that clone. Use this for clean end-to-end install testing from the published/default wrapper source.
- `--dir /Users/johnlindquist/dev/vercel-openclaw`: uses the local checkout as the deployment source. Use this when validating local `vercel-openclaw` fixes, bundle-compatibility changes, admin/debug patches, or any change that has not landed in the managed clone source yet.

For production debugging against the local checkout, prefer:

```bash
node bin/vclaw.mjs create \
  --dir /Users/johnlindquist/dev/vercel-openclaw \
  --scope vercel-internal-playground \
  --auto-project-name \
  --auto-link \
  --admin-secret "$ADMIN_SECRET"
```

`--auto-link` writes `.vercel/project.json`, pulls admin/protection metadata into `.env.local`, and ensures local ignore rules protect that file. Never print or commit `.env.local` values.

If a deploy from the managed workspace fails but the local checkout is expected to contain the fix, rerun with `--dir /Users/johnlindquist/dev/vercel-openclaw` before diagnosing the app as still broken. The managed clone and the local checkout can intentionally differ.
