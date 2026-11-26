// The exchange of a runtime credential (Session 11, Run 11.3; P-187, D-81).
// The pipeline has verified the client secret and admitted the credential;
// this mints the token it is exchanged for and commits the audit row before
// the token leaves.
//
// An exchange changes no product state. The token is minted by the issuer from
// the environment's fixed machine role, as a 30-day token is (D-17), but for
// 900 seconds, and nothing of it is stored: no row, no accessor, no operation.
// It is attributed later by the `meta` given here (P-188). So no outcome can
// block anything: a create whose answer is unclear is `dependency_unavailable`,
// the caller exchanges again, and a token nobody received ends by itself.
//
// The token is a local of this function and of the handler that answers.
import { randomUUID } from "node:crypto";
import { AuditUnavailable, appendAudit } from "@mykey/audit";
import { LIMITS, type CredentialId, type ErrorCode } from "@mykey/contracts";
import { withTransaction, type EnvironmentScope } from "@mykey/db";
import { machineName, namespaceFor } from "@mykey/openbao";
import type pg from "pg";
import type { IssuerBao, IssuerSession } from "../runtime.ts";
import { checkIssuedToken, revokeAndVerify } from "./verify.ts";

export const EXCHANGE_FAULT_POINTS = ["after_create_sent"] as const;
export type ExchangeFaultPoint = (typeof EXCHANGE_FAULT_POINTS)[number];

/** The `meta` of an exchanged token: what attributes it to its credential (P-188). */
export function exchangeMeta(credentialId: CredentialId): Record<string, string> {
  return { credential_id: credentialId, exchange: "1" };
}

export interface ExchangeDeps {
  pool: pg.Pool;
  issuer: IssuerBao;
  /** Tests only: the answer of the create is lost. */
  faults?: (point: ExchangeFaultPoint) => void | Promise<void>;
}

export interface ExchangeRequest {
  scope: EnvironmentScope;
  /** The runtime credential the pipeline admitted. */
  credentialId: CredentialId;
  requestId: string;
}

export type ExchangeOutcome =
  { kind: "exchanged"; token: string; expiresAt: Date } | { kind: "refused"; code: ErrorCode };

const refused = (code: ErrorCode): ExchangeOutcome => ({ kind: "refused", code });

/** The credential stopped being usable between the pipeline's read and the audit row. */
class Gone extends Error {}

export async function exchangeRuntimeCredential(
  deps: ExchangeDeps,
  request: ExchangeRequest,
): Promise<ExchangeOutcome> {
  const opened = await deps.issuer.open(request.scope.organizationId);
  if (opened === null) return refused("dependency_unavailable");
  if (!opened.ok) {
    return refused(opened.kind === "sealed" ? "backend_sealed" : "dependency_unavailable");
  }
  const session = opened.data;
  try {
    return await withSession(deps, request, session);
  } finally {
    await session.close();
  }
}

async function withSession(
  deps: ExchangeDeps,
  request: ExchangeRequest,
  session: IssuerSession,
): Promise<ExchangeOutcome> {
  const { scope, credentialId } = request;
  const role = machineName(scope.environmentId);
  const ttlSeconds = LIMITS.runtimeCredential.exchangeTtlSeconds;
  const meta = exchangeMeta(credentialId);
  const correlation = () => ({ operationId: request.requestId, dispatchId: randomUUID() });

  const created = await session.client.tokenCreateFromRole(role, ttlSeconds, correlation(), meta);
  try {
    await deps.faults?.("after_create_sent");
  } catch {
    // The answer of the create never arrived. Whether a token exists is not
    // known and does not matter: nobody holds it, and it ends within the TTL.
    return refused("dependency_unavailable");
  }
  if (!created.ok) {
    return refused(created.kind === "sealed" ? "backend_sealed" : "dependency_unavailable");
  }
  const { token, accessor } = created.data;
  /** The token never leaves: it is revoked when that works, and ends by itself when not. */
  const drop = async (): Promise<void> => {
    await revokeAndVerify(session, accessor, correlation()).catch(() => undefined);
  };

  // The token is checked as an issuance checks it: exactly the role's policy,
  // not renewable, an orphan, its meta, and no longer than was asked.
  const lookup = await session.client.tokenLookupAccessor(accessor);
  if (!lookup.ok) {
    await drop();
    return refused(lookup.kind === "sealed" ? "backend_sealed" : "dependency_unavailable");
  }
  const fault = checkIssuedToken(lookup.data, {
    role,
    ttlSeconds,
    meta,
    namespace: namespaceFor(scope.organizationId),
  });
  const expiresAt = lookup.data.expireTime === null ? null : new Date(lookup.data.expireTime);
  if (fault !== null || expiresAt === null || Number.isNaN(expiresAt.getTime())) {
    await drop();
    return refused("backend_inconsistent");
  }

  // The audit row is committed before the token leaves. In the same
  // transaction the credential is read again under a share lock: a revocation
  // either committed before this read, and no token leaves, or it waits for
  // this commit, and the product refuses the token from then on.
  try {
    await withTransaction(deps.pool, async (tx) => {
      const row = await tx.query<{ state: string; live: boolean }>(
        `SELECT state, coalesce(effective_expires_at > now(), false) AS live
           FROM app.machine_credential WHERE id = $1 AND kind = 'runtime' FOR SHARE`,
        [credentialId],
      );
      if (row.rows[0]?.state !== "active" || !row.rows[0].live) throw new Gone();
      await appendAudit(tx, {
        action: "machine.exchange",
        actor: { kind: "machine", id: credentialId },
        source: "api",
        organizationId: scope.organizationId,
        target: { kind: "environment", id: scope.environmentId },
        outcome: "success",
        requestId: request.requestId,
        operationId: null,
        details: { credentialId, ttlSeconds },
      });
    });
  } catch (error) {
    await drop();
    if (error instanceof Gone) return refused("unauthenticated");
    if (error instanceof AuditUnavailable) return refused("audit_unavailable");
    throw error;
  }
  return { kind: "exchanged", token, expiresAt };
}
