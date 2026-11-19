// Run 6.5 (P-119, D-52; Session 2 M2): the host side of a paired backup, as
// pure builders of shell text, and backup.sh rendered from them
// (`node infra/hosts/backup/steps.ts render` writes it; a unit test keeps it
// current).
//
// Everything of a pair lives in a tmpfs /var/lib/mykey/pairs/<pairId>/ (1 GiB,
// owned by the ops user 1000) that never reaches the disk; the ops jobs see
// /var/lib/mykey/pairs as /run/mykey/pairs (ops-jobs.json):
//
//   in/         this pair's libpq password file and OpenBao login, deleted as
//               soon as the step that needs them has run
//   artifacts/  postgres.dump, globals.sql, openbao.snap
//   facts       key=value lines the manifest takes from the host
//   manifest.json, repo/ (the pair's own Restic repository), bundle.tar
//   downloaded.tar, restore/repo, restore/out, check.log, check.status
//
// Each container mounts at most the one artifact it writes; Restic runs with
// no network and reads its password from a read-only file; only the ops
// container (host network, ops-run.sh) reaches R2.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const PAIR_ROOT = "/var/lib/mykey/pairs";
/** The tmpfs of one pair; a pair that does not fit fails its capture (runbook backup.md). */
export const PAIR_TMPFS_SIZE = "1g";
const OPS_UID = "1000:1000";
const CA = "/etc/mykey/pki/ca.crt";
const SECRETS = "/etc/mykey/secrets";
/** The backup password (Restic), owned by the ops user, mode 0400. */
export const BACKUP_PASSWORD_FILE = `${SECRETS}/backup/password`;
const BAO = { address: "10.78.3.2", port: 8200 };
/** FROZEN_DEADLINE_MS of the coordinator, in seconds. */
const FROZEN_SECONDS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCK_FILE = resolve(import.meta.dirname, "../../dependencies.lock.json");
const SCRIPT_FILE = resolve(import.meta.dirname, "backup.sh");

function pinned(name: "postgres" | "restic"): { ref: string; tag: string } {
  const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as {
    images: Record<string, { image: string; tag: string; digest: string }>;
  };
  const pin = lock.images[name];
  if (pin === undefined) throw new Error(`dependencies.lock.json has no images.${name}`);
  return { ref: `${pin.image}@${pin.digest}`, tag: pin.tag };
}

const HARDENED = "--read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp";

/** A path under the pair's root, quoted: literally for a known pair, as "$root/…" in the script. */
type Quote = (sub: string) => string;

function stepsFor(q: Quote) {
  const postgres = pinned("postgres").ref;
  const restic = (opts: {
    repo: string;
    artifacts?: boolean;
    out?: boolean;
    args: string;
  }): string =>
    [
      `docker run --rm --network none ${HARDENED} --user ${OPS_UID}`,
      `-e RESTIC_PASSWORD_FILE=/run/mykey/restic-password`,
      `-v ${BACKUP_PASSWORD_FILE}:/run/mykey/restic-password:ro`,
      `-v ${q(`${opts.repo}:/repo`)}`,
      ...(opts.artifacts === true ? [`-v ${q("artifacts:/artifacts:ro")}`] : []),
      ...(opts.out === true ? [`-v ${q("restore/out:/out")}`] : []),
      `${pinned("restic").ref} --repo /repo --no-cache ${opts.args}`,
    ].join(" ");
  return {
    capture: {
      /** pg_dump as backup_reader over the database bridge, into the one file it writes. */
      dump: [
        `: > ${q("artifacts/postgres.dump")} && chown ${OPS_UID} ${q("artifacts/postgres.dump")} &&`,
        `docker run --rm --network mykey_db ${HARDENED} --user ${OPS_UID}`,
        `-v ${q("in/pgpass:/run/mykey/pgpass:ro")} -e PGPASSFILE=/run/mykey/pgpass`,
        `-v ${CA}:/run/mykey/ca.crt:ro -v ${q("artifacts/postgres.dump:/run/mykey/postgres.dump")}`,
        `--entrypoint pg_dump ${postgres} --format=custom --file=/run/mykey/postgres.dump`,
        `--dbname='host=postgres port=5432 dbname=postgres user=backup_reader sslmode=verify-full sslrootcert=/run/mykey/ca.crt'`,
      ].join(" "),
      /** The roles and settings, on the server's own socket, without role passwords. */
      globals: `docker exec -e PGPASSWORD -u postgres mykey-postgres-1 pg_dumpall --globals-only --no-role-passwords -U postgres > ${q("artifacts/globals.sql")}`,
      /** A 600 s token of the root AppRole backup; its header file holds the token. */
      login: `curl --fail --silent --show-error --max-time 60 --cacert ${CA} --resolve openbao:${String(BAO.port)}:${BAO.address} --data @${q("in/login.json")} https://openbao:${String(BAO.port)}/v1/auth/approle/login | sed -n 's/.*"client_token":"\\([^"]*\\)".*/X-Vault-Token: \\1/p' > ${q("in/bao-header")}`,
      snapshot: `curl --fail --silent --show-error --max-time 300 --cacert ${CA} --resolve openbao:${String(BAO.port)}:${BAO.address} -H @${q("in/bao-header")} -o ${q("artifacts/openbao.snap")} https://openbao:${String(BAO.port)}/v1/sys/storage/raft/snapshot`,
    },
    restic: {
      init: restic({ repo: "repo", args: "init" }),
      backup: restic({ repo: "repo", artifacts: true, args: "backup --host mykey /artifacts" }),
      check: restic({ repo: "restore/repo", args: "check --read-data" }),
      restore: restic({ repo: "restore/repo", out: true, args: "restore latest --target /out" }),
    },
    tmpfs: {
      pack: `tar -C ${q("")} -cf ${q("bundle.tar")} repo`,
      unpack: `mkdir -p ${q("restore/out")} && tar -C ${q("restore")} -xf ${q("downloaded.tar")}`,
    },
  };
}

