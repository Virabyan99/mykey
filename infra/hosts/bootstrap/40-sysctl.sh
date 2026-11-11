#!/bin/sh
# System settings: no core dumps, no swap, security updates without an
# automatic reboot, time from fixed addresses. Safe to run again.
set -eu

# put <path> <mode>: writes stdin to <path> when it differs. Returns 0 when it wrote.
put() {
	tmp=$(mktemp)
	cat >"$tmp"
	if [ -f "$1" ] && cmp -s "$tmp" "$1"; then
		rm -f "$tmp"
		return 1
	fi
	install -D -m "$2" "$tmp" "$1"
	rm -f "$tmp"
	return 0
}

note() {
	if [ "$2" = yes ]; then echo "changed: $1"; else echo "unchanged: $1"; fi
}

# --- core dumps -------------------------------------------------------------
changed=no
put /etc/sysctl.d/60-mykey.conf 0644 <<'EOF' && changed=yes
# MyKey: a core dump of a process that holds a secret must not reach the disk.
kernel.core_pattern=|/bin/false
fs.suid_dumpable=0
EOF
put /etc/systemd/coredump.conf.d/60-mykey.conf 0644 <<'EOF' && changed=yes
[Coredump]
Storage=none
ProcessSizeMax=0
EOF
put /etc/security/limits.d/60-mykey.conf 0644 <<'EOF' && changed=yes
* hard core 0
EOF
# apport rewrites kernel.core_pattern every time it starts.
if systemctl is-enabled --quiet apport.service 2>/dev/null || systemctl is-active --quiet apport.service 2>/dev/null; then
	systemctl disable --quiet --now apport.service 2>/dev/null || true
	changed=yes
fi
if [ -f /etc/default/apport ] && grep -q '^enabled=1' /etc/default/apport; then
	sed -i 's/^enabled=1/enabled=0/' /etc/default/apport
	changed=yes
fi
if [ "$(cat /proc/sys/kernel/core_pattern)" != "|/bin/false" ] || [ "$(cat /proc/sys/fs/suid_dumpable)" != "0" ]; then
	sysctl -q -p /etc/sysctl.d/60-mykey.conf
	changed=yes
fi
note "core dumps off" "$changed"

# --- swap -------------------------------------------------------------------
changed=no
if [ -n "$(swapon --noheadings --show=NAME 2>/dev/null)" ]; then
	swapoff -a
	changed=yes
fi
if grep -Eq '^[^#].*[[:space:]]swap[[:space:]]' /etc/fstab; then
	sed -i -E 's/^([^#].*[[:space:]]swap[[:space:]].*)$/# mykey: \1/' /etc/fstab
	changed=yes
fi
note "no swap" "$changed"

# --- unattended upgrades ----------------------------------------------------
changed=no
put /etc/apt/apt.conf.d/52-mykey-unattended 0644 <<'EOF' && changed=yes
// MyKey: security updates install by themselves; a reboot is an operator decision.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
note "unattended security updates, no automatic reboot" "$changed"

# --- time -------------------------------------------------------------------
# Fixed addresses (D-21): the firewall allows NTP to these two only.
changed=no
put /etc/chrony/sources.d/mykey.sources 0644 <<'EOF' && changed=yes
server 162.159.200.1 iburst
server 162.159.200.123 iburst
EOF
if grep -Eq '^(pool|server)[[:space:]]' /etc/chrony/chrony.conf; then
	sed -i -E 's/^((pool|server)[[:space:]].*)$/# mykey: \1/' /etc/chrony/chrony.conf
	changed=yes
fi
if [ "$changed" = yes ]; then
	systemctl restart chrony
fi
if ! systemctl is-enabled --quiet chrony 2>/dev/null; then
	systemctl enable --quiet chrony
	changed=yes
fi
note "chrony with fixed servers" "$changed"
