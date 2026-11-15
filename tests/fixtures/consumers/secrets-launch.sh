#!/bin/sh
# secrets-launch.sh -- <command> [arguments]   (Run 5.8, P-100)
#
# Starts <command> through `secrets run` with the machine token read from a
# file: SECRETS_TOKEN_FILE, or else $HOME/.config/mykey/machine-token. The
# token travels only in the CLI's own environment; `secrets run` keeps it out
# of the command's environment and arguments. The file is refused when it is a
# symbolic link, is not a regular file, is not owned by this user, or has any
# permission bit for group or others. Prints nothing but its refusals.
set -eu

refuse() {
  printf 'secrets-launch.sh: %s\n' "$1" >&2
  exit 78
}

if [ "$#" -lt 2 ] || [ "$1" != "--" ]; then
  refuse "usage: secrets-launch.sh -- <command> [arguments]"
fi
shift

file=${SECRETS_TOKEN_FILE:-${HOME:-}/.config/mykey/machine-token}
if [ -L "$file" ]; then refuse "$file is a symbolic link"; fi
if [ ! -f "$file" ]; then refuse "$file is missing or not a regular file"; fi
listing=$(ls -ln -- "$file")
owner=$(printf '%s\n' "$listing" | awk '{ print $3 }')
if [ "$owner" != "$(id -u)" ]; then refuse "$file is not owned by this user"; fi
others=$(printf '%s\n' "$listing" | cut -c5-10)
if [ "$others" != "------" ]; then
  refuse "$file has permissions for group or others (chmod 600 it)"
fi

SECRETS_MACHINE_TOKEN=$(cat -- "$file")
export SECRETS_MACHINE_TOKEN
exec secrets run -- "$@"
