#!/bin/sh
# Sends one heartbeat to the off-host probe (Run 2.6, D-22): version 2 (Run 6.4,
# P-116), the boot id, the observation time and status.sh's checks. The URL
# and the Authorization header are in a root-only curl config; nothing here
# prints them. One attempt, 10 s; no retry loop (the timer runs every minute).
set -eu
CONFIG=/etc/mykey/secrets/heartbeat/curl.conf
status=$(/opt/mykey/hosts/checks/status.sh)
body=$(printf '%s' "$status" | jq -c '{v: 2, bootId: .bootId, observedAt: .time, checks: .checks}')
curl --silent --show-error --fail --max-time 10 --config "$CONFIG" \
  --request POST --header 'content-type: application/json' --data "$body" --output /dev/null
