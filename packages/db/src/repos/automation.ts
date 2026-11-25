// The automation credential record (Session 11, Run 11.5; P-185, P-191 to
// P-193, D-82). What a provisioner presents: a row with the verifier of its
// secret, its rights, the networks it may be used from, and the chain it
// belongs to (`owner_id`: the first credential of the chain, its own id when
// it replaces none). The secret is never stored. A lifetime is compared with
// now() in the statement: a stored `active` past its expiry is expired.
import {
  LIMITS,
  type AutomationRight,
  type OperationId,
  type OrganizationId,
  type UserId,
} from "@mykey/contracts";
import type pg from "pg";
import type { Queryable } from "../tx.ts";
import type { Resolved } from "./memberships.ts";

export interface AutomationCredentialRow {
  id: string;
  organizationId: OrganizationId;
  /** The chain: the id of its first credential (P-193). */
  ownerId: string;
  name: string;
  rights: AutomationRight[];
  boundCidrs: string[];
  state: "active" | "revoked";
  issuedBy: UserId;
  issuanceOperationId: OperationId;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** expires_at <= now(), computed in the statement. */
  expired: boolean;
  /** Active, and in its last seven days or the last quarter of its life, whichever is shorter. */
  expiringSoon: boolean;
  /** How many projects its chain manages. */
  managedProjects: number;
}

interface Stored {
  id: string;
  organization_id: OrganizationId;
  owner_id: string;
  name: string;
  rights: AutomationRight[];
  bound_cidrs: string[];
  state: "active" | "revoked";
  issued_by: UserId;
  issuance_operation_id: OperationId;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expired: boolean;
  expiring_soon: boolean;
  managed_projects: number;
}

const WARNING = String(LIMITS.machineToken.expiryWarningSeconds);

/**
 * The columns of a row as read; `a` is app.automation_credential. A week is
 * the default lifetime and the warning of a machine token: a credential with
 * a short life warns in its last quarter, or it would warn from its first day.
 */
const COLUMNS = `a.id, a.organization_id, a.owner_id, a.name, a.rights, a.bound_cidrs, a.state,
  a.issued_by, a.issuance_operation_id, a.created_at, a.expires_at, a.last_used_at, a.revoked_at,
  a.expires_at <= now() AS expired,
  (a.state = 'active' AND a.expires_at > now()
   AND a.expires_at <= now() + least(make_interval(secs => ${WARNING}),
                                     (a.expires_at - a.created_at) / 4)) AS expiring_soon,
  (SELECT count(*)::int FROM app.project p
    WHERE p.organization_id = a.organization_id AND p.managed_by = a.owner_id) AS managed_projects`;

function toRow(stored: Stored): AutomationCredentialRow {
  return {
    id: stored.id,
    organizationId: stored.organization_id,
    ownerId: stored.owner_id,
    name: stored.name,
    rights: stored.rights,
    boundCidrs: stored.bound_cidrs,
    state: stored.state,
    issuedBy: stored.issued_by,
    issuanceOperationId: stored.issuance_operation_id,
    createdAt: stored.created_at,
    expiresAt: stored.expires_at,
    lastUsedAt: stored.last_used_at,
    revokedAt: stored.revoked_at,
    expired: stored.expired,
    expiringSoon: stored.expiring_soon,
    managedProjects: stored.managed_projects,
  };
}

