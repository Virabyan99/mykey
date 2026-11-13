// The six-step mutation protocol of a secret (Doc 06 §6.2, P-66 … P-72,
// D-36). Everything runs under the environment's advisory lock, on the lock's
// own connection: (a) pre-read of the key's backend metadata; (b) admission
// transaction; (c) dispatch transaction — its commit is the dispatch marker;
// (d) one change; (e) read-back; (f) finalize. Before the marker a failure
// leaves no operation, or a rejected one with its slot released; from the
// marker on, every failure is `unknown` (Doc 10 §4.1 rule 3): the operation is
// left executing or made uncertain, the key goes to review and the slot stays.
import { randomBytes, randomUUID } from "node:crypto";
import { AuditUnavailable, appendAudit, type AuditAction } from "@mykey/audit";
import { LIMITS, type ErrorCode, type OperationId, type UserId } from "@mykey/contracts";
import {
  applyCounters,
  claimDispatch,
  environmentCounters,
  findOperationByKey,
  finishOperation,
  insertOperation,
  lockIndexRow,
  markEnvironmentReview,
  markKeyReview,
  recordVersionEvent,
  releaseSlot,
  slotOf,
  takeSlot,
  writeIndexRow,
  type EnvironmentScope,
  type Finish,
  type IndexRow,
  type OperationRow,
  type Queryable,
} from "@mykey/db";
import { secretPath, type BaoFailure, type OpenBaoClient } from "@mykey/openbao";
import type pg from "pg";
import { intentFingerprint, sameIntent, type HmacRing, type Intent } from "../replay.ts";
import type { RuntimeBao } from "../runtime.ts";
import { Busy, inTransaction, isLockTimeout, withEnvironmentLock, type Locked } from "./lock.ts";

export type SecretAction = "create" | "update" | "delete" | "undelete" | "restore";

export const FAULT_POINTS = [
  "after_admission",
  "after_dispatch_marker",
  "after_send",
  "after_read_back",
  "before_finalize_commit",
  "after_finalize",
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface EffectDeps {
  pool: pg.Pool;
  lockPool: pg.Pool;
  bao: RuntimeBao;
  bootId: string;
  ring: HmacRing;
  gateOpen: () => boolean;
  /** Test only: a hook at each point of the protocol. */
  faults?: (point: FaultPoint, operationId: OperationId) => void | Promise<void>;
}

export interface SecretRequest {
  action: SecretAction;
  routeId: string;
  scope: EnvironmentScope;
  userId: UserId;
  name: string;
  value?: string;
  expected?: { version: number; stateTag: string };
  sourceVersion?: number;
  idempotencyKey: string;
  intent: Intent;
  requestId: string;
  parent?: { operationId: OperationId; ordinal: number };
  /**
   * The admission recheck (FR-1.10), inside the admission transaction: the
   * parents' states locked and re-read, the caller's authority re-decided.
   * Null when the request may still proceed.
   */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
}

export type SecretOutcome =
  | { kind: "succeeded" | "replay"; operation: OperationRow }
  | {
      kind: "refused";
      code: ErrorCode;
      operationId?: OperationId;
      details?: Record<string, unknown>;
    }
  | { kind: "unknown"; operationId: OperationId };

/** 16 random bytes, base64url (P-70). */
export const freshStateTag = (): string => randomBytes(16).toString("base64url");

type Refused = Extract<SecretOutcome, { kind: "refused" }>;

/** A refusal thrown out of a transaction, so that the transaction rolls back. */
class Refusal extends Error {
  readonly outcome: Refused;
  /** A key to send to review after the rollback (P-68: index absent, backend present). */
  readonly reviewKey: boolean;

  constructor(outcome: Refused, reviewKey = false) {
    super(outcome.code);
    this.name = "Refusal";
    this.outcome = outcome;
    this.reviewKey = reviewKey;
  }
}

/** The finalize found the operation no longer this executor's: change nothing. */
class NotOwner extends Error {}

const refused = (
  code: ErrorCode,
  extra: { operationId?: OperationId; details?: Record<string, unknown> } = {},
): Refused => ({ kind: "refused", code, ...extra });

async function onMainPool<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    return await inTransaction(client, fn).catch((error: unknown) => {
      broken = true;
      throw error;
    });
  } finally {
    client.release(broken);
  }
}

