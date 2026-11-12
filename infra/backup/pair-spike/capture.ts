// THROW-AWAY (Run 2.9, P-36): one paired backup of staging, orchestrated from
// the workstation. Every host step is an SSH command of host-steps.ts, inside
// the pair's root-only tmpfs. Freeze (freeze.ts) → dump, globals, Raft
// snapshot → pair row and manifest → release → Restic seal → upload to R2.
// The restore reads from the bucket only. Session 6 writes the real thing.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  applyDatabaseAccess,
  applyRoles,
  createPool,
  type DbTarget,
  type RoleName,
} from "@mykey/db";
import type pg from "pg";
import {
  destroy as destroySpike,
  init as initSpike,
  start as startSpike,
  waitUnsealed,
  type SpikeInstance,
} from "../../../tests/harness/kms-spike.ts";
import { baoFetch, type Stack } from "../../../tests/harness/stack.ts";
import {
  REMOTE,
  expectSuccess,
  openTunnel,
  parseHostEnv,
  registerSecret,
  sshExec,
  type StagingStack,
  type Tunnel,
} from "../../../tests/harness/staging.ts";
import { boundaryOf, freeze, release } from "./freeze.ts";
import {
  RESTORE_PG_ADDRESS,
  bundleCommands,
  digestCommand,
  globalsCommand,
  pairPaths,
  parseDigests,
  pgDumpCommand,
  pgRestoreCommand,
  pgpassLine,
  r2Config,
  resticCommand,
  restoreClusterCommands,
  tmpfsCommands,
  transferCommand,
  type R2Place,
} from "./host-steps.ts";
import { buildManifest, verifyDigests, type PairManifest } from "./manifest.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const BACKUP_ROLE = "backup";
/** The disposable OpenBao a restore gives the snapshot to (on the KMS bridge). */
const RESTORE_BAO: SpikeInstance = { name: "pairbao", address: "10.78.4.6", cert: "seal" };
const BACKUP_TOKEN_TTL = "600s";

export interface PairContext {
  staging: StagingStack;
  /** Freeze, release and the pair row (backup_reader cannot write control rows: D-25). */
  maintenance: pg.Pool;
  /** Reads meta.schema_migration for the manifest. */
  reader: pg.Pool;
  /** The staging role passwords: backup_reader for the dump, all of them for a restored cluster. */
  passwords: Record<RoleName, string>;
  r2: R2Place & { accessKeyId: string; secretAccessKey: string };
}

export type CaptureResult =
  | {
      ok: true;
      pairId: string;
      manifest: PairManifest;
      timings: Record<string, number>;
      frozenMs: number;
      /** When capturePair began the freeze (draining). */
      frozenAt: number;
      /** When the drain ended and the mode became `capturing`. */
      capturingAt: number;
      releasedAt: number;
      bundleBytes: number;
      resticPasswordFile: string;
    }
  | {
      ok: false;
      pairId: string;
      stage: "admission" | "drain" | "capture" | "seal" | "upload";
      reason: string;
      freezeHeld: boolean;
    };

/** Where the workstation keeps a pair's Restic password (never on the host's disk). */
export function resticPasswordPath(pairId: string, home: string = homedir()): string {
  pairPaths(pairId); // throws unless a UUID
  return join(home, ".mykey", "custody", "staging", `pair-${pairId}.key`);
}

async function host(
  ctx: PairContext,
  command: string,
  what: string,
  opts: { secret?: boolean; stdin?: string | Uint8Array; timeoutMs?: number } = {},
): Promise<string> {
  const result = await sshExec(ctx.staging.host, command, {
    sudo: true,
    timeoutMs: opts.timeoutMs ?? 900_000,
    secretOutput: opts.secret === true,
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
  });
  return expectSuccess(result, what).stdout;
}

/** A file in the pair's in/ directory, root-only (or owned by `owner`), from stdin. */
async function putSecret(
  ctx: PairContext,
  pairId: string,
  name: string,
  value: string,
  owner = "0:0",
): Promise<void> {
  if (!/^[a-z0-9.-]+$/.test(name)) throw new Error("pair secret: unexpected name");
  const [uid, gid] = owner.split(":");
  await host(
    ctx,
    `install -m 0400 -o ${uid} -g ${gid} /dev/stdin ${pairPaths(pairId).root}/in/${name}`,
    `writing in/${name}`,
    { secret: true, stdin: value },
  );
}

