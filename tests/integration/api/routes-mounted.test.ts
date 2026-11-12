// Run 3.1 Task C (P-40): every HTTP route of the API comes from the contract,
// and every contract route is mounted from the first day. A route without a
// handler passes every check of the pipeline and then answers 404 not_found.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { errorOf, startTestApi, type TestApi } from "../../harness/api.ts";

/** Routes with a real handler at this point of the session. */
const HANDLED = new Set(["health.get", "version.get"]);

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
};

function concretePath(route: RouteDef): string {
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    if (name === "name") return "A";
    if (name === "envName") return "dev";
    return randomUUID();
  });
}

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
});

describe("mounted routes", () => {
  it("every route of the app is a contract route or /health", () => {
    const allowed = new Set(ROUTES.map((route) => `${route.method} ${route.path}`));
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
    "%s without a handler ends in 404 not_found",
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
      const response = await api.request(route.method, concretePath(route), init);
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("not_found");
    },
  );

  it("GET /v1/version answers 200 with apiMajor 1 and the build", async () => {
    const response = await api.request("GET", "/v1/version");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apiMajor: 1, build: "0000000" });
  });
});