interface BackendState {
  currentVersion: number;
  /** The current version is deleted or destroyed. */
  deleted: boolean;
}

const AUDIT_ACTION: Record<SecretAction, AuditAction> = {
  create: "secret.create",
  update: "secret.update",
  delete: "secret.delete",
  undelete: "secret.undelete",
  restore: "secret.restore",
};

function audit(
  db: Queryable,
  request: SecretRequest,
  operationId: OperationId,
  outcome: "intent" | "success" | "failure" | "unknown",
  version?: number,
): Promise<string> {
  return appendAudit(db, {
    action: AUDIT_ACTION[request.action],
    actor: { kind: "user", id: request.userId },
    source: "api",
    organizationId: request.scope.organizationId,
    target: { kind: "environment", id: request.scope.environmentId },
    outcome,
    requestId: request.requestId,
    operationId,
    details: { name: request.name, ...(version === undefined ? {} : { version }) },
  });
}

/** The value's length in bytes (the request was validated: well-formed UTF-8). */
const byteLength = (value: string | undefined): number => Buffer.byteLength(value ?? "", "utf8");

/** What the action will send, decided at admission. */
interface Plan {
  cas: number;
  bytes: number;
  /** environment.live_value_bytes moves by this at finalize. */
  liveDelta: number;
}

/**
 * The action's checks (P-68, P-70), comparing the request, the locked index
 * row, the pre-read and the counters. A Refusal rolls the admission back.
 */
function checkAction(
  request: SecretRequest,
  row: IndexRow | null,
  backend: BackendState | null,
  counters: { names: number; liveBytes: number },
): Plan {
  switch (request.action) {
    case "create": {
      if (row !== null) throw new Refusal(refused("already_exists"));
      if (backend !== null) throw new Refusal(refused("backend_inconsistent"), true);
      if (counters.names >= LIMITS.environment.maxNames) {
        throw new Refusal(refused("capacity_exceeded", { details: { limit: "names" } }));
      }
      const bytes = byteLength(request.value);
      if (counters.liveBytes + bytes > LIMITS.environment.maxLiveValueBytes) {
        throw new Refusal(refused("capacity_exceeded", { details: { limit: "bytes" } }));
      }
      return { cas: 0, bytes, liveDelta: bytes };
    }
    case "update": {
      const expected = request.expected;
      if (expected === undefined) throw new Error("an update carries its expected version");
      if (row === null) throw new Refusal(refused("not_found"));
      if (row.state === "needs_review") throw new Refusal(refused("key_under_review"));
      if (row.state === "deleted") throw new Refusal(refused("state_conflict"));
      if (row.currentVersion !== expected.version || row.stateTag !== expected.stateTag) {
        throw new Refusal(
          refused("version_conflict", {
            details: {
              currentVersion: row.currentVersion,
              currentStateTag: row.stateTag,
              state: row.state,
            },
          }),
        );
      }
      // The index and the backend must agree before anything is sent (P-68).
      if (backend === null || backend.deleted || backend.currentVersion !== row.currentVersion) {
        throw new Refusal(refused("backend_inconsistent"), true);
      }
      const bytes = byteLength(request.value);
      const liveDelta = bytes - row.liveValueBytes;
      if (counters.liveBytes + liveDelta > LIMITS.environment.maxLiveValueBytes) {
        throw new Refusal(refused("capacity_exceeded", { details: { limit: "bytes" } }));
      }
      return { cas: expected.version, bytes, liveDelta };
    }
    default:
      throw new Error(`secret action ${request.action} is not implemented`);
  }
}

