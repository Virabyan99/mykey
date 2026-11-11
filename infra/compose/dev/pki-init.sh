#!/bin/sh
# Development-only PKI for the local stack. Runs once as root in the pinned
# PostgreSQL image (which ships openssl) and writes into the `pki` volume:
#
#   ca.crt / ca.key              development certificate authority
#   postgres.crt / postgres.key  server certificate for the postgres service
#   openbao.crt / openbao.key    server certificate for the openbao service
#   openbao-static-seal.key      32 random bytes for OpenBao's static seal
#
# Idempotent: exits early when the CA already exists. Nothing here is a real
# credential and nothing is ever written to the host or to a log.
set -eu

PKI=/pki
: "${POSTGRES_KEY_OWNER:?POSTGRES_KEY_OWNER is required (uid:gid)}"
: "${OPENBAO_KEY_OWNER:?OPENBAO_KEY_OWNER is required (uid:gid)}"

# The audit volume, mounted at /openbao/audit in the openbao service. OpenBao
# does not answer a request it cannot audit, so a wrong owner hangs the stack.
# Checked on every start, not only on the first.
chown "$OPENBAO_KEY_OWNER" /audit
chmod 0700 /audit

if [ -f "$PKI/ca.crt" ] && [ -f "$PKI/.complete" ]; then
  echo "pki-init: already initialised"
  exit 0
fi

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout "$PKI/ca.key" -out "$PKI/ca.crt" -days 3650 \
  -subj "/CN=MyKey development CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1

issue() {
  name="$1"
  owner="$2"
  cat >"$WORK/$name.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:$name,DNS:localhost,IP:127.0.0.1
EOF
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$PKI/$name.key" -out "$WORK/$name.csr" -subj "/CN=$name" >/dev/null 2>&1
  openssl x509 -req -in "$WORK/$name.csr" -CA "$PKI/ca.crt" -CAkey "$PKI/ca.key" \
    -CAcreateserial -out "$PKI/$name.crt" -days 3650 -extfile "$WORK/$name.ext" >/dev/null 2>&1
  chown "$owner" "$PKI/$name.key" "$PKI/$name.crt"
  chmod 0600 "$PKI/$name.key"
  chmod 0644 "$PKI/$name.crt"
}

issue postgres "$POSTGRES_KEY_OWNER"
issue openbao "$OPENBAO_KEY_OWNER"

openssl rand -out "$PKI/openbao-static-seal.key" 32
chown "$OPENBAO_KEY_OWNER" "$PKI/openbao-static-seal.key"
chmod 0600 "$PKI/openbao-static-seal.key"

chmod 0600 "$PKI/ca.key"
chmod 0644 "$PKI/ca.crt"
chmod 0755 "$PKI"
rm -f "$PKI/ca.srl"
touch "$PKI/.complete"
echo "pki-init: done"
