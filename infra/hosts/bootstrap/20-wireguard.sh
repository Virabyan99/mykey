#!/bin/sh
# The operator VPN (P-28): interface wg0 with one peer.
#
#   env WG_ADDRESS=10.77.N.1/24 WG_PEER_ADDRESS=10.77.N.10/32 \
#       WG_PEER_PUBLIC_KEY=<base64> WG_LISTEN_PORT=51820 20-wireguard.sh
#
# The private key is generated here and never leaves the host. Safe to run
# again: the second run prints "unchanged".
set -eu

: "${WG_ADDRESS:?}" "${WG_PEER_ADDRESS:?}" "${WG_PEER_PUBLIC_KEY:?}" "${WG_LISTEN_PORT:?}"

umask 077
install -d -m 0700 /etc/wireguard
changed=no

if [ ! -s /etc/wireguard/wg0.key ]; then
	wg genkey >/etc/wireguard/wg0.key
	changed=yes
fi

tmp=$(mktemp /etc/wireguard/wg0.conf.XXXXXX)
cat >"$tmp" <<EOF
[Interface]
Address = ${WG_ADDRESS}
ListenPort = ${WG_LISTEN_PORT}
PostUp = wg set %i private-key /etc/wireguard/wg0.key

[Peer]
PublicKey = ${WG_PEER_PUBLIC_KEY}
AllowedIPs = ${WG_PEER_ADDRESS}
EOF
if cmp -s "$tmp" /etc/wireguard/wg0.conf; then
	rm -f "$tmp"
else
	mv -f "$tmp" /etc/wireguard/wg0.conf
	changed=yes
fi

if ! systemctl is-enabled --quiet wg-quick@wg0 2>/dev/null; then
	systemctl enable --quiet wg-quick@wg0
	changed=yes
fi

if [ "$changed" = yes ]; then
	systemctl restart wg-quick@wg0
	echo "changed: wireguard"
elif ! systemctl is-active --quiet wg-quick@wg0; then
	systemctl start wg-quick@wg0
	echo "changed: wireguard started"
else
	echo "unchanged: wireguard"
fi
