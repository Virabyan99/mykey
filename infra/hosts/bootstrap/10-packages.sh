#!/bin/sh
# Installs the host packages from the Ubuntu archive. Safe to run again:
# the second run prints only "unchanged" lines.
set -eu

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

PACKAGES="docker.io docker-compose-v2 wireguard-tools nftables chrony unattended-upgrades jq curl"

missing=""
for p in $PACKAGES; do
	if ! dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed"; then
		missing="$missing $p"
	fi
done

if [ -n "$missing" ]; then
	apt-get update -q >/dev/null
	# shellcheck disable=SC2086
	apt-get install -y -q --no-install-recommends $missing >/dev/null
	echo "changed: installed$missing"
else
	echo "unchanged: packages"
fi

# shellcheck disable=SC2086
dpkg-query -W -f='version ${Package} ${Version}\n' $PACKAGES
