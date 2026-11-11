#!/bin/sh
# Applies a network change with a timed automatic revert (Review focus 1).
#
#   apply-with-revert.sh <name> <apply-command> <revert-command> <seconds>
#
# The revert is armed first, as a systemd timer that does not depend on this
# connection. Then the change is applied, also under systemd, so that it
# finishes even when the connection that asked for it is cut by the change.
# `systemctl stop mykey-revert-<name>.timer` confirms the change; nothing
# else does.
set -eu

if [ "$#" -ne 4 ]; then
	echo "usage: apply-with-revert.sh <name> <apply-command> <revert-command> <seconds>" >&2
	exit 2
fi
name=$1
apply=$2
revert=$3
seconds=$4
case "$name" in
'' | *[!a-z0-9-]*) echo "apply-with-revert: bad name" >&2 && exit 2 ;;
esac
case "$seconds" in
'' | *[!0-9]*) echo "apply-with-revert: seconds must be a number" >&2 && exit 2 ;;
esac

unit="mykey-revert-$name"
systemctl stop "$unit.timer" "$unit.service" 2>/dev/null || true
systemctl reset-failed "$unit.timer" "$unit.service" "mykey-apply-$name.service" 2>/dev/null || true

systemd-run --quiet --collect --on-active="$seconds" --timer-property=AccuracySec=1s \
	--unit="$unit" /bin/sh -c "$revert"
echo "revert armed: $unit in ${seconds}s"

if systemd-run --quiet --collect --wait --unit="mykey-apply-$name" /bin/sh -c "$apply"; then
	echo "applied: $name (confirm within ${seconds}s)"
else
	echo "apply failed: $name; reverting now" >&2
	journalctl --no-pager -n 20 -u "mykey-apply-$name.service" >&2 || true
	systemctl start "$unit.service" || true
	systemctl stop "$unit.timer" 2>/dev/null || true
	exit 1
fi
