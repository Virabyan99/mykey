// The machine credential record (Run 5.1, P-86, Doc 06 §7.3). The token is
// never stored, not even encrypted; the accessor is the one handle a
// revocation is addressed to. Every check of a lifetime compares
// effective_expires_at with now() in the statement: a stored `active` past
// its expiry is expired, whatever the sweep has written yet.
import {
  LIMITS,
  type CredentialId,
  type EnvironmentId,
  type OperationId,
  type OrganizationId,
  type ProjectId,
  type UserId,
} from "@mykey/contracts";
import type pg from "pg";
import type { EnvironmentScope } from "../scope.ts";
import type { Queryable } from "../tx.ts";

export type CredentialState =
  "issuing" | "active" | "revoking" | "revoked" | "expired" | "needs_review";

export interface CredentialRow {
  id: CredentialId;
  organizationId: OrganizationId;
  projectId: ProjectId;
  environmentId: EnvironmentId;
  name: string;
  issuanceOperationId: OperationId;
  accessor: string | null;
  requestedExpiresAt: Date;
  effectiveExpiresAt: Date | null;
  state: CredentialState;
  issuedBy: UserId;
  /** The completion time of the issuance operation when it succeeded. */
  issuedAt: Date | null;
  lastUsedAt: Date | null;
  /** effective_expires_at <= now(), computed in the statement. */
  expired: boolean;
  /** Expires within LIMITS.machineToken.expiryWarningSeconds, in the statement. */
  expiringSoon: boolean;
}

interface StoredCredential {
  id: CredentialId;
  organization_id: OrganizationId;
  project_id: ProjectId;
  environment_id: EnvironmentId;
  name: string;
  issuance_operation_id: OperationId;
  accessor: string | null;
  requested_expires_at: Date;
  effective_expires_at: Date | null;
  state: CredentialState;
  issued_by: UserId;
  issued_at: Date | null;
  last_used_at: Date | null;
  expired: boolean;
  expiring_soon: boolean;
}

const WARNING = String(LIMITS.machineToken.expiryWarningSeconds);

/** The columns of a row as read; `c` is app.machine_credential, `o` its issuance operation. */
const COLUMNS = `c.id, c.organization_id, c.project_id, c.environment_id, c.name,
  c.issuance_operation_id, c.accessor, c.requested_expires_at, c.effective_expires_at, c.state,
  c.issued_by, c.last_used_at,
  CASE WHEN o.state = 'succeeded' THEN o.completed_at END AS issued_at,
  coalesce(c.effective_expires_at <= now(), false) AS expired,
  coalesce(c.effective_expires_at > now()
           AND c.effective_expires_at <= now() + make_interval(secs => ${WARNING}), false)
    AS expiring_soon`;
const FROM = `app.machine_credential c LEFT JOIN app.operation o ON o.id = c.issuance_operation_id`;

function toRow(stored: StoredCredential): CredentialRow {
  return {
    id: stored.id,
    organizationId: stored.organization_id,
    projectId: stored.project_id,
    environmentId: stored.environment_id,
    name: stored.name,
    issuanceOperationId: stored.issuance_operation_id,
    accessor: stored.accessor,
    requestedExpiresAt: stored.requested_expires_at,
    effectiveExpiresAt: stored.effective_expires_at,
    state: stored.state,
    issuedBy: stored.issued_by,
    issuedAt: stored.issued_at,
    lastUsedAt: stored.last_used_at,
    expired: stored.expired,
    expiringSoon: stored.expiring_soon,
  };
}

/**
 * The credential row `issuing` (P-86). `blocked`: the environment already has
 * an issuance that is unresolved (the partial unique index); nothing written.
 */
export async function insertIssuing(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
  c: {
    id: CredentialId;
    name: string;
    operationId: OperationId;
    ttlSeconds: number;
    issuedBy: UserId;
  },
): Promise<"inserted" | "blocked"> {
  const result = await tx.query(
    `INSERT INTO app.machine_credential
       (id, organization_id, project_id, environment_id, name, issuance_operation_id,
        requested_expires_at, state, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), 'issuing', $8)
     ON CONFLICT (environment_id) WHERE state IN ('issuing', 'needs_review') DO NOTHING`,
    [
      c.id,
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      c.name,
      c.operationId,
      c.ttlSeconds,
      c.issuedBy,
    ],
  );
  return result.rowCount === 1 ? "inserted" : "blocked";
}

