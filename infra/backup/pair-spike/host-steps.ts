// THROW-AWAY (Run 2.9, P-36): the host-side commands of one paired backup,
// as pure builders. capture.ts runs them over SSH (as root). Everything of a
// pair lives in a root-only tmpfs /run/mykey-pair/<pairId>/ that never reaches
// the disk:
//
//   in/         secrets for this pair only: libpq password files, the Restic
//               password, the R2 curl configuration
//   artifacts/  postgres.dump, globals.sql, openbao.snap, manifest.json
//   repo/       the Restic repository; repo.tar is the packed bundle
//   restore/    the restore side: repo.tar from R2, repo/, out/
//
// Containers see the tmpfs as /pair. Images are the pins of
// infra/dependencies.lock.json.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PAIR_ROOT = "/run/mykey-pair";
/** The disposable restore cluster on the db bridge (the live one is .2, the API .3). */
export const RESTORE_PG_ADDRESS = "10.78.2.5";
const RESTORE_PG_NAME = "mykey-pair-pg";
const HOST_CA = "/etc/mykey/pki/ca.crt";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ARG = /^[A-Za-z0-9_./:=@,-]+$/;
const LOCK_FILE = resolve(import.meta.dirname, "../../dependencies.lock.json");

function pinned(name: "postgres" | "restic"): string {
  const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as {
    images: Record<string, { image: string; digest: string }>;
  };
  const pin = lock.images[name];
  if (pin === undefined) throw new Error(`dependencies.lock.json has no images.${name}`);
  return `${pin.image}@${pin.digest}`;
}

export function pairPaths(pairId: string): { root: string } {
  if (!UUID.test(pairId)) throw new Error("pair id: a UUID expected");
  return { root: `${PAIR_ROOT}/${pairId}` };
}

export function tmpfsCommands(pairId: string): { open: string; close: string } {
  const { root } = pairPaths(pairId);
  return {
    open: [
      `install -d -m 0700 -o root -g root ${PAIR_ROOT}`,
      `mkdir -m 0700 ${root}`,
      `mount -t tmpfs -o size=1g,mode=0700,uid=0,gid=0,nosuid,nodev,noexec tmpfs ${root}`,
      `install -d -m 0700 ${root}/in ${root}/artifacts ${root}/restore`,
    ].join(" && "),
    close: `umount ${root} && rmdir ${root}`,
  };
}

/** One line of a libpq password file for the host name `postgres`. */
export function pgpassLine(user: string, password: string): string {
  if (!/^[a-z_]+$/.test(user)) throw new Error("pgpass: unexpected user name");
  if (/[\r\n]/.test(password) || password === "") throw new Error("pgpass: unusable password");
  const escaped = password.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  return `postgres:5432:*:${user}:${escaped}\n`;
}

const HARDENED = "--read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp";

function pgClient(
  pairId: string,
  program: "pg_dump" | "pg_dumpall" | "pg_restore",
  passfile: string,
  extra: string,
): string {
  const { root } = pairPaths(pairId);
  return [
    `docker run --rm --network mykey_db ${HARDENED}`,
    extra,
    `-v ${root}:/pair -v ${HOST_CA}:/ca.crt:ro -e PGPASSFILE=/pair/in/${passfile}`,
    `--entrypoint ${program} ${pinned("postgres")}`,
  ]
    .filter((part) => part !== "")
    .join(" ");
}

function dsn(user: string): string {
  return `'host=postgres port=5432 dbname=postgres user=${user} sslmode=verify-full sslrootcert=/ca.crt'`;
}

export function pgDumpCommand(pairId: string): string {
  return `${pgClient(pairId, "pg_dump", "pgpass-reader", "")} --format=custom --file=/pair/artifacts/postgres.dump --dbname=${dsn("backup_reader")}`;
}

export function globalsCommand(pairId: string): string {
  return `${pgClient(pairId, "pg_dumpall", "pgpass-super", "")} --globals-only --no-role-passwords --file=/pair/artifacts/globals.sql --dbname=${dsn("postgres")}`;
}

/** Into the restore cluster, reached as `postgres` through --add-host (its certificate names that host). */
export function pgRestoreCommand(pairId: string): string {
  return `${pgClient(pairId, "pg_restore", "pgpass-restore", `--add-host postgres:${RESTORE_PG_ADDRESS}`)} --exit-on-error --dbname=${dsn("postgres")} /pair/restore/out/pair/artifacts/postgres.dump`;
}

export function resticCommand(
  pairId: string,
  repo: "repo" | "restore/repo",
  args: string[],
): string {
  const { root } = pairPaths(pairId);
  for (const arg of args) if (!SAFE_ARG.test(arg)) throw new Error("restic: unexpected argument");
  return [
    `docker run --rm --network none ${HARDENED} -v ${root}:/pair`,
    `--entrypoint restic ${pinned("restic")}`,
    `--repo /pair/${repo} --password-file /pair/in/restic-password --no-cache`,
    ...args,
  ].join(" ");
}

