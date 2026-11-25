// Run 3.7 Task B (FR-1.76, P-52): every state-changing browser request carries
// the product's own Origin. A foreign, missing or cross-site one is
// `403 origin_rejected` before the session is read: nothing is reached,
// nothing changes, no throttle attempt is counted.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { servedAuthRoutes } from "@mykey/auth";
import { ROUTES } from "@mykey/contracts";
import { TEST_ORIGIN, errorOf, startTestApi, type TestApi } from "../../harness/api.ts";
import { createTenants, type Tenants } from "../../harness/tenants.ts";
import { pathIn, requestOf } from "./requests.ts";

let api: TestApi;
let tenants: Tenants;
let cookie: string;

beforeAll(async () => {
  api = await startTestApi({ stubs: true });
  tenants = await createTenants(api);
  cookie = await tenants.cookie("ownerA");
}, 300_000);

afterAll(async () => {
  await api.close();
});

interface Target {
  name: string;
  method: string;
  path: string;
  init: { body?: unknown; rawBody?: string; headers: Record<string, string> };
}

function targets(): Target[] {
  const ids = { org: tenants.a.organizationId, project: tenants.a.project1, env: tenants.a.env1a };
  const contract = ROUTES.filter(
    (route) =>
      route.method !== "GET" &&
      (route.auth === "human" || route.auth === "human_fresh_totp" || route.auth === "reset_flow"),
  ).map((route) => ({
    name: route.id,
    method: route.method,
    path: pathIn(route, ids),
    init: requestOf(route),
  }));
  const auth = servedAuthRoutes()
    .filter((route) => route.method === "POST")
    .map((route) => ({
      name: `${route.method} ${route.path}`,
      method: route.method,
      path: route.path,
      init: { body: {}, headers: {} },
    }));
  return [...contract, ...auth];
}

const BAD: [string, Record<string, string>][] = [
  ["no Origin", { origin: "" }],
  ["a foreign Origin", { origin: "https://evil.example" }],
  ["the right host over http", { origin: TEST_ORIGIN.replace("https:", "http:") }],
  ["the right host on another port", { origin: `${TEST_ORIGIN}:8443` }],
  ["Origin: null", { origin: "null" }],
  ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
  ["Sec-Fetch-Site: same-site", { "sec-fetch-site": "same-site" }],
];

/**
 * What a refused request must leave unchanged. The source counter is not part
 * of it: since Run 6.3 (P-113) every request is counted for its source before
 * anything of it is read.
 */
async function snapshot(): Promise<string> {
  const result = await api.superuser.query<{ snap: string }>(
    `SELECT concat_ws('|',
       (SELECT count(*) FROM auth.session),
       (SELECT string_agg(id || ':' || updated_at::text, ',' ORDER BY id) FROM auth.session),
       (SELECT count(*) FROM app.rate_limit WHERE scope <> 'rl:source'),
       (SELECT coalesce(sum(count), 0) FROM app.rate_limit WHERE scope <> 'rl:source'),
       (SELECT count(*) FROM audit.event),
       (SELECT count(*) FROM app.operation),
       (SELECT string_agg(password, ',' ORDER BY id) FROM auth.account)) AS snap`,
  );
  return result.rows[0]!.snap;
}

function withHeaders(init: Target["init"], extra: Record<string, string>) {
  // An empty value makes the harness send the request without that header.
  return { ...init, headers: { ...init.headers, ...extra } };
}

describe("the Origin check", () => {
  it("covers every non-GET human, fresh and reset route and every POST auth route", () => {
    const names = targets().map((target) => target.name);
    // Run 7.9: said without naming the kinds, so that a new kind of route cannot stay outside.
    // Session 11 (D-15's amendment): the two new classes present a bearer, as a
    // machine route does. A browser never attaches one by itself, so the Origin
    // rule has nothing to protect there; they are outside by decision.
    const bearer = new Set(["machine", "machine_exchange", "automation"]);
    expect(names).toEqual([
      ...ROUTES.filter((route) => route.method !== "GET" && !bearer.has(route.auth)).map(
        (route) => route.id,
      ),
      ...servedAuthRoutes()
        .filter((route) => route.method !== "GET")
        .map((route) => `${route.method} ${route.path}`),
    ]);
    expect(names).toContain("auth.reset.complete");
    expect(names).toContain("POST /v1/auth/sign-in/email");
    expect(names).toContain("projects.create");
    expect(names.length).toBeGreaterThan(30);
  });

  for (const [label, headers] of BAD) {
    it(`${label}: 403 origin_rejected on every target, nothing reached, nothing changed`, async () => {
      const before = await snapshot();
      const reachedBefore = api.reached.length;
      for (const target of targets()) {
        const response = await api.request(target.method, target.path, {
          ...withHeaders(target.init, headers),
          cookie,
        });
        expect(response.status, target.name).toBe(403);
        expect((await errorOf(response)).code, target.name).toBe("origin_rejected");
      }
      expect(api.reached.length).toBe(reachedBefore);
      expect(await snapshot()).toBe(before);
    });
  }

  it("control: the right Origin, with and without Sec-Fetch-Site: same-origin, passes this step", async () => {
    for (const fetchSite of ["same-origin", ""]) {
      for (const target of targets()) {
        // Without a cookie, so that sign-out and revoke-sessions end nothing.
        const response = await api.request(target.method, target.path, {
          ...withHeaders(target.init, { "sec-fetch-site": fetchSite }),
        });
        if (response.status === 403) {
          expect((await errorOf(response)).code, target.name).not.toBe("origin_rejected");
        }
      }
    }
  });

  it("a GET is not subject to it", async () => {
    const response = await api.request("GET", "/v1/organizations", {
      cookie,
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(response.status).toBe(200);
  });

  it("sign-in with a foreign Origin is 403 and counts no throttle attempt", async () => {
    const before = await snapshot();
    const { email } = tenants.credentials("readerA");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await api.request("POST", "/v1/auth/sign-in/email", {
        body: { email, password: "wrong-password-attempt" },
        headers: { origin: "https://evil.example" },
      });
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("origin_rejected");
    }
    expect(await snapshot()).toBe(before);
  });
});
