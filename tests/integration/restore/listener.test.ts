// Run 6.7 Task A (P-123): the private verification listener. While the record
// says closed + verifying it serves reads, /v1/auth/* and secrets.reveal on
// the verify listener only; machine routes and every other write stay
// quarantined there, and the public listener stays quarantined throughout.
import { randomUUID } from "node:crypto";
import { EXPANDING_ROUTES, REDUCING_ROUTES, ROUTES } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApi, type TestApi } from "../../harness/api.ts";
import { createTenants, type Tenants } from "../../harness/tenants.ts";

async function codeOf(response: Response): Promise<string | undefined> {
  const text = await response.text();
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

describe("the verification listener (P-123)", () => {
  let api: TestApi;
  let tenants: Tenants;
  let cookie: string;
  let reveal: string;
  let projects: string;

  beforeAll(async () => {
    api = await startTestApi({ verifyListener: true });
    tenants = await createTenants(api);
    cookie = await tenants.cookie("ownerA");
    const { organizationId, project1, env1a } = tenants.a;
    reveal = `/v1/organizations/${organizationId}/projects/${project1}/environments/${env1a}/secrets/SOME_NAME/reveal`;
    projects = `/v1/organizations/${organizationId}/projects`;
  }, 300_000);
  afterAll(async () => {
    api.setGate("open");
    await api.close();
  });

  it("closed + verifying: the verify listener serves reads, auth and reveal; the public one is quarantined", async () => {
    api.setGate("verifying");
    const publicRead = await api.request("GET", "/v1/organizations", { cookie });
    expect([publicRead.status, await codeOf(publicRead)]).toEqual([503, "quarantined"]);

    const read = await api.verifyRequest("GET", "/v1/organizations", { cookie });
    expect(read.status).toBe(200);

    const signIn = await api.verifyRequest("POST", "/v1/auth/sign-in/email", {
      body: { email: "nobody@mykey.invalid", password: "not-the-password-0" },
    });
    expect(await codeOf(signIn)).not.toBe("quarantined");

    const revealed = await api.verifyRequest("POST", reveal, {
      cookie,
      body: { confirmed: true },
    });
    expect(await codeOf(revealed)).not.toBe("quarantined");
  });

  it("closed + verifying: machine routes and other writes are quarantined on the verify listener", async () => {
    api.setGate("verifying");
    const machine = await api.verifyRequest(
      "GET",
      `/v1/machine/projects/${tenants.a.project1}/environments/dev/keys`,
      { headers: { authorization: "Bearer not-a-token" } },
    );
    expect([machine.status, await codeOf(machine)]).toEqual([503, "quarantined"]);

    const write = await api.verifyRequest("POST", projects, {
      cookie,
      headers: { "idempotency-key": randomUUID() },
      body: { name: "verify-listener-write" },
    });
    expect([write.status, await codeOf(write)]).toEqual([503, "quarantined"]);
  });

  // Ruling (Run 6.7): every /v1/auth/* path is served on the verify listener,
  // not only sign-out and session revocation: the journey completes the reset
  // and enrols the owner there (Task C), and auth writes only to PostgreSQL.
  it("closed + verifying: every expanding and reducing product route is quarantined on the verify listener; the auth paths are served", async () => {
    api.setGate("verifying");
    const { organizationId, project1, env1a } = tenants.a;
    const values: Record<string, string> = {
      org: organizationId,
      project: project1,
      env: env1a,
      envName: "dev",
      name: "SOME_NAME",
      preview: randomUUID(),
      credential: randomUUID(),
      operation: randomUUID(),
    };
    const routes = ROUTES.filter(
      (r) =>
        (EXPANDING_ROUTES.has(r.id) || REDUCING_ROUTES.has(r.id)) &&
        !r.path.startsWith("/v1/auth/"),
    );
    expect(routes.length).toBeGreaterThanOrEqual(15);
    const answered: Record<string, string | undefined> = {};
    for (const route of routes) {
      const path = route.path.replace(/:([a-zA-Z]+)/g, (_, key: string) => values[key] ?? key);
      const response = await api.verifyRequest(route.method, path, {
        cookie,
        headers: { "idempotency-key": randomUUID() },
        body: {},
      });
      answered[route.id] = `${String(response.status)} ${String(await codeOf(response))}`;
    }
    expect(answered).toEqual(Object.fromEntries(routes.map((r) => [r.id, "503 quarantined"])));
    const authPaths = [...EXPANDING_ROUTES, ...REDUCING_ROUTES]
      .filter((key) => key.startsWith("POST /v1/auth/"))
      .map((key) => key.slice("POST ".length));
    authPaths.push(
      ROUTES.find((r) => r.id === "auth.reset.complete")?.path ?? "/v1/auth/reset/complete",
    );
    for (const path of authPaths) {
      const response = await api.verifyRequest("POST", path, { body: {} });
      expect([path, await codeOf(response)]).not.toEqual([path, "quarantined"]);
    }
  });

  it("closed + serving (not verifying): the verify listener is quarantined too", async () => {
    api.setGate("closed");
    const read = await api.verifyRequest("GET", "/v1/organizations", { cookie });
    expect([read.status, await codeOf(read)]).toEqual([503, "quarantined"]);
  });

  it("open + serving: both listeners serve", async () => {
    api.setGate("open");
    expect((await api.request("GET", "/v1/organizations", { cookie })).status).toBe(200);
    expect((await api.verifyRequest("GET", "/v1/organizations", { cookie })).status).toBe(200);
  });
});
