// Archive (Run 5.3, P-91, FR-1.17, D-41): closed first, revoked and verified,
// then archived.
//
// Admission is one transaction on the main pool: the operation inserted as
// `executing`; capture idle, the gate open, the caller's authority re-read;
// the target `active` (FOR UPDATE), no environment of a project `pending`, no
// effect slot held in the scope; `begin_archive` for the target and, for a
// project, for each of its `active` environments (origin `project`); every
// `active` or `expired` credential of the scope → `revoking`; audit `intent`.
// Admission takes no advisory lock: the environment row's lock serializes it
// with an issuance's finalize, which re-reads the environment and withdraws.
//
// Then `driveArchive` reads everything from rows. For each environment in
// turn: its advisory lock (busy → later), any credential that became active
// meanwhile → revoking, one issuer session, revoke and verify each `revoking`
// credential → `revoked`. When no credential of the scope is outside
// `revoked`: `finish_archive`, the operation `succeeded`, audit `success`.
// Whatever stops it leaves the operation `executing` and does not touch the
// heartbeat; the tick's `continueArchives` drives it again after the stale
// time, and until it finishes the alert `operations_unresolved` is up. Every
// backend change is an idempotent revocation verified by absence, so two
// drivers at once are safe.
import { randomUUID } from "node:crypto";
import { AuditUnavailable, appendAudit, type AuditAction } from "@mykey/audit";
import {
  LIMITS,
  type EnvironmentId,
  type ErrorCode,
  type OperationId,
  type OrganizationId,
  type ProjectId,
  type UserId,
} from "@mykey/contracts";
import {
  ARCHIVE_ACTIONS,
  archiveScope,
  closeCredentials,
  findOperationByKey,
  finishArchiveOperation,
  insertOperation,
  lifecycleTransition,
  lockParents,
  moveCredential,
  openCredentialWork,
  settleRevocations,
  slotOf,
  withTransaction,
  type EnvironmentScope,
  type OperationRow,
  invalidateCapture,
} from "@mykey/db";
import type pg from "pg";
import { intentFingerprint, sameIntent, type Intent } from "../replay.ts";
import type { CredentialDeps } from "../credentials/issue.ts";
import { revokeAndVerify } from "../credentials/verify.ts";
import type { IssuerSession, RuntimeBao } from "../runtime.ts";
import { Busy, inTransaction, withEnvironmentLock } from "../secrets/lock.ts";

export const ARCHIVE_FAULT_POINTS = [
  "archive_after_marker",
  "archive_after_revoke_sent",
  "archive_before_finish_commit",
] as const;
export type ArchiveFaultPoint = (typeof ARCHIVE_FAULT_POINTS)[number];

/** What a driver needs: no ring, no gate (it only finishes what was admitted). */
export interface ArchiveDriveDeps {
  pool: pg.Pool;
  lockPool: pg.Pool;
  issuer: CredentialDeps["issuer"];
  bootId: string;
  faults?: (point: ArchiveFaultPoint, operationId: OperationId) => void | Promise<void>;
}

export interface LifecycleDeps extends ArchiveDriveDeps {
  ring: CredentialDeps["ring"];
  gateOpen: () => boolean;
  /** The runtime identity (reactivation lists names with it). */
  bao?: RuntimeBao;
}

export interface ArchiveRequest {
  routeId: string;
  kind: "project" | "environment";
  organizationId: OrganizationId;
  projectId: ProjectId;
  environmentId?: EnvironmentId;
  userId: UserId;
  idempotencyKey: string;
  intent: Intent;
  requestId: string;
  /** Runs in the admission transaction after the target is locked: null when the caller may archive. */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
}

export type ArchiveStart =
  | { kind: "started" | "replay"; operation: OperationRow }
  | { kind: "refused"; code: ErrorCode; operationId?: OperationId };

type Refused = Extract<ArchiveStart, { kind: "refused" }>;

class Refusal extends Error {
  readonly outcome: Refused;

  constructor(code: ErrorCode, operationId?: OperationId | null) {
    super(code);
    this.name = "Refusal";
    this.outcome = {
      kind: "refused",
      code,
      ...(operationId === undefined || operationId === null ? {} : { operationId }),
    };
  }
}

