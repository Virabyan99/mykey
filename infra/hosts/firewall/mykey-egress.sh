#!/bin/sh
# Manages the table `inet mykey` and its address sets.
#
#   mykey-egress.sh apply                     install and load the rules, fill the sets, enable the timer
#   mykey-egress.sh revert                    remove the rules (the revert of `apply`)
#   mykey-egress.sh refresh                   resolve egress-names.conf into the sets (1 h per address)
#   mykey-egress.sh block <purpose> <seconds> cut a purpose off; ends by itself
#   mykey-egress.sh maint <minutes>           open registry egress for a window
#   mykey-egress.sh maint-end                 close the window
#   mykey-egress.sh temp <name> on|off        a temporary include (public-ssh, drop-vpn-ssh); takes effect at the next apply
#   mykey-egress.sh counts                    "<set> <elements>" per line
set -eu

HERE=/opt/mykey/hosts
NAMES="$HERE/firewall/egress-names.conf"
RULES_SRC="$HERE/firewall/mykey.nft"
RULES=/etc/nftables.d/mykey.nft
STATE=/run/mykey
# Written by 30-ssh.sh apply, removed by its revert.
SSH_VPN_ONLY=/etc/systemd/system/ssh.socket.d/10-mykey.conf
PURPOSES="acme kms r2 probe apt registry"
SETS="dns ntp $PURPOSES blocked"

now() { date +%s; }

until_of() {
	if [ -f "$STATE/$1" ]; then cat "$STATE/$1"; else echo 0; fi
}

known_purpose() {
	case " $PURPOSES " in
	*" $1 "*) return 0 ;;
	*) echo "mykey-egress: unknown purpose '$1'" >&2 && return 1 ;;
	esac
}

# IPv4 addresses of a name, one per line. Prints nothing when it does not resolve.
resolve() {
	getent ahostsv4 "$1" 2>/dev/null | awk '$1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print $1 }' | sort -u
}

names_of() {
	awk -v p="$1" '$1 == p { print $2 }' "$NAMES"
}

members_of() {
	nft -j list set inet mykey "$1" |
		jq -r '.nftables[] | select(.set) | .set.elem[]? | if type == "object" then .elem.val else . end'
}

refresh() {
	mkdir -p "$STATE"
	t=$(now)
	batch=$(mktemp)
	resolved=0
	for purpose in $PURPOSES; do
		[ "$(until_of "block-$purpose")" -gt "$t" ] && continue
		ttl=1h
		if [ "$purpose" = registry ]; then
			end=$(until_of maint-until)
			[ "$end" -gt "$t" ] || continue
			ttl="$((end - t))s"
		fi
		for name in $(names_of "$purpose"); do
			for ip in $(resolve "$name"); do
				# destroy + add in one transaction renews the timeout without a gap.
				echo "destroy element inet mykey $purpose { $ip }" >>"$batch"
				echo "add element inet mykey $purpose { $ip timeout $ttl }" >>"$batch"
				resolved=$((resolved + 1))
			done
		done
	done
	if [ -s "$batch" ]; then nft -f "$batch"; fi
	rm -f "$batch"
	if [ "$resolved" -eq 0 ]; then
		echo "mykey-egress: no name resolved" >&2
		return 1
	fi
	echo "refreshed: $resolved addresses"
}

apply() {
	install -d -m 0755 /etc/nftables.d
	install -m 0644 "$RULES_SRC" "$RULES"
	# The firewall never closes the SSH path that is in use: while sshd still
	# listens publicly (30-ssh.sh not applied), port 22 stays open here too.
	if [ -f "$SSH_VPN_ONLY" ]; then temp public-ssh off; else temp public-ssh on; fi
	if [ -f /etc/nftables.conf ] && [ ! -f /etc/nftables.conf.dist ] && ! grep -q "MyKey" /etc/nftables.conf; then
		cp -p /etc/nftables.conf /etc/nftables.conf.dist
	fi
	cat >/etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
# MyKey: never `flush ruleset` here. Docker owns its own tables.
include "/etc/nftables.d/mykey.nft"
EOF
	chmod 0755 /etc/nftables.conf
	nft -c -f /etc/nftables.conf
	nft -f /etc/nftables.conf
	install -m 0644 "$HERE/systemd/mykey-egress-refresh.service" "$HERE/systemd/mykey-egress-refresh.timer" /etc/systemd/system/
	systemctl daemon-reload
	systemctl enable --quiet nftables.service mykey-egress-refresh.service mykey-egress-refresh.timer
	systemctl start mykey-egress-refresh.timer
	# Loading replaced the table, so every block has ended with it.
	rm -f "$STATE"/block-* 2>/dev/null || true
	refresh
	echo "loaded: inet mykey"
}

