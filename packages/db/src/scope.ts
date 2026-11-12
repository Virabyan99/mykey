// Scope objects: every repository function takes the scope it acts in as its
// first data argument, so a query cannot forget the organization it belongs to.
import type { EnvironmentId, OrganizationId, ProjectId } from "@mykey/contracts";

export interface OrgScope {
  readonly organizationId: OrganizationId;
}

export interface ProjectScope extends OrgScope {
  readonly projectId: ProjectId;
}

export interface EnvironmentScope extends ProjectScope {
  readonly environmentId: EnvironmentId;
}