async function timed<T>(
  timings: Record<string, number>,
  stage: string,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    timings[stage] = (timings[stage] ?? 0) + (Date.now() - started) / 1000;
  }
}

function asBaoStack(url: string, caCertPath: string, rootToken: string): Stack {
  return { bao: { url, caCertPath, rootToken } } as unknown as Stack;
}

/** The root-namespace AppRole `backup` (policy `backup` only, 600 s tokens); returns a fresh token. */
export async function backupToken(ctx: PairContext): Promise<string> {
  const root = ctx.staging as unknown as Stack;
  const auth = await baoFetch(root, "/v1/sys/auth");
  const mounts = (await auth.json()) as Record<string, unknown>;
  if (
    !("approle/" in mounts) &&
    !("approle/" in ((mounts.data as Record<string, unknown> | undefined) ?? {}))
  ) {
    const enabled = await baoFetch(root, "/v1/sys/auth/approle", {
      method: "POST",
      body: { type: "approle" },
    });
    if (enabled.status !== 204) throw new Error(`enable approle (root): HTTP ${enabled.status}`);
  }
  const role = await baoFetch(root, `/v1/auth/approle/role/${BACKUP_ROLE}`, {
    method: "POST",
    body: {
      token_policies: [BACKUP_ROLE],
      token_ttl: BACKUP_TOKEN_TTL,
      token_max_ttl: BACKUP_TOKEN_TTL,
      token_no_default_policy: true,
      secret_id_num_uses: 1,
      secret_id_ttl: "60s",
    },
  });
  if (role.status !== 204 && role.status !== 200)
    throw new Error(`backup role: HTTP ${role.status}`);
  const roleId = (
    (await (await baoFetch(root, `/v1/auth/approle/role/${BACKUP_ROLE}/role-id`)).json()) as {
      data: { role_id: string };
    }
  ).data.role_id;
  const secretId = (
    (await (
      await baoFetch(root, `/v1/auth/approle/role/${BACKUP_ROLE}/secret-id`, {
        method: "POST",
        body: {},
      })
    ).json()) as { data: { secret_id: string } }
  ).data.secret_id;
  registerSecret(secretId);
  const login = await baoFetch(root, "/v1/auth/approle/login", {
    method: "POST",
    token: "",
    body: { role_id: roleId, secret_id: secretId },
  });
  if (login.status !== 200) throw new Error(`backup login: HTTP ${login.status}`);
  const token = ((await login.json()) as { auth: { client_token: string } }).auth.client_token;
  registerSecret(token);
  return token;
}

async function listNamespaces(ctx: PairContext): Promise<string[]> {
  const answer = await baoFetch(ctx.staging as unknown as Stack, "/v1/sys/namespaces", {
    method: "LIST",
  });
  if (answer.status === 404) return [];
  const body = (await answer.json()) as { data?: { keys?: string[] } };
  return (body.data?.keys ?? []).map((key) => key.replace(/\/$/, "")).sort();
}

