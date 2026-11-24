#!/bin/sh
# Run 9.6 Task A (P-166, FR-1.100, D-72): one field record per calendar day,
# from the host's own facts. mykey-field-day.timer runs it at 00:10 UTC for the
# day before; `field-day.sh <YYYY-MM-DD>` recomputes one day by hand.
#
# It gathers, into a work directory removed on exit:
#   - the API container's journal lines of the day (its request log, P-42);
#   - the day's audit rows (action, actor kind and id, outcome), read-only
#     through the PostgreSQL container's socket as status.sh reads (Run 6.4);
#   - the newest eligible pair's capture time; the capacity record.
# Then collect.ts, run by the API image's node with no network and a read-only
# root, writes /var/lib/mykey/field/<date>.json: counts and timings only. The
# credential labels' mapping (labels.json) stays here; `host.ts <host>
# field-pull` copies the day records only. Nothing is printed but the date and
# its class.
set -euf
umask 077

day=${1:-$(date -u -d yesterday +%F)}
case "$day" in
[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
*)
	echo "usage: field-day.sh [YYYY-MM-DD]" >&2
	exit 64
	;;
esac
next=$(date -u -d "$day + 1 day" +%F)

state=/var/lib/mykey/field
install -d -m 0700 "$state"
work=$(mktemp -d "$state/.work.XXXXXX")
trap 'rm -rf "$work"' EXIT

image=$(sed -n 's/^API_IMAGE=//p' /etc/mykey/host.env | tail -n 1)
if [ -z "$image" ]; then
	echo "field-day.sh: API_IMAGE is not set in host.env" >&2
	exit 69
fi

TZ=UTC journalctl --utc -o cat CONTAINER_NAME=mykey-api-1 \
	--since "$day 00:00:00" --until "$next 00:00:00" >"$work/journal.txt" 2>/dev/null || :

PGPASSWORD=$(cat /etc/mykey/secrets/postgres/superuser-password)
export PGPASSWORD
pg() {
	docker exec -i -e PGPASSWORD -u postgres mykey-postgres-1 \
		psql -U postgres -d postgres -Atq -v ON_ERROR_STOP=1 -f -
}
pg >"$work/audit.jsonl" <<SQL || :
BEGIN READ ONLY;
SELECT json_build_object('action', action, 'actorKind', actor_kind, 'actorId', actor_id, 'outcome', outcome)
  FROM audit.event
 WHERE occurred_at >= DATE '$day' AND occurred_at < DATE '$next';
COMMIT;
SQL
pg >"$work/pair.txt" <<'SQL' || :
BEGIN READ ONLY;
SELECT coalesce(to_char(max(capture_started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
  FROM app.backup_pair
 WHERE validation_status = 'eligible';
COMMIT;
SQL
cp /etc/mykey/gate/capacity.json "$work/capacity.json" 2>/dev/null || :
chmod 0755 "$work"
# Not "$work"/*: set -f turns globbing off (Run 10.5, tests/unit/hosts/noglob.test.ts).
find "$work" -type f -exec chmod 0644 {} +

docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
	--user 0:0 --entrypoint node \
	--mount "type=bind,source=/opt/mykey/hosts/field,target=/field,readonly" \
	--mount "type=bind,source=$work,target=/in,readonly" \
	--mount "type=bind,source=$state,target=/state" \
	"$image" /field/collect.ts "$day"