/** The row `active`, expiring `ttlSeconds` from the database's now. */
export async function insertAutomationCredential(
  tx: pg.PoolClient,
  organizationId: string,
  c: {
    id: string;
    ownerId: string;
    name: string;
    rights: readonly AutomationRight[];
    cidrs: readonly string[];
    verifier: Buffer;
    verifierKeyId: string;
    ttlSeconds: number;
    issuedBy: string;
    operationId: OperationId;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO app.automation_credential
       (id, organization_id, owner_id, name, rights, bound_cidrs, verifier, verifier_key_id,
        state, expires_at, issued_by, issuance_operation_id)
     VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8, 'active',
             now() + make_interval(secs => $9), $10, $11)`,
    [
      c.id,
      organizationId,
      c.ownerId,
      c.name,
      [...c.rights],
      [...c.cidrs],
      c.verifier,
      c.verifierKeyId,
      c.ttlSeconds,
      c.issuedBy,
      c.operationId,
    ],
  );
}

export async function findAutomationCredential(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<AutomationCredentialRow | null> {
  const result = await db.query<Stored>(
    `SELECT ${COLUMNS} FROM app.automation_credential a
      WHERE a.organization_id = $1 AND a.id = $2`,
    [organizationId, id],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toRow(stored);
}

export async function findAutomationCredentialByOperation(
  db: Queryable,
  operationId: OperationId,
): Promise<AutomationCredentialRow | null> {
  const result = await db.query<Stored>(
    `SELECT ${COLUMNS} FROM app.automation_credential a WHERE a.issuance_operation_id = $1`,
    [operationId],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toRow(stored);
}

/**
 * The chain of a credential, with the row locked FOR SHARE until the
 * transaction ends; null when the organization has no such credential.
 */
export async function chainOf(
  tx: pg.PoolClient,
  organizationId: string,
  id: string,
): Promise<string | null> {
  const result = await tx.query<{ owner_id: string }>(
    `SELECT owner_id FROM app.automation_credential
      WHERE organization_id = $1 AND id = $2 FOR SHARE`,
    [organizationId, id],
  );
  return result.rows[0]?.owner_id ?? null;
}

/** The row's state, locked FOR UPDATE; null when the organization has no such credential. */
export async function lockAutomationCredential(
  tx: pg.PoolClient,
  organizationId: string,
  id: string,
): Promise<{ id: string; state: "active" | "revoked" } | null> {
  const result = await tx.query<{ id: string; state: "active" | "revoked" }>(
    `SELECT id, state FROM app.automation_credential
      WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [organizationId, id],
  );
  return result.rows[0] ?? null;
}

