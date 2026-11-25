// Archive and reactivation (Run 5.3, P-91, P-92, D-41): every state change of
// a project or an environment goes through app.lifecycle_transition
// (migration 0014), one guarded update per step.
import type {
  CredentialId,
  EnvironmentId,
  OperationId,
  OrganizationId,
  ProjectId,
} from "@mykey/contracts";
import type { EnvironmentScope } from "../scope.ts";
import type { Queryable } from "../tx.ts";
import { OPERATION_COLUMNS, toOperationRow, type OperationRow } from "./operations.ts";

export type LifecycleStep = "begin_archive" | "finish_archive" | "reactivate";

/** One step; false: its guard did not hold and nothing changed. */
export async function lifecycleTransition(
  tx: Queryable,
  t: {
    kind: "project" | "environment";
    organizationId: OrganizationId;
    id: string;
    operationId: OperationId;
    step: LifecycleStep;
    origin?: "self" | "project";
  },
): Promise<boolean> {
  const result = await tx.query<{ moved: boolean }>(
    "SELECT app.lifecycle_transition($1, $2, $3, $4, $5, $6) AS moved",
    [t.kind, t.organizationId, t.id, t.operationId, t.step, t.origin ?? null],
  );
  return result.rows[0]?.moved === true;
}

export const ARCHIVE_ACTIONS = ["projects.archive", "environments.archive"] as const;

/** What an archive operation covers, read from the rows: a project's every environment, whatever its state. */
export async function archiveScope(
  db: Queryable,
  operationId: OperationId,
): Promise<{
  kind: "project" | "environment";
  organizationId: OrganizationId;
  id: string;
  state: string;
  environments: (EnvironmentScope & { lockKey: bigint })[];
} | null> {
  const op = await db.query<{
    action: string;
    organization_id: OrganizationId;
    project_id: ProjectId;
    environment_id: EnvironmentId | null;
    state: string;
  }>(
    `SELECT action, organization_id, project_id, environment_id, state FROM app.operation
      WHERE id = $1 AND action = ANY($2::text[])`,
    [operationId, [...ARCHIVE_ACTIONS]],
  );
  const row = op.rows[0];
  if (row === undefined) return null;
  const kind = row.action === "projects.archive" ? "project" : "environment";
  const environments = await db.query<{ id: EnvironmentId; lock_key: string }>(
    `SELECT id, lock_key FROM app.environment
      WHERE organization_id = $1 AND project_id = $2 AND ($3::uuid IS NULL OR id = $3)
      ORDER BY id`,
    [row.organization_id, row.project_id, kind === "environment" ? row.environment_id : null],
  );
  return {
    kind,
    organizationId: row.organization_id,
    id: kind === "project" ? row.project_id : (row.environment_id as string),
    state: row.state,
    environments: environments.rows.map((env) => ({
      organizationId: row.organization_id,
      projectId: row.project_id,
      environmentId: env.id,
      lockKey: BigInt(env.lock_key),
    })),
  };
}

/**
 * Every active or expired credential of the environment is closed. A token
 * goes to `revoking`: OpenBao must still prove it gone. A runtime credential
 * (Session 11) holds nothing in OpenBao and is `revoked` here, in PostgreSQL
 * alone. Answers how many moved, by where they went.
 */
export async function closeCredentials(
  tx: Queryable,
  scope: EnvironmentScope,
): Promise<{ revoking: number; revoked: number }> {
  const runtime = await tx.query(
    `UPDATE app.machine_credential SET state = 'revoked'
      WHERE organization_id = $1 AND environment_id = $2 AND state IN ('active', 'expired')
        AND kind = 'runtime'`,
    [scope.organizationId, scope.environmentId],
  );
  const tokens = await tx.query(
    `UPDATE app.machine_credential SET state = 'revoking'
      WHERE organization_id = $1 AND environment_id = $2 AND state IN ('active', 'expired')
        AND kind = 'token'`,
    [scope.organizationId, scope.environmentId],
  );
  return { revoking: tokens.rowCount ?? 0, revoked: runtime.rowCount ?? 0 };
}

/** What still keeps an archive from finishing in one environment. */
export async function openCredentialWork(
  db: Queryable,
  scope: EnvironmentScope,
): Promise<{ revoking: { id: CredentialId; accessor: string | null }[]; blocking: number }> {
  const rows = await db.query<{ id: CredentialId; accessor: string | null; state: string }>(
    `SELECT id, accessor, state FROM app.machine_credential
      WHERE organization_id = $1 AND environment_id = $2 AND state <> 'revoked'
      ORDER BY id`,
    [scope.organizationId, scope.environmentId],
  );
  return {
    revoking: rows.rows
      .filter((r) => r.state === "revoking")
      .map(({ id, accessor }) => ({ id, accessor })),
    blocking: rows.rows.filter((r) => r.state !== "revoking").length,
  };
}

/**
 * The finish of an archive operation (P-91): executing → succeeded with its
 * result. No boot-id condition — two processes may drive one archive; the
 * first finish wins and the other changes nothing (null).
 */
export async function finishArchiveOperation(
  tx: Queryable,
  operationId: OperationId,
  result: Record<string, unknown>,
  retentionDays: number,
): Promise<OperationRow | null> {
  const updated = await tx.query<Parameters<typeof toOperationRow>[0]>(
    `UPDATE app.operation
        SET state = 'succeeded', result = $2::jsonb, completed_at = now(),
            replay_expires_at = now() + make_interval(days => $3), executor_boot_id = NULL
      WHERE id = $1 AND state = 'executing' AND action = ANY($4::text[])
      RETURNING ${OPERATION_COLUMNS}`,
    [operationId, JSON.stringify(result), retentionDays, [...ARCHIVE_ACTIONS]],
  );
  const stored = updated.rows[0];
  return stored === undefined ? null : toOperationRow(stored);
}
