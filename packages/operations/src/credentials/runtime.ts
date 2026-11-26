// The runtime credential (Session 11, Run 11.3; P-185, P-186, P-189, D-81).
// Unlike a 30-day token it is nothing in OpenBao: its row holds the verifier
// of a client secret, and the secret is exchanged later for a short token.
// So issuing and revoking are one PostgreSQL transaction each, with no lock
// of the environment, no issuer session and no outcome that can be unknown:
// the transaction commits or nothing happened.
//
// The client secret is a local of `issueRuntimeCredential` and of the handler
// that answers: never on an operation, an error, a log line or an audit row.
import { randomUUID } from "node:crypto";
import { AuditUnavailable, appendAudit } from "@mykey/audit";
import {
  LIMITS,
  RUNTIME_SECRET_PREFIX,
  type CredentialId,
  type EnvironmentId,
  type ErrorCode,
  type OperationId,
  type OrganizationId,
  type ProjectId,
} from "@mykey/contracts";
import {
  completeOperation,
  findCredentialByOperation,
  findOperationByKey,
  insertOperation,
  insertRuntimeCredential,
  invalidateCapture,
  isCaptureRefusal,
  lockCredential,
  moveCredential,
  withTransaction,
  type CredentialRow,
  type EnvironmentScope,
  type OperationRow,
} from "@mykey/db";
import type pg from "pg";
import type { Actor } from "../actor.ts";
import { intentFingerprint, sameIntent, type HmacRing, type Intent } from "../replay.ts";
import { mintSecret, runtimeBinding, verifierOf } from "./secret.ts";

export interface RuntimeCredentialDeps {
  pool: pg.Pool;
  /** The replay-fingerprint ring: the operation's intent. */
  ring: HmacRing;
  /** The ring the client secret's verifier is made under (the reset-verifier ring, labelled). */
  verifierRing: HmacRing;
  gateOpen: () => boolean;
}

interface Common {
  routeId: string;
  scope: EnvironmentScope;
  actor: Actor;
  idempotencyKey: string;
  intent: Intent;
  requestId: string;
  /** Runs in the transaction: null when the caller may still do this (authority and states). */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
}

export interface RuntimeIssueRequest extends Common {
  name: string;
  ttlSeconds: number;
  cidrs: readonly string[];
}

export interface RuntimeRevokeRequest extends Common {
  credentialId: CredentialId;
}

interface Refused {
  kind: "refused";
  code: ErrorCode;
  operationId?: OperationId;
}

export type RuntimeIssueOutcome =
  | { kind: "issued"; operation: OperationRow; credential: CredentialRow; clientSecret: string }
  | { kind: "replay"; operation: OperationRow }
  | Refused;

export type RuntimeRevokeOutcome =
  | { kind: "revoked"; operation: OperationRow }
  | { kind: "replay"; operation: OperationRow }
  | Refused;

/** A refusal thrown out of the transaction, so that it rolls back. */
export class Refusal extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.name = "Refusal";
    this.code = code;
  }
}

/** What a failed transaction answers; anything else is rethrown. */
export function refusalOf(error: unknown): { kind: "refused"; code: ErrorCode } {
  if (error instanceof Refusal) return { kind: "refused", code: error.code };
  if (error instanceof AuditUnavailable) return { kind: "refused", code: "audit_unavailable" };
  // P-118: the capture barrier refused a statement; nothing committed.
  if (isCaptureRefusal(error)) return { kind: "refused", code: "busy" };
  throw error;
}

/** What an operation of one transaction is admitted with (the runtime and the automation pair). */
export interface Admission {
  routeId: string;
  actor: Actor;
  idempotencyKey: string;
  intent: Intent;
  /** Runs in the transaction: null when the caller may still do this (authority and states). */
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
}

/** Where the operation belongs; its key's target is the deepest id. */
export interface Place {
  organizationId: OrganizationId;
  projectId?: ProjectId;
  environmentId?: EnvironmentId;
}

/** The operation by its key: inserted, or the one already there (a replay or a conflict). */
export async function admit(
  tx: pg.PoolClient,
  deps: RuntimeCredentialDeps,
  request: Admission,
  place: Place,
  operationId: OperationId,
  expected: Record<string, unknown>,
): Promise<OperationRow | null> {
  const key = {
    principalKind: request.actor.kind,
    principalId: request.actor.id,
    action: request.routeId,
    target: place.environmentId ?? place.projectId ?? place.organizationId,
    idempotencyKey: request.idempotencyKey,
  };
  const { digest, keyId } = intentFingerprint(deps.ring, request.intent);
  const inserted = await insertOperation(tx, {
    ...key,
    id: operationId,
    organizationId: place.organizationId,
    ...(place.projectId === undefined ? {} : { projectId: place.projectId }),
    ...(place.environmentId === undefined ? {} : { environmentId: place.environmentId }),
    expected,
    state: "executing",
    fingerprint: digest,
    fingerprintKeyId: keyId,
    result: null,
  });
  if (inserted === "exists") {
    const found = await findOperationByKey(tx, key);
    if (found === null) throw new Error("operation key exists but its row was not found");
    if (!sameIntent(deps.ring, found, request.intent)) throw new Refusal("idempotency_conflict");
    return found;
  }
  if (!deps.gateOpen()) throw new Refusal("quarantined");
  const code = await request.recheck(tx);
  if (code !== null) throw new Refusal(code);
  return null;
}

