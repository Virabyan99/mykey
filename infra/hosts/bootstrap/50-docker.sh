#!/bin/sh
# Docker daemon settings. Safe to run again.
set -eu

tmp=$(mktemp)
cat >"$tmp" <<'EOF'
{
  "icc": false,
  "userland-proxy": false,
  "no-new-privileges": true,
  "log-driver": "journald"
}
EOF

changed=no
if ! cmp -s "$tmp" /etc/docker/daemon.json 2>/dev/null; then
	install -D -m 0644 "$tmp" /etc/docker/daemon.json
	changed=yes
fi
rm -f "$tmp"

if ! systemctl is-enabled --quiet docker 2>/dev/null; then
	systemctl enable --quiet docker
	changed=yes
fi

if [ "$changed" = yes ]; then
	systemctl restart docker
	echo "changed: docker daemon"
elif ! systemctl is-active --quiet docker; then
	systemctl start docker
	echo "changed: docker started"
else
	echo "unchanged: docker daemon"
fi
