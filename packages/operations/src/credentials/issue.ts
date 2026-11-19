// Machine-token issuance (Run 5.1, P-87, P-88, D-40; Doc 06 §7.3, FR-1.39,
// FR-1.41, FR-1.43). Everything runs under the environment's advisory lock on
// its own connection: (a) an issuer session; (b) one transaction — replay
// recheck, capture mode, gate, authority and states, the credential row
// `issuing`, the operation `executing`, its step and the intent audit row: its
// commit is the marker; (c) one create from the token role; (d) the token's
// lookup by accessor, compared with what was asked; (e) one transaction —
// parents still active, the credential `active` with accessor and expiry, the
// operation succeeded; (f) the answer, which alone carries the token.
//
// From the marker on, every failure is unknown (Doc 10 §4.1 rule 3) except a
// definite refusal of the create. A token that exists but cannot be delivered
// is revoked and its absence verified; when that cannot be proven the
// credential stays `revoking` and the operation `uncertain`. The token is a
// local of this function and of the handler that answers: never on an
// operation, an error, a log line or an audit row.
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
  activateCredential,
  blockingIssuance,
  environmentCounters,
  findCredentialByOperation,
  findOperation,
  findOperationByKey,
  finishOperation,
  insertIssuing,
  insertOperation,
  lockParents,
  markEnvironmentReview,
  moveCredential,
  type CredentialRow,
  type EnvironmentScope,
  type OperationRow,
  type Queryable,
  isCaptureRefusal,
} from "@mykey/db";
import { machineName, namespaceFor, type BaoFailure, type Correlation } from "@mykey/openbao";
import type pg from "pg";
import { intentFingerprint, sameIntent, type HmacRing, type Intent } from "../replay.ts";
import type { IssuerBao, IssuerSession } from "../runtime.ts";
import {
  Busy,
  inTransaction,
  isLockTimeout,
  withEnvironmentLock,
  type Locked,
} from "../secrets/lock.ts";
import { onMainPool } from "../secrets/protocol.ts";
import { checkIssuedToken, revokeAndVerify } from "./verify.ts";

export const CREDENTIAL_FAULT_POINTS = [
  "after_issuer_login",
  "after_marker",
  "after_create_sent",
  "after_verify",
  "before_finalize_commit",
  "after_finalize",
  "after_revoke_marker",
  "after_revoke_sent",
  "before_revoke_finalize_commit",
] as const;
export type CredentialFaultPoint = (typeof CREDENTIAL_FAULT_POINTS)[number];

export interface CredentialDeps {
  pool: pg.Pool;
  lockPool: pg.Pool;
  issuer: IssuerBao;
  bootId: string;
  ring: HmacRing;
  gateOpen: () => boolean;
  /** Test only: a hook at each point of the protocol. */
  faults?: (point: CredentialFaultPoint, operationId: OperationId | null) => void | Promise<void>;
}

export interface IssueRequest {
  routeId: string;
  scope: EnvironmentScope;
  userId: UserId;
  name: string;
  ttlSeconds: number;
  idempotencyKey: string;
  intent: Intent;
  requestId: string;
  /** Runs in the marker transaction: null when the caller may still issue (authority and states). */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
}

export type IssueOutcome =
  | { kind: "issued"; operation: OperationRow; credential: CredentialRow; token: string }
  | { kind: "replay"; operation: OperationRow }
  | { kind: "refused"; code: ErrorCode; operationId?: OperationId }
  | { kind: "unknown"; operationId: OperationId };

type Refused = Extract<IssueOutcome, { kind: "refused" }>;

const refused = (code: ErrorCode, operationId?: OperationId): Refused => ({
  kind: "refused",
  code,
  ...(operationId === undefined ? {} : { operationId }),
});

/** A refusal thrown out of a transaction, so that it rolls back. */
class Refusal extends Error {
  readonly outcome: Refused;

  constructor(outcome: Refused) {
    super(outcome.code);
    this.name = "Refusal";
    this.outcome = outcome;
  }
}

/** The finalize found the operation no longer this executor's (the sweep): change nothing. */
class NotOwner extends Error {}

/** A parent left `active` between the marker and the finalize (an archive took precedence). */
class ParentsClosed extends Error {}

