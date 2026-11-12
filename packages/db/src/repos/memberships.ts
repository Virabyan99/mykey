// The caller's authority over one organization and the states of the resources
// a request names (Run 3.7, P-52). Read from current rows on every request in
// one statement: there is no cache, so a revoked membership or a removed grant
// takes effect on the very next request.
import type { Authority, GrantRole, Role, UserId } from "@mykey/contracts";
import type { Queryable } from "../tx.ts";

export interface ResourceState {
  state: string;
  reviewReason: string | null;
}

export interface Resolved {
  /** Null when the user has no active membership of the organization. */
  authority: Authority | null;
  organization: ResourceState | null;
  /** Null when no project of that id belongs to the organization (or none was named). */
  project: ResourceState | null;
  /** Null when no environment of that id belongs to the project (or none was named). */
  environment: (ResourceState & { kvReady: boolean }) | null;
}

interface GrantRow {
  projectId: string | null;
  environmentId: string | null;
  environmentProjectId: string | null;
  role: GrantRole;
}

interface Row {
  role: Role | null;
  org_state: string | null;
  org_reason: string | null;
  project_state: string | null;
  project_reason: string | null;
  env_state: string | null;
  env_reason: string | null;
  kv_ready: boolean | null;
  grants: GrantRow[];
}

const RESOLVE = `
WITH member AS (
  SELECT role FROM app.membership
   WHERE organization_id = $1 AND user_id = $2 AND state = 'active'
)
SELECT (SELECT role FROM member) AS role,
       o.state AS org_state, o.review_reason AS org_reason,
       p.state AS project_state, p.review_reason AS project_reason,
       e.state AS env_state, e.review_reason AS env_reason, e.kv_ready,
       (SELECT coalesce(json_agg(json_build_object(
                 'projectId', g.project_id, 'environmentId', g.environment_id,
                 'environmentProjectId', ge.project_id, 'role', g.role)), '[]'::json)
          FROM app.access_grant g
          LEFT JOIN app.environment ge
            ON ge.organization_id = g.organization_id AND ge.id = g.environment_id
         WHERE g.organization_id = $1 AND g.user_id = $2
           AND EXISTS (SELECT 1 FROM member)) AS grants
  FROM (SELECT 1) AS one
  LEFT JOIN app.organization o ON o.id = $1
  LEFT JOIN app.project p ON p.organization_id = $1 AND p.id = $3::uuid
  LEFT JOIN app.environment e
    ON e.organization_id = $1 AND e.project_id = $3::uuid AND e.id = $4::uuid`;

export async function resolveAccess(
  db: Queryable,
  userId: UserId,
  ids: { organizationId: string; projectId?: string; environmentId?: string },
): Promise<Resolved> {
  const result = await db.query<Row>(RESOLVE, [
    ids.organizationId,
    userId,
    ids.projectId ?? null,
    ids.environmentId ?? null,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error("resolveAccess returned no row");

  let authority: Authority | null = null;
  if (row.role !== null) {
    const projectGrants = new Map<string, GrantRole>();
    const environmentGrants = new Map<string, { projectId: string; role: GrantRole }>();
    for (const grant of row.grants) {
      if (grant.projectId !== null) {
        if (projectGrants.get(grant.projectId) !== "editor") {
          projectGrants.set(grant.projectId, grant.role);
        }
      } else if (grant.environmentId !== null && grant.environmentProjectId !== null) {
        if (environmentGrants.get(grant.environmentId)?.role !== "editor") {
          environmentGrants.set(grant.environmentId, {
            projectId: grant.environmentProjectId,
            role: grant.role,
          });
        }
      }
    }
    authority = { role: row.role, projectGrants, environmentGrants };
  }

  return {
    authority,
    organization:
      row.org_state === null ? null : { state: row.org_state, reviewReason: row.org_reason },
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

export interface OrganizationEntry {
  id: string;
  role: Role;
  state: string;
  reviewReason: string | null;
}

/** The organizations the user is an active member of, oldest first. */
export async function listOrganizations(
  db: Queryable,
  userId: UserId,
): Promise<OrganizationEntry[]> {
  const result = await db.query<OrganizationEntry>(
    `SELECT o.id, m.role, o.state, o.review_reason AS "reviewReason"
       FROM app.membership m
       JOIN app.organization o ON o.id = m.organization_id
      WHERE m.user_id = $1 AND m.state = 'active'
      ORDER BY o.created_at, o.id`,
    [userId],
  );
  return result.rows;
}
