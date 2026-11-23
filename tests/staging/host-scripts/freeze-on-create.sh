#!/usr/bin/env bash
# freeze-on-create.sh <environment id> <hold seconds> <arm seconds>   (Run 10.3, P-176, D-78)
#
# The credential drill's trigger, sent to the staging host for one run and
# started there as a transient unit (tests/harness/staging.ts hostUnit); never
# a host file, never on production. It follows OpenBao's audit device from its
# end (AUDIT_LOG) and, at the first request record of
# auth/token/create/machine-env-<environment id>, writes 1 to FREEZE_FILE
# (OpenBao's cgroup.freeze), holds for <hold> seconds and writes 0. OpenBao
# writes a request's audit record before it handles the request, so the
# create is received and left unanswered: the API gives up at its deadline
# with outcome_unknown.
#
# FREEZE_FILE reads 0 at every exit, a signal included. Exit 3 when nothing
# matched within <arm> seconds. Prints four lines of a word and a time in
# microseconds (armed, matched, frozen, thawed) and nothing of any audit line.
set -u

env_id=${1:?environment id}
hold=${2:?hold seconds}
arm=${3:?arm seconds}
: "${AUDIT_LOG:?}" "${FREEZE_FILE:?}"

now() { printf '%s' "${EPOCHREALTIME/./}"; }
thaw() { printf '0\n' > "$FREEZE_FILE" 2>/dev/null; }

tail_pid=""
sleep_pid=""
cleanup() {
	thaw
	[ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null
	[ -n "$sleep_pid" ] && kill "$sleep_pid" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

thaw
exec 3< <(exec tail -n 0 -F --sleep-interval=0.02 -- "$AUDIT_LOG" 2>/dev/null)
tail_pid=$!
sleep 0.2
printf 'armed %s\n' "$(now)"

path="auth/token/create/machine-env-$env_id\""
deadline=$((SECONDS + arm))
while :; do
	left=$((deadline - SECONDS))
	[ "$left" -le 0 ] && exit 3
	IFS= read -r -t "$left" line <&3 || exit 3
	case "$line" in
	*'"type":"request"'*)
		case "$line" in
		*"\"path\":\"$path"*)
			matched=$(now)
			printf '1\n' > "$FREEZE_FILE"
			frozen=$(now)
			printf 'matched %s\nfrozen %s\n' "$matched" "$frozen"
			# In the background, so a signal runs the trap at once, not after the hold.
			sleep "$hold" &
			sleep_pid=$!
			wait "$sleep_pid"
			sleep_pid=""
			thaw
			printf 'thawed %s\n' "$(now)"
			exit 0
			;;
		esac
		;;
	esac
done
