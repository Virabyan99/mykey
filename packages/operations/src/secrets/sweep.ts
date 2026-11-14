// The stale-work sweep (Run 4.5, P-69, Doc 06 §6.2 step 6). One conditional
// update per rule; each also clears `executor_boot_id`, so the executor that
// comes back late can neither finalize (finishOperation) nor dispatch
// (claimDispatch). Two sweepers at once: the row lock lets one update a row,
// the other's re-checked condition no longer holds — one audit row each.
//
// - executing, heartbeat older than 120 s → uncertain: the change may have
//   been sent. The key goes to review, the slot stays, `system.operation_stuck`.
// - accepted, heartbeat older than 120 s → rejected (dependency_unavailable):
//   no dispatch marker was written, so nothing was sent (D-20). The slot is
//   released and the action's own audit row records the failure.
//
// - an import parent (Run 4.7), executing with a stale heartbeat → uncertain
//   when one of its children is unresolved, otherwise awaiting_input (the
//   owner resumes it).
// - an import preview that expired unclaimed, or whose import has finished, is
//   removed (Run 4.7).
//
// It touches PostgreSQL only: it works while OpenBao is unreachable.
import { appendAudit, type AuditAction } from "@mykey/audit";
import {
  LIMITS,
  type EnvironmentId,
  type OperationId,
  type OrganizationId,
  type ProjectId,
} from "@mykey/contracts";
import { deleteDeadPreviews, markKeyReview, releaseSlot, withTransaction } from "@mykey/db";
import type pg from "pg";

/** The secret actions the sweep owns (the operation's action is the route id). */
export const SWEPT_ACTIONS: Readonly<Record<string, AuditAction>> = {
  "secrets.create": "secret.create",
  "secrets.update": "secret.update",
  "secrets.delete": "secret.delete",
  "secrets.undelete": "secret.undelete",
  "secrets.restore": "secret.restore",
};

interface Swept {
  id: OperationId;
  organization_id: OrganizationId;
  project_id: ProjectId;
  environment_id: EnvironmentId;
  secret_name: string;
  action: string;
  principal_kind: "user" | "machine" | "operator" | "system";
  principal_id: string;
}

const RETURNING = `RETURNING id, organization_id, project_id, environment_id, secret_name, action,
  principal_kind, principal_id`;

export interface SweepResult {
  uncertain: OperationId[];
  rejected: OperationId[];
  /** Import parents left to their owner's resume (Run 4.7). */
  awaitingInput: OperationId[];
  /** Import previews removed: expired and unclaimed, or claimed by a finished import (Run 4.7). */
  previewsRemoved: number;
}

export async function sweepStaleOperations(
  pool: pg.Pool,
  opts: { staleSeconds?: number } = {},
): Promise<SweepResult> {
  const staleSeconds = opts.staleSeconds ?? LIMITS.operation.stuckAlertSeconds;
  const actions = Object.keys(SWEPT_ACTIONS);

  const uncertain = await withTransaction(pool, async (tx) => {
    const rows = await tx.query<Swept>(
      `UPDATE app.operation SET state = 'uncertain', executor_boot_id = NULL
        WHERE action = ANY($1::text[]) AND state = 'executing'
          AND heartbeat_at < now() - make_interval(secs => $2)
        ${RETURNING}`,
      [actions, staleSeconds],
    );
    for (const row of rows.rows) {
      const scope = {
        organizationId: row.organization_id,
        projectId: row.project_id,
        environmentId: row.environment_id,
      };
      await markKeyReview(tx, scope, row.secret_name, row.id);
      await appendAudit(tx, {
        action: "system.operation_stuck",
        actor: { kind: "system", id: null },
        source: "api",
        organizationId: row.organization_id,
        target: { kind: "environment", id: row.environment_id },
        outcome: "unknown",
        requestId: null,
        operationId: row.id,
        details: { action: row.action, name: row.secret_name },
      });
    }
    return rows.rows.map((row) => row.id);
  });

  const rejected = await withTransaction(pool, async (tx) => {
    const rows = await tx.query<Swept>(
      `UPDATE app.operation
          SET state = 'rejected', error_code = 'dependency_unavailable', executor_boot_id = NULL,
              completed_at = now(), replay_expires_at = now() + make_interval(days => $3)
        WHERE action = ANY($1::text[]) AND state = 'accepted'
          AND heartbeat_at < now() - make_interval(secs => $2)
        ${RETURNING}`,
      [actions, staleSeconds, LIMITS.operation.terminalRetentionDays],
    );
    for (const row of rows.rows) {
      await releaseSlot(tx, row.id);
      await tx.query("UPDATE app.operation_step SET outcome = 'rejected' WHERE operation_id = $1", [
        row.id,
      ]);
      await appendAudit(tx, {
        action: SWEPT_ACTIONS[row.action] ?? "secret.update",
        actor: {
          kind: row.principal_kind === "user" ? "user" : "system",
          id: row.principal_kind === "user" ? row.principal_id : null,
        },
        source: "api",
        organizationId: row.organization_id,
        target: { kind: "environment", id: row.environment_id },
        outcome: "failure",
        requestId: null,
        operationId: row.id,
        details: { name: row.secret_name },
      });
    }
    return rows.rows.map((row) => row.id);
  });

  // Import parents (Run 4.7), after their children: uncertain when a child may
  // still have changed something, else waiting for the owner's resume.
  const parents = await withTransaction(pool, async (tx) => {
    const rows = await tx.query<{
      id: OperationId;
      organization_id: OrganizationId;
      environment_id: EnvironmentId;
      state: "uncertain" | "awaiting_input";
    }>(
      `UPDATE app.operation p
          SET state = CASE WHEN EXISTS (
                SELECT 1 FROM app.operation c
                 WHERE c.parent_operation_id = p.id AND c.completed_at IS NULL
                   AND c.state IN ('uncertain', 'accepted', 'executing'))
              THEN 'uncertain' ELSE 'awaiting_input' END,
              executor_boot_id = NULL
        WHERE p.action = 'import.apply' AND p.state = 'executing'
          AND p.heartbeat_at < now() - make_interval(secs => $1)
        RETURNING p.id, p.organization_id, p.environment_id, p.state`,
      [staleSeconds],
    );
    for (const row of rows.rows) {
      if (row.state !== "uncertain") continue;
      // The entry of the uncertain child records it, as when the import stops by itself.
      await tx.query(
        `UPDATE app.import_entry e SET outcome = 'uncertain', child_operation_id = c.id
           FROM app.operation c
          WHERE c.parent_operation_id = $1 AND c.state = 'uncertain' AND c.completed_at IS NULL
            AND e.parent_operation_id = $1 AND e.name = c.secret_name AND e.outcome IS NULL`,
        [row.id],
      );
      await appendAudit(tx, {
        action: "system.operation_stuck",
        actor: { kind: "system", id: null },
        source: "api",
        organizationId: row.organization_id,
        target: { kind: "environment", id: row.environment_id },
        outcome: "unknown",
        requestId: null,
        operationId: row.id,
        details: { action: "import.apply" },
      });
    }
    return rows.rows;
  });

  const previewsRemoved = await deleteDeadPreviews(pool);

  return {
    uncertain: [
      ...uncertain,
      ...parents.filter((row) => row.state === "uncertain").map((row) => row.id),
    ],
    rejected,
    awaitingInput: parents.filter((row) => row.state === "awaiting_input").map((row) => row.id),
    previewsRemoved,
  };
}
