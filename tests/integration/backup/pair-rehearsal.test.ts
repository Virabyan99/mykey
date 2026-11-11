// Run 2.9 Step 1: a paired backup rehearsed on a local stack (own stack: the
// snapshot is restored into the same OpenBao). Freeze → dump, globals, Raft
// snapshot → release → restore the dump into a new database and the snapshot
// into OpenBao; the two halves must agree.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyDatabaseAccess, applyRoles, createPool } from "@mykey/db";
import { spikeSecretPath } from "@mykey/operations/spike";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boundaryOf, freeze, release } from "../../../infra/backup/pair-spike/freeze.ts";
import {
  ARTIFACT_NAMES,
  buildManifest,
  verifyArtifacts,
  type PairManifest,
} from "../../../infra/backup/pair-spike/manifest.ts";
import { auditedWrites, effectsFixture, type EffectsFixture } from "../../fault/effects/fixture.ts";
import { matrixProblems } from "../../harness/privilege-matrix.ts";
import {
  baoFetch,
  pgDumpToFile,
  pgGlobalsToFile,
  pgRestoreFromFile,
  startStack,
  type Stack,
} from "../../harness/stack.ts";
import { rolePasswords, run } from "../database/setup.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

let stack: Stack;
let fixture: EffectsFixture;
let directory: string;
const before: { name: string; version: number }[] = [];
let after: { name: string } | undefined;
let manifest: PairManifest;
let restoredDatabase = "";
let frozenMs = 0;
let busyOperationId = "";

beforeAll(async () => {
  stack = await startStack();
  fixture = await effectsFixture(stack);
  directory = mkdtempSync(join(tmpdir(), "mykey-pair-"));

  for (let index = 0; index < 5; index += 1) {
    const input = fixture.write({ environment: index % 2 });
    const outcome = await fixture.execute(input);
    if (outcome.state !== "succeeded") throw new Error(`seed write ${index}: ${outcome.state}`);
    before.push({ name: input.name, version: outcome.version });
  }

  const pairId = randomUUID();
  const maintenance = fixture.db.pool("maintenance");
  const started = new Date().toISOString();
  const frozen = await freeze(maintenance, pairId);
  if (!frozen.ok) throw new Error(`freeze: ${frozen.stage} ${frozen.reason}`);

  // A write during the freeze is refused before anything is sent.
  const refused = await fixture.execute(fixture.write());
  if (refused.state !== "rejected" || refused.code !== "busy") {
    throw new Error(`write during the freeze: ${JSON.stringify(refused)}`);
  }
  busyOperationId = refused.operationId;

  const boundary = await boundaryOf(maintenance);
  await pgDumpToFile(stack, fixture.db.database, join(directory, "postgres.dump"));
  await pgGlobalsToFile(stack, join(directory, "globals.sql"));
  const snapshot = await baoFetch(stack, "/v1/sys/storage/raft/snapshot");
  if (snapshot.status !== 200) throw new Error(`snapshot: HTTP ${snapshot.status}`);
  writeFileSync(join(directory, "openbao.snap"), new Uint8Array(await snapshot.arrayBuffer()));
  await release(maintenance);
  frozenMs = Date.now() - frozen.frozenAt;

  // After the boundary: must not be in the restored pair.
  const later = fixture.write();
  const laterOutcome = await fixture.execute(later);
  if (laterOutcome.state !== "succeeded") throw new Error("write after the release failed");
  after = { name: later.name };

  const migration = await run<{ name: string; checksum: string }>(
    fixture.db.pool("superuser"),
    "SELECT name, sha256 AS checksum FROM meta.schema_migration ORDER BY name DESC LIMIT 1",
  );
  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const artifacts = {} as PairManifest["artifacts"];
  for (const name of ARTIFACT_NAMES) {
    artifacts[name] = {
      sha256: sha(join(directory, name)),
      bytes: statSync(join(directory, name)).size,
    };
  }
  manifest = buildManifest({
    pairId,
    captureStartedAt: started,
    captureFinishedAt: new Date().toISOString(),
    captureEpoch: frozen.epoch,
    releaseCommit: "0".repeat(40),
    schemaRevision: `${migration[0]?.name.replace(/\.sql$/, "") ?? ""} ${migration[0]?.checksum ?? ""}`,
    versions: { postgres: "18.6", openbao: "2.7.2", restic: "0.19.1" },
    seal: { type: "static", keyIds: ["dev-1"] },
    namespaces: [fixture.org.namespace],
    boundary: {
      lastOperationId: boundary.lastOperationId,
      executingOperations: 0,
      heldEffectSlots: 0,
    },
    artifacts,
    rolesChecksum: sha(join(ROOT, "packages/db/roles/roles.sql")),
  });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
}, 600_000);

