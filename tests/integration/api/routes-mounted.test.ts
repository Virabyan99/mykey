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
  "environments.list",
  "environments.create",
  "environments.rename",
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
  "session.activity",
  "auth.reset.complete",
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
};

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
/** An mfa_complete session: human routes answer only that (Run 3.4). */
let cookie: string;

beforeAll(async () => {
  api = await startTestApi();
  const owner = await enrollOwner(api, await seedOwner(api));
  cookie = owner.cookie;
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

  it.each(ROUTES.filter((route) => !HANDLED.has(route.id)).map((route) => [route.id, route]))(
    "%s without a handler ends in 404 not_found, for an authorised caller",
    async (_id, route) => {
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
    },
  );

  it("GET /v1/version answers 200 with apiMajor 1 and the build", async () => {
    const response = await api.request("GET", "/v1/version");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apiMajor: 1, build: "0000000" });
  });
});
