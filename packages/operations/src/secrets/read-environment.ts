// The complete environment read (Run 4.8, P-78, Doc 06 §8, FR-1.84; Doc 10
// §4.1 rule 4): every live value of one metadata generation, or nothing. The
// environment's advisory lock is held for the whole read, on the lock's
// connection; a writer of that environment waits two seconds and answers busy.
//
//  1. One transaction: the caller's access and the states re-read; any slot →
//     key_under_review naming its holder; every index row; a row in review →
//     key_under_review; the generation G.
//  2. The backend's list of names must equal the index's (live and deleted);
//     a difference sends the environment to review (system.drift_detected).
//  3. Every live value, eight at a time: the index's version, a format-1
//     envelope and the index's byte length — otherwise the key goes to review.
//     Any failed read ends the read; nothing partial is ever returned.
//  4. The response size limit.
//  5. One transaction: the generation still G and no slot, else
//     environment_changed; the caller's audit row; commit. Only then do the
//     values leave this function.
import { appendAudit } from "@mykey/audit";
import { LIMITS, type ErrorCode, type OperationId, type UserId } from "@mykey/contracts";
import {
  environmentCounters,
  listIndex,
  markEnvironmentReview,
  markKeyReview,
  slotOf,
  type EnvironmentScope,
  type Queryable,
} from "@mykey/db";
import { environmentPrefix, secretPath } from "@mykey/openbao";
import type pg from "pg";
import type { ReadDeps, Refused } from "./history.ts";
import { Busy, inTransaction, withEnvironmentLock } from "./lock.ts";
import { backendRefusal } from "./protocol.ts";

export interface EnvironmentRead {
  generation: bigint;
  /** In bytewise name order. */
  entries: { name: string; value: string; version: number }[];
  valueBytes: number;
}

export interface EnvironmentReadRequest {
  scope: EnvironmentScope;
  userId: UserId;
  routeId: string;
  requestId: string;
  /** The admission recheck (FR-1.10), as for a reveal: null when the caller may still read. */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
  /** Runs in the final transaction on the lock connection; must write the caller's audit row. */
  audit: (tx: pg.PoolClient, read: { names: number; generation: bigint }) => Promise<void>;
}

export type EnvironmentReadOutcome = { kind: "ok"; read: EnvironmentRead } | Refused;

/** Values read at once (Doc 06 §8). */
const READ_BATCH = 8;
/** What the response spends per entry beyond its name and value (P-78). */
const ENTRY_OVERHEAD_BYTES = 64;

const refused = (
  code: ErrorCode,
  extra: { operationId?: OperationId; details?: Record<string, unknown> } = {},
): Refused => ({ kind: "refused", code, ...extra });

class Stop extends Error {
  readonly outcome: Refused;

