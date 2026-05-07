# Slack E2E Test Harness

End-to-end tests for `vclaw create --slack` and the post-install delivery + wake path.

## Prerequisites

- `slack` CLI installed and authenticated (`slack auth list` shows your workspace).
- `jq` and `curl` on PATH.
- An admin-capable user in the test workspace.
- Optional: `VCLAW_TEST_USER_TOKEN` env var for the user token used to post test messages. If absent, scripts read it from `~/.slack/credentials.json`.

## Layout

- `lib/slack-api.sh` — minimal Slack Web API wrapper (`auth.test`, `chat.postMessage`, `conversations.history`, `users.info`, `apps.manifest.*`).
- `lib/load-user-token.sh` — extracts the CLI user token from `~/.slack/credentials.json`.
- `manifest.template.json` — Slack app manifest template; substitutes `{{DEPLOYMENT_URL}}` at provision time.
- `send-and-verify.sh` — post a message, poll for the bot's reply within budget. Used standalone or by other scripts.
- `sleep-and-wake.sh` — same as send-and-verify but allows the sandbox to idle out first, then verifies wake.
- `provision-app.sh` — (stub) provision a Slack app via `slack manifest create`/`apps.manifest.create` and emit credentials JSON.

## Quick start

```bash
# 1. Run vclaw create --slack interactively (or scripted) to get a deployment.
# 2. Identify the bot user ID, test channel, and deployment URL.
# 3. Send a test message and verify the bot replies within 30s:

./send-and-verify.sh \
  --channel "C0123456789" \
  --bot-user "U0BOTID" \
  --message "ping $(date +%s)" \
  --budget 30
```

## Test scenarios

| Scenario | Script | What it asserts |
|---|---|---|
| Cold start (fresh deploy responds) | `send-and-verify.sh` | Bot replies within 30s of first message |
| Steady state | `send-and-verify.sh` (loop) | Replies stay sub-5s after warm |
| Wake from idle | `sleep-and-wake.sh` | After ≥10 min idle, first message wakes sandbox and gets a reply within 60s |
| Full vclaw flow | (TODO) `e2e-full.sh` | `vclaw create --slack` → install OAuth → message → verify, all in one run |

## What's missing

- `provision-app.sh` and `e2e-full.sh` — once the manual flow is proven, automate the create + install steps.
- CI wiring.
- Cleanup (`slack app delete`).