export function bundleCommands(pairId: string): { pack: string; unpack: string } {
  const { root } = pairPaths(pairId);
  return {
    pack: `tar -C ${root} -cf ${root}/repo.tar repo`,
    unpack: `tar -C ${root}/restore -xf ${root}/restore/repo.tar`,
  };
}

export interface R2Place {
  accountId: string;
  bucket: string;
}

export function r2Url(at: R2Place, pairId: string, name: string): string {
  if (!/^[0-9a-f]{32}$/.test(at.accountId)) throw new Error("r2: account id expected");
  if (!/^mykey-[a-z0-9-]+$/.test(at.bucket)) throw new Error("r2: a mykey-* bucket expected");
  if (!/^[a-z]+\.[a-z]+$/.test(name)) throw new Error("r2: unexpected object name");
  pairPaths(pairId);
  return `https://${at.accountId}.r2.cloudflarestorage.com/${at.bucket}/pairs/${pairId}/${name}`;
}

/** The curl configuration that carries the S3 credential (written to in/r2.conf, root-only). */
export function r2Config(accessKeyId: string, secretAccessKey: string): string {
  if (!/^[A-Za-z0-9]+$/.test(accessKeyId) || !/^[A-Za-z0-9]+$/.test(secretAccessKey)) {
    throw new Error("r2: unexpected credential format");
  }
  return `user = "${accessKeyId}:${secretAccessKey}"\n`;
}

export function transferCommand(
  pairId: string,
  at: R2Place,
  op: { put: string; from?: string } | { get: string; into: string },
): string {
  const { root } = pairPaths(pairId);
  const name = "put" in op ? op.put : op.get;
  const local = "put" in op ? (op.from ?? op.put) : op.into;
  if (!/^[a-z/]+\.[a-z]+$/.test(local) || local.includes("..")) {
    throw new Error("r2: unexpected local file");
  }
  const io = "put" in op ? `-T ${root}/${local}` : `-o ${root}/${local}`;
  return [
    "curl --fail --silent --show-error --max-time 900",
    `--aws-sigv4 aws:amz:auto:s3 -K ${root}/in/r2.conf`,
    `-H 'x-amz-content-sha256: UNSIGNED-PAYLOAD'`,
    io,
    r2Url(at, pairId, name),
  ].join(" ");
}

/** A disposable PostgreSQL 18 cluster on a new volume, with the host's server certificate. */
export function restoreClusterCommands(pairId: string): { start: string; remove: string } {
  const { root } = pairPaths(pairId);
  const volume = `${RESTORE_PG_NAME}-${pairId.slice(0, 8)}`;
  return {
    start: [
      `docker volume create ${volume} >/dev/null &&`,
      `docker run -d --name ${RESTORE_PG_NAME} --network mykey_db --ip ${RESTORE_PG_ADDRESS}`,
      `--user 999:999 ${HARDENED} --tmpfs /var/run/postgresql:uid=999,gid=999,mode=0775`,
      `--pids-limit 300 --memory 1g --shm-size 256m`,
      `-v ${volume}:/var/lib/postgresql`,
      `-v ${root}/in/restore-super:/run/restore-super:ro -e POSTGRES_PASSWORD_FILE=/run/restore-super`,
      `-v /etc/mykey/pki/postgres.crt:/pki/postgres.crt:ro -v /etc/mykey/pki/postgres.key:/pki/postgres.key:ro`,
      `${pinned("postgres")} postgres -c ssl=on -c ssl_cert_file=/pki/postgres.crt -c ssl_key_file=/pki/postgres.key`,
    ].join(" "),
    remove: `docker rm -f ${RESTORE_PG_NAME}; docker volume rm -f ${volume}`,
  };
}

/** `<name> <bytes> <sha256>` for every regular file of a directory. */
export function digestCommand(directory: string): string {
  if (!directory.startsWith(`${PAIR_ROOT}/`) || directory.includes("..")) {
    throw new Error("digest: a directory of a pair expected");
  }
  return `cd ${directory} && for f in *; do if [ -f "$f" ]; then printf '%s %s %s\\n' "$f" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d ' ' -f 1)"; fi; done`;
}

export function parseDigests(text: string): Record<string, { bytes: number; sha256: string }> {
  const result: Record<string, { bytes: number; sha256: string }> = {};
  for (const line of text.split("\n")) {
    const match = /^(\S+) (\d+) ([0-9a-f]{64})$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      result[match[1]] = { bytes: Number(match[2]), sha256: match[3] ?? "" };
    }
  }
  return result;
}