revert() {
	nft delete table inet mykey 2>/dev/null || true
	systemctl disable --quiet --now mykey-egress-refresh.timer 2>/dev/null || true
	systemctl disable --quiet nftables.service mykey-egress-refresh.service 2>/dev/null || true
	if [ -f "$RULES" ]; then mv -f "$RULES" "$RULES.reverted"; fi
	rm -f /etc/nftables.d/mykey-temp-*.nft
	if [ -f /etc/nftables.conf.dist ]; then cp -p /etc/nftables.conf.dist /etc/nftables.conf; fi
	echo "unloaded: inet mykey"
}

block() {
	purpose=$1
	seconds=$2
	known_purpose "$purpose"
	case "$seconds" in
	'' | *[!0-9]*) echo "mykey-egress: seconds must be a number" >&2 && return 1 ;;
	esac
	mkdir -p "$STATE"
	end=$(($(now) + seconds))
	echo "$end" >"$STATE/block-$purpose"
	batch=$(mktemp)
	{
		members_of "$purpose"
		for name in $(names_of "$purpose"); do resolve "$name"; done
	} | sort -u | while read -r ip; do
		echo "destroy element inet mykey blocked { $ip }"
		echo "add element inet mykey blocked { $ip timeout ${seconds}s }"
	done >"$batch"
	echo "flush set inet mykey $purpose" >>"$batch"
	nft -f "$batch"
	rm -f "$batch"
	# The kernel ends the block; this only refills the set promptly afterwards.
	systemd-run --quiet --collect --on-active="$((seconds + 2))" --unit="mykey-unblock-$purpose-$end" "$0" refresh
	echo "blocked: $purpose for ${seconds}s"
}

maint() {
	minutes=$1
	case "$minutes" in
	'' | *[!0-9]*) echo "mykey-egress: minutes must be a number" >&2 && return 1 ;;
	esac
	mkdir -p "$STATE"
	if [ "$minutes" -eq 0 ]; then
		rm -f "$STATE/maint-until"
		nft flush set inet mykey registry
		echo "maintenance window closed"
	else
		echo "$(($(now) + minutes * 60))" >"$STATE/maint-until"
		refresh
		echo "maintenance window open for ${minutes} min"
	fi
}

temp() {
	name=$1
	state=$2
	file="/etc/nftables.d/mykey-temp-$name.nft"
	if [ "$state" = off ]; then
		rm -f "$file"
		return 0
	fi
	[ "$state" = on ] || { echo "mykey-egress: temp <name> on|off" >&2 && return 1; }
	install -d -m 0755 /etc/nftables.d
	case "$name" in
	public-ssh) echo 'add rule inet mykey input tcp dport 22 accept comment "temporary: public SSH"' >"$file" ;;
	drop-vpn-ssh) echo 'insert rule inet mykey input iifname "wg0" tcp dport 22 ct state new drop comment "revert drill"' >"$file" ;;
	*) echo "mykey-egress: unknown temporary rule '$name'" >&2 && return 1 ;;
	esac
}

counts() {
	for s in $SETS; do
		echo "$s $(members_of "$s" | wc -l)"
	done
}

command=${1:-}
case "$command" in
apply) apply ;;
revert) revert ;;
refresh) refresh ;;
block) block "${2:-}" "${3:-}" ;;
maint) maint "${2:-}" ;;
maint-end) maint 0 ;;
temp) temp "${2:-}" "${3:-}" ;;
counts) counts ;;
*)
	echo "usage: mykey-egress.sh apply|revert|refresh|block <purpose> <seconds>|maint <minutes>|maint-end|temp <name> on|off|counts" >&2
	exit 2
	;;
esac
