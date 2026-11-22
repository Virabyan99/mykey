#!/bin/bash
# Run 9.5 baseline: the same task as a consumer's first connection, done the
# usual way with plain OpenBao: a value put with `bao kv put`, a hand-written
# policy, a token made with `bao token create`, a .env written by hand, the app
# started from it. Inside a throwaway container (OpenBao dev server), with a
# synthetic value. Prints counts only.
set -u
VALUE="baseline-canary-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export BAO_ADDR=http://127.0.0.1:8200
cd /work
start=$(date +%s)

# The operator's interactive shell: every line it runs goes into its history.
HISTFILE=/work/home/.bash_history HOME=/work/home bash -i >/work/out.txt 2>&1 <<EOF
set -o history
export BAO_ADDR=$BAO_ADDR
bao login -no-print root
bao kv put -mount=secret app/dev API_KEY=$VALUE
bao policy write app-dev - <<'POL'
path "secret/data/app/dev" { capabilities = ["read"] }
POL
APP_TOKEN=\$(bao token create -policy=app-dev -ttl=720h -field=token)
echo "token: \$APP_TOKEN"
mkdir -p /work/app && cd /work/app
printf 'API_KEY=%s\n' "\$(BAO_TOKEN=\$APP_TOKEN bao kv get -mount=secret -field=API_KEY app/dev)" > .env
set -a; . ./.env; set +a; sh -c 'echo "app started with API_KEY set: \${API_KEY:+yes}"'
history -w
exit
EOF
end=$(date +%s)

count_file() { grep -lF -- "$VALUE" "$@" 2>/dev/null | wc -l; }
echo "seconds: $((end - start))"
echo "commands typed: $(grep -c . /work/home/.bash_history 2>/dev/null)"
echo "value in .env: $(count_file /work/app/.env)"
echo "value in shell history: $(count_file /work/home/.bash_history)"
echo "value on the terminal: $(count_file /work/out.txt)"
echo "token helper file (~/.vault-token or ~/.bao-token): $(ls -a /work/home | grep -cE '^\.(vault|bao)-token$')"
echo "files under /work holding the value: $(grep -rlF -- "$VALUE" /work 2>/dev/null | wc -l)"
echo "app started: $(grep -c 'API_KEY set: yes' /work/out.txt)"
