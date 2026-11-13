// Run 3.7 Task B (P-52): a request cannot choose what it is checked against.
// Mixed credentials are refused before any database read; client-supplied
// selectors (namespace, path, policy, role, organization) are refused as
// malformed; a header claiming a role changes nothing.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { errorOf, startTestApi, type TestApi } from "../../harness/api.ts";
import { createTenants, type Tenants } from "../../harness/tenants.ts";
import { pathIn, requestOf } from "./requests.ts";

let api: TestApi;
let tenants: Tenants;
let cookie: string;

beforeAll(async () => {
  // No outbox dispatcher: its background polls share the API's pool and would be counted.
  api = await startTestApi({ stubs: true, dispatcher: false });
  tenants = await createTenants(api);
  cookie = await tenants.cookie("ownerA");
}, 300_000);

afterAll(async () => {
  await api.close();
});

/** Counts every statement and checkout of the API's own pool while `body` runs. */
async function queriesDuring(body: () => Promise<void>): Promise<number> {
  const pool = api.pool;
  const query = pool.query.bind(pool);
  const connect = pool.connect.bind(pool);
  let count = 0;
  const counted =
    (inner: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      count += 1;
      return inner(...args);
    };
  pool.query = counted(query) as typeof pool.query;
  pool.connect = counted(connect as (...args: unknown[]) => unknown) as typeof pool.connect;
  try {
    await body();
  } finally {
    pool.query = query;
    pool.connect = connect;
  }
  return count;
}

const route = (id: string): RouteDef => {
  const found = ROUTES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

describe("mixed credentials", () => {
  it("cookie + Authorization: Bearer x is 400 mixed_authentication on a human and a machine route, with no query", async () => {
    const ids = {
      org: tenants.a.organizationId,
      project: tenants.a.project1,
      env: tenants.a.env1a,
    };
    for (const id of ["organizations.list", "secrets.create", "machine.resolve", "machine.keys"]) {
      const def = route(id);
      const init = requestOf(def);
      let response: Response | undefined;
      const queries = await queriesDuring(async () => {
        response = await api.request(def.method, pathIn(def, ids), {
          ...init,
          cookie,
          headers: { ...init.headers, authorization: "Bearer x" },
        });
      });
      expect(response?.status, id).toBe(400);
      expect((await errorOf(response!)).code, id).toBe("mixed_authentication");
      expect(queries, id).toBe(0);
    }
  });

  it("control: the cookie alone reaches the route", async () => {
    const response = await api.request("GET", "/v1/organizations", { cookie });
    expect(response.status).toBe(200);
  });
});

/** The routes Session 3 implements, with a valid request each. */
const SESSION_3 = [
  "version.get",
  "organizations.list",
  "session.activity",
  "auth.reset.complete",
  "projects.list",
  "projects.create",
  "projects.rename",
  "environments.list",
  "environments.create",
  "environments.rename",
];

describe("client-supplied selectors are refused", () => {
  const QUERIES = [
    "namespace=org-x",
    "path=kv/data/x",
    "role=owner",
    `organizationId=${randomUUID()}`,
  ];
  const BODY_KEYS: Record<string, unknown>[] = [
    { namespace: "org-x" },
    { policy: "runtime" },
    { role: "owner" },
    { organizationId: randomUUID() },
  ];

  for (const id of SESSION_3) {
    it(`${id}: a selector in the query or the body is 400 malformed_request`, async () => {
      const def = route(id);
      const ids = {
        org: tenants.a.organizationId,
        project: tenants.a.project1,
        env: tenants.a.env1a,
      };
      const path = pathIn(def, ids);
      const init = requestOf(def);
      for (const query of QUERIES) {
        const response = await api.request(def.method, `${path}?${query}`, { ...init, cookie });
        expect(response.status, `${id}?${query}`).toBe(400);
        expect((await errorOf(response)).code, `${id}?${query}`).toBe("malformed_request");
      }
      if (def.method === "GET") return;
      for (const extra of BODY_KEYS) {
        const base = (init.body ?? {}) as Record<string, unknown>;
        const response = await api.request(def.method, path, {
          headers: init.headers,
          body: { ...base, ...extra },
          cookie,
        });
        expect(response.status, `${id} ${JSON.stringify(extra)}`).toBe(400);
        expect((await errorOf(response)).code, id).toBe("malformed_request");
      }
    });
  }

  it("a header x-role: owner changes nothing: a reader stays denied", async () => {
    const def = route("secrets.create");
    const init = requestOf(def);
    const response = await api.request(
      def.method,
      pathIn(def, {
        org: tenants.a.organizationId,
        project: tenants.a.project1,
        env: tenants.a.env1a,
      }),
      {
        ...init,
        cookie: await tenants.cookie("readerA"),
        headers: { ...init.headers, "x-role": "owner", "x-organization-role": "owner" },
      },
    );
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("action_denied");
  });
});

describe("organizations.list", () => {
  it("returns only the caller's organizations, with role and state, and no namespace", async () => {
    const forA = await api.request("GET", "/v1/organizations", { cookie });
    expect(forA.status).toBe(200);
    const textA = await forA.text();
    expect(JSON.parse(textA)).toEqual({
      organizations: [
        { id: tenants.a.organizationId, role: "owner", state: "active", reviewReason: null },
      ],
    });
    expect(textA).not.toContain("org-");

    const forB = await api.request("GET", "/v1/organizations", {
      cookie: await tenants.cookie("ownerB"),
    });
    const textB = await forB.text();
    expect(JSON.parse(textB)).toEqual({
      organizations: [
        { id: tenants.b.organizationId, role: "owner", state: "active", reviewReason: null },
      ],
    });
    expect(textB).not.toContain("org-");

    const forReader = await api.request("GET", "/v1/organizations", {
      cookie: await tenants.cookie("readerA"),
    });
    expect(await forReader.json()).toEqual({
      organizations: [
        { id: tenants.a.organizationId, role: "member", state: "active", reviewReason: null },
      ],
    });
  });
});
