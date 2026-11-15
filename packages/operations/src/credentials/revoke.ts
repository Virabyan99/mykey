// Machine credential revocation (Run 5.2, P-89, D-40; FR-1.42, Doc 06 §7.3).
// Under the environment's lock: (a) an issuer session; (b) one transaction —
// replay recheck, authority, the credential locked and admitted, the
// credential `revoking`, the operation `executing`, its step and the intent
// audit row: its commit is the marker, and from it the product denies the
// credential; (c) one revoke-by-accessor; (d) up to three lookups — only a
// 400 proves the token gone; (e) one transaction — the credential `revoked`,
// this operation and every uncertain revocation of it succeeded.
//
// Revoke-by-accessor is the one backend change that may be sent again for the
// same accessor (by a new request, the archive coordinator or the operator):
// it is idempotent and proven only by absence. Whatever is not proven leaves
// the credential `revoking`; it is never shown as revoked.
import { randomUUID } from "node:crypto";
import { AuditUnavailable, appendAudit } from "@mykey/audit";
import {
  LIMITS,
  type CredentialId,
  type ErrorCode,
  type OperationId,
  type UserId,
} from "@mykey/contracts";
import {
  environmentCounters,
  findOperationByKey,
  finishOperation,
  insertOperation,
  liveRevocation,
  lockCredential,
  moveCredential,
  settleRevocations,
  type EnvironmentScope,
  type OperationRow,
  type Queryable,
} from "@mykey/db";
import type pg from "pg";
import { intentFingerprint, sameIntent, type Intent } from "../replay.ts";
import type { IssuerSession } from "../runtime.ts";
import {
  Busy,
  inTransaction,
  isLockTimeout,
  withEnvironmentLock,
  type Locked,
} from "../secrets/lock.ts";
import { onMainPool } from "../secrets/protocol.ts";
import type { CredentialDeps, CredentialFaultPoint } from "./issue.ts";
import { revokeAndVerify } from "./verify.ts";

export interface RevokeRequest {
  routeId: string;
  scope: EnvironmentScope;
  userId: UserId;
  credentialId: CredentialId;
  idempotencyKey: string;
  intent: Intent;
  requestId: string;
  /** Runs in the marker transaction: null when the caller may still revoke (authority, organization). */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
}

export type RevokeOutcome =
  | { kind: "revoked" | "replay"; operation: OperationRow }
  | { kind: "refused"; code: ErrorCode; operationId?: OperationId }
  | { kind: "unknown"; operationId: OperationId };

type Refused = Extract<RevokeOutcome, { kind: "refused" }>;

const refused = (code: ErrorCode, operationId?: OperationId): Refused => ({
  kind: "refused",
  code,
  ...(operationId === undefined ? {} : { operationId }),
});

class Refusal extends Error {
  readonly outcome: Refused;

  constructor(outcome: Refused) {
    super(outcome.code);
    this.name = "Refusal";
    this.outcome = outcome;
  }
}

class NotOwner extends Error {}

/** A revocation in flight is one whose heartbeat is younger than this (P-89). */
const LIVE_SECONDS = LIMITS.operation.stuckAlertSeconds;

function audit(
  db: Queryable,
  request: RevokeRequest,
  operationId: OperationId,
  outcome: "intent" | "success" | "failure" | "unknown",
): Promise<string> {
  return appendAudit(db, {
    action: "credential.revoke",
    actor: { kind: "user", id: request.userId },
    source: "api",
    organizationId: request.scope.organizationId,
    target: { kind: "environment", id: request.scope.environmentId },
    outcome,
    requestId: request.requestId,
    operationId,
    details: { credentialId: request.credentialId },
  });
}

export async function revokeCredential(
  deps: CredentialDeps,
  request: RevokeRequest,
): Promise<RevokeOutcome> {
  // A revocation of this credential in flight answers before the lock it holds.
  const live = await liveRevocation(deps.pool, request.credentialId, LIVE_SECONDS);
  if (live !== null) return refused("state_conflict", live);
  const { lockKey } = await environmentCounters(deps.pool, request.scope);
  try {
    return await withEnvironmentLock(deps.lockPool, lockKey, async (locked) => {
      const opened = await deps.issuer.open(request.scope.organizationId);
      if (opened === null) return refused("dependency_unavailable");
      if (!opened.ok) {
        return refused(opened.kind === "sealed" ? "backend_sealed" : "dependency_unavailable");
      }
      try {
        return await withSession(deps, request, locked, opened.data);
      } finally {
        await opened.data.close();
      }
    });
  } catch (error) {
    if (error instanceof Busy) return refused("busy");
    throw error;
  }
}