export type PairSteps = ReturnType<typeof stepsFor> & { root: string };

/** The steps of one known pair (tests, by-hand runs). */
export function pairSteps(pairId: string): PairSteps {
  if (!UUID.test(pairId)) throw new Error("pair id: a UUID expected");
  const root = `${PAIR_ROOT}/${pairId}`;
  const q: Quote = (sub) => `'${sub === "" ? root : `${root}/${sub}`}'`;
  return { ...stepsFor(q), root };
}

/** The same Restic invocation over local directories (the local pair test). */
export function resticArgv(
  paths: { repo: string; password: string; artifacts: string | null; out: string | null },
  args: readonly string[],
): string[] {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "-e",
    "RESTIC_PASSWORD_FILE=/run/mykey/restic-password",
    "-v",
    `${paths.password}:/run/mykey/restic-password:ro`,
    "-v",
    `${paths.repo}:/repo`,
    ...(paths.artifacts === null ? [] : ["-v", `${paths.artifacts}:/artifacts:ro`]),
    ...(paths.out === null ? [] : ["-v", `${paths.out}:/out`]),
    pinned("restic").ref,
    "--repo",
    "/repo",
    "--no-cache",
    ...args,
  ];
}

/** The tools the manifest names: the pinned images (OpenBao's version is read from the server). */
export function pinnedTools(): { postgres: string; restic: string } {
  return { postgres: pinned("postgres").tag, restic: pinned("restic").tag };
}