/** P-114: an issuer session is reused while it is younger than this (it lives 60 s). */
const ISSUER_REUSE_MS = (LIMITS.machineToken.issuerSessionSeconds - 15) * 1000;

const AUDIT: Record<(typeof ARCHIVE_ACTIONS)[number], AuditAction> = {
  "projects.archive": "project.archive",
  "environments.archive": "environment.archive",
};

function auditArchive(
  db: pg.PoolClient,
  a: {
    action: string;
    userId: string | null;
    organizationId: OrganizationId;
    kind: "project" | "environment";
    id: string;
    outcome: "intent" | "success";
    requestId: string | null;
    operationId: OperationId;
    environments: number;
  },
): Promise<string> {
  return appendAudit(db, {
    action: AUDIT[a.action as (typeof ARCHIVE_ACTIONS)[number]],
    actor: a.userId === null ? { kind: "system", id: null } : { kind: "user", id: a.userId },
    source: "api",
    organizationId: a.organizationId,
    target: { kind: a.kind, id: a.id },
    outcome: a.outcome,
    requestId: a.requestId,
    operationId: a.operationId,
    details: { environments: a.environments },
  });
}

export async function beginArchive(
  deps: LifecycleDeps,
  request: ArchiveRequest,
): Promise<ArchiveStart> {
  const operationId = randomUUID() as OperationId;
  const target = request.kind === "project" ? request.projectId : request.environmentId;
  if (target === undefined) throw new Error("an environment archive names its environment");
  const key = {
    principalKind: "user" as const,
    principalId: request.userId,
    action: request.routeId,
    target,
    idempotencyKey: request.idempotencyKey,
  };
  let admitted: OperationRow | { replay: OperationRow };
  try {
    admitted = await withTransaction(deps.pool, async (tx) => {
      // P-118: an archive reduces access; while a pair is captured it records that and proceeds.
      await invalidateCapture(tx, "archive");
      const { digest, keyId } = intentFingerprint(deps.ring, request.intent);
      const inserted = await insertOperation(tx, {
        ...key,
        id: operationId,
        organizationId: request.organizationId,
        projectId: request.projectId,
        ...(request.environmentId === undefined ? {} : { environmentId: request.environmentId }),
        expected: { closed: 0 },
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
          throw new Refusal("idempotency_conflict");
        }
        return { replay: found };
      }
      if (!deps.gateOpen()) throw new Refusal("quarantined");
      // The rows in the order every admission takes them — organization (share),
      // project, environment, the target FOR UPDATE — so a concurrent create,
      // which updates the organization row first, queues instead of deadlocking.
      // A concurrent create or finalize then waits for this transaction.
      await lockParents(
        tx,
        {
          organizationId: request.organizationId,
          projectId: request.projectId,
          ...(request.environmentId === undefined ? {} : { environmentId: request.environmentId }),
        },
        request.kind,
      );
      const own = await tx.query<{ state: string; archive_operation_id: OperationId | null }>(
        request.kind === "project"
          ? `SELECT state, archive_operation_id FROM app.project
              WHERE organization_id = $1 AND id = $2 FOR UPDATE`
          : `SELECT state, archive_operation_id FROM app.environment
              WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [request.organizationId, target],
      );
      const code = await request.recheck(tx);
      if (code !== null) throw new Refusal(code);
      const row = own.rows[0];
      if (row === undefined) throw new Refusal("not_found");
      if (row.state === "revoking") throw new Refusal("state_conflict", row.archive_operation_id);
      if (row.state !== "active") throw new Refusal("state_conflict");

      const environments = await tx.query<{ id: EnvironmentId; state: string }>(
        `SELECT id, state FROM app.environment
          WHERE organization_id = $1 AND project_id = $2 AND ($3::uuid IS NULL OR id = $3)
          ORDER BY id FOR UPDATE`,
        [request.organizationId, request.projectId, request.environmentId ?? null],
      );
      const scopes: EnvironmentScope[] = environments.rows.map((env) => ({
        organizationId: request.organizationId,
        projectId: request.projectId,
        environmentId: env.id,
      }));
      if (environments.rows.some((env) => env.state === "pending")) {
        throw new Refusal("state_conflict");
      }
      for (const scope of scopes) {
        const slot = await slotOf(tx, scope);
        if (slot !== null) throw new Refusal("state_conflict", slot.operationId);
      }
      const begin = (kind: "project" | "environment", id: string, origin?: "project") =>
        lifecycleTransition(tx, {
          kind,
          organizationId: request.organizationId,
          id,
          operationId,
          step: "begin_archive",
          ...(origin === undefined ? {} : { origin }),
        });
      if (!(await begin(request.kind, target))) throw new Refusal("state_conflict");
      if (request.kind === "project") {
        for (const env of environments.rows) {
          if (env.state === "active") await begin("environment", env.id, "project");
        }
      }
      for (const scope of scopes) await closeCredentials(tx, scope);
      // What this archive revokes: every credential of the scope that is now revoking.
      const revoking = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM app.machine_credential
          WHERE organization_id = $1 AND project_id = $2
            AND ($3::uuid IS NULL OR environment_id = $3) AND state = 'revoking'`,
        [request.organizationId, request.projectId, request.environmentId ?? null],
      );
      const closed = revoking.rows[0]?.count ?? 0;
      await tx.query(
        "UPDATE app.operation SET expected = $2::jsonb, dispatched_at = now() WHERE id = $1",
        [operationId, JSON.stringify({ closed, environments: scopes.length })],
      );
      await auditArchive(tx, {
        action: request.routeId,
        userId: request.userId,
        organizationId: request.organizationId,
        kind: request.kind,
        id: target,
        outcome: "intent",
        requestId: request.requestId,
        operationId,
        environments: scopes.length,
      });
      const row2 = await findOperationByKey(tx, key);
      if (row2 === null) throw new Error("archive operation vanished");
      return row2;
    });
  } catch (error) {
    if (error instanceof Refusal) return error.outcome;
    if (error instanceof AuditUnavailable) return { kind: "refused", code: "audit_unavailable" };
    throw error;
  }
  if ("replay" in admitted) return { kind: "replay", operation: admitted.replay };
  return { kind: "started", operation: admitted };
}