/** The issuance's view of the outcome of the create (P-87, the answer table). */
function definiteRefusal(failure: BaoFailure): { code: ErrorCode; review: boolean } | null {
  switch (failure.kind) {
    case "denied":
      return { code: "backend_inconsistent", review: true };
    case "sealed":
      return { code: "backend_sealed", review: false };
    case "invalid":
    case "not_found":
    case "cas_mismatch":
      return failure.status === 0 || (failure.status >= 400 && failure.status < 500)
        ? { code: "dependency_unavailable", review: false }
        : null;
    default:
      return null;
  }
}

function audit(
  db: Queryable,
  request: IssueRequest,
  credentialId: CredentialId,
  operationId: OperationId,
  outcome: "intent" | "success" | "failure" | "unknown",
): Promise<string> {
  return appendAudit(db, {
    action: "credential.issue",
    actor: { kind: "user", id: request.userId },
    source: "api",
    organizationId: request.scope.organizationId,
    target: { kind: "environment", id: request.scope.environmentId },
    outcome,
    requestId: request.requestId,
    operationId,
    details: {
      credentialId,
      nameLength: Array.from(request.name).length,
      ttlSeconds: request.ttlSeconds,
    },
  });
}

/** The environment goes to review with `system.drift_detected` (kv_data is not it: the token role). */
async function reviewEnvironment(db: Queryable, request: IssueRequest): Promise<void> {
  await markEnvironmentReview(db, request.scope);
  await appendAudit(db, {
    action: "system.drift_detected",
    actor: { kind: "system", id: null },
    source: "api",
    organizationId: request.scope.organizationId,
    target: { kind: "environment", id: request.scope.environmentId },
    outcome: "failure",
    requestId: request.requestId,
    operationId: null,
    details: { scope: "environment", object: "machine_token_role" },
  });
}

export async function issueCredential(
  deps: CredentialDeps,
  request: IssueRequest,
): Promise<IssueOutcome> {
  const { lockKey } = await environmentCounters(deps.pool, request.scope);
  try {
    return await withEnvironmentLock(deps.lockPool, lockKey, (locked) =>
      underLock(deps, request, locked),
    );
  } catch (error) {
    if (error instanceof Busy) return refused("busy");
    throw error;
  }
}

async function underLock(
  deps: CredentialDeps,
  request: IssueRequest,
  locked: Locked,
): Promise<IssueOutcome> {
  // (a) The issuer session: a login is no change of the product's state, so it comes first.
  const opened = await deps.issuer.open(request.scope.organizationId);
  if (opened === null) return refused("dependency_unavailable");
  if (!opened.ok)
    return refused(opened.kind === "sealed" ? "backend_sealed" : "dependency_unavailable");
  const session = opened.data;
  try {
    await deps.faults?.("after_issuer_login", null);
    return await withSession(deps, request, locked, session);
  } finally {
    await session.close();
  }
}