export async function issueRuntimeCredential(
  deps: RuntimeCredentialDeps,
  request: RuntimeIssueRequest,
): Promise<RuntimeIssueOutcome> {
  const { scope, actor } = request;
  const operationId = randomUUID() as OperationId;
  const credentialId = randomUUID() as CredentialId;
  // The one place the secret exists besides the answer.
  const clientSecret = mintSecret(RUNTIME_SECRET_PREFIX, credentialId);
  // Bound to its environment and its networks (D-81): a row changed later does not verify.
  const verifier = verifierOf(
    deps.verifierRing,
    clientSecret,
    runtimeBinding(scope, request.cidrs),
  );
  try {
    return await withTransaction(deps.pool, async (tx) => {
      const replay = await admit(tx, deps, request, scope, operationId, { credentialId });
      if (replay !== null) return { kind: "replay", operation: replay } as const;
      const ready = await tx.query<{ kv_ready: boolean }>(
        "SELECT kv_ready FROM app.environment WHERE organization_id = $1 AND id = $2",
        [scope.organizationId, scope.environmentId],
      );
      if (ready.rows[0]?.kv_ready !== true) throw new Refusal("state_conflict");
      await insertRuntimeCredential(tx, scope, {
        id: credentialId,
        name: request.name,
        operationId,
        ttlSeconds: request.ttlSeconds,
        issuedBy: actor.id,
        issuedByKind: actor.kind,
        verifier: verifier.digest,
        verifierKeyId: verifier.keyId,
        cidrs: request.cidrs,
      });
      const operation = await completeOperation(
        tx,
        operationId,
        { credentialId },
        LIMITS.operation.terminalRetentionDays,
      );
      await appendAudit(tx, {
        action: "credential.issue",
        actor,
        source: "api",
        organizationId: scope.organizationId,
        target: { kind: "environment", id: scope.environmentId },
        outcome: "success",
        requestId: request.requestId,
        operationId,
        details: {
          credentialId,
          nameLength: Array.from(request.name).length,
          ttlSeconds: request.ttlSeconds,
          kind: "runtime",
          cidrCount: request.cidrs.length,
        },
      });
      const credential = await findCredentialByOperation(tx, operationId);
      if (credential === null) throw new Error("the issued runtime credential was not found");
      return { kind: "issued", operation, credential, clientSecret } as const;
    });
  } catch (error) {
    return refusalOf(error);
  }
}

/**
 * P-189: one transaction. From its commit the product refuses the credential
 * and every token exchanged for it (the machine routes re-read this row). A
 * token already minted ends in OpenBao with its own lifetime, at most 15
 * minutes later: no accessor is stored, so none is revoked here.
 */
export async function revokeRuntimeCredential(
  deps: RuntimeCredentialDeps,
  request: RuntimeRevokeRequest,
): Promise<RuntimeRevokeOutcome> {
  const { scope, credentialId } = request;
  const operationId = randomUUID() as OperationId;
  try {
    return await withTransaction(deps.pool, async (tx) => {
      // P-118: a revocation reduces access; while a pair is captured it records that and proceeds.
      await invalidateCapture(tx, "credential_revoke");
      const replay = await admit(tx, deps, request, scope, operationId, { credentialId });
      if (replay !== null) return { kind: "replay", operation: replay } as const;
      const row = await lockCredential(tx, scope, credentialId, "update");
      // A token credential is never closed here: it has a token in OpenBao to prove gone.
      if (row?.kind !== "runtime") throw new Refusal("not_found");
      if (row.state !== "active" && row.state !== "expired") throw new Refusal("state_conflict");
      if (!(await moveCredential(tx, row.id, [row.state], "revoked"))) {
        throw new Refusal("state_conflict");
      }
      const operation = await completeOperation(
        tx,
        operationId,
        { credentialId, state: "revoked" },
        LIMITS.operation.terminalRetentionDays,
      );
      await appendAudit(tx, {
        action: "credential.revoke",
        actor: request.actor,
        source: "api",
        organizationId: scope.organizationId,
        target: { kind: "environment", id: scope.environmentId },
        outcome: "success",
        requestId: request.requestId,
        operationId,
        details: { credentialId },
      });
      return { kind: "revoked", operation } as const;
    });
  } catch (error) {
    return refusalOf(error);
  }
}
