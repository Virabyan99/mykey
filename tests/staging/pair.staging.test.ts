// Run 2.9 (part of D08-S11, P-36): one paired backup of staging — PostgreSQL
// dump, globals and OpenBao Raft snapshot at one boundary — sealed with Restic,
// stored in R2, restored from the bucket into new stores, checked half by half
// and against each other; then the bad paths. Synthetic data only: the 40
// values are canaries assembled at run time, kept in memory, never written.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createPool, type RoleName } from "@mykey/db";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { OpenBaoClient } from "@mykey/openbao";
import { spikeSecretPath } from "@mykey/operations/spike";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RestoreRefused,
  abortCapture,
  capturePair,
  cleanupRestore,
  restorePair,
  waitRestoredOpenBao,
  type CaptureResult,
  type PairContext,
  type RestoredPair,
} from "../../infra/backup/pair-spike/capture.ts";
import { pairPaths, restoreGlobalsCommand } from "../../infra/backup/pair-spike/host-steps.ts";
import { effectsFixture, type EffectsFixture } from "../fault/effects/fixture.ts";
import { matrixProblems } from "../harness/privilege-matrix.ts";
import { baoFetch, type Stack } from "../harness/stack.ts";
import { stagingDatabase } from "../harness/staging-db.ts";
import {
  connectStaging,
  expectSuccess,
  registerSecret,
  sshExec,
  type StagingStack,
} from "../harness/staging.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const EVIDENCE = join(ROOT, "docs/evidence/session-2/pair-staging.txt");
const MEASURES = join(ROOT, "docs/evidence/session-2/pair-spike.json");
/** The losstest key L-C of Run 2.7 (key-loss-staging.txt): a healthy key that sealed nothing here. */
const OTHER_SEAL = { cert: "losstest-ops", keyId: "ed842867-356d-492d-9605-8f94b3bca6ac" };
const SCHEMAS = ["app", "audit", "auth", "jobs", "meta"];

interface Seeded {
  fixture: EffectsFixture;
  environment: number;
  name: string;
  version: number;
  sha256: string;
}

let staging: StagingStack;
let ctx: PairContext;
let fixtures: EffectsFixture[] = [];
const seeded: Seeded[] = [];
const canaries: string[] = [];
const machineTokens: { before: string[]; after: string } = { before: [], after: "" };
let good: Extract<CaptureResult, { ok: true }>;
let restored: RestoredPair | undefined;
let boundaryCounts: Record<string, number> = {};
const writer = {
  stop: false,
  attempts: [] as { at: number; end: number; state: string; code?: string }[],
};
let writerDone: Promise<void> = Promise.resolve();

