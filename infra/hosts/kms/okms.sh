#!/bin/sh
# okms.sh <certificate name> <okms arguments...> — runs OVHcloud's okms tool
# (Run 2.7) with one KMS access certificate of /etc/mykey/secrets/kms. It uses
# the host's network: the KMS bridge exists only while OpenBao runs, and
# OpenBao cannot start before its seal key exists; the host firewall's output
# chain allows the set `kms` on 5696 (and nothing new). The binary is
# the pinned release installed by `host.ts <host> kms-install`; it runs in the
# pinned restic image for its CA bundle, as OpenBao's uid, which owns the
# certificates. Prints what okms prints: identifiers and states, no key material.
set -eu

name=${1:?certificate name}
shift
case "$name" in
	*[!a-z0-9-]* | "" | -*) echo "okms.sh: invalid certificate name" >&2; exit 2 ;;
esac

. /etc/mykey/host.env
: "${MYKEY_KMS_HOST:?MYKEY_KMS_HOST is not set in /etc/mykey/host.env}"

DIR=/etc/mykey/secrets/kms
BINARY=/opt/mykey/bin/okms
IMAGE=restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510
test -x "$BINARY" || { echo "okms.sh: $BINARY missing (host.ts kms-install)" >&2; exit 2; }
test -e "$DIR/$name.crt" || { echo "okms.sh: no certificate $name" >&2; exit 2; }

exec docker run --rm --network host --user 100:1000 --read-only --cap-drop ALL \
	--security-opt no-new-privileges --tmpfs /tmp -e HOME=/tmp \
	-v "$BINARY:/usr/local/bin/okms:ro" -v "$DIR:/kms:ro" \
	-e "KMS_KMIP_ENDPOINT=$MYKEY_KMS_HOST:5696" \
	-e "KMS_KMIP_CERT=/kms/$name.crt" -e "KMS_KMIP_KEY=/kms/$name.key" \
	--entrypoint /usr/local/bin/okms "$IMAGE" "$@"