/** P-68: how a definite refusal of the change is recorded. */
function definiteRefusal(failure: BaoFailure): {
  code: ErrorCode;
  review: "key" | "environment" | null;
} | null {
  switch (failure.kind) {
    case "cas_mismatch":
      return { code: "backend_inconsistent", review: "key" };
    case "denied":
      return { code: "backend_inconsistent", review: "environment" };
    case "sealed":
      return { code: "backend_sealed", review: null };
    case "invalid":
      return failure.status === 0 ? { code: "dependency_unavailable", review: null } : null;
    default:
      return null;
  }
}

export async function runSecretAction(
  deps: EffectDeps,
  request: SecretRequest,
): Promise<SecretOutcome> {
  const bao = deps.bao.clientFor(request.scope.organizationId);
  if (bao === null) return refused("dependency_unavailable");
  const { projectId, environmentId } = request.scope;
  const path = secretPath(projectId, environmentId, request.name);
  const { lockKey } = await environmentCounters(deps.pool, request.scope);
  try {
    return await withEnvironmentLock(deps.lockPool, lockKey, (locked) =>
      underLock(deps, request, bao, path, locked),
    );
  } catch (error) {
    if (error instanceof Busy) return refused("busy");
    throw error;
  }
}

/**
 * A backend read that failed, before anything was changed (P-68, P-72):
 * `sealed` → backend_sealed; `denied` → the environment goes to review and
 * `system.drift_detected` (kv_data) is audited → backend_inconsistent;
 * anything else → dependency_unavailable.
 */
export async function backendRefusal(
  db: Queryable,
  scope: EnvironmentScope,
  failure: BaoFailure,
  requestId: string,
): Promise<ErrorCode> {
  if (failure.kind === "sealed") return "backend_sealed";
  if (failure.kind !== "denied") return "dependency_unavailable";
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
  return "backend_inconsistent";
}

