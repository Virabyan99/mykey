#!/bin/sh
# Prints the host status as one JSON object (HostStatus in tests/harness/staging.ts).
# Prints no secret (the KMS check hands the seal key to openssl in a container
# and prints nothing of it). A value not measured is null, never a guess. The
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

# OpenBao (Run 2.7): what OpenBao itself says about its seal, asked over its
# bridge address with the host CA. null where it does not run or not answer.
sealed=null
seal_type=null
if [ -r /etc/mykey/pki/ca.crt ] && seal=$(curl -s --fail --max-time 5 --cacert /etc/mykey/pki/ca.crt \
	--resolve openbao:8200:10.78.3.2 https://openbao:8200/v1/sys/seal-status 2>/dev/null); then
	sealed=$(echo "$seal" | jq 'if has("sealed") then .sealed else null end' 2>/dev/null || echo null)
	seal_type=$(echo "$seal" | jq 'if has("type") then .type else null end' 2>/dev/null || echo null)
fi

# The KMS (Run 2.7): a TLS handshake with the seal certificate to the KMIP
# endpoint, from the KMS bridge and independent of OpenBao (a KMS outage does
# not seal a running OpenBao, FR-1.64). null without a certificate or KMS host.
PKI_IMAGE=postgres@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42
kms_reachable=null
if [ -n "${MYKEY_KMS_HOST:-}" ] && [ -e /etc/mykey/secrets/kms/seal.crt ] &&
	docker network inspect mykey_kms >/dev/null 2>&1; then
	# As OpenBao's uid, which owns the KMS directory (Run 2.7). The image has no
	# CA bundle; the host's is mounted, and verification stays on. A KMS outage
	# drops the handshake: --init passes timeout's signal on to openssl (as PID 1
	# it would ignore it), and -k kills what is left, so status never hangs.
	if timeout -k 5 15 docker run --init --rm --network mykey_kms --user 100:1000 --read-only --cap-drop ALL \
		--security-opt no-new-privileges -v /etc/mykey/secrets/kms:/kms:ro \
		-v /etc/ssl/certs/ca-certificates.crt:/roots.pem:ro --entrypoint openssl "$PKI_IMAGE" \
		s_client -connect "$MYKEY_KMS_HOST:5696" -servername "$MYKEY_KMS_HOST" -verify_return_error -CAfile /roots.pem \
		-cert /kms/seal.crt -key /kms/seal.key </dev/null >/dev/null 2>&1; then
		kms_reachable=true
	else
		kms_reachable=false
	fi
fi

# The service gate (Run 3.1, P-43): what the record says, not whether it is valid
# for this host (the API decides that per request).
gate=absent
if [ -e /etc/mykey/gate/gate.json ]; then
	gate=$(jq -r 'if (.state == "open" or .state == "closed") and .version == 1 then .state else "invalid" end' \
		/etc/mykey/gate/gate.json 2>/dev/null || echo invalid)
fi

# Scopes in review (Run 3.8, P-57): one read-only statement through the
# PostgreSQL container's local socket; null when it cannot be read.
review_open=null
count=$(docker exec -u postgres mykey-postgres-1 psql -d postgres -Atq -c \
	"BEGIN READ ONLY; SELECT (SELECT count(*) FROM app.organization WHERE state = 'needs_review') + (SELECT count(*) FROM app.project WHERE state = 'needs_review') + (SELECT count(*) FROM app.environment WHERE state = 'needs_review'); COMMIT;" \
	2>/dev/null | head -n 1 || true)
case "$count" in
'' | *[!0-9]*) ;;
*) review_open=$count ;;
esac

# The provisioner container's health (Run 3.8): healthy, unhealthy, or absent.
provisioner=absent
if health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' mykey-provisioner-1 2>/dev/null); then
	case "$health" in
	healthy) provisioner=healthy ;;
	*) provisioner=unhealthy ;;
	esac
fi

jq -n \
	--arg host "$host" --arg bootId "$boot_id" --arg time "$time" --arg gate "$gate" --arg provisioner "$provisioner" --argjson reviewOpen "$review_open" \
	--argjson chronyOffsetMs "$chrony_offset_ms" --argjson clockSynced "$clock_synced" \
	--argjson containers "$containers" --argjson pendingRevert "$pending" \
	--argjson firewallLoaded "$firewall_loaded" --argjson sets "$sets" --argjson sshListen "$ssh_listen" \
	--argjson sealed "$sealed" --argjson sealType "$seal_type" --argjson kmsReachable "$kms_reachable" \
	'{ host: $host, bootId: $bootId, time: $time, chronyOffsetMs: $chronyOffsetMs, clockSynced: $clockSynced,
	   containers: $containers, sealed: $sealed, sealType: $sealType, kmsReachable: $kmsReachable, pendingRevert: $pendingRevert,
	   firewall: { loaded: $firewallLoaded, sets: $sets }, sshListen: $sshListen, gate: $gate,
	   reviewOpen: $reviewOpen, provisioner: $provisioner }'
