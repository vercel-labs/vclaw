#!/usr/bin/env bash
# Send a Slack message and assert the bot replies within a budget.
# Usage:
#   send-and-verify.sh --bot-user <Uxxx> [--channel <id-or-name>] [--message "..."] [--budget 30]
#
# If --channel is omitted, the script opens a DM with --bot-user and uses
# that conversation. This is the default since DMs don't require inviting
# the bot to a channel.
#
# Exit codes:
#   0  bot replied within budget
#   1  no reply within budget
#   2  bad usage / missing token

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/lib/load-user-token.sh"
# shellcheck disable=SC1091
source "$HERE/lib/slack-api.sh"

CHANNEL=""
BOT_USER=""
MESSAGE="vclaw e2e ping $(date +%s)"
BUDGET=30
POLL_INTERVAL=2

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)  CHANNEL="$2"; shift 2 ;;
    --bot-user) BOT_USER="$2"; shift 2 ;;
    --message)  MESSAGE="$2"; shift 2 ;;
    --budget)   BUDGET="$2"; shift 2 ;;
    --poll)     POLL_INTERVAL="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BOT_USER" ]]; then
  echo "error: --bot-user is required" >&2
  exit 2
fi

if [[ -n "$CHANNEL" ]]; then
  CHANNEL_ID=$(slack_resolve_channel "$CHANNEL")
  echo "channel: $CHANNEL_ID (named)"
else
  IM_RESP=$(slack_open_im "$BOT_USER") || {
    echo "could not open DM with $BOT_USER: $IM_RESP" >&2; exit 1;
  }
  CHANNEL_ID=$(jq -r '.channel.id' <<<"$IM_RESP")
  echo "channel: $CHANNEL_ID (dm with $BOT_USER)"
fi
echo "bot:     $BOT_USER"
echo "budget:  ${BUDGET}s"

POST_BEFORE=$(date +%s)
echo "→ posting: $MESSAGE"
POST_RESP=$(slack_post_message "$CHANNEL_ID" "$MESSAGE") || {
  echo "post failed: $POST_RESP" >&2
  exit 1
}
POST_TS=$(jq -r '.ts' <<<"$POST_RESP")
echo "  posted ts=$POST_TS"

DEADLINE=$((POST_BEFORE + BUDGET))
while [[ $(date +%s) -le $DEADLINE ]]; do
  sleep "$POLL_INTERVAL"
  HIST=$(slack_history "$CHANNEL_ID" "$POST_TS") || continue
  REPLY=$(jq -r --arg u "$BOT_USER" '
    .messages[]? | select(.user == $u or .bot_id != null) |
    select(.ts > "'"$POST_TS"'") |
    [.ts, (.text // "")] | @tsv
  ' <<<"$HIST" | head -1)
  if [[ -n "$REPLY" ]]; then
    REPLY_TS=$(cut -f1 <<<"$REPLY")
    REPLY_TXT=$(cut -f2- <<<"$REPLY")
    ELAPSED=$(awk -v a="$REPLY_TS" -v b="$POST_TS" 'BEGIN{printf "%.2f", a-b}')
    echo "✓ bot replied in ${ELAPSED}s"
    echo "  reply: $REPLY_TXT"
    exit 0
  fi
done

echo "✗ no bot reply within ${BUDGET}s" >&2
echo "  channel history dump:" >&2
slack_history "$CHANNEL_ID" "$POST_TS" | jq '.messages' >&2
exit 1
