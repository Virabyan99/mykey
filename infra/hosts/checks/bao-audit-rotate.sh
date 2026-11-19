#!/bin/sh
# Rotates OpenBao's file audit device (Run 6.2, P-110, D-48) without losing a
# record, then leaves the closed file for `ops audit-archive`:
#
#  1. renames audit.log to audit-<UTC>.log inside the container (same
#     directory, so OpenBao keeps writing to the same inode);
#  2. sends SIGHUP, on which OpenBao 2.7.2 reopens the configured path;
#  3. waits until audit.log exists again (the reopen happened) and the old
#     file stopped growing (the same size twice, a second apart);
#  4. checks the old file ends with a newline after a complete JSON line;
#  5. copies it out to the rotated directory, compares the size, and only
#     then removes it from the container.
#
# It works through `docker exec` and `docker cp`, so it needs no path of the
# volume. A failure exits 1 and leaves the renamed file where it is: the next
# run (or an operator) finds it. Prints names and counts only.
#
# Settings: MYKEY_BAO_CONTAINER (default: the compose service `openbao` of
# project `mykey`), MYKEY_BAO_ROTATED_DIR (default /var/lib/mykey/bao-audit/rotated).
set -eu

audit_dir=/openbao/audit
live="$audit_dir/audit.log"
rotated=${MYKEY_BAO_ROTATED_DIR:-/var/lib/mykey/bao-audit/rotated}
container=${MYKEY_BAO_CONTAINER:-$(docker ps -q \
	--filter label=com.docker.compose.project=mykey \
	--filter label=com.docker.compose.service=openbao)}

fail() {
	echo "bao-audit-rotate: $1" >&2
	exit 1
}

[ -n "$container" ] || fail "OpenBao is not running"
inside() {
	docker exec "$container" sh -c "$1"
}

mkdir -p "$rotated"
if [ "$(id -u)" = 0 ]; then
	chown 1000:1000 "$rotated"
	chmod 0700 "$rotated"
fi

# A file a stopped run left behind is shipped first, under its own name.
left=$(inside "cd $audit_dir && ls audit-*.log 2>/dev/null || true")

if inside "test -s $live"; then
	name="audit-$(date -u +%Y%m%dT%H%M%SZ).log"
	inside "test ! -e $audit_dir/$name" || fail "$name exists already"
	inside "mv $live $audit_dir/$name"
	docker kill --signal HUP "$container" >/dev/null
	tries=0
	until inside "test -e $live"; do
		tries=$((tries + 1))
		[ "$tries" -le 60 ] || fail "OpenBao did not reopen $live after SIGHUP; $name is kept"
		sleep 0.5
	done
	left="$left $name"
fi

shipped=0
for name in $left; do
	previous=-1
	tries=0
	while :; do
		size=$(inside "wc -c < $audit_dir/$name" | tr -d ' ')
		[ "$size" = "$previous" ] && break
		previous=$size
		tries=$((tries + 1))
		[ "$tries" -le 60 ] || fail "$name is still growing"
		sleep 1
	done
	target="$rotated/$name"
	docker cp "$container:$audit_dir/$name" "$target.partial" >/dev/null
	copied=$(wc -c <"$target.partial" | tr -d ' ')
	[ "$copied" = "$size" ] || fail "$name: copied $copied bytes of $size"
	if [ "$size" -gt 0 ]; then
		[ "$(tail -c 1 "$target.partial" | od -An -tx1 | tr -d ' ')" = "0a" ] ||
			fail "$name does not end with a newline"
		tail -n 1 "$target.partial" | grep -q '^{.*}$' || fail "$name: its last line is not complete"
	fi
	mv "$target.partial" "$target"
	if [ "$(id -u)" = 0 ]; then
		chown 1000:1000 "$target"
		chmod 0400 "$target"
	fi
	inside "rm $audit_dir/$name"
	shipped=$((shipped + 1))
	echo "bao-audit-rotate: $name ($size bytes)"
done
echo "bao-audit-rotate: rotated $shipped"