  constructor(outcome: Refused) {
    super(outcome.code);
    this.outcome = outcome;
  }
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/** The backend's names differ from the index's: the environment goes to review (P-72). */
async function driftDetected(
  db: Queryable,
  scope: EnvironmentScope,
  requestId: string,
): Promise<Refused> {
  await markEnvironmentReview(db, scope);
  await appendAudit(db, {
    action: "system.drift_detected",
    actor: { kind: "system", id: null },
    source: "api",
    organizationId: scope.organizationId,
    target: { kind: "environment", id: scope.environmentId },
    outcome: "failure",
    requestId,
    operationId: null,
    details: { scope: "environment", object: "kv_data" },
  });
  return refused("backend_inconsistent");
}

export async function readEnvironment(
  deps: ReadDeps,
  request: EnvironmentReadRequest,
): Promise<EnvironmentReadOutcome> {
  const { scope } = request;
  const bao = deps.bao.clientFor(scope.organizationId);
  if (bao === null) return refused("dependency_unavailable");
  const { lockKey } = await environmentCounters(deps.pool, scope);
  try {
    return await withEnvironmentLock(deps.lockPool, lockKey, async (locked) => {
      // (1) Access, slot, every row and the generation.
      const seen = await inTransaction(locked.client, async (tx) => {
        const code = await request.recheck(tx);
        if (code !== null) throw new Stop(refused(code));
        const slot = await slotOf(tx, scope);
        if (slot !== null) {
          throw new Stop(refused("key_under_review", { operationId: slot.operationId }));
        }
        const index = await listIndex(tx, scope, {
          prefix: null,
          after: null,
          limit: LIMITS.environment.maxNames + 1,
        });
        if (index.rows.some((row) => row.state === "needs_review")) {
          throw new Stop(refused("key_under_review"));
        }
        return index;
      });
      const { rows, generation } = seen;

      // (2) The backend's names against the index's.
      const listed = await bao.kvList(environmentPrefix(scope.projectId, scope.environmentId));
      let names: string[];
      if (listed.ok) names = listed.data.names;
      else if (listed.kind === "not_found") names = [];
      else return refused(await backendRefusal(deps.pool, scope, listed, request.requestId));
      const indexed = new Set(rows.map((row) => row.name));
      if (names.length !== indexed.size || !names.every((name) => indexed.has(name))) {
        return driftDetected(deps.pool, scope, request.requestId);
      }

      // (3) Every live value, eight at a time.
      const live = rows.filter((row) => row.state === "live");
      const entries: EnvironmentRead["entries"] = [];
      let valueBytes = 0;
      for (let start = 0; start < live.length; start += READ_BATCH) {
        const batch = live.slice(start, start + READ_BATCH);
        const reads = await Promise.all(
          batch.map((row) =>
            bao.kvRead(secretPath(scope.projectId, scope.environmentId, row.name)),
          ),
        );
        for (const [position, row] of batch.entries()) {
          const result = reads[position];
          if (result === undefined) throw new Error("read batch out of step");
          if (!result.ok) {
            if (
              result.kind === "not_found" ||
              (result.kind === "invalid" && result.status === 200)
            ) {
              await markKeyReview(deps.pool, scope, row.name, null);
              return refused("backend_inconsistent");
            }
            return refused(await backendRefusal(deps.pool, scope, result, request.requestId));
          }
          // A version that is not a format-1 envelope reads as invalid 200 (above).
          const value = result.data.envelope.value;
          if (
            result.data.version !== row.currentVersion ||
            byteLength(value) !== row.liveValueBytes
          ) {
            await markKeyReview(deps.pool, scope, row.name, null);
            return refused("backend_inconsistent");
          }
          entries.push({ name: row.name, value, version: result.data.version });
          valueBytes += byteLength(value);
        }
      }
      await deps.faults?.("after_backend_read");
      if (locked.lost()) return refused("dependency_unavailable");

      // (4) The response size.
      const nameBytes = entries.reduce((sum, entry) => sum + byteLength(entry.name), 0);
      if (
        valueBytes + nameBytes + ENTRY_OVERHEAD_BYTES * entries.length >
        LIMITS.completeResponse.maxBodyBytes
      ) {
        return refused("capacity_exceeded", { details: { limit: "response" } });
      }

      // (5) Still generation G and no slot; the caller's audit row, committed.
      try {
        await inTransaction(locked.client, async (tx) => {
          const counters = await environmentCounters(tx, scope);
          if (counters.generation !== generation || (await slotOf(tx, scope)) !== null) {
            throw new Stop(refused("environment_changed"));
          }
          await request.audit(tx, { names: entries.length, generation });
          await deps.faults?.("before_audit_commit");
        });
      } catch (error) {
        if (error instanceof Stop) throw error;
        // Which failed: the audit write, or the lock's session? A session that still answers wrote no row.
        const alive =
          !locked.lost() &&
          (await locked.client.query("SELECT 1").then(
            () => true,
            () => false,
          ));
        return refused(alive ? "audit_unavailable" : "dependency_unavailable");
      }
      if (locked.lost()) return refused("dependency_unavailable");
      return { kind: "ok", read: { generation, entries, valueBytes } };
    });
  } catch (error) {
    if (error instanceof Busy) return refused("busy");
    if (error instanceof Stop) return error.outcome;
    throw error;
  }
}