/** active → revoked; false when the row was not active. */
export async function revokeAutomationCredentialRow(
  tx: pg.PoolClient,
  id: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.automation_credential SET state = 'revoked', revoked_at = now()
      WHERE id = $1 AND state = 'active'`,
    [id],
  );
  return result.rowCount === 1;
}

/** How many projects a chain manages. */
export async function managedProjectCount(
  db: Queryable,
  organizationId: string,
  ownerId: string,
): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM app.project
      WHERE organization_id = $1 AND managed_by = $2`,
    [organizationId, ownerId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * The organization's automation credentials, newest first. Paged as
 * listCredentials: `anchor` (microseconds since the epoch of the first page's
 * first row) bounds every later page; `after` is the previous page's last
 * sort key "<micros>|<id>".
 */
export async function listAutomationCredentials(
  db: Queryable,
  organizationId: string,
  page: { anchor: string | null; after: string | null; limit: number },
): Promise<(AutomationCredentialRow & { sortKey: string })[]> {
  const [afterMicros, afterId] = page.after === null ? [null, null] : page.after.split("|");
  const result = await db.query<Stored & { sort_key: string }>(
    `SELECT ${COLUMNS},
            (extract(epoch FROM a.created_at) * 1000000)::bigint::text || '|' || a.id AS sort_key
       FROM app.automation_credential a
      WHERE a.organization_id = $1
        AND ($2::bigint IS NULL
             OR a.created_at <= 'epoch'::timestamptz + $2::bigint * interval '1 microsecond')
        AND ($3::bigint IS NULL
             OR (a.created_at, a.id) < ('epoch'::timestamptz + $3::bigint * interval '1 microsecond',
                                        $4::uuid))
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $5`,
    [organizationId, page.anchor, afterMicros ?? null, afterId ?? null, page.limit],
  );
  return result.rows.map((stored) => ({ ...toRow(stored), sortKey: stored.sort_key }));
}

/** What authentication reads (Run 11.5 Task B): the row with its verifier, never shown. */
export interface AutomationAuthRow {
  id: string;
  ownerId: string;
  rights: AutomationRight[];
  boundCidrs: string[];
  verifier: Buffer;
  verifierKeyId: string;
  state: "active" | "revoked";
  /** expires_at > now(), on database time. */
  live: boolean;
}

/** `id` must be a UUID (the presented secret's shape says so). */
export async function findAutomationForAuth(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<AutomationAuthRow | null> {
  const result = await db.query<{
    id: string;
    owner_id: string;
    rights: AutomationRight[];
    bound_cidrs: string[];
    verifier: Buffer;
    verifier_key_id: string;
    state: "active" | "revoked";
    live: boolean;
  }>(
    `SELECT id, owner_id, rights, bound_cidrs, verifier, verifier_key_id, state,
            expires_at > now() AS live
       FROM app.automation_credential
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, id],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    rights: row.rights,
    boundCidrs: row.bound_cidrs,
    verifier: row.verifier,
    verifierKeyId: row.verifier_key_id,
    state: row.state,
    live: row.live,
  };
}

/** The credential as it is now, for the admission recheck: its state, expiry, chain and rights. */
export async function automationCredentialNow(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<{
  state: "active" | "revoked";
  live: boolean;
  ownerId: string;
  rights: AutomationRight[];
} | null> {
  const row = await findAutomationForAuth(db, organizationId, id);
  return row === null
    ? null
    : { state: row.state, live: row.live, ownerId: row.ownerId, rights: row.rights };
}

/** At most once a minute per credential. */
export async function touchAutomationCredential(db: Queryable, id: string): Promise<void> {
  await db.query(
    `UPDATE app.automation_credential SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [id],
  );
}

/** True when `credentialId` is a credential of the chain `ownerId` in this organization. */
export async function chainHasCredential(
  db: Queryable,
  organizationId: string,
  ownerId: string,
  credentialId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM app.automation_credential
      WHERE organization_id = $1 AND owner_id = $2 AND id::text = $3`,
    [organizationId, ownerId, credentialId],
  );
  return result.rowCount === 1;
}

/**
 * The states an automation request is decided on (P-53), read in one
 * statement: the organization, the project only when the chain `ownerId`
 * manages it, and the environment only when it belongs to that project. A
 * project of another chain, of the owner or of nobody reads as absent. The
 * ids must be UUIDs. `authority` is null: a credential has rights, not a role.
 */
export async function resolveManaged(
  db: Queryable,
  organizationId: string,
  ownerId: string,
  ids: { projectId?: string; environmentId?: string },
): Promise<Resolved> {
  const result = await db.query<{
    org_state: string;
    org_reason: string | null;
    project_state: string | null;
    project_reason: string | null;
    env_state: string | null;
    env_reason: string | null;
    kv_ready: boolean | null;
  }>(
    `SELECT o.state AS org_state, o.review_reason AS org_reason,
            p.state AS project_state, p.review_reason AS project_reason,
            e.state AS env_state, e.review_reason AS env_reason, e.kv_ready
       FROM app.organization o
       LEFT JOIN app.project p
         ON p.organization_id = o.id AND p.id = $3::uuid AND p.managed_by = $2::uuid
       LEFT JOIN app.environment e
         ON e.organization_id = o.id AND e.project_id = p.id AND e.id = $4::uuid
      WHERE o.id = $1`,
    [organizationId, ownerId, ids.projectId ?? null, ids.environmentId ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return { authority: null, organization: null, project: null, environment: null };
  }
  return {
    authority: null,
    organization: { state: row.org_state, reviewReason: row.org_reason },
    project:
      row.project_state === null
        ? null
        : { state: row.project_state, reviewReason: row.project_reason },
    environment:
      row.env_state === null
        ? null
        : { state: row.env_state, reviewReason: row.env_reason, kvReady: row.kv_ready === true },
  };
}