function record(line: string): void {
  appendFileSync(EVIDENCE, `${new Date().toISOString()} ${line}\n`);
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function imageDigests(): Record<string, string> {
  const lock = JSON.parse(readFileSync(join(ROOT, "infra/dependencies.lock.json"), "utf8")) as {
    images: Record<string, { digest: string }>;
  };
  return Object.fromEntries(
    ["postgres", "openbao", "restic"].map((name) => [name, lock.images[name]?.digest ?? ""]),
  );
}

/** A canary, assembled at run time (never a literal in the repository). */
function canary(): string {
  const value = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
  canaries.push(value);
  registerSecret(value);
  return value;
}

function passwordsOf(db: {
  targets: Record<RoleName, { password: string }>;
}): Record<RoleName, string> {
  return Object.fromEntries(
    Object.entries(db.targets).map(([role, target]) => [role, target.password]),
  ) as Record<RoleName, string>;
}

async function mintMachineToken(fixture: EffectsFixture): Promise<string> {
  const machine = fixture.org.environments[0]!.machineName;
  const minted = await baoFetch(staging as unknown as Stack, `/v1/auth/token/create/${machine}`, {
    method: "POST",
    namespace: fixture.org.namespace,
    body: { ttl: "3600s", policies: [machine], no_default_policy: true },
  });
  if (minted.status !== 200) throw new Error(`machine token: HTTP ${minted.status}`);
  const token = ((await minted.json()) as { auth: { client_token: string } }).auth.client_token;
  registerSecret(token);
  return token;
}

async function tableCounts(pool: pg.Pool, createdBefore?: string): Promise<Record<string, number>> {
  const tables = await pool.query<{ schemaname: string; tablename: string }>(
    "SELECT schemaname, tablename FROM pg_tables WHERE schemaname = ANY($1) ORDER BY 1, 2",
    [SCHEMAS],
  );
  const counts: Record<string, number> = {};
  for (const { schemaname, tablename } of tables.rows) {
    const name = `${schemaname}.${tablename}`;
    // Refused writes insert `rejected` operations during the freeze: compare what existed before it.
    const filter =
      name === "app.operation" && createdBefore !== undefined ? " WHERE created_at < $1" : "";
    const result = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM "${schemaname}"."${tablename}"${filter}`,
      filter === "" ? [] : [createdBefore],
    );
    counts[name] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

async function onHost(command: string, what: string, secret = false): Promise<string> {
  return expectSuccess(
    await sshExec(staging.host, command, { sudo: true, timeoutMs: 600_000, secretOutput: secret }),
    what,
  ).stdout;
}

function restoredClient(fixture: EffectsFixture, token: string): OpenBaoClient {
  if (restored === undefined) throw new Error("not restored");
  return new OpenBaoClient(
    { url: restored.openbao.stack.bao.url, caCertPath: staging.bao.caCertPath },
    { namespace: fixture.org.namespace, token },
  );
}

beforeAll(async () => {
  staging = await connectStaging({ openbao: true });
  if (!existsSync(EVIDENCE))
    writeFileSync(EVIDENCE, "# Run 2.9 paired backup on staging (appended)\n");
  const dbA = await stagingDatabase(staging);
  const dbB = await stagingDatabase(staging);
  const stack = staging as unknown as Stack;
  fixtures = [await effectsFixture(stack, { db: dbA }), await effectsFixture(stack, { db: dbB })];
  const r2 = JSON.parse(
    readFileSync(join(homedir(), ".mykey/secrets/r2/mykey-staging-pairs-upload.json"), "utf8"),
  ) as { accountId: string; accessKeyId: string; secretAccessKey: string };
  registerSecret(r2.secretAccessKey);
  ctx = {
    staging,
    maintenance: dbA.pool("maintenance"),
    reader: dbA.pool("backup_reader"),
    passwords: passwordsOf(dbA),
    r2: { ...r2, bucket: "mykey-staging-pairs" },
  };

  // Step 2: 40 secrets through executeWrite, two machine tokens, a background writer.
  for (let index = 0; index < 40; index += 1) {
    const fixture = fixtures[index % 2]!;
    const environment = Math.floor(index / 2) % 2;
    const value = canary();
    const input = fixture.write({ environment, value });
    const outcome = await fixture.execute(input);
    if (outcome.state !== "succeeded") throw new Error(`seed ${index}: ${outcome.state}`);
    seeded.push({
      fixture,
      environment,
      name: input.name,
      version: outcome.version,
      sha256: sha256(value),
    });
  }
  for (const fixture of fixtures) machineTokens.before.push(await mintMachineToken(fixture));
  writerDone = (async () => {
    const fixture = fixtures[0]!;
    while (!writer.stop) {
      const at = Date.now();
      const outcome = await fixture
        .execute(fixture.write({ environment: 1, value: `synthetic-${at}` }))
        .catch(() => ({ state: "error" as const }));
      writer.attempts.push({
        at,
        end: Date.now(),
        state: outcome.state,
        ...("code" in outcome && typeof outcome.code === "string" ? { code: outcome.code } : {}),
      });
      await new Promise((wait) => setTimeout(wait, Math.max(0, 1_000 - (Date.now() - at))));
    }
  })();
  record(
    `seeded: 40 secrets in 2 organizations x 2 environments, 2 machine tokens; writer running`,
  );
}, 900_000);

afterAll(async () => {
  writer.stop = true;
  await writerDone;
  if (restored !== undefined) await cleanupRestore(ctx, restored);
  for (const fixture of fixtures) await fixture.close().catch(() => undefined);
  await (staging as StagingStack | undefined)?.close();
}, 600_000);

describe("a paired backup of staging, the good path", () => {
  it("capture produces a matched pair", async () => {
    const result = await capturePair(ctx, {
      duringFreeze: async () => {
        boundaryCounts = await tableCounts(fixtures[0]!.db.pool("superuser"));
      },
    });
    if (!result.ok) throw new Error(`capture: ${result.stage} ${result.reason}`);
    good = result;
    // Let the writer see the release, then stop it.
    await new Promise((wait) => setTimeout(wait, 5_000));
    writer.stop = true;
    await writerDone;
    machineTokens.after = await mintMachineToken(fixtures[0]!);

    expect(good.manifest.boundary.executingOperations).toBe(0);
    expect(good.manifest.boundary.heldEffectSlots).toBe(0);
    expect(good.frozenMs).toBeLessThan(60_000);
    // An attempt takes seconds over the tunnel, and its admission check falls somewhere
    // inside it: an attempt that both began after the drain and ended before the release
    // was checked during the freeze, and must have been refused.
    const during = writer.attempts.filter(
      (a) => a.at >= good.capturingAt && a.end <= good.releasedAt,
    );
    const after = writer.attempts.filter((a) => a.at >= good.releasedAt + 1_000);
    const states = (list: typeof writer.attempts): string =>
      JSON.stringify(
        list.reduce<Record<string, number>>((all, a) => {
          const key = `${a.state}${a.code === undefined ? "" : `/${a.code}`}`;
          all[key] = (all[key] ?? 0) + 1;
          return all;
        }, {}),
      );
    const around = writer.attempts.filter(
      (a) => a.at >= good.frozenAt - 2_000 && a.at < good.releasedAt + 2_000,
    );
    record(
      `capture ${good.pairId}: freeze ${good.frozenMs} ms (drain ${good.capturingAt - good.frozenAt} ms); writer inside the freeze ${states(during)}, around it ${states(around)}, after ${states(after)}; timings ${JSON.stringify(good.timings)}`,
    );
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((a) => a.state === "rejected" && a.code === "busy")).toBe(true);
    expect(after.some((a) => a.state === "succeeded")).toBe(true);
  }, 900_000);

  it("restore into new stores", async () => {
    restored = await restorePair(ctx, good.pairId, readFileSync(good.resticPasswordFile, "utf8"));
    await waitRestoredOpenBao(restored, 180);
    record(
      `restore ${good.pairId}: ${restored.openbao.snapshotEndpoint}; timings ${JSON.stringify(restored.timings)}`,
    );
  }, 1_200_000);

  it("the bucket holds ciphertext only", async () => {
    const { root } = pairPaths(good.pairId);
    expect(Number((await onHost(`stat -c %s ${root}/restore/repo.tar`, "size")).trim())).toBe(
      good.bundleBytes,
    );
    const downloaded = JSON.parse(
      await onHost(`cat ${root}/restore/manifest.json`, "manifest"),
    ) as unknown;
    expect(downloaded).toEqual(good.manifest);
    expectSuccess(
      await sshExec(staging.host, `install -m 0400 /dev/stdin ${root}/in/canaries`, {
        sudo: true,
        secretOutput: true,
        stdin: `${canaries.join("\n")}\n`,
      }),
      "canary list",
    );
    const found = (
      await onHost(
        `grep -c -a -F -f ${root}/in/canaries ${root}/restore/repo.tar || true`,
        "search",
        true,
      )
    ).trim();
    expect(found).toBe("0");
    const text = JSON.stringify(good.manifest);
    for (const secret of [...canaries, staging.bao.rootToken, ...Object.values(ctx.passwords)]) {
      expect(text.includes(secret)).toBe(false);
    }
  }, 300_000);

  it("PostgreSQL is whole", async () => {
    if (restored === undefined) throw new Error("not restored");
    const pool = createPool(restored.postgres.superuser, { max: 1 });
    try {
      const createdBefore = new Date(good.frozenAt).toISOString();
      const restoredCounts = await tableCounts(pool, createdBefore);
      const sourceOperations = await fixtures[0]!.db
        .pool("superuser")
        .query<{ n: string }>("SELECT count(*) AS n FROM app.operation WHERE created_at < $1", [
          createdBefore,
        ]);
      expect(restoredCounts).toEqual({
        ...boundaryCounts,
        "app.operation": Number(sourceOperations.rows[0]?.n ?? 0),
      });
      const migrations = "SELECT name, sha256 FROM meta.schema_migration ORDER BY name";
      expect((await pool.query(migrations)).rows).toEqual(
        (await fixtures[0]!.db.pool("superuser").query(migrations)).rows,
      );
      expect(await matrixProblems(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
    const { root } = pairPaths(good.pairId);
    await onHost(restoreGlobalsCommand(good.pairId), "globals of the new cluster", true);
    const strip = "sed -e '/^--/d' -e '/^.restrict /d' -e '/^.unrestrict /d' -e '/^$/d'";
    const same = await onHost(
      `${strip} ${root}/restore/out/pair/artifacts/globals.sql > ${root}/restore/g1 && ${strip} ${root}/restore/globals-new.sql > ${root}/restore/g2 && if cmp -s ${root}/restore/g1 ${root}/restore/g2; then echo same; else diff ${root}/restore/g1 ${root}/restore/g2 | head -20; fi`,
      "globals compared",
    );
    expect(same.trim()).toBe("same");
    const api = createPool(restored.postgres.target("api_runtime"), { max: 1 });
    try {
      expect((await api.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    } finally {
      await api.end();
    }
  }, 600_000);

  it("OpenBao is whole", async () => {
    if (restored === undefined) throw new Error("not restored");
    const restoredPool = createPool(restored.postgres.superuser, { max: 1 });
    try {
      const operations = new Set(
        (await restoredPool.query<{ id: string }>("SELECT id FROM app.operation")).rows.map(
          (r) => r.id,
        ),
      );
      // The restored mounts may serve a moment after /sys/health.
      const first = seeded[0]!;
      const firstClient = restoredClient(first.fixture, first.fixture.runtimeToken);
      const firstPath = spikeSecretPath(
        first.fixture.org.projectId,
        first.fixture.org.environments[first.environment]!.id,
        first.name,
      );
      const waited = Date.now();
      while (!(await firstClient.kvRead(firstPath)).ok && Date.now() - waited < 90_000) {
        await new Promise((wait) => setTimeout(wait, 2_000));
      }
      for (const secret of seeded) {
        const client = restoredClient(secret.fixture, secret.fixture.runtimeToken);
        const path = spikeSecretPath(
          secret.fixture.org.projectId,
          secret.fixture.org.environments[secret.environment]!.id,
          secret.name,
        );
        const read = await client.kvRead(path);
        expect(read.ok, secret.name).toBe(true);
        if (!read.ok) continue;
        expect(sha256(read.data.envelope.value)).toBe(secret.sha256);
        expect(read.data.version).toBe(secret.version);
        // No backend write without its operation in the restored database.
        expect(operations.has(read.data.envelope.operation_id)).toBe(true);
      }
    } finally {
      await restoredPool.end();
    }
    const sourceAdmin = new OpenBaoAdmin(staging.bao, staging.bao.rootToken);
    const restoredAdmin = new OpenBaoAdmin(
      { url: restored.openbao.stack.bao.url, caCertPath: staging.bao.caCertPath },
      staging.bao.rootToken,
    );
    for (const fixture of fixtures) {
      for (const name of ["runtime", "issuer", "provisioner"]) {
        expect(await restoredAdmin.readPolicy(fixture.org.namespace, name)).toBe(
          await sourceAdmin.readPolicy(fixture.org.namespace, name),
        );
      }
      for (const environment of fixture.org.environments) {
        expect(
          await restoredAdmin.readTokenRole(fixture.org.namespace, environment.machineName),
        ).toEqual(await sourceAdmin.readTokenRole(fixture.org.namespace, environment.machineName));
      }
    }
    const namespaces = await baoFetch(restored.openbao.stack, "/v1/sys/namespaces", {
      method: "LIST",
      token: staging.bao.rootToken,
    });
    const listed = ((await namespaces.json()) as { data: { keys: string[] } }).data.keys
      .map((key) => key.replace(/\/$/, ""))
      .sort();
    expect(listed).toEqual(good.manifest.namespaces);

    // A machine token from before the capture reads its environment; one from after does not exist.
    const before = seeded.find((s) => s.fixture === fixtures[0] && s.environment === 0)!;
    const machineRead = await restoredClient(fixtures[0]!, machineTokens.before[0]!).kvRead(
      spikeSecretPath(
        fixtures[0]!.org.projectId,
        fixtures[0]!.org.environments[0]!.id,
        before.name,
      ),
    );
    expect(machineRead.ok).toBe(true);
    const lookup = await baoFetch(restored.openbao.stack, "/v1/auth/token/lookup-self", {
      namespace: fixtures[0]!.org.namespace,
      token: machineTokens.after,
    });
    expect(lookup.status).toBe(403);
  }, 600_000);

  it("the two halves agree, and the pair becomes eligible", async () => {
    if (restored === undefined) throw new Error("not restored");
    const pool = createPool(restored.postgres.superuser, { max: 1 });
    try {
      for (const fixture of fixtures) {
        const rows = await pool.query<{
          name: string;
          environment_id: string;
          current_version: number;
        }>(
          `SELECT s.name, s.environment_id, s.current_version FROM app.secret_index s
             JOIN app.environment e ON e.id = s.environment_id WHERE e.organization_id = $1`,
          [fixture.org.organizationId],
        );
        expect(rows.rows.length).toBeGreaterThan(0);
        const operator = new OpenBaoClient(
          { url: restored.openbao.stack.bao.url, caCertPath: staging.bao.caCertPath },
          { namespace: fixture.org.namespace, token: staging.bao.rootToken },
        );
        for (const row of rows.rows) {
          const metadata = await operator.kvMetadata(
            spikeSecretPath(fixture.org.projectId, row.environment_id, row.name),
          );
          expect(metadata.ok ? metadata.data.currentVersion : -1, row.name).toBe(
            row.current_version,
          );
        }
      }
      const executing = await pool.query("SELECT 1 FROM app.operation WHERE state = 'executing'");
      expect(executing.rowCount).toBe(0);
    } finally {
      await pool.end();
    }
    await ctx.maintenance.query(
      "UPDATE app.backup_pair SET validation_status = 'eligible', eligible_until = now() + interval '7 days' WHERE id = $1",
      [good.pairId],
    );
    record(`pair ${good.pairId} eligible`);
    const artifacts = good.manifest.artifacts;
    writeFileSync(
      MEASURES,
      `${JSON.stringify(
        {
          pairId: good.pairId,
          captured: good.manifest.captureStartedAt,
          frozenMs: good.frozenMs,
          bytes: {
            "postgres.dump": artifacts["postgres.dump"].bytes,
            "globals.sql": artifacts["globals.sql"].bytes,
            "openbao.snap": artifacts["openbao.snap"].bytes,
            "repo.tar": good.bundleBytes,
          },
          secondsCapture: good.timings,
          secondsRestore: restored.timings,
          snapshotEndpoint: restored.openbao.snapshotEndpoint,
          images: imageDigests(),
          objects: [`pairs/${good.pairId}/repo.tar`, `pairs/${good.pairId}/manifest.json`],
        },
        null,
        2,
      )}\n`,
    );
    await cleanupRestore(ctx, restored);
    restored = undefined;
  }, 600_000);
});

describe("a paired backup of staging, the bad paths", () => {
  let second = "";

  it("an unresolved effect blocks the capture; after reconcile the next capture works", async () => {
    const fixture = fixtures[0]!;
    const child = fixture.child(fixture.write({ environment: 0 }), { hangAfterSend: true });
    await child.started;
    await new Promise((wait) => setTimeout(wait, 5_000));
    const blocked = await capturePair(ctx);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.stage).toBe("drain");
    const mode = await ctx.maintenance.query<{ capture_mode: string }>(
      "SELECT capture_mode FROM app.service_control",
    );
    expect(mode.rows[0]?.capture_mode).toBe("idle");
    const eligible = await ctx.maintenance.query(
      "SELECT 1 FROM app.backup_pair WHERE id = $1 AND validation_status = 'eligible'",
      [blocked.pairId],
    );
    expect(eligible.rowCount).toBe(0);
    await child.kill();
    const stuck = await ctx.maintenance.query<{ id: string }>(
      "SELECT id FROM app.operation WHERE organization_id = $1 AND state IN ('accepted', 'executing')",
      [fixture.org.organizationId],
    );
    for (const row of stuck.rows) await fixture.reconcile(row.id, true);
    const next = await capturePair(ctx);
    if (!next.ok) throw new Error(`capture after reconcile: ${next.stage} ${next.reason}`);
    second = next.pairId;
    record(
      `unresolved effect: capture refused at drain (${blocked.ok ? "" : blocked.reason}); after reconcile pair ${second} captured`,
    );
  }, 900_000);

  it("a capture that dies keeps the freeze", async () => {
    const died = await capturePair(ctx, { failAt: "after_dump" });
    expect(died).toMatchObject({ ok: false, stage: "capture", freezeHeld: true });
    const mode = await ctx.maintenance.query<{ capture_mode: string }>(
      "SELECT capture_mode FROM app.service_control",
    );
    expect(mode.rows[0]?.capture_mode).toBe("capturing");
    const refused = await fixtures[1]!.execute(fixtures[1]!.write());
    expect(refused).toMatchObject({ state: "rejected", code: "busy" });
    const row = await ctx.maintenance.query<{ validation_status: string }>(
      "SELECT validation_status FROM app.backup_pair WHERE id = $1",
      [died.pairId],
    );
    expect(row.rows[0]?.validation_status).toBe("candidate");
    await abortCapture(ctx, died.pairId);
    const after = await ctx.maintenance.query<{ capture_mode: string }>(
      "SELECT capture_mode FROM app.service_control",
    );
    expect(after.rows[0]?.capture_mode).toBe("idle");
    const marked = await ctx.maintenance.query<{ validation_status: string }>(
      "SELECT validation_status FROM app.backup_pair WHERE id = $1",
      [died.pairId],
    );
    expect(marked.rows[0]?.validation_status).toBe("ineligible");
    record(
      `capture died after the dump: freeze held, writes busy, pair candidate; abortCapture → idle, ineligible`,
    );
  }, 600_000);

  it("a swapped manifest is rejected", async () => {
    const attempt = restorePair(ctx, good.pairId, readFileSync(good.resticPasswordFile, "utf8"), {
      manifestOf: second,
    });
    await expect(attempt).rejects.toBeInstanceOf(RestoreRefused);
    await cleanupRestore(ctx, { pairId: good.pairId });
    record(
      `swapped manifest (pair ${second}'s with ${good.pairId}'s bundle): refused before anything was restored`,
    );
  }, 600_000);

  it("a missing role is detected", async () => {
    let failed: boolean;
    let detail: string;
    try {
      const partial = await restorePair(
        ctx,
        good.pairId,
        readFileSync(good.resticPasswordFile, "utf8"),
        {
          withoutRole: "backup_reader",
          postgresOnly: true,
        },
      );
      const pool = createPool(partial.postgres.superuser, { max: 1 });
      const problems = await matrixProblems(pool).finally(() => pool.end());
      failed = problems.length > 0;
      detail = `matrix: ${problems.length} problems`;
      await cleanupRestore(ctx, partial);
    } catch (error) {
      failed = error instanceof RestoreRefused;
      detail = (error as Error).message;
      await cleanupRestore(ctx, { pairId: good.pairId });
    }
    record(`missing role backup_reader: restore reported failed=${failed} (${detail})`);
    expect(failed).toBe(true);
  }, 600_000);

  it("changed default privileges are detected", async () => {
    const partial = await restorePair(
      ctx,
      good.pairId,
      readFileSync(good.resticPasswordFile, "utf8"),
      {
        skipDatabaseAccess: true,
        postgresOnly: true,
      },
    );
    const pool = createPool(partial.postgres.superuser, { max: 1 });
    const problems = await matrixProblems(pool).finally(() => pool.end());
    await cleanupRestore(ctx, partial);
    expect(problems.length).toBeGreaterThan(0);
    record(`applyDatabaseAccess skipped: matrix reports ${problems.slice(0, 3).join(" | ")}`);
  }, 600_000);

  it("a different seal key cannot open the snapshot", async () => {
    let readable = false;
    let detail: string;
    try {
      const other = await restorePair(
        ctx,
        good.pairId,
        readFileSync(good.resticPasswordFile, "utf8"),
        {
          seal: OTHER_SEAL,
        },
      );
      detail = other.openbao.snapshotEndpoint;
      const first = seeded[0]!;
      const client = new OpenBaoClient(
        { url: other.openbao.stack.bao.url, caCertPath: staging.bao.caCertPath },
        { namespace: first.fixture.org.namespace, token: first.fixture.runtimeToken },
      );
      const path = spikeSecretPath(
        first.fixture.org.projectId,
        first.fixture.org.environments[first.environment]!.id,
        first.name,
      );
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !readable) {
        readable = (await client.kvRead(path).catch(() => ({ ok: false }))).ok;
        if (!readable) await new Promise((wait) => setTimeout(wait, 3_000));
      }
      await cleanupRestore(ctx, other);
    } catch (error) {
      detail = (error as Error).message;
      await cleanupRestore(ctx, { pairId: good.pairId });
    }
    expect(readable).toBe(false);
    record(
      `snapshot into an instance on another seal key (L-C): ${detail}; secret readable=${readable}`,
    );
  }, 900_000);
});
