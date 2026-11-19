// The organization's overview (Run 7.3, P-139): its projects, their
// environments and what the secret index counts for each, read by one
// statement, so every number is of one moment. Nothing here reads a value or
// asks OpenBao: the index is the one place counts exist without values.
import type pg from "pg";
import { withTransaction } from "../tx.ts";
import { AUDIT_READ_TIMEOUT_MS, AuditReadTimeout } from "./audit-read.ts";

export interface OverviewEnvironment {
  id: string;
  name: string;
  state: string;
  reviewReason: string | null;
  kvReady: boolean;
  /** Rows of the index by state; all zero for an environment the index holds nothing of. */
  live: number;
  deleted: number;
  needsReview: number;
  changedAt: Date | null;
}

export interface OverviewProject {
  id: string;
  name: string;
  state: string;
  reviewReason: string | null;
  environments: OverviewEnvironment[];
}

export interface Overview {
  /** The database's time of the read. */
  observedAt: Date;
  projects: OverviewProject[];
  /** The organization has more projects than `maxProjects`. */
  truncated: boolean;
}

interface Raw {
  project_id: string;
  project_name: string;
  project_state: string;
  project_review: string | null;
  environment_id: string | null;
  environment_name: string | null;
  environment_state: string | null;
  environment_review: string | null;
  kv_ready: boolean | null;
  live: string | null;
  deleted: string | null;
  needs_review: string | null;
  changed_at: Date | null;
}

const STATEMENT = `
  WITH p AS (
    SELECT id, name, state, review_reason
      FROM app.project
     WHERE organization_id = $1
     ORDER BY id
     LIMIT $2
  ), k AS (
    SELECT s.environment_id,
           count(*) FILTER (WHERE s.state = 'live') AS live,
           count(*) FILTER (WHERE s.state = 'deleted') AS deleted,
           count(*) FILTER (WHERE s.state = 'needs_review') AS needs_review,
           max(s.last_changed_at) AS changed_at
      FROM app.secret_index s
     WHERE s.organization_id = $1
     GROUP BY s.environment_id
  )
  SELECT p.id AS project_id, p.name AS project_name, p.state AS project_state,
         p.review_reason AS project_review,
         e.id AS environment_id, e.name AS environment_name, e.state AS environment_state,
         e.review_reason AS environment_review, e.kv_ready,
         k.live, k.deleted, k.needs_review, k.changed_at
    FROM p
    LEFT JOIN app.environment e ON e.organization_id = $1 AND e.project_id = p.id
    LEFT JOIN k ON k.environment_id = e.id
   ORDER BY p.id, e.id`;

/** Throws `AuditReadTimeout` when the read passes the statement deadline: the caller's `503 busy`. */
export async function readOverview(
  pool: pg.Pool,
  organizationId: string,
  maxProjects: number,
): Promise<Overview> {
  let read: { observedAt: Date; rows: Raw[] };
  try {
    read = await withTransaction(pool, async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = ${String(AUDIT_READ_TIMEOUT_MS)}`);
      // The transaction's own time: not later than the snapshot of the statement below.
      const now = await tx.query<{ now: Date }>("SELECT now() AS now");
      const rows = await tx.query<Raw>(STATEMENT, [organizationId, maxProjects + 1]);
      const observedAt = now.rows[0]?.now;
      if (observedAt === undefined) throw new Error("the database gave no time");
      return { observedAt, rows: rows.rows };
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === "57014") throw new AuditReadTimeout();
    throw error;
  }
  const projects: OverviewProject[] = [];
  for (const row of read.rows) {
    let project = projects.at(-1);
    if (project?.id !== row.project_id) {
      project = {
        id: row.project_id,
        name: row.project_name,
        state: row.project_state,
        reviewReason: row.project_review,
        environments: [],
      };
      projects.push(project);
    }
    if (row.environment_id === null) continue;
    project.environments.push({
      id: row.environment_id,
      name: row.environment_name ?? "",
      state: row.environment_state ?? "",
      reviewReason: row.environment_review,
      kvReady: row.kv_ready === true,
      live: Number(row.live ?? 0),
      deleted: Number(row.deleted ?? 0),
      needsReview: Number(row.needs_review ?? 0),
      changedAt: row.changed_at,
    });
  }
  const truncated = projects.length > maxProjects;
  return { observedAt: read.observedAt, projects: projects.slice(0, maxProjects), truncated };
}
