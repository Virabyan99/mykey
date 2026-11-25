// Shared by the authorization suites (Run 3.7): a valid body for every contract
// route that takes one, and the concrete path of a route inside a target.
import { randomUUID } from "node:crypto";
import type { RouteDef } from "@mykey/contracts";

export const VALID_BODIES: Record<string, unknown> = {
  "projects.create": { name: "New project" },
  "projects.rename": { name: "Renamed" },
  "projects.archive": { confirmed: true },
  "projects.reactivate": { confirmed: true },
  "environments.create": { name: "staging" },
  "environments.rename": { name: "renamed" },
  "environments.archive": { confirmed: true },
  "environments.reactivate": { confirmed: true },
  "secrets.reveal": {},
  "secrets.create": { name: "A", value: "" },
  "secrets.update": { value: "", expectedVersion: 1, expectedStateTag: "t" },
  "secrets.delete": { expectedVersion: 1, expectedStateTag: "t", confirmed: true },
  "secrets.undelete": { expectedVersion: 1, expectedStateTag: "t", confirmed: true },
  "secrets.restore": {
    sourceVersion: 1,
    expectedVersion: 1,
    expectedStateTag: "t",
    confirmed: true,
  },
  "export.create": { confirmed: true },
  "credentials.issue": { name: "c" },
  "credentials.revoke": { confirmed: true },
  "auth.reset.complete": { token: "A".repeat(43), newPassword: "a-long-new-password" },
  // Session 11.
  "runtime_credentials.issue": { name: "c" },
  "automation_credentials.issue": {
    name: "c",
    rights: ["projects.create"],
    cidrs: ["192.0.2.0/24"],
  },
  "automation_credentials.revoke": { confirmed: true },
  "automation.projects.create": { name: "New project" },
  "automation.environments.create": { name: "staging" },
  "automation.secrets.create": { name: "A", value: "" },
  "automation.runtime_credentials.issue": { name: "c" },
  "automation.runtime_credentials.revoke": { confirmed: true },
};

/**
 * Session 11 (Run 11.2): the class this build cannot authenticate yet. A
 * route of it answers the terminal 404 to every caller, whatever it sends; a
 * suite that walks the route table gives it that expectation, or leaves it to
 * the run that authenticates it (11.5). Run 11.3 took `machine_exchange` out:
 * its route answers a caller without a client secret 401, like a machine route.
 */
export function unauthenticatedClass(route: RouteDef): boolean {
  return route.auth === "automation";
}

/** A raw dotenv body for the import routes. */
export const DOTENV_ROUTES = new Set(["import.preview", "import.apply", "import.resume"]);

export interface PathIds {
  org: string;
  project: string;
  env: string;
}

/** The route's path with the target's ids; other parameters get a fixed or random value. */
export function pathIn(route: RouteDef, ids: PathIds): string {
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    if (name === "org") return ids.org;
    if (name === "project") return ids.project;
    if (name === "env") return ids.env;
    if (name === "name") return "A";
    if (name === "envName") return "dev";
    return randomUUID();
  });
}

/** Routes whose handler exists since Run 3.9 and whose name must be new on every request. */
const UNIQUE_NAMES: Record<string, () => unknown> = {
  "projects.create": () => ({ name: `Project ${randomUUID().slice(0, 8)}` }),
  "projects.rename": () => ({ name: `Renamed ${randomUUID().slice(0, 8)}` }),
  "environments.create": () => ({ name: `e${randomUUID().slice(0, 8)}` }),
  "environments.rename": () => ({ name: `r${randomUUID().slice(0, 8)}` }),
};

/** Headers and body of a well-formed request to `route`. */
export function requestOf(route: RouteDef): {
  body?: unknown;
  rawBody?: string;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = route.idempotent
    ? { "idempotency-key": randomUUID() }
    : {};
  if (DOTENV_ROUTES.has(route.id)) {
    return { rawBody: "A=1\n", headers: { ...headers, "content-type": "text/plain" } };
  }
  const body = UNIQUE_NAMES[route.id]?.() ?? VALID_BODIES[route.id];
  return body === undefined ? { headers } : { body, headers };
}
