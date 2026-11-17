// Run 6.5 (P-118, P-120, D-51): the capture coordinator, run as maintenance
// by `ops capture begin|record|abort`. idle → draining (one commit, which
// waits for every writing transaction in flight); wait until no operation is
// executing and no effect slot is held, at most 30 s, else back to idle and
// busy; draining → capturing (the database's time of that change is the
// pair's captureStartedAt); the caller takes the artifacts; recordCapture
// writes the candidate, its audit row and idle in one commit. abortCapture
// releases a freeze this owner holds and marks its pair ineligible.
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import {
  captureMode,
  findPair,
  insertCandidate,
  markIneligible,
  setCaptureMode,
  withTransaction,
} from "@mykey/db";
import type pg from "pg";

export const DRAIN_DEADLINE_MS = 30_000;
export const FROZEN_DEADLINE_MS = 120_000;

/** What the manifest of a pair says that the database records (P-119). */
export interface CaptureRecord {
  host: string;
  captureStartedAt: string;
  boundary: unknown;
  schemaRevision: string;
  releaseBuild: string;
  keyRefs: unknown;
  artifacts: readonly { name: string; bytes: number; sha256: string }[];
}

export interface Boundary {
  lastOperationId: string | null;
  executingOperations: number;
  heldEffectSlots: number;
}

export type BeginResult =
  | { kind: "capturing"; pairId: string; captureStartedAt: Date; boundary: Boundary }
  | { kind: "busy"; reason: "not_idle" | "drain_deadline" };

async function boundaryOf(db: pg.Pool | pg.PoolClient): Promise<Boundary> {
  const result = await db.query<{ last: string | null; executing: string; slots: string }>(
    `SELECT (SELECT id FROM app.operation ORDER BY created_at DESC, id DESC LIMIT 1) AS last,
            (SELECT count(*) FROM app.operation WHERE state = 'executing') AS executing,
            (SELECT count(*) FROM app.effect_slot) AS slots`,
  );
  const row = result.rows[0];
  return {
    lastOperationId: row?.last ?? null,
    executingOperations: Number(row?.executing ?? 0),
    heldEffectSlots: Number(row?.slots ?? 0),
  };
}

const audit = (
  tx: pg.PoolClient,
  action: "system.backup_capture" | "system.backup_invalidated",
  outcome: "intent" | "success" | "failure",
  details: {
    pairId: string;
    reason?: "deadline" | "access_reduction" | "verification" | "aborted";
  },
): Promise<string> =>
  appendAudit(tx, {
    action,
    actor: { kind: "system", id: null },
    source: "system",
    organizationId: null,
    target: { kind: "backup_pair", id: details.pairId },
    outcome,
    requestId: null,
    operationId: null,
    details,
  });

export async function beginCapture(
  pool: pg.Pool,
  owner: string,
  opts: { drainDeadlineMs?: number } = {},
): Promise<BeginResult> {
  const pairId = randomUUID();
  const entered = await withTransaction(pool, async (tx) => {
    if (!(await setCaptureMode(tx, "idle", "draining", pairId, owner))) return false;
    await audit(tx, "system.backup_capture", "intent", { pairId });
    return true;
  });
  if (!entered) return { kind: "busy", reason: "not_idle" };

  const deadline = Date.now() + (opts.drainDeadlineMs ?? DRAIN_DEADLINE_MS);
  const clean = (b: Boundary) => b.executingOperations === 0 && b.heldEffectSlots === 0;
  for (;;) {
    if (clean(await boundaryOf(pool))) {
      // The change to capturing waits for every writing transaction in flight
      // (they hold the row FOR SHARE) and new writers queue behind it, so the
      // boundary read after it is exact. A request admitted before draining can
      // still have committed an operation or a slot since the check above: then
      // the change is rolled back and the drain goes on.
      const captured = await withTransaction(pool, async (tx) => {
        if (!(await setCaptureMode(tx, "draining", "capturing", pairId, owner))) {
          throw new Error("the capture mode changed while draining");
        }
        const boundary = await boundaryOf(tx);
        if (!clean(boundary)) throw new NotYet();
        const started = await tx.query<{ now: Date }>("SELECT now() AS now");
        return {
          kind: "capturing" as const,
          pairId,
          captureStartedAt: started.rows[0]?.now ?? new Date(),
          boundary,
        };
      }).catch((error: unknown) => {
        if (error instanceof NotYet) return null;
        throw error;
      });
      if (captured !== null) return captured;
    }
    if (Date.now() > deadline) {
      await withTransaction(pool, async (tx) => {
        await setCaptureMode(tx, "draining", "idle", null, owner);
        await audit(tx, "system.backup_capture", "failure", { pairId });
      });
      return { kind: "busy", reason: "drain_deadline" };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

class NotYet extends Error {}

/** The candidate row, system.backup_capture success and idle, in one commit. */
export async function recordCapture(
  pool: pg.Pool,
  pairId: string,
  record: CaptureRecord,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const control = await captureMode(tx, { lock: "share" });
    if (control.mode !== "capturing" || control.pairId !== pairId) {
      throw new Error(`pair ${pairId} is not the one being captured`);
    }
    await insertCandidate(tx, {
      id: pairId,
      host: record.host,
      captureStartedAt: new Date(record.captureStartedAt),
      boundary: record.boundary,
      schemaRevision: record.schemaRevision,
      releaseBuild: record.releaseBuild,
      keyRefs: record.keyRefs,
      artifactHashes: Object.fromEntries(record.artifacts.map((a) => [a.name, a.sha256])),
    });
    await audit(tx, "system.backup_capture", "success", { pairId });
    const owner = await tx.query<{ owner: string | null }>("SELECT owner FROM app.service_control");
    if (!(await setCaptureMode(tx, "capturing", "idle", null, owner.rows[0]?.owner ?? ""))) {
      throw new Error("the capture mode changed before the release");
    }
  });
}

/**
 * Releases a freeze this owner holds (draining or capturing) and marks its
 * pair ineligible, with system.backup_invalidated. Idle, or another owner's
 * freeze: nothing, and says so.
 */
export async function abortCapture(
  pool: pg.Pool,
  owner: string,
  reason: "aborted" | "deadline",
): Promise<{ released: boolean; pairId: string | null }> {
  return withTransaction(pool, async (tx) => {
    const row = await tx.query<{
      capture_mode: string;
      owner: string | null;
      pair_id: string | null;
      updated_at: Date;
    }>("SELECT capture_mode, owner, pair_id, updated_at FROM app.service_control FOR UPDATE");
    const control = row.rows[0];
    if (control === undefined || control.capture_mode === "idle") {
      return { released: false, pairId: null };
    }
    if (control.owner !== owner) return { released: false, pairId: control.pair_id };
    const pairId = control.pair_id;
    if (pairId !== null) {
      const pair = await findPair(tx, pairId);
      if (pair === null) {
        // Aborted before the record: the pair exists only as this row.
        await tx.query(
          `INSERT INTO app.backup_pair (id, host, capture_started_at, boundary, artifact_hashes,
                                        schema_revision, release_commit, key_refs,
                                        validation_status, invalid_reason)
           VALUES ($1, NULL, $2, '{}', '{}', '', '', '{}', 'ineligible', $3)`,
          [pairId, control.updated_at, reason],
        );
      } else {
        await markIneligible(tx, pairId, reason);
      }
      await audit(tx, "system.backup_invalidated", "success", { pairId, reason });
    }
    await tx.query(
      "UPDATE app.service_control SET capture_mode = 'idle', pair_id = NULL, owner = NULL, updated_at = now()",
    );
    return { released: true, pairId };
  });
}