/**
 * Drives one archive as far as it goes now. Compare-then-act: safe to call
 * again, and from two processes at once. "archived" once the operation reads
 * succeeded; "waiting" when something keeps it from finishing now.
 */
export async function driveArchive(
  deps: ArchiveDriveDeps,
  operationId: OperationId,
): Promise<"archived" | "waiting"> {
  const scope = await archiveScope(deps.pool, operationId);
  if (scope === null) throw new Error("not an archive operation");
  if (scope.state === "succeeded") return "archived";
  if (scope.state !== "executing") return "waiting";
  const fault = async (point: ArchiveFaultPoint): Promise<void> => {
    await deps.faults?.(point, operationId);
  };
  let revokedHere = 0;
  // P-114: one issuer session for as many environments as fit in its first
  // 45 s (it lives LIMITS.machineToken.issuerSessionSeconds); then a new one.
  let session: { data: IssuerSession; openedAt: number } | null = null;
  const issuerSession = async (): Promise<IssuerSession | null> => {
    if (session !== null && Date.now() - session.openedAt < ISSUER_REUSE_MS) return session.data;
    if (session !== null) {
      await session.data.close();
      session = null;
    }
    const opened = await deps.issuer.open(scope.organizationId);
    if (!opened?.ok) return null;
    session = { data: opened.data, openedAt: Date.now() };
    return opened.data;
  };
  try {
    for (const environment of scope.environments) {
      const done = await (async (): Promise<boolean> => {
        try {
          return await withEnvironmentLock(deps.lockPool, environment.lockKey, async (locked) => {
            // A credential that became active meanwhile (an issuance finalized before admission) closes too.
            // P-118: one transaction, so the invalidation that lets it pass a capture covers both writes.
            await inTransaction(locked.client, async (tx) => {
              await invalidateCapture(tx, "archive");
              const closedNow = await closeCredentials(tx, environment);
              if (closedNow > 0) {
                await tx.query(
                  `UPDATE app.operation
                    SET expected = jsonb_set(expected, '{closed}',
                                   to_jsonb(coalesce((expected->>'closed')::int, 0) + $2))
                  WHERE id = $1`,
                  [operationId, closedNow],
                );
              }
            });
            const work = await openCredentialWork(locked.client, environment);
            if (work.revoking.length > 0) {
              for (const credential of work.revoking) {
                if (credential.accessor === null) return false;
                const issuer = await issuerSession();
                if (issuer === null) return false;
                {
                  const proof = await revokeAndVerify(issuer, credential.accessor, {
                    operationId,
                    dispatchId: randomUUID(),
                  });
                  if (proof !== "absent") return false;
                  await inTransaction(locked.client, async (tx) => {
                    await invalidateCapture(tx, "archive");
                    if (await moveCredential(tx, credential.id, ["revoking"], "revoked")) {
                      await settleRevocations(
                        tx,
                        credential.id,
                        LIMITS.operation.terminalRetentionDays,
                      );
                    }
                  });
                  revokedHere += 1;
                  if (revokedHere === 1) await fault("archive_after_revoke_sent");
                }
              }
            }
            return work.blocking === 0;
          });
        } catch (error) {
          if (error instanceof Busy) return false;
          throw error;
        }
      })();
      if (!done) return "waiting";
    }
  } finally {
    // A null session was never opened; the cast undoes the narrowing of the closure's writes.
    const open = session as { data: IssuerSession } | null;
    if (open !== null) await open.data.close();
  }

  // Every credential of the scope is revoked: finish, once.
  const finished = await withTransaction(deps.pool, async (tx) => {
    await invalidateCapture(tx, "archive");
    const moved = await lifecycleTransition(tx, {
      kind: scope.kind,
      organizationId: scope.organizationId,
      id: scope.id,
      operationId,
      step: "finish_archive",
    });
    if (!moved) return false;
    const expected = await tx.query<{
      expected: { closed?: number } | null;
      action: string;
      principal_id: string;
    }>("SELECT expected, action, principal_id FROM app.operation WHERE id = $1", [operationId]);
    const row = expected.rows[0];
    const result = {
      state: "archived",
      environments: scope.environments.length,
      credentialsRevoked: row?.expected?.closed ?? 0,
    };
    const done = await finishArchiveOperation(
      tx,
      operationId,
      result,
      LIMITS.operation.terminalRetentionDays,
    );
    if (done === null) return false;
    await auditArchive(tx, {
      action: row?.action ?? "",
      userId: row?.principal_id ?? null,
      organizationId: scope.organizationId,
      kind: scope.kind,
      id: scope.id,
      outcome: "success",
      requestId: null,
      operationId,
      environments: scope.environments.length,
    });
    await fault("archive_before_finish_commit");
    return true;
  });
  if (finished) return "archived";
  // Another driver may have been faster.
  const after = await archiveScope(deps.pool, operationId);
  return after?.state === "succeeded" ? "archived" : "waiting";
}

/** The tick (P-91): every archive executing with a heartbeat older than the stale time, driven again. */
export async function continueArchives(
  deps: ArchiveDriveDeps,
  opts: { staleSeconds?: number } = {},
): Promise<{ archived: OperationId[]; waiting: OperationId[] }> {
  const staleSeconds = opts.staleSeconds ?? LIMITS.operation.stuckAlertSeconds;
  const due = await deps.pool.query<{ id: OperationId }>(
    `SELECT id FROM app.operation
      WHERE action = ANY($1::text[]) AND state = 'executing'
        AND heartbeat_at <= now() - make_interval(secs => $2)
      ORDER BY created_at`,
    [[...ARCHIVE_ACTIONS], staleSeconds],
  );
  const archived: OperationId[] = [];
  const waiting: OperationId[] = [];
  for (const { id } of due.rows) {
    ((await driveArchive(deps, id)) === "archived" ? archived : waiting).push(id);
  }
  return { archived, waiting };
}
