#!/usr/bin/env bash
# Tiny Slack Web API wrapper. Source this; expects $SLACK_USER_TOKEN (or pass --token).
# Every function prints raw JSON on stdout and returns 0 on `ok:true`, 1 otherwise.

set -uo pipefail

SLACK_API="https://slack.com/api"

_slack_call() {
  local method="$1"; shift
  local token="${SLACK_TOKEN:-${SLACK_USER_TOKEN:-}}"
  if [[ -z "$token" ]]; then
    echo '{"ok":false,"error":"no_token"}' >&2
    return 1
  fi
  local resp
  resp=$(curl -sS -X POST "$SLACK_API/$method" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data "$@")
  echo "$resp"
  jq -e '.ok == true' >/dev/null 2>&1 <<<"$resp"
}

slack_auth_test() {
  _slack_call auth.test '{}'
}

# slack_post_message <channel> <text>
slack_post_message() {
  local channel="$1" text="$2"
  _slack_call chat.postMessage \
    "$(jq -nc --arg c "$channel" --arg t "$text" '{channel:$c, text:$t}')"
}

# slack_history <channel> <oldest_ts>
# Returns messages newer than oldest_ts (epoch seconds, fractional ok).
slack_history() {
  local channel="$1" oldest="${2:-0}"
  _slack_call conversations.history \
    "$(jq -nc --arg c "$channel" --arg o "$oldest" '{channel:$c, oldest:$o, limit:50, inclusive:false}')"
}

# slack_users_info <user_id>
slack_users_info() {
  _slack_call users.info \
    "$(jq -nc --arg u "$1" '{user:$u}')"
}

# slack_open_im <user_id>
# Opens (or returns existing) DM conversation with a user. Prints the JSON
# response; channel ID is at .channel.id.
slack_open_im() {
  _slack_call conversations.open \
    "$(jq -nc --arg u "$1" '{users:$u, return_im:true}')"
}

# slack_resolve_channel <name-or-id>
# Accepts C0123…, #channel-name, or channel-name; returns channel ID via conversations.list paging.
slack_resolve_channel() {
  local input="$1"
  if [[ "$input" =~ ^[CDG][A-Z0-9]+$ ]]; then
    echo "$input"; return 0
  fi
  input="${input#\#}"
  local cursor="" page id=""
  while :; do
    page=$(_slack_call conversations.list \
      "$(jq -nc --arg c "$cursor" '{types:"public_channel,private_channel", limit:200, cursor:$c}')") || return 1
    id=$(jq -r --arg n "$input" '.channels[]? | select(.name==$n) | .id' <<<"$page" | head -1)
    [[ -n "$id" ]] && { echo "$id"; return 0; }
    cursor=$(jq -r '.response_metadata.next_cursor // ""' <<<"$page")
    [[ -z "$cursor" ]] && break
  done
  echo "error: channel '$input' not found" >&2
  return 1
}
