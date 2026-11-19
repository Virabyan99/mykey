// Run 6.7 Task C (P-124, D-55): the host side of a restore — a RestoreTarget
// over SSH for restoreToVerifying (apps/ops), used by `host.ts <host> restore`.
// The pair is read from R2 on the workstation, verified, and streamed to the
// host's tmpfs; Restic, the digests, pg_restore and the OpenBao snapshot run
// on the host as the text of infra/hosts/backup/restore-steps.ts. Every
// secret crosses on stdin; a step that names the secrets directory is run
// with its output redacted. Exercised end to end by the drill (Run 6.8).
import { createHash, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fetchEligiblePair, type ObjectStore } from "@mykey/backup";
import { ROLE_NAMES, type RoleName } from "@mykey/db";
import { closeGate } from "@mykey/operations/operator";
import type { RestoreState, RestoreTarget } from "@mykey/ops";
import pg from "pg";
import { restoreSteps } from "../infra/hosts/backup/restore-steps.ts";
import { BACKUP_PASSWORD_FILE } from "../infra/hosts/backup/steps.ts";

export const RESTORE_STATE_FILE = "/var/lib/mykey/restore-state.json";
const GATE_FILE = "/etc/mykey/gate/gate.json";
const SECRETS = "/etc/mykey/secrets";

/** What host.ts gives the target: its SSH, tunnels and the workstation's custody. */
/**
 * Run 6.8: Restic opens a pair with its source host's backup password, read
 * from BACKUP_PASSWORD_FILE on the target. It comes from the workstation's
 * custody copy (on stdin into tmpfs, never in a command). A clean host made
 * its own at install (no pair uses it yet): that one is kept beside, at
 * `.before-restore`, once; a second different one is refused.
 */
export async function ensureSourceBackupPassword(
  exec: HostIo["exec"],
  password: string,
): Promise<"installed" | "present" | `replaced (${string})`> {
  const f = BACKUP_PASSWORD_FILE;
  const kept = `${f}.before-restore`;
  const put = `install -d -m 0700 -o 1000 -g 1000 $(dirname ${f}) && install -m 0400 -o 1000 -g 1000 "$t" ${f}`;
  const command = [
    `t=$(mktemp -p /dev/shm) && trap 'rm -f "$t"' EXIT && cat > "$t" &&`,
    `if [ ! -s ${f} ]; then ${put} && exit 10;`,
    `elif cmp -s "$t" ${f}; then exit 0;`,
    `elif [ -e ${kept} ]; then exit 11;`,
    `else mv ${f} ${kept} && ${put} && exit 12; fi`,
  ].join(" ");
  const { code } = await exec(command, { stdin: password, secretOutput: true });
  if (code === 10) return "installed";
  if (code === 0) return "present";
  if (code === 12) return `replaced (the target's own kept at ${kept})`;
  if (code === 11) {
    throw new Error(
      `restore refused: the target holds a different backup password and ${kept} exists already`,
    );
  }
  throw new Error(`installing the source's backup password: exit ${String(code)}`);
}

export interface HostIo {
  /** One command as root on the host. */
  exec(
    command: string,
    opts?: { stdin?: string | Buffer; secretOutput?: boolean; timeoutMs?: number },
  ): Promise<{ code: number; stdout: string }>;
  tunnel(remote: {
    address: string;
    port: number;
  }): Promise<{ localPort: number; close(): Promise<void> }>;
  /** A local copy of the host's CA certificate. */
  caCertPath: string;
  superuserPassword: string;
  /** The lost host's root token (its custody copy): valid in OpenBao once the snapshot is in. */
  pairRootToken: string;
  /**
   * Run 6.8: this host's own OpenBao root token (its custody copy, from its
   * bao-init). A clean host's OpenBao knows only that one, so it is the token
   * `snapshot-force` is sent with; the drill found the pair's token refused.
   */
  targetRootToken: string;
  /** Run 6.8: the source host's backup password (its custody copy), as the file holds it. */
  sourceBackupPassword: string;
  kmsKeyUsable(keyId: string): Promise<boolean>;
  /** Stores a role's new password where db-init and the services read it. */
  keepPassword(role: RoleName, password: string): Promise<void>;
  /** Sets KEY=value in host.env. */
  setHostEnv(key: string, value: string): Promise<void>;
  /** Starts api and provisioner (resume); answers the running API's build. */
  startExecutors(): Promise<string>;
  /** The organization the host serves (its credential files name it), or null. */
  organizationId: string | null;
  log(line: string): void;
}

export function restoreStateCommand(): { read: string; write: string } {
  return {
    read: `if test -s ${RESTORE_STATE_FILE}; then cat ${RESTORE_STATE_FILE}; fi`,
    write: `install -d -m 0755 /var/lib/mykey && cat > ${RESTORE_STATE_FILE}.tmp && mv -f ${RESTORE_STATE_FILE}.tmp ${RESTORE_STATE_FILE}`,
  };
}

