#!/usr/bin/env bash
# Run 9.2 Step 4: the consumer's leak check, run by the owner on the consumer host.
#
#   bash consumer-leak-check.sh [--app-dir <dir>]
#
# Reads the needles on stdin without echo, one per line, ending with an empty
# line: the old token, the new token, and up to six values (real secret
# values, or a token that was exposed). They stay in this shell's memory:
# never in a file, an argument or an exported variable. grep gets them
# through a pipe.
#
# Every surface is searched for every needle. The script prints one line per
# surface with the count of hits and its control. A control is a random string
# that the script writes into the surface first and removes afterwards. A
# surface whose control is not found was not really searched.
#
# Excluded, and said so: the token file itself.
set -u
umask 077

app_dir=""
token_file="${SECRETS_TOKEN_FILE:-$HOME/.config/mykey/machine-token}"
needles=()
excluded=("$token_file")
# --token-file <path> (repeatable): a token read from its file (shown once, so it
# cannot be pasted); that file is excluded from the search like the token file.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-dir) app_dir="${2:-}"; shift 2 ;;
    --token-file)
      [ -r "${2:-}" ] || { echo "cannot read ${2:-}" >&2; exit 64; }
      IFS= read -r line <"$2"
      [ -n "$line" ] && needles+=("$line")
      excluded+=("$2")
      shift 2 ;;
    *) echo "usage: consumer-leak-check.sh [--app-dir <dir>] [--token-file <path>]..." >&2; exit 64 ;;
  esac
done
[ -r "$token_file" ] && IFS= read -r line <"$token_file" && [ -n "$line" ] && needles+=("$line")

echo "Paste each value and press Enter. Nothing shows. An empty line ends."
echo "Paste one value at a time, not a file or a block of NAME=value lines."
while :; do
  IFS= read -rs -p "needle $((${#needles[@]} + 1)): " line || break
  echo
  # Run 10.1 (F-9.2-2): a paste of several lines arrives at once. Every line
  # that follows within a second is swallowed here, so none reaches the shell
  # after the script, and the paste is refused whole.
  more=""
  while IFS= read -rs -t 1 -n 4096 rest; do more=yes; done
  [ -n "${rest:-}" ] && more=yes
  rest=""
  # A NAME=value line, not a base64 value ending in = padding (review finding 4).
  if [ -n "$more" ] || [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=[^=] ]]; then
    echo "Not taken: one value, not a file. Paste only the value, one at a time."
    line=""
    continue
  fi
  [ -z "$line" ] && break
  needles+=("$line")
  [ "${#needles[@]}" -ge 8 ] && break
done
line=""
if [ "${#needles[@]}" -lt 1 ]; then
  echo "no needle given; nothing searched" >&2
  exit 64
fi

control="mykey-leak-control-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"

# Counts the files among "$@" (files or directories, recursively) holding any
# needle. The token file is never read.
hits_in() {
  local n=0 f
  while IFS= read -r -d '' f; do
    [[ " ${excluded[*]} " == *" $f "* ]] && continue
    if printf '%s\n' "${needles[@]}" | grep -qFf - -- "$f" 2>/dev/null; then n=$((n + 1)); fi
  done < <(find "$@" -xdev -type f -print0 2>/dev/null)
  echo "$n"
}

# True when the control is in one of "$@".
control_in() {
  grep -rqF -- "$control" "$@" 2>/dev/null
}

report() { printf '%-28s needles=%-4s control=%s\n' "$1" "$2" "$3"; }

echo
echo "surface                      result"

# --- shell histories ------------------------------------------------------
histories=()
for h in "$HOME/.bash_history" "$HOME/.zsh_history" "$HOME/.local/share/fish/fish_history" \
  "$HOME/.python_history" "$HOME/.node_repl_history" "$HOME/.lesshst"; do
  [ -f "$h" ] && histories+=("$h")
