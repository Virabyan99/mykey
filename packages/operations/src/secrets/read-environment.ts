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
//     environment_changed; the admission recheck again, else its refusal;
//     the caller's audit row; commit. Only then do the values leave this
//     function.
//
// Run 5.4 (P-94): a machine request brings its own reader, the client of the
// presented token; then every backend call uses it and `deps.bao` is never
// asked. A read it is denied asks `alive()` once more: a dead token is
// `unauthenticated` and nothing is marked; a live token that may not read is
// a broken machine policy, the drift path as for the runtime identity.
// `readEnvironmentNames` is steps 1, 2 and 5 without the value reads.
import { appendAudit } from "@mykey/audit";
import { LIMITS, type ErrorCode, type OperationId } from "@mykey/contracts";
import {
  environmentCounters,
  listIndex,
  markEnvironmentReview,
  markKeyReview,
  slotOf,
  type EnvironmentScope,
  type IndexRow,
  type Queryable,
} from "@mykey/db";
import { environmentPrefix, secretPath, type BaoFailure, type OpenBaoClient } from "@mykey/openbao";
import type pg from "pg";
import type { ReadDeps, Refused } from "./history.ts";
import { Busy, READ_COOLDOWN_MS, inTransaction, withEnvironmentLock, type Locked } from "./lock.ts";
import { backendRefusal } from "./protocol.ts";

export interface EnvironmentRead {
  generation: bigint;
  /** In bytewise name order. */
  entries: { name: string; value: string; version: number }[];
  valueBytes: number;
}

export interface EnvironmentReadRequest {
  scope: EnvironmentScope;
  routeId: string;
  requestId: string;
  /** The admission recheck (FR-1.10), as for a reveal: null when the caller may still read. */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
  /** Runs in the final transaction on the lock connection; must write the caller's audit row. */
  audit: (tx: pg.PoolClient, read: { names: number; generation: bigint }) => Promise<void>;
  /** A machine request: every backend read uses this client and deps.bao is never asked. */
  reader?: { client: OpenBaoClient; alive: () => Promise<boolean> };
  /** Run 6.3 (P-114): one read at a time for this key (the machine credential); else busy at once. */
  exclusive?: string;
}

export type EnvironmentReadOutcome = { kind: "ok"; read: EnvironmentRead } | Refused;
export type EnvironmentNamesOutcome = { kind: "ok"; generation: bigint; names: string[] } | Refused;

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

/** The refusal of a failed backend call; a denied machine read first asks whether its token lives. */
async function refusalOf(
  deps: ReadDeps,
  request: EnvironmentReadRequest,
  failure: BaoFailure,
): Promise<Refused> {
  if (failure.kind === "denied" && request.reader !== undefined) {
    const alive = await request.reader.alive().catch(() => null);
    if (alive === false) return refused("unauthenticated");
    if (alive === null) return refused("dependency_unavailable");
  }
  return refused(await backendRefusal(deps.pool, request.scope, failure, request.requestId));
}

/** The client every backend call of this request uses. */
function clientOf(deps: ReadDeps, request: EnvironmentReadRequest): OpenBaoClient | null {
  return request.reader?.client ?? deps.bao.clientFor(request.scope.organizationId);
}

/** (1) Access, slot, every row and the generation, in one transaction. */
function admit(
  locked: Locked,
  request: EnvironmentReadRequest,
): Promise<{ rows: IndexRow[]; generation: bigint }> {
  const { scope } = request;
  return inTransaction(locked.client, async (tx) => {
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
}

/** (2) The backend's names against the index's; null when they agree. */
async function compareNames(
  deps: ReadDeps,
  request: EnvironmentReadRequest,
  bao: OpenBaoClient,
  rows: IndexRow[],
): Promise<Refused | null> {
  const { scope } = request;
  const listed = await bao.kvList(environmentPrefix(scope.projectId, scope.environmentId));
  let names: string[];
  if (listed.ok) names = listed.data.names;
  else if (listed.kind === "not_found") names = [];
  else return refusalOf(deps, request, listed);
  const indexed = new Set(rows.map((row) => row.name));
  if (names.length !== indexed.size || !names.every((name) => indexed.has(name))) {
    return driftDetected(deps.pool, scope, request.requestId);
  }
  return null;
}

/** (5) Still generation G and no slot; the caller's audit row, committed; null when it is. */
async function commitRead(
  deps: ReadDeps,
  request: EnvironmentReadRequest,
  locked: Locked,
  read: { names: number; generation: bigint },
): Promise<Refused | null> {
  try {
    await inTransaction(locked.client, async (tx) => {
      const counters = await environmentCounters(tx, request.scope);
      if (counters.generation !== read.generation || (await slotOf(tx, request.scope)) !== null) {
        throw new Stop(refused("environment_changed"));
      }
      // Admission again (gate review): an archive admitted, or access removed,
      // while the values were read means nothing answers.
      const code = await request.recheck(tx);
      if (code !== null) throw new Stop(refused(code));
      await request.audit(tx, read);
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
  return null;
}

/** Runs `work` under the environment's lock; busy and stops become refusals. */
async function underLock<T>(
  deps: ReadDeps,
  request: EnvironmentReadRequest,
  work: (locked: Locked) => Promise<T | Refused>,
  cooldownMs?: number,
): Promise<T | Refused> {
  const { lockKey } = await environmentCounters(deps.pool, request.scope);
  try {
    return await withEnvironmentLock(deps.lockPool, lockKey, work, undefined, {
      ...(request.exclusive === undefined ? {} : { exclusive: request.exclusive }),
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
    });
  } catch (error) {
    if (error instanceof Busy) return refused("busy");
    if (error instanceof Stop) return error.outcome;
    throw error;
  }
}

export async function readEnvironment(
  deps: ReadDeps,
  request: EnvironmentReadRequest,
): Promise<EnvironmentReadOutcome> {
  const { scope } = request;
  const bao = clientOf(deps, request);
  if (bao === null) return refused("dependency_unavailable");
  return underLock(
    deps,
    request,
    async (locked): Promise<EnvironmentReadOutcome> => {
      const { rows, generation } = await admit(locked, request);
      const differ = await compareNames(deps, request, bao, rows);
      if (differ !== null) return differ;

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
            return refusalOf(deps, request, result);
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

      const failed = await commitRead(deps, request, locked, { names: entries.length, generation });
      if (failed !== null) return failed;
      return { kind: "ok", read: { generation, entries, valueBytes } };
    },
    READ_COOLDOWN_MS,
  );
}

/**
 * machine.keys (Run 5.4, P-94): steps 1, 2 and 5 of `readEnvironment` — the
 * lock, the recheck, the slot and review checks, the names OpenBao lists
 * compared with the index's, the generation rechecked and the caller's audit
 * row — and the live names in bytewise order. No value is read.
 */
export async function readEnvironmentNames(
  deps: ReadDeps,
  request: EnvironmentReadRequest,
): Promise<EnvironmentNamesOutcome> {
  const bao = clientOf(deps, request);
  if (bao === null) return refused("dependency_unavailable");
  return underLock(deps, request, async (locked): Promise<EnvironmentNamesOutcome> => {
    const { rows, generation } = await admit(locked, request);
    const differ = await compareNames(deps, request, bao, rows);
    if (differ !== null) return differ;
    const names = rows
      .filter((row) => row.state === "live")
      .map((row) => row.name)
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    await deps.faults?.("after_backend_read");
    if (locked.lost()) return refused("dependency_unavailable");
    const failed = await commitRead(deps, request, locked, { names: names.length, generation });
    if (failed !== null) return failed;
    return { kind: "ok", generation, names };
  });
}
