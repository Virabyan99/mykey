// Reveal of one value (Run 4.3, FR-1.22 server half, P-73, D-37). Under the
// environment's lock, on the lock's connection: (1) the caller's access and
// the states re-read, the slot, the index row; (2) one backend read; (3) the
// row's tag checked again and `secret.reveal` committed to the audit log.
// Only after that commit does the value leave this function. Every failure
// drops the value.
import { appendAudit } from "@mykey/audit";
import type { ErrorCode, OperationId, UserId } from "@mykey/contracts";
import {
  environmentCounters,
  lockIndexRow,
  markKeyReview,
  slotOf,
  type EnvironmentScope,
} from "@mykey/db";
import { secretPath } from "@mykey/openbao";
import type pg from "pg";
import type { ReadDeps, Refused } from "./history.ts";
import { Busy, inTransaction, withEnvironmentLock } from "./lock.ts";
import { backendRefusal } from "./protocol.ts";

export interface RevealRequest {
  scope: EnvironmentScope;
  userId: UserId;
  name: string;
  version?: number;
  requestId: string;
  /** The admission recheck (FR-1.10), as for a mutation: null when the caller may still read. */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
}

export type RevealOutcome =
  { kind: "ok"; value: string; version: number; stateTag: string } | Refused;

const refused = (code: ErrorCode, operationId?: OperationId): Refused => ({
  kind: "refused",
  code,
  ...(operationId === undefined ? {} : { operationId }),
});

/** A refusal that ends the lock's work; the value, if any, is dropped with it. */
class Stop extends Error {
  readonly outcome: Refused;

  constructor(outcome: Refused) {
    super(outcome.code);
    this.outcome = outcome;
  }
}

export async function revealSecret(deps: ReadDeps, request: RevealRequest): Promise<RevealOutcome> {
  const { scope, name } = request;
  const bao = deps.bao.clientFor(scope.organizationId);
  if (bao === null) return refused("dependency_unavailable");
  const path = secretPath(scope.projectId, scope.environmentId, name);
  const { lockKey } = await environmentCounters(deps.pool, scope);
  try {
    return await withEnvironmentLock(deps.lockPool, lockKey, async (locked) => {
      // (1) Access, slot and row.
      const row = await inTransaction(locked.client, async (tx) => {
        const code = await request.recheck(tx);
        if (code !== null) throw new Stop(refused(code));
        const slot = await slotOf(tx, scope);
        // P-67: a slot blocks this read only when its operation names this key, or no key.
        if (slot !== null && (slot.secretName === null || slot.secretName === name)) {
          throw new Stop(refused("key_under_review", slot.operationId));
        }
        const found = await lockIndexRow(tx, scope, name);
        if (found === null) throw new Stop(refused("not_found"));
        if (found.state === "needs_review") throw new Stop(refused("key_under_review"));
        if (request.version === undefined && found.state === "deleted") {
          throw new Stop(refused("state_conflict"));
        }
        const current = found.currentVersion;
        if (current === null) throw new Stop(refused("key_under_review"));
        if (request.version !== undefined && (request.version > current || request.version < 1)) {
          throw new Stop(refused("not_found"));
        }
        return { ...found, currentVersion: current };
      });

      // (2) One backend read: the latest for the current value, the version asked for otherwise.
      const wantsCurrent = request.version === undefined;
      const read = await bao.kvRead(path, wantsCurrent ? undefined : request.version);
      await deps.faults?.("after_backend_read");
      if (!read.ok) {
        if (read.kind === "not_found" && !wantsCurrent) return refused("state_conflict");
        // The index says live, the backend has no readable current version, or not a format-1 envelope.
        if (
          wantsCurrent &&
          (read.kind === "not_found" || (read.kind === "invalid" && read.status === 200))
        ) {
          await markKeyReview(deps.pool, scope, name, null);
          return refused("backend_inconsistent");
        }
        return refused(await backendRefusal(deps.pool, scope, read, request.requestId));
      }
      if (wantsCurrent && read.data.version !== row.currentVersion) {
        await markKeyReview(deps.pool, scope, name, null);
        return refused("backend_inconsistent");
      }
      const version = read.data.version;

      // (3) The audit row, committed before the value leaves.
      try {
        await inTransaction(locked.client, async (tx) => {
          const again = await lockIndexRow(tx, scope, name);
          if (again?.stateTag !== row.stateTag) throw new Stop(refused("dependency_unavailable"));
          await appendAudit(tx, {
            action: "secret.reveal",
            actor: { kind: "user", id: request.userId },
            source: "api",
            organizationId: scope.organizationId,
            target: { kind: "environment", id: scope.environmentId },
            outcome: "success",
            requestId: request.requestId,
            operationId: null,
            details: { name, version },
          });
          await deps.faults?.("before_audit_commit");
        });
      } catch (error) {
        if (error instanceof Stop) throw error;
        // Which failed: the audit write, or the lock's session? A session that still answers wrote no audit row.
        const alive =
          !locked.lost() &&
          (await locked.client.query("SELECT 1").then(
            () => true,
            () => false,
          ));
        return refused(alive ? "audit_unavailable" : "dependency_unavailable");
      }
      if (locked.lost()) return refused("dependency_unavailable");
      return { kind: "ok", value: read.data.envelope.value, version, stateTag: row.stateTag };
    });
  } catch (error) {
    if (error instanceof Busy) return refused("busy");
    if (error instanceof Stop) return error.outcome;
    throw error;
  }
}
