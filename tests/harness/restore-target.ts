// Run 6.7 Task C (P-124): the local target of restoreToVerifying — the same
// steps host.ts restore runs on a host, into the stack's second cluster
// (scratch-pg.override.yml, database `restored`) and a new scratch OpenBao
// (same static seal), with an API process on the restored database started
// closed + verifying, its verification listener on a port of its own.
//
// Run 9.7 (R4-3): the scratch OpenBao is new once per target, as a host's is
// once per install; every restore into the target, a rerun included, meets
// the instance the earlier run left, and must offer it a token it accepts.
//
// The local path skips R2 and the signature: the pair is the lost world's
// artifacts directory, and fetchEligiblePair's refusals are proven by
// tests/unit/backup/restore.test.ts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ArtifactName, PairManifest } from "@mykey/backup";
import { ROLE_NAMES, type DbTarget, type RoleName } from "@mykey/db";
import type { RestoreState, RestoreTarget } from "@mykey/ops";
import pg from "pg";
import { TEST_ORIGIN, requestTo } from "./api.ts";
import { keepCapacityOk, startApiProcess, type ApiProcess } from "./api-worker.ts";
import { TEST_BUILD, gateText } from "./gate.ts";
import type { LostWorld } from "./restore-fixture.ts";
import {
  baoFetch,
  freshScratchBao,
  pgRestoreFromFile,
  scratchPg,
  type ScratchBao,
} from "./stack.ts";

export const RESTORED_DATABASE = "restored";

