#!/bin/sh
# The child that OpenBao Agent starts (Run 2.8). It prints the NAMES of the
# environment variables it was given and, per expected name, whether it is
# unset, empty, "<no value>" or set. It never prints a value.
# $1: "exit7" exits with code 7 at once; anything else waits for a signal.
mode="${1:-wait}"
names=$(env | cut -d= -f1 | grep -E '^(A_|BAO_|VAULT_)' | sort | tr '\n' ',')
echo "CHILD-START pid=$$ names=${names}"
for name in A_ONE A_TWO A_MISSING; do
  eval "value=\${${name}-__unset__}"
  if [ "$value" = "__unset__" ]; then state=unset
  elif [ -z "$value" ]; then state=empty
  elif [ "$value" = "<no value>" ]; then state=no-value-marker
  else state=set
  fi
  echo "CHILD-VAR ${name}=${state}"
done
if [ -r /run/spike/token ]; then echo "CHILD-TOKEN-FILE readable"; else echo "CHILD-TOKEN-FILE not readable"; fi
trap 'echo "CHILD-GOT-TERM"; exit 143' TERM
if [ "$mode" = "exit7" ]; then
  echo "CHILD-EXIT 7"
  exit 7
fi
sleep 600 &
wait $!
