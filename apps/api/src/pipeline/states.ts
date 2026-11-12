// State precedence (Doc 04 §1.2, P-53): after visibility and action, the states
// of the organization, the project and the environment decide, parent first.
import { stateClassOf, type ErrorCode, type RouteDef, type StateClass } from "@mykey/contracts";
import type { Resolved, ResourceState } from "@mykey/db";

function organizationCode(state: string): ErrorCode | null {
  if (state === "provisioning" || state === "failed") return "state_conflict";
  if (state === "needs_review") return "backend_inconsistent";
  return null;
}

function resourceCode(
  stateClass: StateClass,
  resource: ResourceState,
  kvReady: boolean,
): ErrorCode | null {
  switch (resource.state) {
    case "active":
      return null;
    case "pending":
      if (stateClass === "metadata_read" || stateClass === "metadata_write") return null;
      if (stateClass === "credential_issue") return "state_conflict";
      return kvReady ? null : "state_conflict";
    case "revoking":
    case "archived":
      return stateClass === "metadata_read" || stateClass === "secret_read"
        ? null
        : "state_conflict";
    case "needs_review":
      if (stateClass === "metadata_read") return null;
      return stateClass === "metadata_write" ? "state_conflict" : "backend_inconsistent";
    default:
      return "state_conflict";
  }
}

/** The state error of a request that may see and do the thing, or null. */
export function checkStates(route: RouteDef, resolved: Resolved): ErrorCode | null {
  const stateClass = stateClassOf(route);
  if (stateClass === "none") return null;
  if (resolved.organization !== null) {
    const code = organizationCode(resolved.organization.state);
    if (code !== null) return code;
  }
  // Archive, reactivate and revocation decide on resource states in their own runs (5.2, 5.3).
  if (stateClass === "lifecycle") return null;
  const kvReady = resolved.environment?.kvReady ?? false;
  for (const resource of [resolved.project, resolved.environment]) {
    if (resource === null) continue;
    const code = resourceCode(stateClass, resource, kvReady);
    if (code !== null) return code;
  }
  return null;
}
