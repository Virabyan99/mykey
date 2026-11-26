// Doc 04 §1.1 as data and one pure function (Run 3.7, P-52). The API resolves the
// caller's authority from current rows on every request and asks `decide`; no
// other code decides who may see or do what.
import type { RouteDef } from "./routes.ts";

/** What a route asks of its caller beyond seeing the target. `null`: seeing is enough. */
export const ACTIONS = [
  "resources.manage",
  "secrets.read",
  "secrets.history",
  "secrets.write",
  "credentials.manage",
  "audit.view",
  // Run 5.9 (P-101): the API reference and the OpenAPI document of this build.
  "reference.read",
] as const;
export type Action = (typeof ACTIONS)[number];

/** The deepest resource a route's path names. */
export type RouteScope = "none" | "organization" | "project" | "environment" | "operation";

export type Role = "owner" | "admin" | "member";
export type GrantRole = "reader" | "editor";

export interface Authority {
  readonly role: Role;
  readonly projectGrants: ReadonlyMap<string, GrantRole>;
  readonly environmentGrants: ReadonlyMap<string, { projectId: string; role: GrantRole }>;
}

/** Empty: the organization itself. An environment target always carries its project. */
export interface Target {
  readonly projectId?: string;
  readonly environmentId?: string;
}

/** `hidden` answers 404 (the same as absent), `denied` answers 403. */
export type Decision = "allow" | "hidden" | "denied";

const MEMBER_READS: ReadonlySet<Action> = new Set(["secrets.read", "secrets.history"]);

function stronger(a: GrantRole | undefined, b: GrantRole | undefined): GrantRole | undefined {
  if (a === "editor" || b === "editor") return "editor";
  return a ?? b;
}

export function decide(
  authority: Authority | null,
  target: Target,
  action: Action | null,
): Decision {
  if (authority === null) return "hidden";
  if (target.environmentId !== undefined && target.projectId === undefined) return "hidden";
  if (authority.role === "owner" || authority.role === "admin") return "allow";

  // A member. The reference is for owner and admins only, and a member does not learn it exists.
  if (action === "reference.read") return "hidden";
  const { projectId, environmentId } = target;
  if (projectId === undefined) return action === null ? "allow" : "denied";

  const projectRole = authority.projectGrants.get(projectId);
  if (environmentId === undefined) {
    const visible =
      projectRole !== undefined ||
      [...authority.environmentGrants.values()].some((grant) => grant.projectId === projectId);
    if (!visible) return "hidden";
    return action === null ? "allow" : "denied";
  }

  const own = authority.environmentGrants.get(environmentId);
  const effective = stronger(projectRole, own?.projectId === projectId ? own.role : undefined);
  if (effective === undefined) return "hidden";
  if (action === null || MEMBER_READS.has(action)) return "allow";
  if (action === "secrets.write") return effective === "editor" ? "allow" : "denied";
  return "denied";
}

/** Which column of the state table (P-53) a route's request falls in. */
export type StateClass =
  | "none"
  | "metadata_read"
  | "metadata_write"
  | "secret_read"
  | "secret_write"
  | "credential_issue"
  | "lifecycle";

const LIFECYCLE: ReadonlySet<string> = new Set([
  "projects.archive",
  "projects.reactivate",
  "environments.archive",
  "environments.reactivate",
  "credentials.revoke",
  // Session 11: revoking an automation credential, and a runtime credential by automation.
  "automation_credentials.revoke",
  "automation.runtime_credentials.revoke",
]);

/** Session 11: issuing a credential for an environment, whoever asks and whichever kind. */
const CREDENTIAL_ISSUE: ReadonlySet<string> = new Set([
  "credentials.issue",
  "runtime_credentials.issue",
  "automation.runtime_credentials.issue",
]);

/**
 * Session 11: an automation route has no action, so its class is that of the
 * human route it stands beside. Every read is a read of metadata: no
 * automation route reads a value.
 */
const AUTOMATION_WRITES: Readonly<Record<string, StateClass>> = {
  "automation.projects.create": "metadata_write",
  "automation.environments.create": "metadata_write",
  "automation.secrets.create": "secret_write",
};

export function stateClassOf(route: RouteDef): StateClass {
  if (LIFECYCLE.has(route.id)) return "lifecycle";
  if (CREDENTIAL_ISSUE.has(route.id)) return "credential_issue";
  if (route.auth === "automation") {
    return route.method === "GET" ? "metadata_read" : (AUTOMATION_WRITES[route.id] ?? "none");
  }
  if (route.auth !== "human" && route.auth !== "human_fresh_totp") return "none";
  // The organization's state answers before an automation credential is issued in it.
  if (route.id === "automation_credentials.issue") return "metadata_write";
  switch (route.action) {
    case "secrets.read":
    case "secrets.history":
      return "secret_read";
    case "secrets.write":
      return "secret_write";
    case "resources.manage":
      return route.method === "GET" ? "metadata_read" : "metadata_write";
    default:
      return route.method === "GET" ? "metadata_read" : "none";
  }
}