async function withSession(
  deps: CredentialDeps,
  request: IssueRequest,
  locked: Locked,
  session: IssuerSession,
): Promise<IssueOutcome> {
  const { scope } = request;
  const operationId = randomUUID() as OperationId;
  const credentialId = randomUUID() as CredentialId;
  const dispatchId = randomUUID();
  const key = {
    principalKind: "user" as const,
    principalId: request.userId,
    action: request.routeId,
    target: scope.environmentId,
    idempotencyKey: request.idempotencyKey,
  };

  // (b) Admission and marker, one transaction.
  try {
    const admitted = await inTransaction(locked.client, async (tx) => {
      const { digest, keyId } = intentFingerprint(deps.ring, request.intent);
      const inserted = await insertOperation(tx, {
        ...key,
        id: operationId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        expected: { credentialId },
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
      if (!deps.gateOpen()) throw new Refusal(refused("quarantined"));
      const code = await request.recheck(tx);
      if (code !== null) throw new Refusal(refused(code));
      const ready = await tx.query<{ kv_ready: boolean }>(
        "SELECT kv_ready FROM app.environment WHERE organization_id = $1 AND id = $2",
        [scope.organizationId, scope.environmentId],
      );
      if (ready.rows[0]?.kv_ready !== true) throw new Refusal(refused("state_conflict"));
      const row = await insertIssuing(tx, scope, {
        id: credentialId,
        name: request.name,
        operationId,
        ttlSeconds: request.ttlSeconds,
        issuedBy: request.userId,
      });
      if (row === "blocked") {
        const blocking = await blockingIssuance(tx, scope);
        throw new Refusal(refused("state_conflict", blocking?.operationId));
      }
      await tx.query(
        `INSERT INTO app.operation_step (id, operation_id, ordinal, target, dispatch_attempt_id)
         VALUES ($1, $2, 1, $3, $4)`,
        [randomUUID(), operationId, credentialId, dispatchId],
      );
      await audit(tx, request, credentialId, operationId, "intent");
      return { marker: true } as const;
    });
    if ("replay" in admitted) return { kind: "replay", operation: admitted.replay };
  } catch (error) {
    if (error instanceof Refusal) return error.outcome;
    if (error instanceof AuditUnavailable) return refused("audit_unavailable");
    if (isLockTimeout(error)) return refused("busy");
    // P-118: the barrier refused the admission; nothing committed.
    if (isCaptureRefusal(error)) return refused("busy");
    // The marker may or may not have committed; nothing was sent either way.
    const row = await findOperation(deps.pool, operationId).catch(() => null);
    if (row === null) return refused("dependency_unavailable");
    await settleUnknown(deps, locked, request, operationId, credentialId).catch(() => undefined);
    return { kind: "unknown", operationId };
  }

  // From here on, every failure is unknown.
  try {
    return await afterMarker(deps, request, locked, session, {
      operationId,
      credentialId,
      correlation: { operationId, dispatchId },
    });
  } catch {
    await settleUnknown(deps, locked, request, operationId, credentialId).catch(() => undefined);
    return { kind: "unknown", operationId };
  }
}

/**
 * Unknown (P-87): the operation uncertain, the credential `issuing` →
 * `needs_review` (or, with an accessor whose revocation was not proven,
 * `revoking`), audit `unknown`. On the lock's connection while it lives, on the
 * main pool once it is lost; when both fail, the sweep does it (Run 5.2).
 */
async function settleUnknown(
  deps: CredentialDeps,
  locked: Locked,
  request: IssueRequest,
  operationId: OperationId,
  credentialId: CredentialId,
  revoking?: { accessor: string },
): Promise<void> {
  const work = async (tx: pg.PoolClient): Promise<void> => {
    const row = await finishOperation(tx, operationId, deps.bootId, { state: "uncertain" }, 0);
    if (row === null) throw new NotOwner();
    if (revoking === undefined) {
      await moveCredential(tx, credentialId, ["issuing"], "needs_review");
    } else {
      await moveCredential(tx, credentialId, ["issuing"], "revoking", revoking.accessor);
    }
    await audit(tx, request, credentialId, operationId, "unknown");
  };
  await (locked.lost() ? onMainPool(deps.pool, work) : inTransaction(locked.client, work));
}

interface Marked {
  operationId: OperationId;
  credentialId: CredentialId;
  correlation: Correlation;
}

async function afterMarker(
  deps: CredentialDeps,
  request: IssueRequest,
  locked: Locked,
  session: IssuerSession,
  marked: Marked,
): Promise<IssueOutcome> {
  const { operationId, credentialId } = marked;
  const { scope } = request;
  const fault = async (point: CredentialFaultPoint): Promise<void> => {
    await deps.faults?.(point, operationId);
  };
  await fault("after_marker");

  // (c) The one create.
  const role = machineName(scope.environmentId);
  const meta = { credential_id: credentialId, operation_id: operationId };
  const created = await session.client.tokenCreateFromRole(
    role,
    request.ttlSeconds,
    marked.correlation,
    meta,
  );
  await fault("after_create_sent");
  if (!created.ok) {
    const definite = definiteRefusal(created);
    if (definite === null || locked.lost()) {
      await settleUnknown(deps, locked, request, operationId, credentialId);
      return { kind: "unknown", operationId };
    }
    // Definite: no token exists. The row was never a token (revoked, no accessor).
    await inTransaction(locked.client, async (tx) => {
      await reject(tx, deps, request, marked, definite.code);
      if (definite.review) await reviewEnvironment(tx, request);
    });
    return refused(definite.code, operationId);
  }
  const { token, accessor } = created.data;

  // (d) What the token says about itself.
  const lookup = await session.client.tokenLookupAccessor(accessor);
  const fault4 = lookup.ok
    ? checkIssuedToken(lookup.data, {
        role,
        ttlSeconds: request.ttlSeconds,
        meta,
        namespace: namespaceFor(scope.organizationId),
      })
    : null;
  const expireTime = lookup.ok ? lookup.data.expireTime : null;
  await fault("after_verify");
  if (!lookup.ok || fault4 !== null || expireTime === null) {
    // Not provably what was asked for: it is revoked, never delivered.
    const code: ErrorCode = lookup.ok ? "backend_inconsistent" : "dependency_unavailable";
    return withdraw(deps, request, locked, session, marked, accessor, code, lookup.ok);
  }

  // (e) Finalize.
  let row: OperationRow;
  try {
    row = await inTransaction(locked.client, async (tx) => {
      const parents = await lockParents(tx, scope, null);
      if (parents.project !== "active" || parents.environment !== "active") {
        throw new ParentsClosed();
      }
      if (
        !(await activateCredential(tx, credentialId, {
          accessor,
          effectiveExpiresAt: new Date(expireTime),
        }))
      ) {
        throw new NotOwner();
      }
      const finished = await finishOperation(
        tx,
        operationId,
        deps.bootId,
        {
          state: "succeeded",
          result: {
            credentialId,
            state: "active",
            effectiveExpiresAt: new Date(expireTime).toISOString(),
          },
        },
        LIMITS.operation.terminalRetentionDays,
      );
      if (finished === null) throw new NotOwner();
      await tx.query(
        "UPDATE app.operation_step SET outcome = 'succeeded' WHERE operation_id = $1 AND ordinal = 1",
        [operationId],
      );
      await audit(tx, request, credentialId, operationId, "success");
      await fault("before_finalize_commit");
      return finished;
    });
  } catch (error) {
    if (error instanceof ParentsClosed) {
      // FR-1.39: no token becomes usable after an archive took precedence.
      return withdraw(deps, request, locked, session, marked, accessor, "state_conflict", false);
    }
    throw error;
  }
  await fault("after_finalize");
  const credential = await findCredentialByOperation(locked.client, operationId);
  if (credential === null) throw new Error("the finalized credential was not found");
  return { kind: "issued", operation: row, credential, token };
}

/** Closes a definite refusal: operation rejected, credential revoked, step and audit. */
async function reject(
  tx: pg.PoolClient,
  deps: CredentialDeps,
  request: IssueRequest,
  marked: Marked,
  code: ErrorCode,
  accessor?: string,
): Promise<void> {
  const row = await finishOperation(
    tx,
    marked.operationId,
    deps.bootId,
    { state: "rejected", errorCode: code },
    LIMITS.operation.terminalRetentionDays,
  );
  if (row === null) throw new NotOwner();
  if (!(await moveCredential(tx, marked.credentialId, ["issuing"], "revoked", accessor))) {
    throw new NotOwner();
  }
  await tx.query(
    "UPDATE app.operation_step SET outcome = 'rejected' WHERE operation_id = $1 AND ordinal = 1",
    [marked.operationId],
  );
  await audit(tx, request, marked.credentialId, marked.operationId, "failure");
}

/**
 * A token exists that must not be delivered: revoke it by accessor and prove
 * the absence. Proven → rejected with `code` (the environment to review when
 * the token was not what was asked for). Not proven → the accessor is kept on
 * a `revoking` credential, the operation is uncertain.
 */
async function withdraw(
  deps: CredentialDeps,
  request: IssueRequest,
  locked: Locked,
  session: IssuerSession,
  marked: Marked,
  accessor: string,
  code: ErrorCode,
  review: boolean,
): Promise<IssueOutcome> {
  const proof = await revokeAndVerify(session, accessor, marked.correlation);
  if (proof !== "absent" || locked.lost()) {
    await settleUnknown(deps, locked, request, marked.operationId, marked.credentialId, {
      accessor,
    });
    return { kind: "unknown", operationId: marked.operationId };
  }
  await inTransaction(locked.client, async (tx) => {
    await reject(tx, deps, request, marked, code, accessor);
    if (review) await reviewEnvironment(tx, request);
  });
  return refused(code, marked.operationId);
}
