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

# One read-only statement as the superuser through the PostgreSQL container's
# socket (Run 6.4); fails when it cannot be read. PGPASSWORD is exported below.
pg_read() {
	out=$(docker exec -e PGPASSWORD -u postgres mykey-postgres-1 psql -U postgres -d postgres -Atq -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY;" -c "$1" -c "COMMIT;" 2>/dev/null) || return 1
	printf '%s\n' "$out" | head -n 1
}
CHECKS_DIR=$(dirname "$0")

# Scopes in review (Run 3.8, P-57): one read-only statement through the
# PostgreSQL container's local socket; null when it cannot be read. The
# superuser password goes through the environment (`-e PGPASSWORD` without a
# value), never onto a command line.
review_open=null
PGPASSWORD=$(cat /etc/mykey/secrets/postgres/superuser-password 2>/dev/null || true)
export PGPASSWORD
count=$(docker exec -e PGPASSWORD -u postgres mykey-postgres-1 psql -U postgres -d postgres -Atq -c \
	"BEGIN READ ONLY; SELECT (SELECT count(*) FROM app.organization WHERE state = 'needs_review') + (SELECT count(*) FROM app.project WHERE state = 'needs_review') + (SELECT count(*) FROM app.environment WHERE state = 'needs_review'); COMMIT;" \
	2>/dev/null | head -n 1 || true)
case "$count" in
'' | *[!0-9]*) ;;
*) review_open=$count ;;
esac

# Unresolved secret operations (Run 4.5, P-75; Run 6.4, M-3): the query of
# sql/operations-unresolved.sql. Null when it cannot be read.
operations_unresolved=null
count=$(docker exec -i -e PGPASSWORD -u postgres mykey-postgres-1 psql -U postgres -d postgres -Atq -v ON_ERROR_STOP=1 -f - \
	<"$CHECKS_DIR/sql/operations-unresolved.sql" 2>/dev/null | head -n 1 || true)
case "$count" in
'' | *[!0-9]*) ;;
*) operations_unresolved=$count ;;
esac

# Disk pressure (Run 6.3, P-115, D-49): the capacity record the API reads per
# mutation, written atomically into the gate directory (world-readable: sizes
# only). Written only by root and only when every volume was measured; a
# record that is not renewed becomes stale for the API after 180 s, which the
# API treats as unknown (expanding mutations 503). The thresholds are those of
# LIMITS.disk, kept equal by tests/unit/hosts/capacity.test.ts.
DISK_MIN_FREE_PERCENT=15
DISK_MIN_FREE_BYTES=4294967296
DISK_MIN_INODES_PERCENT=10
capacity_volumes='{}'
capacity_state=ok
capacity_complete=yes
measure() { # <name> <path>
	[ -n "$2" ] && [ -e "$2" ] || return 1
	line=$(df -B1 --output=size,avail,itotal,iavail "$2" 2>/dev/null | tail -n 1) || return 1
	# shellcheck disable=SC2086 # the four numbers of df's line
	set -- "$1" $line
	[ "$#" -eq 5 ] || return 1
	inodes=$(awk -v t="$4" -v f="$5" 'BEGIN { if (t == 0) print 100; else printf "%.2f", f * 100 / t }')
	low=$(awk -v s="$2" -v a="$3" -v i="$inodes" -v p="$DISK_MIN_FREE_PERCENT" -v b="$DISK_MIN_FREE_BYTES" -v n="$DISK_MIN_INODES_PERCENT" 'BEGIN { print ((a * 100 < s * p) || (a < b) || (i < n)) ? "low" : "ok" }')
	[ "$low" = low ] && capacity_state=low
	capacity_volumes=$(printf '%s' "$capacity_volumes" | jq -c --arg n "$1" --argjson s "$2" --argjson a "$3" --argjson i "$inodes" '. + { ($n): { freeBytes: $a, sizeBytes: $s, freeInodesPercent: $i } }') || return 1
}
volume_path() { docker volume inspect -f '{{.Mountpoint}}' "$1" 2>/dev/null || true; }
measure postgres "$(volume_path mykey_pgdata)" || capacity_complete=no
measure openbao "$(volume_path mykey_baodata)" || capacity_complete=no
measure bao-audit "$(volume_path mykey_baoaudit)" || capacity_complete=no
measure docker "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)" || capacity_complete=no
measure bao-rotated /var/lib/mykey/bao-audit/rotated || capacity_complete=no
if [ "$(id -u)" = 0 ] && [ -d /etc/mykey/gate ] && [ "$capacity_complete" = yes ]; then
	capacity_tmp=$(mktemp /etc/mykey/gate/.capacity.XXXXXX)
	if jq -n --arg time "$time" --arg state "$capacity_state" --argjson volumes "$capacity_volumes" '{ version: 1, observedAt: $time, state: $state, volumes: $volumes }' >"$capacity_tmp" &&
		chmod 0644 "$capacity_tmp" && mv -f "$capacity_tmp" /etc/mykey/gate/capacity.json; then
		:
	else
		rm -f "$capacity_tmp"
	fi