export interface LocalTarget extends RestoreTarget {
  /** The roles' new passwords, once step 3 ran. */
  passwords: Record<RoleName, string> | null;
  delivered: Map<string, { roleId: string; secretId: string }>;
  gatePath: string;
  api: ApiProcess | null;
  /** The restore's own token, as keepRootToken kept it (null before step 4). */
  keptRootToken: string | null;
  /** The scratch OpenBao's own init (null before the first restore). */
  scratch: ScratchBao | null;
  /** A request to the restored API: its public or its verification listener. */
  request(
    listener: "public" | "verify",
    method: string,
    path: string,
    init?: Parameters<typeof requestTo>[3],
  ): Promise<Response>;
  /** The scratch cluster's `restored` database as `role` with a password. */
  connect(role: RoleName, password: string): DbTarget;
  stop(): Promise<void>;
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function localRestoreTarget(
  world: LostWorld,
  opts: { kmsUsable?: boolean; extraGlobals?: string } = {},
): Promise<LocalTarget> {
  const { f } = world;
  const stack = f.stack;
  const cluster = await scratchPg(stack);
  const directory = mkdtempSync(join(tmpdir(), "mykey-restore-target-"));
  const secrets = join(directory, "secrets");
  const stateFile = join(directory, "restore-state.json");
  const gatePath = join(directory, "gate.json");
  const ca = readFileSync(stack.api.certAuthorityPath);
  let bao: ScratchBao | null = null;
  let kept: string | null = null;
  let api: ApiProcess | null = null;
  let capacity: { stop(): void } | null = null;

  const restoredAs = (user: string, password: string): DbTarget => ({
    ...cluster,
    database: RESTORED_DATABASE,
    user,
    password,
  });
  const adminClient = async <T>(work: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({
      host: cluster.host,
      port: cluster.port,
      database: "postgres",
      user: cluster.user,
      password: cluster.password,
      ssl: { ca: readFileSync(cluster.caCertPath, "utf8"), rejectUnauthorized: true },
    });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };

  // The lost world's artifacts; the globals copy may carry a role nobody listed.
  const files = {
    "postgres.dump": join(world.pair.directory, "postgres.dump"),
    "globals.sql": join(directory, "globals.sql"),
    "openbao.snap": join(world.pair.directory, "openbao.snap"),
  } satisfies Record<ArtifactName, string>;
  writeFileSync(
    files["globals.sql"],
    readFileSync(join(world.pair.directory, "globals.sql"), "utf8") + (opts.extraGlobals ?? ""),
  );
  const manifest: PairManifest = {
    format: "mykey-pair/1",
    pairId: world.pair.pairId,
    host: "local",
    hostInstanceId: f.api.gate.hostInstanceId,
    backendIncarnation: f.api.gate.backendIncarnation,
    captureStartedAt: world.pair.captureStartedAt.toISOString(),
    boundary: {
      lastOperationId: world.pair.boundary.lastOperationId,
      executingOperations: 0,
      heldEffectSlots: 0,
    },
    schemaRevision: "0018_incarnation",
    releaseBuild: "000000000000",
    artifacts: (Object.keys(files) as ArtifactName[]).map((name) => {
      const bytes = readFileSync(files[name]);
      return { name, bytes: bytes.length, sha256: sha(bytes) };
    }),
    keyRefs: {
      kmsKeyId: "local-static-seal",
      sealName: "static",
      backupPassword: "local/1",
      signingKeyId: "k1",
    },
    tools: { postgres: "18", openbao: "2.7.2", restic: "0.19.1" },
  };

  const target: LocalTarget = {
    passwords: null,
    delivered: new Map(),
    gatePath,
    get api() {
      return api;
    },
    get keptRootToken() {
      return kept;
    },
    get scratch() {
      return bao;
    },
    async holding() {
      const exists = await adminClient((c) =>
        c.query("SELECT 1 FROM pg_database WHERE datname = $1", [RESTORED_DATABASE]),
      );
      return (exists.rowCount ?? 0) > 0
        ? { why: "the target holds a database already", serving: false }
        : null;
    },
    keepRootToken(token) {
      kept = token;
      return Promise.resolve();
    },
    state: {
      path: stateFile,
      read: () =>
        Promise.resolve(
          existsSync(stateFile)
            ? (JSON.parse(readFileSync(stateFile, "utf8")) as RestoreState)
            : null,
        ),
      write: (state) => {
        writeFileSync(stateFile, JSON.stringify(state));
        return Promise.resolve();
      },
    },
    fetch: () => Promise.resolve({ ok: true as const, manifest, files }),
    kmsUsable: () => Promise.resolve(opts.kmsUsable ?? true),
    postgres: {
      superuser: restoredAs(cluster.user, cluster.password),
      async reset() {
        await adminClient(async (c) => {
          await c.query(`DROP DATABASE IF EXISTS ${RESTORED_DATABASE} WITH (FORCE)`);
          await c.query(`CREATE DATABASE ${RESTORED_DATABASE}`);
        });
      },
      restoreDump: (file) => pgRestoreFromFile(stack, file, RESTORED_DATABASE, "postgres-scratch"),
      keepPasswords: (passwords) => {
        target.passwords = passwords;
        return Promise.resolve();
      },
    },
    openbao: {
      get target() {
        if (bao === null) throw new Error("no scratch OpenBao yet");
        return { url: bao.stack.bao.url, caCertPath: bao.stack.bao.caCertPath };
      },
      async rootTokens() {
        // A target's OpenBao is new once, like a host's at install.
        bao ??= await freshScratchBao(stack);
        return [...(kept === null ? [] : [kept]), bao.own.rootToken];
      },
      async restoreSnapshot(file, token) {
        bao ??= await freshScratchBao(stack);
        await bao.restore(new Uint8Array(readFileSync(file)), token);
      },
      async warm(token) {
        const deadline = Date.now() + 120_000;
        for (;;) {
          if (bao === null) throw new Error("no scratch OpenBao yet");
          const answer = await baoFetch(bao.stack, "/v1/auth/token/lookup-self", { token });
          if (answer.status === 200) return;
          if (Date.now() > deadline) throw new Error(`warm: HTTP ${String(answer.status)}`);
          await sleep(1_000);
        }
      },
    },
    pairRootToken: world.old.rootToken,
    deliver: (namespace, name, credential) => {
      target.delivered.set(`${namespace}/${name}`, credential);
      // The API's own organization: its runtime and issuer credentials as files.
      if (namespace === f.fx.namespace && (name === "runtime" || name === "issuer")) {
        writeFileSync(join(secrets, `${name}-role-id`), credential.roleId, { flag: "w" });
        writeFileSync(join(secrets, `${name}-secret-id`), credential.secretId, { flag: "w" });
      }
      return Promise.resolve();
    },
    knownRoles: ["postgres", ...ROLE_NAMES],
    async startVerifying({ backendIncarnation, hostInstanceId }) {
      await api?.kill();
      capacity?.stop();
      writeFileSync(
        gatePath,
        gateText({ hostInstanceId, backendIncarnation, releaseBuild: TEST_BUILD }, "verifying", 1, {
          kind: "restore",
          pairId: world.pair.pairId,
        }),
      );
      capacity = keepCapacityOk(gatePath);
      const passwords = target.passwords;
      if (passwords === null) throw new Error("no role passwords");
      api = await startApiProcess(restoredAs("api_runtime", passwords.api_runtime), {
        keysDirectory: f.keysDirectory,
        api: {
          baseUrl: TEST_ORIGIN,
          build: TEST_BUILD,
          gatePath,
          hostInstanceId,
          backendIncarnation,
          trustedProxy: null,
        },
        tls: { certPath: stack.api.certPath, keyPath: stack.api.keyPath },
        openBao: target.openbao.target,
        secretsDirectory: secrets,
        verifyListener: true,
      });
    },
    request(listener, method, path, init = {}) {
      if (api === null) throw new Error("the restored API is not running");
      const port = listener === "verify" ? api.verifyPort : api.port;
      if (port === undefined) throw new Error("no verification listener");
      return requestTo({ port, ca }, method, path, init);
    },
    connect: (role, password) => restoredAs(role, password),
    async stop() {
      await api?.kill();
      capacity?.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  // The credential directory names the API's organization from the start.
  mkdirSync(secrets);
  writeFileSync(join(secrets, "organization-id"), f.tenants.a.organizationId);
  return target;
}