export async function capturePair(
  ctx: PairContext,
  opts: {
    failAt?: "after_dump" | "after_snapshot";
    /** Runs while the freeze still holds, after the artifacts are taken (the test counts rows). */
    duringFreeze?: () => Promise<void>;
  } = {},
): Promise<CaptureResult> {
  const pairId = randomUUID();
  const { root } = pairPaths(pairId);
  const timings: Record<string, number> = {};
  const tmpfs = tmpfsCommands(pairId);
  await host(ctx, tmpfs.open, "opening the pair tmpfs");
  const env = parseHostEnv(await host(ctx, `cat ${REMOTE.hostEnv}`, "reading host.env"));

  await putSecret(
    ctx,
    pairId,
    "pgpass-reader",
    pgpassLine("backup_reader", ctx.passwords.backup_reader),
  );
  await putSecret(
    ctx,
    pairId,
    "pgpass-super",
    pgpassLine("postgres", ctx.staging.pg.superuser.password),
  );
  await putSecret(ctx, pairId, "r2.conf", r2Config(ctx.r2.accessKeyId, ctx.r2.secretAccessKey));
  await putSecret(ctx, pairId, "bao-header", `X-Vault-Token: ${await backupToken(ctx)}\n`);

  const captureStartedAt = new Date().toISOString();
  const freezeStarted = Date.now();
  const frozen = await timed(timings, "freeze", () => freeze(ctx.maintenance, pairId));
  if (!frozen.ok) {
    await host(ctx, tmpfs.close, "closing the pair tmpfs");
    return { ok: false, pairId, stage: frozen.stage, reason: frozen.reason, freezeHeld: false };
  }
  // The pair row exists from the freeze on: a capture that dies leaves it `candidate`.
  await ctx.maintenance.query(
    `INSERT INTO app.backup_pair (id, capture_started_at, boundary, artifact_hashes, schema_revision,
                                  release_commit, key_refs, validation_status)
     VALUES ($1, $2, '{}', '{}', '', '', '{}', 'candidate')`,
    [pairId, captureStartedAt],
  );
  const boundary = await boundaryOf(ctx.maintenance);

  await timed(timings, "dump", async () => {
    await host(ctx, pgDumpCommand(pairId), "pg_dump as backup_reader");
    await host(ctx, globalsCommand(pairId), "pg_dumpall --globals-only");
  });
  if (opts.failAt === "after_dump") {
    return {
      ok: false,
      pairId,
      stage: "capture",
      reason: "stopped after the dump (failAt)",
      freezeHeld: true,
    };
  }
  const { address, port } = REMOTE.openbao;
  await timed(timings, "snapshot", () =>
    host(
      ctx,
      `curl --fail --silent --show-error --max-time 300 --cacert ${REMOTE.caCert} --resolve openbao:${port}:${address} -H @${root}/in/bao-header -o ${root}/artifacts/openbao.snap https://openbao:${port}/v1/sys/storage/raft/snapshot`,
      "Raft snapshot with the backup token",
      { secret: true },
    ),
  );
  if (opts.failAt === "after_snapshot") {
    return {
      ok: false,
      pairId,
      stage: "capture",
      reason: "stopped after the snapshot (failAt)",
      freezeHeld: true,
    };
  }

  const listing = parseDigests(
    await host(ctx, digestCommand(`${root}/artifacts`), "artifact digests"),
  );
  const migration = await ctx.reader.query<{ name: string; sha256: string }>(
    "SELECT name, sha256 FROM meta.schema_migration ORDER BY name DESC LIMIT 1",
  );
  const sha = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const artifact = (name: "postgres.dump" | "globals.sql" | "openbao.snap") => {
    const found = listing[name];
    if (found === undefined) throw new Error(`artifact missing: ${name}`);
    return found;
  };
  const manifest = buildManifest({
    pairId,
    captureStartedAt,
    captureFinishedAt: new Date().toISOString(),
    captureEpoch: frozen.epoch,
    releaseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
    schemaRevision: `${migration.rows[0]?.name.replace(/\.sql$/, "") ?? ""} ${migration.rows[0]?.sha256 ?? ""}`,
    versions: { postgres: "18.6", openbao: "2.7.2", restic: "0.19.1" },
    seal: { type: "kmip", keyIds: [env.MYKEY_KMS_SEAL_KEY_ID ?? ""] },
    namespaces: await listNamespaces(ctx),
    boundary: {
      lastOperationId: boundary.lastOperationId,
      executingOperations: boundary.executingOperations as 0,
      heldEffectSlots: boundary.heldEffectSlots as 0,
    },
    artifacts: {
      "postgres.dump": artifact("postgres.dump"),
      "globals.sql": artifact("globals.sql"),
      "openbao.snap": artifact("openbao.snap"),
    },
    rolesChecksum: sha(join(ROOT, "packages/db/roles/roles.sql")),
  });
  await host(
    ctx,
    `install -m 0400 /dev/stdin ${root}/artifacts/manifest.json`,
    "writing the manifest",
    {
      stdin: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  );
  await ctx.maintenance.query(
    `UPDATE app.backup_pair SET boundary = $2, artifact_hashes = $3, schema_revision = $4,
            release_commit = $5, key_refs = $6 WHERE id = $1`,
    [
      pairId,
      JSON.stringify(manifest.boundary),
      JSON.stringify(manifest.artifacts),
      manifest.schemaRevision,
      manifest.releaseCommit,
      JSON.stringify(manifest.seal),
    ],
  );
  if (opts.duringFreeze !== undefined) await opts.duringFreeze();
  await release(ctx.maintenance);
  const releasedAt = Date.now();
  const frozenMs = releasedAt - freezeStarted;

  // Seal: a new Restic repository; the password exists only on the workstation and in the tmpfs.
  const resticPassword = randomBytes(32).toString("base64url");
  registerSecret(resticPassword);
  const resticPasswordFile = resticPasswordPath(pairId);
  mkdirSync(dirname(resticPasswordFile), { recursive: true, mode: 0o700 });
  writeFileSync(resticPasswordFile, resticPassword, { mode: 0o600, flag: "wx" });
  await putSecret(ctx, pairId, "restic-password", resticPassword);
  await timed(timings, "restic", async () => {
    await host(ctx, resticCommand(pairId, "repo", ["init"]), "restic init");
    await host(
      ctx,
      resticCommand(pairId, "repo", ["backup", "--host", "mykey-pair", "/pair/artifacts"]),
      "restic backup",
    );
    await host(ctx, resticCommand(pairId, "repo", ["check", "--read-data"]), "restic check");
    await host(ctx, bundleCommands(pairId).pack, "tar of the repository");
  });
  const bundleBytes = Number(
    (await host(ctx, `stat -c %s ${root}/repo.tar`, "bundle size")).trim(),
  );
  await timed(timings, "upload", async () => {
    await host(ctx, transferCommand(pairId, ctx.r2, { put: "repo.tar" }), "upload repo.tar", {
      secret: true,
    });
    await host(
      ctx,
      transferCommand(pairId, ctx.r2, { put: "manifest.json", from: "artifacts/manifest.json" }),
      "upload manifest.json",
      { secret: true },
    );
  });
  await host(ctx, tmpfs.close, "closing the pair tmpfs");
  return {
    ok: true,
    pairId,
    manifest,
    timings,
    frozenAt: freezeStarted,
    capturingAt: frozen.frozenAt,
    releasedAt,
    frozenMs,
    bundleBytes,
    resticPasswordFile,
  };
}

/** Ends a capture that stopped: back to idle, the pair `ineligible`, the tmpfs gone. */
export async function abortCapture(ctx: PairContext, pairId: string): Promise<void> {
  await release(ctx.maintenance);
  await ctx.maintenance.query(
    "UPDATE app.backup_pair SET validation_status = 'ineligible' WHERE id = $1",
    [pairId],
  );
  await sshExec(ctx.staging.host, tmpfsCommands(pairId).close, { sudo: true }).catch(
    () => undefined,
  );
}

export interface RestoredPair {
  pairId: string;
  manifest: PairManifest;
  postgres: { superuser: DbTarget; target(role: RoleName): DbTarget; tunnel: Tunnel };
  openbao: { stack: Stack; instance: SpikeInstance; snapshotEndpoint: string };
  timings: Record<string, number>;
}

export class RestoreRefused extends Error {
  readonly stage: "verify" | "postgres" | "openbao";
  readonly problems: string[];
  constructor(stage: "verify" | "postgres" | "openbao", problems: string[]) {
    super(`restore refused at ${stage}: ${problems.join("; ")}`);
    this.stage = stage;
    this.problems = problems;
  }
}

export interface RestoreOptions {
  /** Take the manifest of another pair (the swapped-manifest test). */
  manifestOf?: string;
  /**
   * Make this role absent after applyRoles (the missing-role test). It is
   * renamed away: right after applyRoles a DROP can fail on dependencies.
   */
  withoutRole?: RoleName;
  /** Skip applyDatabaseAccess (the default-privileges test). */
  skipDatabaseAccess?: boolean;
  /** OpenBao on another seal (the wrong-key test); default: the staging seal (`seal` links). */
  seal?: { cert: string; keyId: string };
  /** Restore PostgreSQL only. */
  postgresOnly?: boolean;
}

/** Restores pair `pairId` from the bucket into a new PostgreSQL cluster and a new OpenBao. */
export async function restorePair(
  ctx: PairContext,
  pairId: string,
  resticPassword: string,
  opts: RestoreOptions = {},
): Promise<RestoredPair> {
  const { root } = pairPaths(pairId);
  const timings: Record<string, number> = {};
  const tmpfs = tmpfsCommands(pairId);
  await host(ctx, tmpfs.open, "opening the restore tmpfs");
  await putSecret(ctx, pairId, "r2.conf", r2Config(ctx.r2.accessKeyId, ctx.r2.secretAccessKey));
  registerSecret(resticPassword);
  await putSecret(ctx, pairId, "restic-password", resticPassword);

  await timed(timings, "download", async () => {
    await host(
      ctx,
      transferCommand(pairId, ctx.r2, { get: "repo.tar", into: "restore/repo.tar" }),
      "download repo.tar",
      { secret: true },
    );
    const manifestPlace = opts.manifestOf ?? pairId;
    await host(
      ctx,
      transferCommand(manifestPlace, ctx.r2, {
        get: "manifest.json",
        into: "restore/manifest.json",
      })
        .replace(
          `${pairPaths(manifestPlace).root}/restore/manifest.json`,
          `${root}/restore/manifest.json`,
        )
        .replace(`-K ${pairPaths(manifestPlace).root}/in/r2.conf`, `-K ${root}/in/r2.conf`),
      "download manifest.json",
      { secret: true },
    );
  });
  const manifest = JSON.parse(
    await host(ctx, `cat ${root}/restore/manifest.json`, "reading the manifest"),
  ) as PairManifest;
  await timed(timings, "restic", async () => {
    await host(ctx, bundleCommands(pairId).unpack, "untar");
    await host(
      ctx,
      resticCommand(pairId, "restore/repo", ["restore", "latest", "--target", "/pair/restore/out"]),
      "restic restore",
    );
  });
  const verified = verifyDigests(
    manifest,
    parseDigests(
      await host(ctx, digestCommand(`${root}/restore/out/pair/artifacts`), "restored digests"),
    ),
  );
  if (!verified.ok || manifest.pairId !== pairId) {
    throw new RestoreRefused(
      "verify",
      manifest.pairId === pairId
        ? verified.problems
        : ["manifest of another pair", ...verified.problems],
    );
  }

  // PostgreSQL: a new cluster, roles from roles.sql, the database-level access, then the dump.
  const superuserPassword = randomBytes(24).toString("base64url");
  registerSecret(superuserPassword);
  await putSecret(ctx, pairId, "restore-super", superuserPassword, "999:999");
  await putSecret(ctx, pairId, "pgpass-restore", pgpassLine("postgres", superuserPassword));
  const cluster = restoreClusterCommands(pairId);
  const dir = mkdtempSync(join(tmpdir(), "mykey-pair-restore-"));
  let tunnel: Tunnel | undefined;
  try {
    await timed(timings, "restore_postgres", async () => {
      await host(ctx, cluster.start, "starting the restore cluster");
      for (let attempt = 0; ; attempt += 1) {
        const ready = await sshExec(
          ctx.staging.host,
          "docker exec mykey-pair-pg pg_isready -q -h /var/run/postgresql -U postgres",
          { sudo: true },
        );
        if (ready.code === 0) break;
        if (attempt > 60) throw new Error("restore cluster not ready");
        await new Promise((wait) => setTimeout(wait, 2_000));
      }
      // The image's entrypoint restarts the server once after init; wait for the final one.
      await new Promise((wait) => setTimeout(wait, 4_000));
      tunnel = await openTunnel(ctx.staging.host, { address: RESTORE_PG_ADDRESS, port: 5432 });
      const caCertPath = join(dir, "ca.crt");
      writeFileSync(caCertPath, await host(ctx, `cat ${REMOTE.caCert}`, "reading the host CA"));
      const superuser: DbTarget = {
        host: "127.0.0.1",
        port: tunnel.localPort,
        database: "postgres",
        user: "postgres",
        password: superuserPassword,
        caCertPath,
      };
      await applyRoles(superuser, ctx.passwords);
      const pool = createPool(superuser, { max: 1 });
      try {
        if (opts.withoutRole !== undefined) {
          await pool.query(`ALTER ROLE ${opts.withoutRole} RENAME TO ${opts.withoutRole}_absent`);
        }
        if (opts.skipDatabaseAccess !== true) await applyDatabaseAccess(pool, "postgres");
      } finally {
        await pool.end();
      }
      const restored = await sshExec(ctx.staging.host, pgRestoreCommand(pairId), {
        sudo: true,
        timeoutMs: 900_000,
      });
      if (restored.code !== 0)
        throw new RestoreRefused("postgres", [`pg_restore exit ${restored.code}`]);
    });
  } catch (error) {
    await tunnel?.close().catch(() => undefined);
    // Any failure of the PostgreSQL half is a refused restore, with its reason.
    throw error instanceof RestoreRefused
      ? error
      : new RestoreRefused("postgres", [(error as Error).message]);
  }
  const pgTunnel = tunnel as unknown as Tunnel;
  const caCertPath = join(dir, "ca.crt");
  const superuser: DbTarget = {
    host: "127.0.0.1",
    port: pgTunnel.localPort,
    database: "postgres",
    user: "postgres",
    password: superuserPassword,
    caCertPath,
  };
  const postgres = {
    superuser,
    target: (role: RoleName): DbTarget => ({
      ...superuser,
      user: role,
      password: ctx.passwords[role],
    }),
    tunnel: pgTunnel,
  };
  if (opts.postgresOnly === true) {
    return {
      pairId,
      manifest,
      postgres,
      openbao: {
        stack: asBaoStack("", caCertPath, ""),
        instance: { name: "none", address: "", cert: "" },
        snapshotEndpoint: "",
      },
      timings,
    };
  }

  // OpenBao: a new instance on the same seal key, initialised, then given the snapshot.
  const sealKeyId = opts.seal?.keyId ?? manifest.seal.keyIds[0] ?? "";
  const instance: SpikeInstance = { ...RESTORE_BAO, cert: opts.seal?.cert ?? RESTORE_BAO.cert };
  let snapshotEndpoint = "";
  const stack = await timed(timings, "restore_openbao", async () => {
    const bao = await startSpike(ctx.staging, instance, sealKeyId);
    await initSpike(bao);
    await putSecret(ctx, pairId, "pairbao-header", `X-Vault-Token: ${bao.bao.rootToken}\n`);
    const curl = (path: string) =>
      `curl --silent --show-error --max-time 300 -o /dev/null -w '%{http_code}' --cacert ${REMOTE.caCert} --resolve openbao:8200:${instance.address} -H @${root}/in/pairbao-header -X POST --data-binary @${root}/restore/out/pair/artifacts/openbao.snap https://openbao:8200${path}`;
    const plain = (
      await host(ctx, curl("/v1/sys/storage/raft/snapshot"), "snapshot restore", { secret: true })
    ).trim();
    snapshotEndpoint = `sys/storage/raft/snapshot (HTTP ${plain})`;
    if (!plain.startsWith("2")) {
      const forced = (
        await host(ctx, curl("/v1/sys/storage/raft/snapshot-force"), "snapshot-force", {
          secret: true,
        })
      ).trim();
      snapshotEndpoint = `sys/storage/raft/snapshot-force (HTTP ${forced}; plain HTTP ${plain})`;
      if (!forced.startsWith("2")) throw new RestoreRefused("openbao", [snapshotEndpoint]);
    }
    return bao;
  });
  return { pairId, manifest, postgres, openbao: { stack, instance, snapshotEndpoint }, timings };
}

/** Waits until a restored OpenBao is unsealed and active again. */
export function waitRestoredOpenBao(restored: RestoredPair, seconds: number): Promise<void> {
  return waitUnsealed(restored.openbao.stack, seconds);
}

/** Removes everything a restore made on the host (cluster, instance, tmpfs). */
export async function cleanupRestore(
  ctx: PairContext,
  restored: {
    pairId: string;
    postgres?: { tunnel: Tunnel };
    openbao?: { instance: SpikeInstance };
  },
): Promise<void> {
  await restored.postgres?.tunnel.close().catch(() => undefined);
  // A restore that failed half-way may have left its instance: it always goes.
  const instance = restored.openbao?.instance ?? RESTORE_BAO;
  if (instance.name !== "none") await destroySpike(ctx.staging, instance);
  await sshExec(ctx.staging.host, restoreClusterCommands(restored.pairId).remove, {
    sudo: true,
  }).catch(() => undefined);
  await sshExec(ctx.staging.host, tmpfsCommands(restored.pairId).close, { sudo: true }).catch(
    () => undefined,
  );
}

export function removeLocal(path: string): void {
  rmSync(path, { force: true });
}