/** The unresolved issuance of the environment, if any. */
export async function blockingIssuance(
  db: Queryable,
  scope: EnvironmentScope,
): Promise<{ credentialId: CredentialId; operationId: OperationId } | null> {
  const result = await db.query<{ id: CredentialId; issuance_operation_id: OperationId }>(
    `SELECT id, issuance_operation_id FROM app.machine_credential
      WHERE organization_id = $1 AND environment_id = $2 AND state IN ('issuing', 'needs_review')`,
    [scope.organizationId, scope.environmentId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { credentialId: row.id, operationId: row.issuance_operation_id };
}

/** issuing → active with its accessor and the backend's expiry. False: nothing changed. */
export async function activateCredential(
  tx: pg.PoolClient,
  id: CredentialId,
  v: { accessor: string; effectiveExpiresAt: Date },
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.machine_credential
        SET state = 'active', accessor = $2, effective_expires_at = $3
      WHERE id = $1 AND state = 'issuing'`,
    [id, v.accessor, v.effectiveExpiresAt],
  );
  return result.rowCount === 1;
}

/** One conditional update: `from` → `to`, the accessor stored when given. False: nothing changed. */
export async function moveCredential(
  tx: Queryable,
  id: CredentialId,
  from: readonly CredentialState[],
  to: CredentialState,
  accessor?: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.machine_credential
        SET state = $3, accessor = coalesce($4, accessor)
      WHERE id = $1 AND state = ANY($2::text[])`,
    [id, [...from], to, accessor ?? null],
  );
  return result.rowCount === 1;
}

export async function lockCredential(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
  id: CredentialId,
  mode: "update" | "share",
): Promise<CredentialRow | null> {
  const result = await tx.query<StoredCredential>(
    `SELECT ${COLUMNS} FROM ${FROM}
      WHERE c.organization_id = $1 AND c.environment_id = $2 AND c.id = $3
      ${mode === "update" ? "FOR UPDATE OF c" : "FOR SHARE OF c"}`,
    [scope.organizationId, scope.environmentId, id],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toRow(stored);
}

export async function findCredentialByAccessor(
  db: Queryable,
  organizationId: OrganizationId,
  accessor: string,
): Promise<CredentialRow | null> {
  const result = await db.query<StoredCredential>(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE c.organization_id = $1 AND c.accessor = $2`,
    [organizationId, accessor],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toRow(stored);
}

export async function findCredentialByOperation(
  db: Queryable,
  operationId: OperationId,
): Promise<CredentialRow | null> {
  const result = await db.query<StoredCredential>(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE c.issuance_operation_id = $1`,
    [operationId],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toRow(stored);
}

/**
 * The inventory of one environment, newest issuance first (P-86). A row that
 * is `revoked` with no accessor was never a token and is not listed. Paged as
 * listOperations: `anchor` (microseconds since the epoch of the first page's
 * first issuance) bounds every later page; `after` is the previous page's
 * last sort key "<micros>|<id>".
 */
export async function listCredentials(
  db: Queryable,
  scope: EnvironmentScope,
  page: { anchor: string | null; after: string | null; limit: number },
): Promise<(CredentialRow & { sortKey: string })[]> {
  const [afterMicros, afterId] = page.after === null ? [null, null] : page.after.split("|");
  const result = await db.query<StoredCredential & { sort_key: string }>(
    `SELECT ${COLUMNS},
            (extract(epoch FROM o.created_at) * 1000000)::bigint::text || '|' || c.id AS sort_key
       FROM app.machine_credential c JOIN app.operation o ON o.id = c.issuance_operation_id
      WHERE c.organization_id = $1 AND c.environment_id = $2
        AND NOT (c.state = 'revoked' AND c.accessor IS NULL)
        AND ($3::bigint IS NULL
             OR o.created_at <= 'epoch'::timestamptz + $3::bigint * interval '1 microsecond')
        AND ($4::bigint IS NULL
             OR (o.created_at, c.id) < ('epoch'::timestamptz + $4::bigint * interval '1 microsecond',
                                        $5::uuid))
      ORDER BY o.created_at DESC, c.id DESC
      LIMIT $6`,
    [
      scope.organizationId,
      scope.environmentId,
      page.anchor,
      afterMicros ?? null,
      afterId ?? null,
      page.limit,
    ],
  );
  return result.rows.map((stored) => ({ ...toRow(stored), sortKey: stored.sort_key }));
}

/** last_used_at = now(), at most once a minute per credential (Run 5.4). */
export async function touchLastUsed(db: Queryable, id: CredentialId): Promise<void> {
  await db.query(
    `UPDATE app.machine_credential SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [id],
  );
}