afterAll(async () => {
  if (restoredDatabase !== "") {
    await run(
      fixture.db.pool("superuser"),
      `DROP DATABASE IF EXISTS ${restoredDatabase} WITH (FORCE)`,
    ).catch(() => undefined);
  }
  rmSync(directory, { recursive: true, force: true });
  await (fixture as EffectsFixture | undefined)?.close().catch(() => undefined);
  await (stack as Stack | undefined)?.stop();
}, 300_000);

describe("a paired backup, rehearsed locally", () => {
  it("froze briefly and refused a write during the freeze without sending it", async () => {
    expect(frozenMs).toBeLessThan(60_000);
    expect(await auditedWrites(fixture, busyOperationId)).toBe(0);
    const mode = await run<{ capture_mode: string }>(
      fixture.db.pool("maintenance"),
      "SELECT capture_mode FROM app.service_control",
    );
    expect(mode[0]?.capture_mode).toBe("idle");
  });

  it("holds exactly the three artifacts the manifest describes", async () => {
    expect(await verifyArtifacts(manifest, directory)).toEqual({ ok: true, problems: [] });
    expect(manifest.boundary.executingOperations).toBe(0);
  });

  it("restores PostgreSQL into a new database that matches the matrix and the boundary", async () => {
    restoredDatabase = `pair_${randomBytes(5).toString("hex")}`;
    const superuser = fixture.db.pool("superuser");
    await run(superuser, `CREATE DATABASE ${restoredDatabase}`);
    const target = { ...fixture.db.superuser, database: restoredDatabase };
    await applyRoles(target, rolePasswords(stack));
    const pool = createPool(target, { max: 1 });
    try {
      await applyDatabaseAccess(pool, restoredDatabase);
      await pgRestoreFromFile(stack, join(directory, "postgres.dump"), restoredDatabase);
      expect(await matrixProblems(pool)).toEqual([]);
      const names = await run<{ name: string; current_version: number }>(
        pool,
        "SELECT name, current_version FROM app.secret_index ORDER BY name",
      );
      expect(names.map((row) => ({ name: row.name, version: row.current_version }))).toEqual(
        [...before].sort((a, b) => a.name.localeCompare(b.name)),
      );
      expect(names.map((row) => row.name)).not.toContain(after?.name);
    } finally {
      await pool.end();
    }
  });

  it("restores the OpenBao snapshot, and the two halves agree", async () => {
    const restored = await baoFetch(stack, "/v1/sys/storage/raft/snapshot-force", {
      method: "POST",
      body: new Uint8Array(readFileSync(join(directory, "openbao.snap"))),
    });
    expect(restored.status).toBe(204);
    let healthy = false;
    for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
      healthy =
        (await baoFetch(stack, "/v1/sys/health", { token: "" }).catch(() => undefined))?.status ===
        200;
      if (!healthy) await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    expect(healthy).toBe(true);
    const bao = fixture.runtimeBao();
    // Observed: /sys/health answers before the restored mounts serve; reads
    // first time out. Wait (bounded) for the first secret, and record how long.
    const first = before[0];
    if (first === undefined) throw new Error("no seeded secret");
    const firstPath = spikeSecretPath(
      fixture.org.projectId,
      fixture.org.environments[0]!.id,
      first.name,
    );
    const waited = Date.now();
    let readable = false;
    while (!readable && Date.now() - waited < 60_000) {
      readable = (await bao.kvMetadata(firstPath)).ok;
      if (!readable) await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    console.info(`snapshot restore: secrets readable ${Date.now() - waited} ms after /sys/health`);
    expect(readable).toBe(true);
    for (const [index, secret] of before.entries()) {
      const path = spikeSecretPath(
        fixture.org.projectId,
        fixture.org.environments[index % 2]!.id,
        secret.name,
      );
      const metadata = await bao.kvMetadata(path);
      expect(
        metadata.ok ? metadata.data.currentVersion : JSON.stringify(metadata),
        secret.name,
      ).toBe(secret.version);
    }
    const laterPath = spikeSecretPath(
      fixture.org.projectId,
      fixture.org.environments[0]!.id,
      after?.name ?? "",
    );
    expect(await bao.kvRead(laterPath)).toEqual({ ok: false, kind: "not_found", status: 404 });
  });
});