fi

# ---- Run 6.4 (P-116): the checks of heartbeat version 2. A check that cannot
# be read is null (captureSince: absent), never a guess. Drill hooks live in
# /etc/mykey/checks/ and exist only while a drill runs (alerts.staging.test.ts).
HOOKS=/etc/mykey/checks

# The firewall: the table is loaded (above); the drill flag reports it unloaded.
firewall_check=$firewall_loaded
[ -e "$HOOKS/firewall-unloaded" ] && firewall_check=false

# Disk: this run's own capacity record (Run 6.3), when every volume was measured.
disk_low=null
if [ "$capacity_complete" = yes ]; then
	if [ "$capacity_state" = low ]; then disk_low=true; else disk_low=false; fi
fi

# Credentials within LIMITS.machineToken.expiryWarningSeconds (604800 s) of
# expiry, as the credential repository counts them (expiring_soon).
credential_expiring=null
count=$(pg_read "SELECT count(*) FROM app.machine_credential WHERE state = 'active' AND effective_expires_at > now() AND effective_expires_at <= now() + interval '604800 seconds';") || count=
case "$count" in
'' | *[!0-9]*) ;;
*) credential_expiring=$count ;;
esac

# The capture (P-116): the control row's mode; a running capture since its
# last change. "idle" → null; unreadable → the key is left out (unknown).
capture='{}'
mode=$(pg_read "SELECT CASE WHEN capture_mode = 'idle' THEN 'idle' ELSE to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') END FROM app.service_control;") || mode=
case "$mode" in
idle) capture='{"captureSince":null}' ;;
[0-9][0-9][0-9][0-9]-*) capture=$(jq -n --arg s "$mode" '{captureSince: $s}') ;;
esac

# The backup: expected once Run 6.5 sets MYKEY_BACKUP_EXPECTED=yes; the newest
# eligible capture from app.backup_pair.
backup=null
expected=false
[ "${MYKEY_BACKUP_EXPECTED:-no}" = yes ] && expected=true
if newest=$(pg_read "SELECT coalesce(to_char(max(capture_started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), 'none') FROM app.backup_pair WHERE validation_status = 'eligible';"); then
	case "$newest" in
	none) backup=$(jq -n --argjson e "$expected" '{expected: $e, newestEligibleCaptureAt: null}') ;;
	[0-9][0-9][0-9][0-9]-*) backup=$(jq -n --argjson e "$expected" --arg n "$newest" '{expected: $e, newestEligibleCaptureAt: $n}') ;;
	esac
fi

# Audit (P-116): failing when the API's last health_down named audit, when
# OpenBao's audit directory takes no byte, when an archive unit failed, or when
# the oldest closed day not yet archived and verified ended more than 48 h ago.
audit_failing=null
audit_parts=0
audit_bad=false
if lines=$(docker logs --since 2m mykey-api-1 2>&1); then
	audit_parts=$((audit_parts + 1))
	last=$(printf '%s\n' "$lines" | grep '"event":"health_down"' | tail -n 1 | jq -r '.cause' 2>/dev/null || true)
	case "$last" in audit_unwritable | openbao_audit) audit_bad=true ;; esac
fi
if docker inspect mykey-openbao-1 >/dev/null 2>&1; then
	audit_parts=$((audit_parts + 1))
	docker exec mykey-openbao-1 sh -c 'printf x >/openbao/audit/.writable && rm -f /openbao/audit/.writable' >/dev/null 2>&1 || audit_bad=true
else
	audit_parts=$((audit_parts + 1))
fi
for unit in mykey-audit-archive.service mykey-bao-audit-rotate.service; do
	[ "$(systemctl is-failed "$unit" 2>/dev/null || true)" = failed ] && audit_bad=true
done
behind=$(pg_read "SELECT coalesce(coalesce((SELECT max(to_at) FROM audit.archive_segment WHERE stream = 'app' AND verified_at IS NOT NULL), (SELECT date_trunc('day', min(occurred_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' FROM audit.event)) + interval '1 day' < now() - interval '48 hours', false);") || behind=
case "$behind" in
t) audit_parts=$((audit_parts + 1)) audit_bad=true ;;
f) audit_parts=$((audit_parts + 1)) ;;
esac
if [ "$audit_bad" = true ]; then
	audit_failing=true
elif [ "$audit_parts" -eq 3 ]; then
	audit_failing=false
fi

