#!/bin/sh
# The private certificate authority of one MyKey server, for the hops that stay
# inside it: proxy -> API, API -> PostgreSQL, operator tunnel -> PostgreSQL.
# The public certificate of the host name comes from Let's Encrypt, not from here.
#
# Runs as root in the pinned PostgreSQL image (which ships openssl), with no
# network, and writes into /etc/mykey/pki on the host:
#
#   ca.crt / ca.key              the host's CA; the key stays root-only
#   postgres.crt / postgres.key  server certificate of the postgres service
#   api.crt / api.key            server certificate of the api service
#
# A file that exists is never written again. No key is printed.
set -eu

PKI=/pki
: "${POSTGRES_KEY_OWNER:?POSTGRES_KEY_OWNER is required (uid:gid)}"
: "${API_KEY_OWNER:?API_KEY_OWNER is required (uid:gid)}"
: "${EDGE_OWNER:?EDGE_OWNER is required (uid:gid)}"

# The ACME volume, mounted at /acme in the edge service, which is not root.
chown "$EDGE_OWNER" /acme
chmod 0700 /acme

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$PKI/ca.crt" ] || [ ! -f "$PKI/ca.key" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$PKI/ca.key" -out "$PKI/ca.crt" -days 3650 \
    -subj "/CN=MyKey host CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
  echo "pki-init: created the CA"
fi

issue() {
  name="$1"
  owner="$2"
  if [ -f "$PKI/$name.crt" ] && [ -f "$PKI/$name.key" ]; then
    return 0
  fi
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
  chmod 0400 "$PKI/$name.key"
  chmod 0644 "$PKI/$name.crt"
  echo "pki-init: issued $name"
}

issue postgres "$POSTGRES_KEY_OWNER"
issue api "$API_KEY_OWNER"

chown 0:0 "$PKI/ca.key" "$PKI/ca.crt"
chmod 0400 "$PKI/ca.key"
chmod 0644 "$PKI/ca.crt"
chmod 0755 "$PKI"
rm -f "$PKI/ca.srl"
echo "pki-init: done"
