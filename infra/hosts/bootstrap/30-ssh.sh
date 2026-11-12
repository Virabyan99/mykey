#!/bin/sh
# SSH over the VPN only.
#
#   30-ssh.sh apply    listen on the VPN address only, harden sshd, drop the temporary public rule
#   30-ssh.sh revert   listen publicly again and reopen port 22 in the firewall
#
# Always run through apply-with-revert.sh. Break-glass when both fail:
# OVHcloud rescue mode, by the owner (docs/runbooks/network.md).
set -eu

EGRESS=/opt/mykey/hosts/firewall/mykey-egress.sh
SOCKET_DIR=/etc/systemd/system/ssh.socket.d
SOCKET_DROPIN="$SOCKET_DIR/10-mykey.conf"
SSHD_DROPIN=/etc/ssh/sshd_config.d/10-mykey.conf

# Ubuntu 24.04 starts sshd from ssh.socket. systemd refuses to start a socket
# whose service is running, so both stop first. ssh.service has
# KillMode=process: sessions that are open stay open.
restart_socket() {
	systemctl daemon-reload
	systemctl stop ssh.socket ssh.service
	systemctl start ssh.socket
}

apply() {
	# The host's VPN address, as 20-wireguard.sh wrote it. Refuse without it:
	# closing public SSH with no VPN address would lock the operator out.
	vpn_address=$(sed -n 's/^Address = \([0-9.]*\)\/[0-9]*$/\1/p' /etc/wireguard/wg0.conf)
	case "$vpn_address" in
	10.77.*.1) ;;
	*) echo "30-ssh: no VPN address in /etc/wireguard/wg0.conf" >&2 && exit 1 ;;
	esac
	if ! ip -4 -o addr show dev wg0 2>/dev/null | grep -q " ${vpn_address}/"; then
		echo "30-ssh: wg0 does not carry ${vpn_address}" >&2
		exit 1
	fi

	# 10- sorts before cloud-init's 50- file, and sshd keeps the first value it reads.
	cat >"$SSHD_DROPIN" <<'EOF'
# MyKey (Run 2.5)
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers ubuntu
AllowTcpForwarding local
X11Forwarding no
AllowAgentForwarding no
EOF
	chmod 0644 "$SSHD_DROPIN"
	rm -f /etc/ssh/sshd_config.d/05-mykey-early.conf
	mkdir -p /run/sshd
	sshd -t

	install -d -m 0755 "$SOCKET_DIR"
	# The empty ListenStream clears the default; FreeBind lets the socket bind
	# before wg0 exists at boot.
	cat >"$SOCKET_DROPIN" <<EOF
[Socket]
ListenStream=
ListenStream=${vpn_address}:22
FreeBind=yes
EOF
	chmod 0644 "$SOCKET_DROPIN"

	# With the drop-in present, the firewall closes public port 22.
	"$EGRESS" apply
	restart_socket
	echo "applied: ssh on ${vpn_address} only"
}

revert() {
	rm -f "$SOCKET_DROPIN"
	# Without the drop-in, the firewall opens public port 22 again.
	"$EGRESS" apply || true
	restart_socket
	echo "reverted: ssh listens publicly again"
}

case "${1:-}" in
apply) apply ;;
revert) revert ;;
*)
	echo "usage: 30-ssh.sh apply|revert" >&2
	exit 2
	;;
esac