export function renderBackupScript(): string {
  const s = stepsFor((sub) => `"${sub === "" ? "$root" : `$root/${sub}`}"`);
  const tools = pinnedTools();
  const ops = "/opt/mykey/hosts/ops-run.sh";
  return `#!/bin/sh
# GENERATED by infra/hosts/backup/steps.ts (render): do not edit.
# The daily pair (Run 6.5, P-118 … P-120, D-51, D-52), run by mykey-backup.service:
# begin the capture (drain, freeze), take the three artifacts, record the
# candidate (writing reopens), then pack, upload, read back, check and sign.
# Exit 75: busy (the timer tries again). Every secret is a file; none is an
# argument or an environment value.
set -eu
umask 077

host_env=\${MYKEY_HOST_ENV:-/etc/mykey/host.env}
setting() { sed -n "s/^$1=//p" "$host_env" | tail -n 1; }
# The jobs mount the pairs' directory: it exists before the first one runs.
install -d -m 0711 -o root -g root ${PAIR_ROOT}

# backup.sh recover (mykey-capture-recover at boot; mykey-backup's ExecStopPost):
# release a freeze a dead capture left, and remove every pair tmpfs left behind.
if [ "\${1:-}" = recover ]; then
  ${ops} capture -- capture --step abort --owner backup --reason aborted
  for dir in ${PAIR_ROOT}/*; do
    [ -d "$dir" ] || continue
    umount "$dir" 2>/dev/null || true
    rm -rf "$dir"
  done
  exit 0
fi
[ "$#" -eq 0 ] || { echo "usage: backup.sh [recover]" >&2; exit 64; }

begun=$(${ops} capture -- capture --step begin --owner backup) || exit $?
pair=$(printf '%s' "$begun" | sed -n 's/.*"pairId":"\\([0-9a-f-]*\\)".*/\\1/p')
case "$pair" in
  ????????-????-????-????-????????????) ;;
  *) echo "backup: no pair id from capture begin" >&2; exit 1 ;;
esac
root="${PAIR_ROOT}/$pair"
released=false
finish() {
  status=$?
  if [ "$released" = false ]; then
    ${ops} capture -- capture --step abort --owner backup --reason aborted >&2 || true
  fi
  umount "$root" 2>/dev/null || true
  rmdir "$root" 2>/dev/null || true
  exit "$status"
}
trap finish EXIT INT TERM

mkdir -m 0700 "$root"
mount -t tmpfs -o size=${PAIR_TMPFS_SIZE},mode=0700,uid=1000,gid=1000,nosuid,nodev,noexec tmpfs "$root"
install -d -m 0700 -o 1000 -g 1000 "$root/in" "$root/artifacts"
printf '%s\\n' "$begun" > "$root/begin.json"

# The frozen part: at most ${String(FROZEN_SECONDS)} s (FROZEN_DEADLINE_MS); then the
# watchdog's TERM runs the trap, which aborts the capture.
( sleep ${String(FROZEN_SECONDS)}; kill -TERM $$ ) &
watchdog=$!
pw=$(sed 's/[\\\\:]/\\\\&/g' ${SECRETS}/ops/backup_reader)
printf 'postgres:5432:*:backup_reader:%s\\n' "$pw" > "$root/in/pgpass"
pw=
chown 1000:1000 "$root/in/pgpass"
${s.capture.dump}
rm -f "$root/in/pgpass"
PGPASSWORD=$(cat ${SECRETS}/postgres/superuser-password)
export PGPASSWORD
${s.capture.globals}
PGPASSWORD=
printf '{"role_id":"%s","secret_id":"%s"}' "$(cat ${SECRETS}/backup-approle/role-id)" "$(cat ${SECRETS}/backup-approle/secret-id)" > "$root/in/login.json"
${s.capture.login}
rm -f "$root/in/login.json"
${s.capture.snapshot}
rm -f "$root/in/bao-header"

health=$(curl --fail --silent --max-time 30 --cacert ${CA} --resolve openbao:${String(BAO.port)}:${BAO.address} https://openbao:${String(BAO.port)}/v1/sys/health)
seal=$(curl --fail --silent --max-time 30 --cacert ${CA} --resolve openbao:${String(BAO.port)}:${BAO.address} https://openbao:${String(BAO.port)}/v1/sys/seal-status)
# The API image's own build (host.env records image ids, not tags).
release_build=$(docker image inspect "$(setting API_IMAGE)" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MYKEY_BUILD=//p')
{
  printf 'host_instance_id=%s\\n' "$(cat /etc/machine-id)"
  printf 'backend_incarnation=%s\\n' "$(printf '%s' "$health" | sed -n 's/.*"cluster_id":"\\([^"]*\\)".*/\\1/p')"
  printf 'release_build=%s\\n' "$release_build"
  printf 'kms_key_id=%s\\n' "$(setting MYKEY_KMS_SEAL_KEY_ID)"
  printf 'seal_name=%s\\n' "$(printf '%s' "$seal" | sed -n 's/.*"type":"\\([^"]*\\)".*/\\1/p')"
  printf 'tool_openbao=%s\\n' "$(printf '%s' "$health" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')"
  printf 'tool_postgres=%s\\n' "${tools.postgres}"
  printf 'tool_restic=%s\\n' "${tools.restic}"
} > "$root/facts"
chown -R 1000:1000 "$root"

${ops} pair -- pair --step manifest --pair "$pair"
${ops} capture -- capture --step record --owner backup --pair "$pair" --manifest "/run/mykey/pairs/$pair/manifest.json"
released=true
kill "$watchdog" 2>/dev/null || true

# Writing is open again. The pair is a candidate until it is verified.
install -d -m 0700 -o 1000 -g 1000 "$root/repo"
${s.restic.init}
${s.restic.backup}
${s.tmpfs.pack}
rm -rf "$root/repo"
chown 1000:1000 "$root/bundle.tar"
${ops} pair -- pair --step upload --pair "$pair"
${s.tmpfs.unpack}
chown -R 1000:1000 "$root/restore"
set +e
${s.restic.check} > "$root/check.log" 2>&1
printf '%s\\n' "$?" > "$root/check.status"
set -e
${s.restic.restore} >/dev/null
chown 1000:1000 "$root/check.log" "$root/check.status"
${ops} pair -- pair --step verify --pair "$pair"
`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv[2] !== "render") {
    process.stderr.write("usage: node infra/hosts/backup/steps.ts render\n");
    process.exit(64);
  }
  writeFileSync(SCRIPT_FILE, renderBackupScript());
  process.stdout.write(`wrote ${SCRIPT_FILE}\n`);
}
