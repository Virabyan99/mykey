#!/bin/sh
# Run 2.8: OpenBao Agent observations, inside a container from the pinned
# OpenBao image on the dev stack's network. See README.md. Prints observation
# lines only: names, states and exit codes, never a value or a token.
#
# Expects: /spike (this directory, read-only), /run/spike/{token,runtime-token,ca.crt},
# BAO_NAMESPACE, PREFIX (p/<project>/e/<environment>).
set -u
export BAO_ADDR=https://openbao:8200
export BAO_CACERT=/run/spike/ca.crt

# env_template blocks for the given names; FORM is "with" or "direct".
templates() {
  form="$1"
  shift
  for name in "$@"; do
    if [ "$form" = "with" ]; then
      body="{{ with secret \"kv/data/${PREFIX}/${name}\" }}{{ .Data.data.value }}{{ end }}"
    else
      body="{{ (secret \"kv/data/${PREFIX}/${name}\").Data.data.value }}"
    fi
    printf 'env_template "%s" {\n  contents = <<EOT\n%s\nEOT\n  error_on_missing_key = true\n}\n\n' "$name" "$body"
  done
}

# config <file> <child mode> <form> <names...>
config() {
  file="$1"
  mode="$2"
  form="$3"
  shift 3
  templates "$form" "$@" >/tmp/templates.hcl
  awk -v mode="$mode" '
    /__ENV_TEMPLATES__/ { while ((getline line < "/tmp/templates.hcl") > 0) print line; next }
    { gsub(/__CHILD_MODE__/, mode); print }
  ' /spike/agent.hcl >"$file"
}

# Starts the agent in the background; its output goes to $1.log.
start_agent() {
  bao agent -config="/tmp/$1.hcl" >"/tmp/$1.log" 2>&1 &
  echo $! >"/tmp/$1.pid"
}

wait_for() {
  label="$1"
  pattern="$2"
  seconds="$3"
  i=0
  while [ "$i" -lt "$seconds" ]; do
    grep -q "$pattern" "/tmp/${label}.log" 2>/dev/null && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

report() {
  label="$1"
  grep -E '^CHILD-' "/tmp/${label}.log" | sed "s/^/${label}: /"
}

echo "== Q2/Q5/Q7a: two existing names, child exits 7"
config /tmp/s1.hcl exit7 with A_ONE A_TWO
timeout 40 bao agent -config=/tmp/s1.hcl >/tmp/s1.log 2>&1
echo "s1: agent exit code $?"
report s1

echo "== Q3a: a third name that does not exist, 'with secret' form"
config /tmp/s2.hcl exit7 with A_ONE A_TWO A_MISSING
timeout 25 bao agent -config=/tmp/s2.hcl >/tmp/s2.log 2>&1
echo "s2: agent exit code $? (124 = still running after 25 s)"
report s2
grep -c "CHILD-START" /tmp/s2.log | sed 's/^/s2: child starts /'
grep -iE "error|missing|exit" /tmp/s2.log | grep -v CHILD | cut -c1-240 | head -4 | sed 's/^/s2 agent: /'

echo "== Q3b: the same, direct form"
config /tmp/s3.hcl exit7 direct A_ONE A_TWO A_MISSING
timeout 25 bao agent -config=/tmp/s3.hcl >/tmp/s3.log 2>&1
echo "s3: agent exit code $? (124 = still running after 25 s)"
report s3
grep -c "CHILD-START" /tmp/s3.log | sed 's/^/s3: child starts /'
grep -iE "error|missing|no secret" /tmp/s3.log | grep -v CHILD | cut -c1-240 | head -2 | sed 's/^/s3 agent: /'

echo "== Q7b: SIGTERM to the agent"
config /tmp/s4.hcl wait with A_ONE A_TWO
start_agent s4
if wait_for s4 CHILD-START 30; then
  kill -TERM "$(cat /tmp/s4.pid)"
  wait "$(cat /tmp/s4.pid)"
  echo "s4: agent exit code after TERM $?"
else
  echo "s4: child never started"
fi
report s4

echo "== Q8: a value changes while the child runs (render interval 3 s, restart_on_secret_changes always)"
config /tmp/s5.hcl wait with A_ONE A_TWO
start_agent s5
if wait_for s5 CHILD-START 30; then
  printf '{"value":"synthetic-changed","operation_id":"spike-change","format":1}' |
    BAO_TOKEN="$(cat /run/spike/runtime-token)" bao kv put -mount=kv -cas=1 "${PREFIX}/A_TWO" - >/dev/null 2>/tmp/s5-put.err
  echo "s5: new version written, exit code $? $(head -c 200 /tmp/s5-put.err | tr '\n' ' ')"
  sleep 12
  grep -c "CHILD-START" /tmp/s5.log | sed 's/^/s5: child starts after the change /'
  grep -c "CHILD-GOT-TERM" /tmp/s5.log | sed 's/^/s5: child TERM signals /'
  kill -TERM "$(cat /tmp/s5.pid)"
  wait "$(cat /tmp/s5.pid)" 2>/dev/null
else
  echo "s5: child never started"
fi

echo "== Q6: the raw machine token reads a retained old version"
BAO_TOKEN="$(cat /run/spike/token)" bao kv get -mount=kv -version=1 -field=operation_id "${PREFIX}/A_ONE" >/tmp/q6.out 2>/tmp/q6.err
echo "q6: exit code $? operation_id of version 1: $(cat /tmp/q6.out)"
BAO_TOKEN="$(cat /run/spike/token)" bao kv metadata get -mount=kv "${PREFIX}/A_ONE" >/dev/null 2>&1
echo "q6: metadata read exit code $?"

echo "== Q4: the agent talks to ${BAO_ADDR} directly"
