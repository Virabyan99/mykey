// Run 3.1 Task C (P-40): every HTTP route of the API comes from the contract,
// and every contract route is mounted from the first day. A route without a
// handler passes every check of the pipeline and then answers 404 not_found.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { servedAuthRoutes } from "@mykey/auth";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { enrollOwner, errorOf, seedOwner, startTestApi, type TestApi } from "../../harness/api.ts";
import { activeTarget } from "../../harness/tenants.ts";
import type { PathIds } from "../authz/requests.ts";

/** Routes with a real handler at this point of the session. */
const HANDLED = new Set([
  "health.get",
  "version.get",
  "organizations.list",
  "projects.list",
  "projects.create",
  "projects.rename",
  "projects.archive",
  "environments.list",
  "environments.create",
  "environments.rename",
  "environments.archive",
  "projects.reactivate",
  "environments.reactivate",
  "machine.keys",
  "machine.resolve",
  "operations.get",
  "operations.list",
  "secrets.list",
  "secrets.history",
  "secrets.reveal",
  "secrets.create",
  "secrets.update",
  "secrets.delete",
  "secrets.undelete",
  "secrets.restore",
  "import.preview",
  "import.apply",
  "import.resume",
  "export.create",
  "credentials.list",
  "credentials.issue",
  "credentials.revoke",
  "session.activity",
  "auth.reset.complete",
  "openapi.get",
  "reference.get",
  "audit.list",
  "activity.list",
  // Session 7 filled the last three: every contract route has a handler now,
  // and the 404 case below has no route left to run on.
  "overview.get",
  "credentials.summary",
  "metrics.get",
]);

/** A valid body for every contract route that takes one. */
const BODIES: Record<string, unknown> = {
  "projects.create": { name: "p" },
  "projects.rename": { name: "p" },
  "projects.archive": { confirmed: true },
  "projects.reactivate": { confirmed: true },
  "environments.create": { name: "dev" },
  "environments.rename": { name: "dev" },
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
  "automation.projects.create": { name: "p" },
  "automation.environments.create": { name: "dev" },
  "automation.secrets.create": { name: "A", value: "" },
  "automation.runtime_credentials.issue": { name: "c" },
  "automation.runtime_credentials.revoke": { confirmed: true },
};

/**
 * Session 11 (Run 11.2): the two classes this build cannot authenticate yet.
 * Nobody is an authorised caller of them, so the terminal 404 is their answer
 * to every request, a wrong body included.
 */
const UNAUTHENTICATED_CLASSES = new Set(["machine_exchange", "automation"]);

/** An active organization of the owner (Run 3.7: an id the caller cannot see is 404 earlier). */
let target: PathIds;

function concretePath(route: RouteDef): string {
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    if (name === "org" || name === "project" || name === "env") return target[name];
    if (name === "name") return "A";
    if (name === "envName") return "dev";
    return randomUUID();
  });
}

let api: TestApi;
/** The organization the API serves (Run 5.9, service scope): the owner's. */
let processOrganization: string | null = null;
/** An mfa_complete session: human routes answer only that (Run 3.4). */
let cookie: string;

beforeAll(async () => {
  api = await startTestApi({ processOrganization: () => processOrganization });
  const owner = await enrollOwner(api, await seedOwner(api));
  cookie = owner.cookie;
  processOrganization = owner.organizationId;
  target = await activeTarget(api, owner.organizationId);
});

afterAll(async () => {
  await api.close();
});

describe("mounted routes", () => {
  it("every route of the app is a contract route, an auth route or /health", () => {
    const allowed = new Set(
      [...ROUTES, ...servedAuthRoutes()].map((route) => `${route.method} ${route.path}`),
    );
    const extra = api.routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((route) => !allowed.has(route));
    expect(extra).toEqual([]);
    // Control: the listing sees the routes at all.
    expect(api.routes.length).toBeGreaterThanOrEqual(ROUTES.length);
  });

  it("every contract route is mounted", () => {
    const mounted = new Set(api.routes.map((route) => `${route.method} ${route.path}`));
    const missing = ROUTES.filter((route) => !mounted.has(`${route.method} ${route.path}`)).map(
      (route) => route.id,
    );
    expect(missing).toEqual([]);
  });

  // A machine route without a handler is reached only with a real token: Run 11.3
  // gives machine.metadata its handler and its tests. Here: no token, no answer but 401.
  it.each(
    ROUTES.filter((route) => !HANDLED.has(route.id) && route.auth === "machine").map((route) => [
      route.id,
      route,
    ]),
  )("%s without a handler still refuses a caller with no token", async (_id, route) => {
    const response = await api.request(route.method, concretePath(route));
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
  });

  it.each(
    ROUTES.filter((route) => UNAUTHENTICATED_CLASSES.has(route.auth)).map((route) => [
      route.id,
      route,
    ]),
  )(
    "%s answers the same 404 with no bearer and with a bearer of either shape",
    async (_id, route) => {
      // A well-formed request: the body's framing is checked first on every route (400).
      const body = BODIES[route.id];
      const answers: string[] = [];
      for (const headers of [
        {},
        { authorization: `Bearer mkac.${randomUUID()}.${"A".repeat(43)}` },
        { authorization: `Bearer mkrc.${randomUUID()}.${"A".repeat(43)}` },
        { cookie },
      ] as Record<string, string>[]) {
        const response = await api.request(route.method, concretePath(route), {
          ...(body === undefined ? {} : { body }),
          headers: {
            ...headers,
            ...(route.idempotent ? { "idempotency-key": randomUUID() } : {}),
          },
        });
        expect(response.status, route.id).toBe(404);
        const error = await errorOf(response);
        answers.push(JSON.stringify({ ...error, requestId: undefined }));
      }
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toContain("not_found");
    },
  );

  it.each(
    ROUTES.filter((route) => !HANDLED.has(route.id) && route.auth !== "machine").map((route) => [
      route.id,
      route,
    ]),
  )("%s without a handler ends in 404 not_found, for an authorised caller", async (_id, route) => {
    const body = BODIES[route.id];
    const init =
      route.request.body === "raw-dotenv"
        ? { rawBody: "A=1\n", headers: { "content-type": "text/plain" } }
        : route.request.body === "pending"
          ? { body: {} }
          : body === undefined
            ? {}
            : { body };
    const human = route.auth === "human" || route.auth === "human_fresh_totp";
    const response = await api.request(route.method, concretePath(route), {
      ...init,
      ...(human ? { cookie } : {}),
      headers: {
        ...("headers" in init ? init.headers : {}),
        ...(route.idempotent ? { "idempotency-key": randomUUID() } : {}),
      },
    });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
    // The terminal 404, not a refusal of the authorization steps.
    {
      const denied = await api.superuser.query(
        "SELECT 1 FROM audit.event WHERE action = 'access.denied' AND request_id = $1",
        [response.headers.get("x-request-id")],
      );
      expect(denied.rowCount, route.id).toBe(0);
    }
  });

  it("GET /v1/version answers 200 with apiMajor 1 and the build", async () => {
    const response = await api.request("GET", "/v1/version");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apiMajor: 1, build: "0000000" });
  });
});