/** Where a delivered AppRole credential goes on the host. */
export function deliveryFiles(name: "runtime" | "issuer" | "provisioner" | "backup"): {
  roleId: string;
  secretId: string;
  owner: string;
} {
  if (name === "backup") {
    return {
      roleId: `${SECRETS}/backup-approle/role-id`,
      secretId: `${SECRETS}/backup-approle/secret-id`,
      owner: "1000:1000",
    };
  }
  const directory = `${SECRETS}/${name === "provisioner" ? "provisioner" : "api"}`;
  return {
    roleId: `${directory}/${name}-role-id`,
    secretId: `${directory}/${name}-secret-id`,
    owner: "1000:1000",
  };
}

const install = (path: string, owner: string): string => {
  const [uid, gid] = owner.split(":");
  const dir = path.slice(0, path.lastIndexOf("/"));
  return `install -d -m 0700 -o ${uid ?? ""} -g ${gid ?? ""} ${dir} && install -m 0400 -o ${uid ?? ""} -g ${gid ?? ""} /dev/stdin ${path}`;
};

export async function hostRestoreTarget(
  io: HostIo,
  pair: { store: ObjectStore; prefix: string; trust: ReadonlyMap<string, KeyObject> },
): Promise<RestoreTarget & { close(): Promise<void> }> {
  const ok = async (command: string, what: string, opts: Parameters<HostIo["exec"]>[1] = {}) => {
    const result = await io.exec(command, opts);
    if (result.code !== 0) throw new Error(`${what}: exit ${String(result.code)}`);
    return result.stdout;
  };
  const local = mkdtempSync(join(tmpdir(), "mykey-host-restore-"));
  const pgTunnel = await io.tunnel({ address: "10.78.2.2", port: 5432 });
  const baoTunnel = await io.tunnel({ address: "10.78.3.2", port: 8200 });
  const superuser = {
    host: "127.0.0.1",
    port: pgTunnel.localPort,
    database: "postgres",
    user: "postgres",
    password: io.superuserPassword,
    caCertPath: io.caCertPath,
  };
  const query = async <T extends pg.QueryResultRow>(sql: string): Promise<T[]> => {
    const client = new pg.Client({
      ...superuser,
      ssl: { ca: readFileSync(io.caCertPath, "utf8"), servername: "postgres" },
    });
    await client.connect();
    try {
      return (await client.query<T>(sql)).rows;
    } finally {
      await client.end();
    }
  };
  let steps: ReturnType<typeof restoreSteps> | null = null;
  let pairId: string | null = null;
  const stepsOf = () => {
    if (steps === null) throw new Error("restore: the pair was not fetched");
    return steps;
  };
  const header = (token: string) =>
    ok(stepsOf().baoHeader, "the OpenBao header", {
      stdin: `X-Vault-Token: ${token}\n`,
      secretOutput: true,
    });

  return {
    async holding() {
      const gate = await io.exec(`cat ${GATE_FILE}`);
      if (gate.code === 0 && /"state"\s*:\s*"open"/.test(gate.stdout)) return "the gate is open";
      const table = await query<{ found: string | null }>(
        "SELECT to_regclass('app.organization')::text AS found",
      );
      if (table[0]?.found === null || table[0]?.found === undefined) return null;
      const orgs = await query<{ n: string }>("SELECT count(*) AS n FROM app.organization");
      return Number(orgs[0]?.n ?? "0") > 0 ? "the host holds organizations" : null;
    },
    state: {
      async read() {
        const text = (await ok(restoreStateCommand().read, "reading the restore state")).trim();
        return text === "" ? null : (JSON.parse(text) as RestoreState);
      },
      async write(state) {
        await ok(restoreStateCommand().write, "writing the restore state", {
          stdin: JSON.stringify(state),
        });
      },
    },
    async fetch() {
      const held: { bundle: Buffer } = { bundle: Buffer.alloc(0) };
      const sink = async (stream: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        held.bundle = Buffer.concat(chunks);
        return {
          sha256: createHash("sha256").update(held.bundle).digest("hex"),
          bytes: held.bundle.length,
        };
      };
      const fetched = await fetchEligiblePair(pair.store, pair.prefix, pair.trust, sink);
      if (!fetched.ok) return fetched;
      const { manifest } = fetched.eligibility;
      steps = restoreSteps(manifest);
      pairId = manifest.pairId;
      const s = steps;
      await ok(s.mount, "mounting the tmpfs");
      await ok(s.receive, "receiving the bundle", {
        stdin: held.bundle,
        timeoutMs: 600_000,
      });
      await ok(s.unpack, "unpacking the bundle");
      io.log(
        `the source's backup password: ${await ensureSourceBackupPassword((c, o) => io.exec(c, o), io.sourceBackupPassword)}`,
      );
      await ok(s.resticCheck, "restic check --read-data", {
        secretOutput: true,
        timeoutMs: 900_000,
      });
      await ok(s.resticRestore, "restic restore", { secretOutput: true, timeoutMs: 900_000 });
      await ok(s.digests, "the artifacts' digests");
      const root = `/var/lib/mykey/pairs/${manifest.pairId}/restore/out/artifacts`;
      const globals = join(local, "globals.sql");
      writeFileSync(globals, await ok(`cat '${root}/globals.sql'`, "reading globals.sql"));
      io.log(`pair ${manifest.pairId}: signature, bundle, Restic and digests verified`);
      return {
        ok: true as const,
        manifest,
        files: {
          "postgres.dump": `${root}/postgres.dump`,
          "globals.sql": globals,
          "openbao.snap": `${root}/openbao.snap`,
        },
      };
    },
    kmsUsable: (keyId) => io.kmsKeyUsable(keyId),
    postgres: {
      superuser,
      async reset() {
        await query("DROP SCHEMA IF EXISTS app, auth, audit, meta, jobs CASCADE");
      },
      async restoreDump() {
        await ok(stepsOf().pgRestore, "pg_restore", { secretOutput: true, timeoutMs: 1_800_000 });
      },
      async keepPasswords(passwords) {
        for (const role of ROLE_NAMES) await io.keepPassword(role, passwords[role]);
      },
    },
    openbao: {
      target: {
        url: `https://127.0.0.1:${String(baoTunnel.localPort)}`,
        caCertPath: io.caCertPath,
      },
      async restoreSnapshot() {
        await header(io.targetRootToken);
        await ok(stepsOf().baoRestore, "the OpenBao snapshot", {
          secretOutput: true,
          timeoutMs: 900_000,
        });
      },
      async warm(token) {
        await header(token);
        try {
          await ok(stepsOf().baoWarm, "waiting for the restored OpenBao", { timeoutMs: 300_000 });
        } finally {
          await ok(stepsOf().baoForget, "removing the OpenBao header");
        }
      },
    },
    pairRootToken: io.pairRootToken,
    async deliver(namespace, name, credential) {
      const ours =
        namespace === "" ? name === "backup" : namespace === `org-${io.organizationId ?? ""}`;
      if (!ours) return; // another organization's credential: its host is elsewhere
      const files = deliveryFiles(name);
      if (name === "runtime" && io.organizationId !== null) {
        // Run 6.8: the organization the credentials belong to; a clean host has none.
        await ok(
          install(`${SECRETS}/api/organization-id`, files.owner),
          "installing the organization id",
          {
            stdin: io.organizationId,
            secretOutput: true,
          },
        );
      }
      await ok(install(files.roleId, files.owner), `installing ${name} role id`, {
        stdin: credential.roleId,
        secretOutput: true,
      });
      await ok(install(files.secretId, files.owner), `installing ${name} secret id`, {
        stdin: credential.secretId,
        secretOutput: true,
      });
    },
    knownRoles: ["postgres", ...ROLE_NAMES],
    async startVerifying({ backendIncarnation, hostInstanceId }) {
      await io.setHostEnv("MYKEY_BACKEND_INCARNATION", backendIncarnation);
      await io.setHostEnv("MYKEY_HOST_INSTANCE_ID", hostInstanceId);
      const fetchedPair = pairId;
      if (fetchedPair === null) throw new Error("restore: the pair was not fetched");
      const releaseBuild = await io.startExecutors();
      await closeGate({
        writer: {
          read: async () => {
            const r = await io.exec(`cat ${GATE_FILE}`);
            return r.code === 0 ? r.stdout : null;
          },
          write: async (text) => {
            await ok(
              `install -d -m 0755 /etc/mykey/gate && cat > ${GATE_FILE}.tmp && chmod 0644 ${GATE_FILE}.tmp && sync ${GATE_FILE}.tmp && mv -f ${GATE_FILE}.tmp ${GATE_FILE} && sync /etc/mykey/gate`,
              "writing the gate",
              { stdin: text },
            );
          },
        },
        pool: null,
        expect: { hostInstanceId, backendIncarnation, releaseBuild },
        origin: { kind: "restore", pairId: fetchedPair },
        phase: "verifying",
        now: () => new Date(),
      });
    },
    async close() {
      if (steps !== null) await io.exec(steps.cleanup);
      await pgTunnel.close();
      await baoTunnel.close();
      rmSync(local, { recursive: true, force: true });
    },
  };
}

/** The prefix of an eligible pair of `source` by its id; null when none is eligible. */
export async function pairPrefixFor(
  store: Pick<ObjectStore, "list">,
  source: string,
  pairId: string,
): Promise<string | null> {
  const wanted = `-${pairId}/eligible.json`;
  const hit = (await store.list(`pairs/${source}/`)).find((o) => o.key.endsWith(wanted));
  return hit === undefined ? null : hit.key.slice(0, -"eligible.json".length);
}
