#!/usr/bin/env bash
# Verify the bot wakes from idle and responds.
# Strategy:
#   1. Send a baseline message, confirm reply (warm path).
#   2. Wait $IDLE seconds for Vercel sandbox to suspend (default 600s = 10min).
#      Optionally accept --force-cold-url to hit an admin endpoint that forces
#      sandbox shutdown (faster than waiting). Not implemented yet.
#   3. Send a wake message, assert reply within $WAKE_BUDGET (default 60s).
#
# Usage:
#   sleep-and-wake.sh --channel <id|#name> --bot-user <Uxxx> [--idle 600] [--wake-budget 60]

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

CHANNEL=""
BOT_USER=""
IDLE=600
WAKE_BUDGET=60
WARM_BUDGET=30

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)      CHANNEL="$2"; shift 2 ;;
    --bot-user)     BOT_USER="$2"; shift 2 ;;
    --idle)         IDLE="$2"; shift 2 ;;
    --wake-budget)  WAKE_BUDGET="$2"; shift 2 ;;
    --warm-budget)  WARM_BUDGET="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$CHANNEL" && -n "$BOT_USER" ]] || {
  echo "--channel and --bot-user required" >&2; exit 2;
}

echo "=== phase 1: warm baseline ==="
"$HERE/send-and-verify.sh" \
  --channel "$CHANNEL" --bot-user "$BOT_USER" \
  --message "warm baseline $(date +%s)" --budget "$WARM_BUDGET"

echo ""
echo "=== phase 2: idle ${IDLE}s ==="
START=$(date +%s)
while [[ $(( $(date +%s) - START )) -lt $IDLE ]]; do
  REMAIN=$((IDLE - ($(date +%s) - START)))
  printf "\r  idling… %3ds remaining" "$REMAIN"
  sleep 5
done
echo ""

echo "=== phase 3: wake probe (budget ${WAKE_BUDGET}s) ==="
"$HERE/send-and-verify.sh" \
  --channel "$CHANNEL" --bot-user "$BOT_USER" \
  --message "wake probe $(date +%s)" --budget "$WAKE_BUDGET"