async function underLock(
  deps: EffectDeps,
  request: SecretRequest,
  bao: OpenBaoClient,
  path: string,
  locked: Locked,
): Promise<SecretOutcome> {
  const { scope } = request;
  const fault = async (point: FaultPoint, operationId: OperationId): Promise<void> => {
    await deps.faults?.(point, operationId);
  };

  // (a) Pre-read.
  const pre = await bao.kvMetadata(path);
  let backend: BackendState | null = null;
  if (pre.ok) {
    const current = pre.data.versions[String(pre.data.currentVersion)];
    backend = {
      currentVersion: pre.data.currentVersion,
      deleted: current === undefined || current.deleted || current.destroyed,
    };
  } else if (pre.kind !== "not_found") {
    return refused(await backendRefusal(deps.pool, scope, pre, request.requestId));
  }

  // (b) Admission.
  const operationId = randomUUID() as OperationId;
  const stepId = randomUUID();
  const key = {
    principalKind: "user" as const,
    principalId: request.userId,
    action: request.routeId,
    target: environmentIdOf(request),
    idempotencyKey: request.idempotencyKey,
  };
  let plan: Plan;
  try {
    const admitted = await inTransaction(locked.client, async (tx) => {
      const { digest, keyId } = intentFingerprint(deps.ring, request.intent);
      const inserted = await insertOperation(tx, {
        ...key,
        id: operationId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        secretName: request.name,
        ...(request.parent === undefined ? {} : { parentOperationId: request.parent.operationId }),
        ...(request.expected === undefined ? {} : { expected: { ...request.expected } }),
        executorBootId: deps.bootId,
        state: "accepted",
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
      const capture = await tx.query<{ capture_mode: string }>(
        "SELECT capture_mode FROM app.service_control FOR SHARE",
      );
      if (capture.rows[0]?.capture_mode !== "idle") throw new Refusal(refused("busy"));
      const code = await request.recheck(tx);
      if (code !== null) throw new Refusal(refused(code));
      const slot = await slotOf(tx, scope);
      if (slot !== null) {
        throw new Refusal(refused("key_under_review", { operationId: slot.operationId }));
      }
      const row = await lockIndexRow(tx, scope, request.name);
      const counters = await environmentCounters(tx, scope);
      const decided = checkAction(request, row, backend, counters);
      await tx.query(
        `INSERT INTO app.operation_step (id, operation_id, ordinal, target, before_state)
         VALUES ($1, $2, 1, $3, $4)`,
        [
          stepId,
          operationId,
          request.name,
          JSON.stringify({
            indexVersion: row?.currentVersion ?? null,
            backendCurrentVersion: backend?.currentVersion ?? null,
            backendDeleted: backend?.deleted ?? null,
          }),
        ],
      );
      await takeSlot(tx, scope, operationId, stepId, counters.generation);
      await audit(tx, request, operationId, "intent");
      return { plan: decided, previous: row } as const;
    });
    if ("replay" in admitted) return { kind: "replay", operation: admitted.replay };
    plan = admitted.plan;
  } catch (error) {
    if (error instanceof Refusal) {
      if (error.reviewKey) await markKeyReview(deps.pool, scope, request.name, null);
      return error.outcome;
    }
    if (isLockTimeout(error)) return refused("busy");
    throw error;
  }

  // Before the marker: a failure closes the operation as rejected; nothing was sent.
  const reject = async (code: ErrorCode): Promise<SecretOutcome> => {
    const closed = await inTransaction(locked.client, async (tx) => {
      const row = await finishOperation(
        tx,
        operationId,
        deps.bootId,
        { state: "rejected", errorCode: code },
        LIMITS.operation.terminalRetentionDays,
      );
      if (row === null) throw new NotOwner();
      await releaseSlot(tx, operationId);
      await audit(tx, request, operationId, "failure");
      return row;
    }).catch(() => null);
    return closed === null ? { kind: "unknown", operationId } : refused(code, { operationId });
  };

  // (c) Dispatch.
  const dispatchId = randomUUID();
  try {
    await fault("after_admission", operationId);
    await inTransaction(locked.client, async (tx) => {
      if (!(await claimDispatch(tx, operationId, deps.bootId))) {
        throw new Refusal(refused("dependency_unavailable"));
      }
      await tx.query("UPDATE app.operation_step SET dispatch_attempt_id = $2 WHERE id = $1", [
        stepId,
        dispatchId,
      ]);
      const capture = await tx.query<{ capture_mode: string }>(
        "SELECT capture_mode FROM app.service_control FOR SHARE",
      );
      if (capture.rows[0]?.capture_mode !== "idle") throw new Refusal(refused("busy"));
      if (!deps.gateOpen()) throw new Refusal(refused("quarantined"));
    });
  } catch (error) {
    if (error instanceof Refusal) return reject(error.outcome.code);
    if (error instanceof AuditUnavailable) return reject("audit_unavailable");
    // The marker may or may not have committed; nothing was sent either way.
    return reject("dependency_unavailable");
  }

  // From here on, every failure is unknown.
  try {
    return await afterMarker(deps, request, bao, path, locked, {
      operationId,
      stepId,
      dispatchId,
      plan,
      fault,
    });
  } catch {
    await settleUnknown({ pool: deps.pool }, deps, request, operationId).catch(() => undefined);
    return { kind: "unknown", operationId };
  }
}

const environmentIdOf = (request: SecretRequest): string => request.scope.environmentId;

/** Unknown (P-68): the operation uncertain, the key to review, audit `unknown`; the slot stays. */
async function settleUnknown(
  on: { pool: pg.Pool } | { client: pg.PoolClient },
  deps: EffectDeps,
  request: SecretRequest,
  operationId: OperationId,
): Promise<void> {
  const work = async (tx: pg.PoolClient): Promise<void> => {
    const row = await finishOperation(tx, operationId, deps.bootId, { state: "uncertain" }, 0);
    if (row === null) throw new NotOwner();
    await markKeyReview(tx, request.scope, request.name, operationId);
    await audit(tx, request, operationId, "unknown");
  };
  await ("pool" in on ? onMainPool(on.pool, work) : inTransaction(on.client, work));
}

/** Where an unknown outcome is recorded: the lock's connection, or the main pool once it is lost. */
const settleOn = (deps: EffectDeps, locked: Locked) =>
  locked.lost() ? { pool: deps.pool } : { client: locked.client };

async function afterMarker(
  deps: EffectDeps,
  request: SecretRequest,
  bao: OpenBaoClient,
  path: string,
  locked: Locked,
  step: {
    operationId: OperationId;
    stepId: string;
    dispatchId: string;
    plan: Plan;
    fault: (point: FaultPoint, operationId: OperationId) => Promise<void>;
  },
): Promise<SecretOutcome> {
  const { operationId, plan, fault } = step;
  const { scope } = request;
  await fault("after_dispatch_marker", operationId);

  // (d) The one change.
  const written = await bao.kvWrite(
    path,
    { value: request.value ?? "", operation_id: operationId, format: 1 },
    plan.cas,
    { operationId, dispatchId: step.dispatchId },
  );
  await fault("after_send", operationId);

  if (!written.ok) {
    const definite = definiteRefusal(written);
    if (definite === null || locked.lost()) {
      await settleUnknown(settleOn(deps, locked), deps, request, operationId);
      return { kind: "unknown", operationId };
    }
    await inTransaction(locked.client, async (tx) => {
      const row = await finishOperation(
        tx,
        operationId,
        deps.bootId,
        { state: "rejected", errorCode: definite.code },
        LIMITS.operation.terminalRetentionDays,
      );
      if (row === null) throw new NotOwner();
      if (definite.review === "key") await markKeyReview(tx, scope, request.name, operationId);
      if (definite.review === "environment") await markEnvironmentReview(tx, scope);
      await tx.query("UPDATE app.operation_step SET outcome = 'rejected' WHERE id = $1", [
        step.stepId,
      ]);
      await audit(tx, request, operationId, "failure");
      await releaseSlot(tx, operationId);
    });
    return refused(definite.code, { operationId });
  }

  // (e) Read-back: the version holds this operation's envelope.
  const version = written.data.version;
  const read = await bao.kvRead(path, version);
  await fault("after_read_back", operationId);
  const proven = read.ok && read.data.envelope.operation_id === operationId;
  if (!proven || locked.lost()) {
    await settleUnknown(settleOn(deps, locked), deps, request, operationId);
    return { kind: "unknown", operationId };
  }

  // (f) Finalize.
  const stateTag = freshStateTag();
  const finished = await inTransaction(locked.client, async (tx) => {
    const generation = await applyCounters(tx, scope, plan.liveDelta);
    const finish: Finish = {
      state: "succeeded",
      result: {
        name: request.name,
        version,
        stateTag,
        state: "live",
        generation: generation.toString(),
      },
    };
    const row = await finishOperation(
      tx,
      operationId,
      deps.bootId,
      finish,
      LIMITS.operation.terminalRetentionDays,
    );
    if (row === null) throw new NotOwner();
    await writeIndexRow(tx, scope, {
      name: request.name,
      currentVersion: version,
      stateTag,
      state: "live",
      liveValueBytes: plan.bytes,
      lastOperationId: operationId,
    });
    await recordVersionEvent(tx, scope, {
      name: request.name,
      version,
      operationId,
      actorKind: "user",
      actorId: request.userId,
      action: AUDIT_ACTION[request.action],
    });
    await tx.query(
      "UPDATE app.operation_step SET outcome = 'succeeded', backend_ref = $2 WHERE id = $1",
      [step.stepId, String(version)],
    );
    await audit(tx, request, operationId, "success", version);
    await releaseSlot(tx, operationId);
    await fault("before_finalize_commit", operationId);
    return row;
  });
  await fault("after_finalize", operationId);
  return { kind: "succeeded", operation: finished };
}
