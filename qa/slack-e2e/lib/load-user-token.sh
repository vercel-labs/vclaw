#!/usr/bin/env bash
# Extract the CLI's user token from ~/.slack/credentials.json (or env var).
# Sources of truth, in order:
#   $VCLAW_TEST_USER_TOKEN
#   ~/.slack/credentials.json (first workspace, or $SLACK_TEAM_ID if set)
#
# Exports SLACK_USER_TOKEN. Exits non-zero if no token can be located.

set -euo pipefail

# Auto-load qa/slack-e2e/.env.local if present (gitignored). Lets users keep
# the test user token out of their shell rc and out of git.
_THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$_THIS_DIR/.env.local" ]]; then
  set -a; source "$_THIS_DIR/.env.local"; set +a
fi

if [[ -n "${VCLAW_TEST_USER_TOKEN:-}" ]]; then
  export SLACK_USER_TOKEN="$VCLAW_TEST_USER_TOKEN"
  return 0 2>/dev/null || exit 0
fi

CREDS="$HOME/.slack/credentials.json"
if [[ ! -f "$CREDS" ]]; then
  echo "error: $CREDS not found and VCLAW_TEST_USER_TOKEN unset" >&2
  exit 1
fi

if [[ -n "${SLACK_TEAM_ID:-}" ]]; then
  TOKEN=$(jq -r --arg team "$SLACK_TEAM_ID" '.[$team].token // empty' "$CREDS")
else
  TOKEN=$(jq -r '(. | to_entries | first | .value.token) // empty' "$CREDS")
fi

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "error: no token in $CREDS (run 'slack login' first)" >&2
  exit 1
fi

export SLACK_USER_TOKEN="$TOKEN"