# Certificates (names and dates only): the public one as the edge serves it,
# the internal PKI's, and the KMS client certificate where the host has a KMS.
# One that applies and cannot be read makes the list unknown.
certificates='[]'
cert_entry() { # <name> <openssl x509 input on stdin>
	dates=$(openssl x509 -noout -startdate -enddate 2>/dev/null) || return 1
	start=$(printf '%s\n' "$dates" | sed -n 's/^notBefore=//p')
	end=$(printf '%s\n' "$dates" | sed -n 's/^notAfter=//p')
	[ -n "$start" ] && [ -n "$end" ] || return 1
	start=$(date -u -d "$start" +%Y-%m-%dT%H:%M:%SZ) || return 1
	end=$(date -u -d "$end" +%Y-%m-%dT%H:%M:%SZ) || return 1
	certificates=$(printf '%s' "$certificates" | jq -c --arg n "$1" --arg b "$start" --arg a "$end" '. + [{ name: $n, notBefore: $b, notAfter: $a }]')
}
certs_ok=yes
if [ -n "${MYKEY_HOSTNAME:-}" ]; then
	# Through a file: a function at the end of a pipe runs in a subshell.
	served=$(mktemp)
	timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$MYKEY_HOSTNAME" </dev/null >"$served" 2>/dev/null || true
	cert_entry public <"$served" || certs_ok=no
	rm -f "$served"
fi
for name in ca api openbao postgres; do
	if [ -e "/etc/mykey/pki/$name.crt" ]; then
		cert_entry "internal-$name" <"/etc/mykey/pki/$name.crt" || certs_ok=no
	fi
done
if [ -n "${MYKEY_KMS_HOST:-}" ]; then
	cert_entry kms-client </etc/mykey/secrets/kms/seal.crt || certs_ok=no
fi
if [ -r "$HOOKS/certificates.extra.json" ]; then
	certificates=$(jq -c --argjson base "$certificates" '$base + .' "$HOOKS/certificates.extra.json" 2>/dev/null) || certs_ok=no
fi
[ "$certs_ok" = yes ] || certificates=null

# Units: every mykey-* unit systemd reports failed.
units_failed=null
if failed=$(systemctl list-units 'mykey-*' --state=failed --no-legend --plain 2>/dev/null); then
	units_failed=$(printf '%s\n' "$failed" | awk 'NF { print $1 }' | jq -R -s -c 'split("\n") | map(select(length > 0))')
fi
unset PGPASSWORD

checks=$(jq -n -c --argjson capture "$capture" \
	--argjson sealed "$sealed" --argjson kmsReachable "$kms_reachable" --argjson reviewOpen "$review_open" \
	--argjson operationsUnresolved "$operations_unresolved" --argjson firewallLoaded "$firewall_check" \
	--argjson diskLow "$disk_low" --argjson auditFailing "$audit_failing" --argjson backup "$backup" \
	--argjson certificates "$certificates" --argjson credentialExpiring "$credential_expiring" \
	--argjson unitsFailed "$units_failed" \
	'{ sealed: $sealed, kmsReachable: $kmsReachable, reviewOpen: $reviewOpen, operationsUnresolved: $operationsUnresolved,
	   firewallLoaded: $firewallLoaded, diskLow: $diskLow, auditFailing: $auditFailing, backup: $backup,
	   certificates: $certificates, credentialExpiring: $credentialExpiring, unitsFailed: $unitsFailed } + $capture')

# The provisioner container's health (Run 3.8): healthy, unhealthy, or absent.
provisioner=absent
if health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' mykey-provisioner-1 2>/dev/null); then
	case "$health" in
	healthy) provisioner=healthy ;;
	*) provisioner=unhealthy ;;
	esac
fi

jq -n \
	--arg host "$host" --arg bootId "$boot_id" --arg time "$time" --arg gate "$gate" --arg provisioner "$provisioner" --argjson reviewOpen "$review_open" --argjson operationsUnresolved "$operations_unresolved" \
	--argjson chronyOffsetMs "$chrony_offset_ms" --argjson clockSynced "$clock_synced" \
	--argjson containers "$containers" --argjson pendingRevert "$pending" \
	--argjson firewallLoaded "$firewall_loaded" --argjson sets "$sets" --argjson sshListen "$ssh_listen" \
	--argjson sealed "$sealed" --argjson sealType "$seal_type" --argjson kmsReachable "$kms_reachable" \
	--argjson checks "$checks" \
	'{ host: $host, bootId: $bootId, time: $time, chronyOffsetMs: $chronyOffsetMs, clockSynced: $clockSynced,
	   containers: $containers, sealed: $sealed, sealType: $sealType, kmsReachable: $kmsReachable, pendingRevert: $pendingRevert,
	   firewall: { loaded: $firewallLoaded, sets: $sets }, sshListen: $sshListen, gate: $gate,
	   reviewOpen: $reviewOpen, operationsUnresolved: $operationsUnresolved, provisioner: $provisioner,
	   checks: $checks }'