done
probe_history="$HOME/.bash_history"
touch "$probe_history"
[ -f "$probe_history" ] && [[ " ${histories[*]-} " != *" $probe_history "* ]] && histories+=("$probe_history")
printf '%s\n' "# $control" >>"$probe_history"
if control_in "${histories[@]}"; then c=found; else c=MISSING; fi
n=$(hits_in "${histories[@]}")
grep -vF -- "$control" "$probe_history" >"$probe_history.leakcheck" && cat "$probe_history.leakcheck" >"$probe_history"
rm -f "$probe_history.leakcheck"
report "shell histories (${#histories[@]})" "$n" "$c"

# --- the application's directory: .env* -----------------------------------
if [ -n "$app_dir" ] && [ -d "$app_dir" ]; then
  printf '%s\n' "$control" >"$app_dir/.env.mykey-leak-control"
  envs=()
  while IFS= read -r -d '' f; do envs+=("$f"); done < <(find "$app_dir" -maxdepth 3 -name '.env*' -type f -print0 2>/dev/null)
  if control_in "${envs[@]}"; then c=found; else c=MISSING; fi
  rm -f "$app_dir/.env.mykey-leak-control"
  n=$(hits_in "${envs[@]}")
  report "app .env* ($((${#envs[@]} - 1)) files)" "$n" "$c"
else
  report "app .env*" "-" "skipped (no --app-dir)"
fi

# --- /tmp -------------------------------------------------------------------
probe_tmp=$(mktemp /tmp/mykey-leak-control.XXXXXX)
printf '%s\n' "$control" >"$probe_tmp"
if control_in /tmp; then c=found; else c=MISSING; fi
rm -f "$probe_tmp"
report "/tmp" "$(hits_in /tmp)" "$c"

# --- the user's configuration, except the token file -------------------------
mkdir -p "$HOME/.config"
probe_cfg="$HOME/.config/mykey-leak-control"
printf '%s\n' "$control" >"$probe_cfg"
if control_in "$HOME/.config"; then c=found; else c=MISSING; fi
rm -f "$probe_cfg"
report "~/.config (token file excl.)" "$(hits_in "$HOME/.config")" "$c"

# --- processes: argv and environment -------------------------------------------
env "MYKEY_LEAK_CONTROL=$control" sh -c 'sleep 30' "$control" &
probe_pid=$!
sleep 0.3
n=0
seen=0
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  [ "$pid" = "$$" ] && continue
  for part in cmdline environ; do
    [ -r "$d/$part" ] || continue
    if tr '\0' '\n' <"$d/$part" 2>/dev/null | grep -qF -- "$control"; then seen=$((seen + 1)); fi
    if tr '\0' '\n' <"$d/$part" 2>/dev/null | grep -qFf <(printf '%s\n' "${needles[@]}"); then n=$((n + 1)); fi
  done
done
kill "$probe_pid" 2>/dev/null
wait "$probe_pid" 2>/dev/null
if [ "$seen" -ge 2 ]; then c=found; else c=MISSING; fi
report "process argv + environment" "$n" "$c"

# --- the journal (a host with systemd) ------------------------------------------
if command -v journalctl >/dev/null 2>&1 && journalctl -n 1 >/dev/null 2>&1; then
  logger -t mykey-leak-check "$control" 2>/dev/null
  sleep 1
  if journalctl --since "-1h" -o cat 2>/dev/null | grep -qF -- "$control"; then c=found; else c=MISSING; fi
  n=$(journalctl -o cat 2>/dev/null | grep -cFf <(printf '%s\n' "${needles[@]}"))
  report "journal" "$n" "$c (the control line stays in the journal)"
else
  report "journal" "-" "skipped (no journal)"
fi

# --- docker inspect ---------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ids=$(docker ps -aq 2>/dev/null)
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    n=$(docker inspect $ids 2>/dev/null | grep -cFf <(printf '%s\n' "${needles[@]}"))
  else
    n=0
  fi
  report "docker inspect ($(printf '%s\n' "$ids" | grep -c .) containers)" "$n" "no control (no container is started)"
else
  report "docker inspect" "-" "skipped (no Docker)"
fi

echo
echo "excluded: ${excluded[*]}"
echo "needles searched: ${#needles[@]}"
echo "expected: needles=0 on every line, and control=found wherever one is written"
needles=()
