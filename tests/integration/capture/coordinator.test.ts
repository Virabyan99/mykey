// Run 6.5 Task B (P-118, P-120, D-51): the capture coordinator. idle →
// draining → (drain, at most 30 s) → capturing → recordCapture → idle, or
// back to idle and busy; abortCapture releases only its owner's freeze.
import { randomUUID } from "node:crypto";
import {
  abortCapture,
  beginCapture,
  recordCapture,
  type CaptureRecord,
} from "@mykey/operations/operator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await prepareDatabase({ migrate: true });
}, 300_000);

afterEach(async () => {
  await db
    .pool("maintenance")
    .query(
      "UPDATE app.service_control SET capture_mode = 'idle', owner = NULL, pair_id = NULL, updated_at = now()",
    );
  await db.pool("superuser").query("DELETE FROM app.operation WHERE action = 'coordinator.test'");
});

afterAll(async () => {
  await db.drop();
});

const maintenance = () => db.pool("maintenance");

async function mode(): Promise<{
  capture_mode: string;
  owner: string | null;
  pair_id: string | null;
}> {
  const rows = await run<{ capture_mode: string; owner: string | null; pair_id: string | null }>(
    db.pool("superuser"),
    "SELECT capture_mode, owner, pair_id FROM app.service_control",
  );
  return rows[0]!;
}

async function executing(): Promise<string> {
  const id = randomUUID();
  await db.pool("superuser").query(
    `INSERT INTO app.operation (id, principal_kind, principal_id, action, target, idempotency_key, state)
     VALUES ($1::uuid, 'operator', 'coordinator', 'coordinator.test', $1::text, $1::text, 'executing')`,
    [id],
  );
  return id;
}

async function finish(id: string): Promise<void> {
  await db
    .pool("superuser")
    .query("UPDATE app.operation SET state = 'succeeded', completed_at = now() WHERE id = $1", [
      id,
    ]);
}

function record(captureStartedAt: Date): CaptureRecord {
  return {
    host: "local",
    captureStartedAt: captureStartedAt.toISOString(),
    boundary: { lastOperationId: null, executingOperations: 0, heldEffectSlots: 0 },
    schemaRevision: "0017_capture_barrier",
    releaseBuild: "000000000000",
    keyRefs: { backupPassword: "local/1" },
    artifacts: [
      { name: "postgres.dump", bytes: 1, sha256: "a".repeat(64) },
      { name: "globals.sql", bytes: 1, sha256: "b".repeat(64) },
      { name: "openbao.snap", bytes: 1, sha256: "c".repeat(64) },
    ],
  };
}

async function auditRows(pairId: string): Promise<{ action: string; outcome: string }[]> {
  return run<{ action: string; outcome: string }>(
    db.pool("superuser"),
    "SELECT action, outcome FROM audit.event WHERE target_id = $1 ORDER BY occurred_at, id",
    [pairId],
  );
}

describe("beginCapture", () => {
  it("an accepted operation does not hold the drain (the provisioner defers its jobs while draining)", async () => {
    const id = randomUUID();
    await db.pool("superuser").query(
      `INSERT INTO app.operation (id, principal_kind, principal_id, action, target, idempotency_key, state)
       VALUES ($1::uuid, 'operator', 'coordinator', 'coordinator.test', $1::text, $1::text, 'accepted')`,
      [id],
    );
    const result = await beginCapture(maintenance(), "test-a", { drainDeadlineMs: 5_000 });
    expect(result.kind).toBe("capturing");
  });

  it("a writer that commits an executing operation while the change to capturing waits keeps the coordinator draining (the compete test's finding)", async () => {
    const blocker = await executing();
    const begun = beginCapture(maintenance(), "test-a");
    const deadline = Date.now() + 10_000;
    while ((await mode()).capture_mode !== "draining") {
      if (Date.now() > deadline) throw new Error("never draining");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The writer's statement passes the barrier while draining and holds the
    // control row FOR SHARE until it commits.
    const writer = await db.pool("superuser").connect();
    const late = randomUUID();
    try {
      await writer.query("BEGIN");
      await writer.query(
        `INSERT INTO app.operation (id, principal_kind, principal_id, action, target, idempotency_key, state)
         VALUES ($1::uuid, 'operator', 'coordinator', 'coordinator.test', $1::text, $1::text, 'executing')`,
        [late],
      );
      // The committed boundary is clean now: the coordinator tries capturing
      // and waits for the writer.
      await finish(blocker);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await writer.query("COMMIT");
    } finally {
      writer.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await mode()).capture_mode).toBe("draining");
    await finish(late);
    const result = await begun;
    expect(result.kind).toBe("capturing");
    if (result.kind !== "capturing") return;
    expect(result.boundary.executingOperations).toBe(0);
  });

  it("waits for an operation that is executing and then answers capturing", async () => {
    const id = await executing();
    const begun = beginCapture(maintenance(), "test-a");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await mode()).capture_mode).toBe("draining");
    await finish(id);
    const result = await begun;
    expect(result.kind).toBe("capturing");
    if (result.kind !== "capturing") return;
    expect(result.boundary).toEqual({
      lastOperationId: expect.any(String) as string,
      executingOperations: 0,
      heldEffectSlots: 0,
    });
    expect(await mode()).toEqual({
      capture_mode: "capturing",
      owner: "test-a",
      pair_id: result.pairId,
    });
  });

  it("with an operation that stays executing for 31 s it answers busy and the mode is idle again", async () => {
    await executing();
    const started = Date.now();
    const result = await beginCapture(maintenance(), "test-a");
    expect(result).toEqual({ kind: "busy", reason: "drain_deadline" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
    expect((await mode()).capture_mode).toBe("idle");
  }, 60_000);

  it("two coordinators: one captures, the other is busy", async () => {
    const [one, two] = await Promise.all([
      beginCapture(maintenance(), "test-a"),
      beginCapture(maintenance(), "test-b"),
    ]);
    const kinds = [one.kind, two.kind].sort();
    expect(kinds).toEqual(["busy", "capturing"]);
    const busy = one.kind === "busy" ? one : two;
    expect(busy).toEqual({ kind: "busy", reason: "not_idle" });
  });
});

