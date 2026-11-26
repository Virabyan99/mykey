// Run 3.7 Task A (P-52): every route carries the action Doc 04 §1.1 asks of its
// caller and the scope its path names. The table below is this plan's reading of
// Doc 04 §1.1; a run that owns a route may change its row with a `contract:` commit.
import {
  ROUTES,
  stateClassOf,
  type Action,
  type RouteScope,
  type StateClass,
} from "@mykey/contracts";
import { describe, expect, it } from "vitest";

const ROW: Record<string, readonly [Action | null, RouteScope, StateClass]> = {
  "organizations.list": [null, "none", "metadata_read"],
  "projects.list": [null, "organization", "metadata_read"],
  "projects.create": ["resources.manage", "organization", "metadata_write"],
  "projects.rename": ["resources.manage", "project", "metadata_write"],
  "projects.archive": ["resources.manage", "project", "lifecycle"],
  "projects.reactivate": ["resources.manage", "project", "lifecycle"],
  "environments.list": [null, "project", "metadata_read"],
  "environments.create": ["resources.manage", "project", "metadata_write"],
  "environments.rename": ["resources.manage", "environment", "metadata_write"],
  "environments.archive": ["resources.manage", "environment", "lifecycle"],
  "environments.reactivate": ["resources.manage", "environment", "lifecycle"],
  "secrets.list": ["secrets.read", "environment", "secret_read"],
  "secrets.history": ["secrets.history", "environment", "secret_read"],
  "secrets.reveal": ["secrets.read", "environment", "secret_read"],
  "secrets.create": ["secrets.write", "environment", "secret_write"],
  "secrets.update": ["secrets.write", "environment", "secret_write"],
  "secrets.delete": ["secrets.write", "environment", "secret_write"],
  "secrets.undelete": ["secrets.write", "environment", "secret_write"],
  "secrets.restore": ["secrets.write", "environment", "secret_write"],
  "import.preview": ["secrets.write", "environment", "secret_write"],
  "import.apply": ["secrets.write", "environment", "secret_write"],
  "import.resume": ["secrets.write", "environment", "secret_write"],
  "export.create": ["secrets.read", "environment", "secret_read"],
  "credentials.list": ["credentials.manage", "environment", "metadata_read"],
  "credentials.issue": ["credentials.manage", "environment", "credential_issue"],
  "credentials.revoke": ["credentials.manage", "environment", "lifecycle"],
  "operations.get": [null, "operation", "metadata_read"],
  "operations.list": [null, "environment", "metadata_read"],
  "audit.list": ["audit.view", "organization", "metadata_read"],
  "activity.list": ["audit.view", "organization", "metadata_read"],
  "overview.get": ["audit.view", "organization", "metadata_read"],
  "credentials.summary": ["credentials.manage", "organization", "metadata_read"],
  "metrics.get": ["audit.view", "organization", "metadata_read"],
  "session.activity": [null, "none", "none"],
  "reference.get": ["reference.read", "none", "metadata_read"],
  "openapi.get": ["reference.read", "none", "metadata_read"],
  // Session 11 (D-80): the owner's routes for the two new kinds.
  "runtime_credentials.issue": ["credentials.manage", "environment", "credential_issue"],
  "automation_credentials.list": ["credentials.manage", "organization", "metadata_read"],
  "automation_credentials.issue": ["credentials.manage", "organization", "metadata_write"],
  "automation_credentials.revoke": ["credentials.manage", "organization", "lifecycle"],
};

/** Session 11: the state class of each automation route (it has no action and no human scope). */
const AUTOMATION_CLASS: Record<string, StateClass> = {
  "automation.projects.list": "metadata_read",
  "automation.projects.create": "metadata_write",
  "automation.projects.get": "metadata_read",
  "automation.environments.create": "metadata_write",
  "automation.secrets.list": "metadata_read",
  "automation.secrets.create": "secret_write",
  "automation.runtime_credentials.list": "metadata_read",
  "automation.runtime_credentials.issue": "credential_issue",
  "automation.runtime_credentials.revoke": "lifecycle",
  "automation.operations.get": "metadata_read",
};

const isHuman = (auth: string) => auth === "human" || auth === "human_fresh_totp";

function scopeOfPath(path: string): RouteScope {
  if (path.includes("/:env")) return "environment";
  if (path.includes("/:project")) return "project";
  if (path.includes("/:org")) return "organization";
  if (path.includes("/:operation")) return "operation";
  return "none";
}

describe("route actions and scopes", () => {
  it("every human route has a row, and every row is a human route", () => {
    const human = ROUTES.filter((route) => isHuman(route.auth)).map((route) => route.id);
    expect(human.toSorted()).toEqual(Object.keys(ROW).toSorted());
  });

  for (const route of ROUTES.filter((r) => isHuman(r.auth))) {
    it(`${route.id}: action, scope and state class as the table says`, () => {
      const [action, scope, stateClass] = ROW[route.id]!;
      expect(route.action).toBe(action);
      expect(route.scope).toBe(scope);
      expect(stateClassOf(route)).toBe(stateClass);
    });
  }

  it("the scope of a human route is the deepest id its path names", () => {
    for (const route of ROUTES.filter((r) => isHuman(r.auth))) {
      expect(route.scope, route.id).toBe(scopeOfPath(route.path));
    }
  });

  it("machine, public and reset routes have no action, scope none and state class none", () => {
    const others = ROUTES.filter((r) => !isHuman(r.auth) && r.auth !== "automation");
    expect(others.map((r) => r.id)).toContain("machine.exchange");
    for (const route of others) {
      expect(route.action, route.id).toBeNull();
      expect(route.scope, route.id).toBe("none");
      expect(stateClassOf(route), route.id).toBe("none");
    }
  });

  it("an automation route has no action and no human scope, and the state class of its twin", () => {
    const automation = ROUTES.filter((r) => r.auth === "automation");
    expect(automation.map((r) => r.id).toSorted()).toEqual(
      Object.keys(AUTOMATION_CLASS).toSorted(),
    );
    for (const route of automation) {
      expect(route.action, route.id).toBeNull();
      expect(route.scope, route.id).toBe("none");
      expect(stateClassOf(route), route.id).toBe(AUTOMATION_CLASS[route.id]);
    }
  });

  it("every route under /v1/organizations/:org lists state_conflict and backend_inconsistent", () => {
    const scoped = ROUTES.filter((route) => route.path.startsWith("/v1/organizations/:org"));
    expect(scoped.length).toBeGreaterThan(30);
    for (const route of scoped) {
      expect(route.errors, route.id).toContain("state_conflict");
      expect(route.errors, route.id).toContain("backend_inconsistent");
    }
  });
});