async function withSession(
  deps: CredentialDeps,
  request: RevokeRequest,
  locked: Locked,
  session: IssuerSession,
): Promise<RevokeOutcome> {
  const { scope } = request;
  const operationId = randomUUID() as OperationId;
  const dispatchId = randomUUID();
  const key = {
    principalKind: "user" as const,
    principalId: request.userId,
    action: request.routeId,
    target: scope.environmentId,
    idempotencyKey: request.idempotencyKey,
  };
  const fault = async (point: CredentialFaultPoint): Promise<void> => {
    await deps.faults?.(point, operationId);
  };

  // (b) Admission and marker.
  let accessor: string;
  try {
    const admitted = await inTransaction(locked.client, async (tx) => {
      const { digest, keyId } = intentFingerprint(deps.ring, request.intent);
      const inserted = await insertOperation(tx, {
        ...key,
        id: operationId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        expected: { credentialId: request.credentialId },
        executorBootId: deps.bootId,
        state: "executing",
        fingerprint: digest,
        fingerprintKeyId: keyId,
        result: null,
      });
      if (inserted === "exists") {
        const found = await findOperationByKey(tx, key);
        if (found === null) throw new Error("operation key exists but its row was not found");
        if (!sameIntent(deps.ring, found, request.intent)) {
          throw new Refusal(refused("idempotency_conflict"));
        }
        return { replay: found } as const;
      }
      await tx.query("UPDATE app.operation SET dispatched_at = now() WHERE id = $1", [operationId]);
      const capture = await tx.query<{ capture_mode: string }>(
        "SELECT capture_mode FROM app.service_control FOR SHARE",
      );
      if (capture.rows[0]?.capture_mode !== "idle") throw new Refusal(refused("busy"));
      if (!deps.gateOpen()) throw new Refusal(refused("quarantined"));
      const code = await request.recheck(tx);
      if (code !== null) throw new Refusal(refused(code));
      const row = await lockCredential(tx, scope, request.credentialId, "update");
      if (row === null) throw new Refusal(refused("not_found"));
      if (row.state === "revoked") throw new Refusal(refused("state_conflict"));
      if (row.state === "issuing" || row.state === "needs_review") {
        // The operator settles an unresolved issuance (P-90).
        throw new Refusal(refused("state_conflict", row.issuanceOperationId));
      }
      if (row.state === "revoking") {
        const live = await liveRevocation(tx, row.id, LIVE_SECONDS);
        if (live !== null) throw new Refusal(refused("state_conflict", live));
      }
      if (row.accessor === null) throw new Refusal(refused("state_conflict"));
      await moveCredential(tx, row.id, [row.state], "revoking");
      await tx.query(
        `INSERT INTO app.operation_step (id, operation_id, ordinal, target, dispatch_attempt_id)
         VALUES ($1, $2, 1, $3, $4)`,
        [randomUUID(), operationId, row.id, dispatchId],
      );
      await audit(tx, request, operationId, "intent");
      return { accessor: row.accessor } as const;
    });
    if ("replay" in admitted) return { kind: "replay", operation: admitted.replay };
    accessor = admitted.accessor;
  } catch (error) {
    if (error instanceof Refusal) return error.outcome;
    if (error instanceof AuditUnavailable) return refused("audit_unavailable");
    if (isLockTimeout(error)) return refused("busy");
    // The marker may have committed: the credential is then `revoking`, which only denies more.
    return { kind: "unknown", operationId };
  }

  // From here on, every failure is unknown.
  try {
    await fault("after_revoke_marker");
    const proof = await revokeAndVerify(session, accessor, { operationId, dispatchId });
    await fault("after_revoke_sent");
    if (proof === "absent" && !locked.lost()) {
      const row = await inTransaction(locked.client, async (tx) => {
        if (!(await moveCredential(tx, request.credentialId, ["revoking"], "revoked"))) {
          throw new NotOwner();
        }
        const finished = await finishOperation(
          tx,
          operationId,
          deps.bootId,
          { state: "succeeded", result: { credentialId: request.credentialId, state: "revoked" } },
          LIMITS.operation.terminalRetentionDays,
        );
        if (finished === null) throw new NotOwner();
        await settleRevocations(tx, request.credentialId, LIMITS.operation.terminalRetentionDays);
        await tx.query(
          "UPDATE app.operation_step SET outcome = 'succeeded' WHERE operation_id = $1 AND ordinal = 1",
          [operationId],
        );
        await audit(tx, request, operationId, "success");
        await fault("before_revoke_finalize_commit");
        return finished;
      });
      return { kind: "revoked", operation: row };
    }
    const definite: ErrorCode | null =
      proof === "refused_sealed"
        ? "backend_sealed"
        : proof === "refused_denied"
          ? "backend_inconsistent"
          : proof === "not_sent"
            ? "dependency_unavailable"
            : null;
    if (definite !== null && !locked.lost()) {
      // Nothing was revoked; the credential stays `revoking` (closed first).
      await inTransaction(locked.client, async (tx) => {
        const row = await finishOperation(
          tx,
          operationId,
          deps.bootId,
          { state: "rejected", errorCode: definite },
          LIMITS.operation.terminalRetentionDays,
        );
        if (row === null) throw new NotOwner();
        await tx.query(
          "UPDATE app.operation_step SET outcome = 'rejected' WHERE operation_id = $1 AND ordinal = 1",
          [operationId],
        );
        await audit(tx, request, operationId, "failure");
      });
      return refused(definite, operationId);
    }
    await settleUnknown(deps, locked, request, operationId);
    return { kind: "unknown", operationId };
  } catch {
    await settleUnknown(deps, locked, request, operationId).catch(() => undefined);
    return { kind: "unknown", operationId };
  }
}

/** Unknown: the operation uncertain, audit `unknown`; the credential stays `revoking`. */
async function settleUnknown(
  deps: CredentialDeps,
  locked: Locked,
  request: RevokeRequest,
  operationId: OperationId,
): Promise<void> {
  const work = async (tx: pg.PoolClient): Promise<void> => {
    const row = await finishOperation(tx, operationId, deps.bootId, { state: "uncertain" }, 0);
    if (row === null) throw new NotOwner();
    await audit(tx, request, operationId, "unknown");
  };
  await (locked.lost() ? onMainPool(deps.pool, work) : inTransaction(locked.client, work));
}
