# Slack E2E Delivery Probe — TODO

## Background

A 4-agent investigation on 2026-05-05 found a `vclaw create --slack` regression:
deploys produced a sandbox that DID accept Slack webhooks and DID start the
workflow, but had a hung gateway (stale lockfile after warm-restore). Slack
showed "Verifying config…" forever; the bot never replied.

`vclaw verify` already runs `launch-verify`, but it doesn't exercise the
channel-delivery → workflow → gateway → response round-trip. The hung-gateway
case slipped through.

## What shipped (this branch)

- `provisionSlack` now emits an actionable diagnostic when `configured && connected
  && !deliveryReady` after the poll timeout, pointing operators at
  `vclaw doctor` and `vercel logs`.
- `evaluateSlackProvisioningOutcome` warn message updated similarly.
- `vclaw verify` accepts `--probe-delivery` / `--no-probe-delivery` / `--probe-timeout-ms`.
  Today's probe is "weak": it reuses `/api/channels/summary` signals
  (`configured && connected && deliveryReady`), the same signal post-OAuth
  uses. It does NOT yet do a synthetic Slack delivery + workflow poll.

## Full E2E probe (deferred)

The full probe described in the original task requires changes in BOTH repos:

### vclaw (this repo)

1. `src/steps/probe-slack-delivery.mjs` — new module:
   - Read live signing secret. Today `/api/channels/summary` does NOT return
     the secret (sensibly). Either:
     - add a tightly-scoped admin endpoint that returns a per-deploy "probe
       nonce + signature" (server signs the synthetic body so vclaw never
       holds the secret), OR
     - have vclaw POST a `__probe` body to a dedicated admin endpoint that
       generates the signed event server-side and routes it through the
       webhook handler.
   - POST synthetic `event_callback` (type `message`) to `/api/channels/slack/webhook`
     with the v0 HMAC the same way Slack does (timestamp + body, prefix `v0:`).
     Mirror `vercel-openclaw/src/app/api/channels/slack/webhook/route.ts`'s
     verifySlackSignature. Use a recognizable text marker (e.g. `__vclaw_probe_<uuid>`)
     so the run is filterable.
   - Poll `/api/admin/workflow-runs?marker=<uuid>` (NEW endpoint, see below)
     up to 60s for `status === "completed"` or `"failed"`.
   - Map terminal states:
     - `completed` → probe passed.
     - `failed` with `reason ∈ {"sandbox-not-ready","stale-lock","gateway-timeout"}` →
       fail with a hand-tailored hint per reason.
     - timeout → fail with "polling timed out; check `vclaw doctor`".

2. `src/commands/verify.mjs` — replace the weak `waitForSlackDeliveryReady`
   call with the new module when `--probe-delivery` is set.

3. `src/commands/create.mjs` — auto-enable the full probe when `--slack` is
   passed (skip-able with `--no-probe-delivery`). Wire after the existing
   `provisionSlack` succeeds.

### vercel-openclaw (sibling repo)

1. `app/api/admin/workflow-runs/route.ts` — list recent runs, filterable by
   `marker` (text-marker query). Return `[{id, status, reason?, startedAt,
   completedAt}]`. Auth: `Bearer ADMIN_SECRET`.

2. (Alternative) `app/api/admin/probe-slack/route.ts` — accepts a probe
   request from vclaw, generates the signed synthetic event server-side,
   POSTs it to its own webhook handler in-process, and returns the workflow
   run id. Avoids exporting the signing secret entirely.

3. Decide whether to gate probe-marker'd events out of channel reply paths
   so the synthetic message never user-visibly posts back. Simplest: any
   `event.text` starting with `__vclaw_probe_` short-circuits before the
   channel reply.

## Tests required for full probe

- happy path (synthetic event → run completed → probe ok)
- gateway hung (workflow run status `failed`, reason `stale-lock`) → exit
  with friendly error
- polling times out (no run found within budget) → exit with `vclaw doctor`
  hint
- signing secret mismatch (server rejects probe with 401) → exit with
  configuration error

## Acceptance

A future regression with the same shape (webhook accepted, workflow started,
gateway wedged) should be caught by `vclaw create --slack` before the user
sends their first real Slack message.
