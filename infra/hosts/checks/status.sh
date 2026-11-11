#!/bin/sh
# Prints the host status as one JSON object (HostStatus in tests/harness/staging.ts).
# Reads no secret. A value that was not measured is null, never a guess. The
# caller adds clockOffsetMs (host clock against its own) from `time`.
set -eu

EGRESS=/opt/mykey/hosts/firewall/mykey-egress.sh

host=unknown
if [ -r /etc/mykey/host.env ]; then
	. /etc/mykey/host.env
	host=${MYKEY_HOST:-unknown}
fi

boot_id=$(cat /proc/sys/kernel/random/boot_id)
time=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)

# chronyc -c tracking: field 5 is the system clock offset in seconds,
# field 14 the leap status. No measurement while chrony is not synchronised.
chrony_offset_ms=null
clock_synced=false
if tracking=$(chronyc -c tracking 2>/dev/null); then
	if [ "$(echo "$tracking" | awk -F, '{ print $14 }')" = "Normal" ]; then
		clock_synced=true
		chrony_offset_ms=$(echo "$tracking" | awk -F, '{ v = $5 * 1000; if (v < 0) v = -v; printf "%.3f", v }')
	fi
fi

containers='{}'
if command -v docker >/dev/null 2>&1 && ids=$(docker ps -aq 2>/dev/null) && [ -n "$ids" ]; then
	# Selected fields only: the environment of a container is never printed.
	# shellcheck disable=SC2086
	containers=$(docker inspect --format '{{.Name}}	{{.State.Status}}	{{.State.Pid}}	{{.State.StartedAt}}	{{.Image}}' $ids |
		jq -R -s 'split("\n") | map(select(length > 0) | split("\t")) |
			map({ key: (.[0] | ltrimstr("/")), value: { state: .[1], pid: (.[2] | tonumber), startedAt: .[3], imageId: .[4] } }) | from_entries')
fi

pending=$(systemctl list-timers --all --no-legend --plain 'mykey-revert-*.timer' 2>/dev/null |
	awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^mykey-revert-.*\.timer$/) print $i }' |
	sed -e 's/^mykey-revert-//' -e 's/\.timer$//' | jq -R -s 'split("\n") | map(select(length > 0))')

firewall_loaded=false
sets='{}'
if nft list table inet mykey >/dev/null 2>&1; then
	firewall_loaded=true
	sets=$("$EGRESS" counts | jq -R -s 'split("\n") | map(select(length > 0) | split(" ")) | map({ key: .[0], value: (.[1] | tonumber) }) | from_entries')
fi

ssh_listen=$(ss -Hltn 'sport = :22' 2>/dev/null | awk '{ print $4 }' | jq -R -s 'split("\n") | map(select(length > 0))')

jq -n \
	--arg host "$host" --arg bootId "$boot_id" --arg time "$time" \
	--argjson chronyOffsetMs "$chrony_offset_ms" --argjson clockSynced "$clock_synced" \
	--argjson containers "$containers" --argjson pendingRevert "$pending" \
	--argjson firewallLoaded "$firewall_loaded" --argjson sets "$sets" --argjson sshListen "$ssh_listen" \
	'{ host: $host, bootId: $bootId, time: $time, chronyOffsetMs: $chronyOffsetMs, clockSynced: $clockSynced,
	   containers: $containers, sealed: null, sealType: null, kmsReachable: null, pendingRevert: $pendingRevert,
	   firewall: { loaded: $firewallLoaded, sets: $sets }, sshListen: $sshListen }'