describe("recordCapture", () => {
  it("writes the candidate, system.backup_capture success and idle in one commit", async () => {
    const begun = await beginCapture(maintenance(), "test-a");
    if (begun.kind !== "capturing") throw new Error("not capturing");
    await recordCapture(maintenance(), begun.pairId, record(begun.captureStartedAt));
    const pair = await run<{ validation_status: string; host: string }>(
      db.pool("superuser"),
      "SELECT validation_status, host FROM app.backup_pair WHERE id = $1",
      [begun.pairId],
    );
    expect(pair).toEqual([{ validation_status: "candidate", host: "local" }]);
    expect(await auditRows(begun.pairId)).toEqual([
      { action: "system.backup_capture", outcome: "intent" },
      { action: "system.backup_capture", outcome: "success" },
    ]);
    expect((await mode()).capture_mode).toBe("idle");
  });

  it("refuses a pair that is not the one being captured, and changes nothing", async () => {
    const begun = await beginCapture(maintenance(), "test-a");
    if (begun.kind !== "capturing") throw new Error("not capturing");
    const other = randomUUID();
    await expect(
      recordCapture(maintenance(), other, record(begun.captureStartedAt)),
    ).rejects.toThrow(/not the one being captured/);
    expect((await mode()).capture_mode).toBe("capturing");
    const pair = await run(db.pool("superuser"), "SELECT 1 FROM app.backup_pair WHERE id = $1", [
      other,
    ]);
    expect(pair).toEqual([]);
  });
});

describe("abortCapture", () => {
  it("releases only the caller's own freeze, marks the candidate ineligible (aborted) and writes system.backup_invalidated", async () => {
    const begun = await beginCapture(maintenance(), "test-a");
    if (begun.kind !== "capturing") throw new Error("not capturing");
    expect(await abortCapture(maintenance(), "test-b", "aborted")).toEqual({
      released: false,
      pairId: begun.pairId,
    });
    expect((await mode()).capture_mode).toBe("capturing");
    expect(await abortCapture(maintenance(), "test-a", "aborted")).toEqual({
      released: true,
      pairId: begun.pairId,
    });
    expect((await mode()).capture_mode).toBe("idle");
    const pair = await run<{ validation_status: string; invalid_reason: string }>(
      db.pool("superuser"),
      "SELECT validation_status, invalid_reason FROM app.backup_pair WHERE id = $1",
      [begun.pairId],
    );
    expect(pair).toEqual([{ validation_status: "ineligible", invalid_reason: "aborted" }]);
    expect(await auditRows(begun.pairId)).toContainEqual({
      action: "system.backup_invalidated",
      outcome: "success",
    });
  });

  it("abort when idle is a no-op that says so", async () => {
    expect(await abortCapture(maintenance(), "test-a", "aborted")).toEqual({
      released: false,
      pairId: null,
    });
    expect((await mode()).capture_mode).toBe("idle");
  });
});
