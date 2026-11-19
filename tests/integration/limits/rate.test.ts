// Run 6.3 Task A (P-113, FR-1.60, D-49): rate limits as pipeline steps, with
// the product's limits, on two API processes over one database. The handled
// routes whose class has a limit answer through the stub (every check of the
// pipeline has run, the class step included). A test starts in a fresh window
// with an empty counter table; "a new window" moves `window_start` back a
// minute instead of moving the clock.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRateLimiter, windowSecondsLeft, type LogEntry } from "@mykey/api";
import { generateKeyFiles, loadAuthKeys } from "@mykey/auth";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requestTo, startTestApi, TEST_ORIGIN, type TestApi } from "../../harness/api.ts";
import { startApiProcess, type ApiProcess } from "../../harness/api-worker.ts";
import { createTenants, type Tenants } from "../../harness/tenants.ts";
import { pathIn, requestOf, type PathIds } from "../authz/requests.ts";

let api: TestApi;
let second: ApiProcess;
let tenants: Tenants;
let keysDirectory: string;

const CLASS_ROUTES = [
  "secrets.reveal",
  "import.preview",
  "import.apply",
  "import.resume",
  "export.create",
  "credentials.issue",
];
const EXEMPT_ROUTES = ["credentials.revoke", "projects.archive", "environments.archive"];

beforeAll(async () => {
  keysDirectory = mkdtempSync(join(tmpdir(), "mykey-rate-keys-"));
  generateKeyFiles(keysDirectory);
  api = await startTestApi({
    keys: loadAuthKeys(keysDirectory),
    rateLimits: "product",
    stubs: true,
    stubRoutes: [...CLASS_ROUTES, ...EXEMPT_ROUTES, "secrets.list"],
  });
  tenants = await createTenants(api);
  second = await startApiProcess(api.database.targets.api_runtime, {
    keysDirectory,
    api: {
      baseUrl: TEST_ORIGIN,
      build: api.gate.releaseBuild,
      gatePath: api.gate.gatePath,
      hostInstanceId: api.gate.hostInstanceId,
      backendIncarnation: api.gate.backendIncarnation,
      trustedProxy: null,
    },
    tls: { certPath: api.database.stack.api.certPath, keyPath: api.database.stack.api.keyPath },
    rateLimits: "product",
  });
}, 300_000);

afterAll(async () => {
  await second.kill();
  await api.close();
  rmSync(keysDirectory, { recursive: true, force: true });
});

/** An empty counter table, at least 25 s of the window left. */
beforeEach(async () => {
  const left = windowSecondsLeft(Date.now());
  if (left < 25) await sleep(left * 1000 + 500);
  await api.superuser.query("DELETE FROM app.rate_limit");
}, 60_000);

const route = (id: string): RouteDef => ROUTES.find((candidate) => candidate.id === id)!;
const ids = (): PathIds => ({
  org: tenants.a.organizationId,
  project: tenants.a.project1,
  env: tenants.a.env1a,
});

/** One request of a contract route as `ownerA` (or anonymously), to the first or the second process. */
async function call(
  id: string,
  opts: { cookie?: string | null; to?: "first" | "second"; headers?: Record<string, string> } = {},
): Promise<Response> {
  const def = route(id);
  const request = requestOf(def);
  const cookie = opts.cookie === undefined ? await tenants.cookie("ownerA") : opts.cookie;
  const init = {
    ...request,
    headers: { ...request.headers, ...opts.headers },
    ...(cookie === null ? {} : { cookie }),
  };
  if (opts.to === "second") {
    return secondRequest(def.method, pathIn(def, ids()), init);
  }
  return api.request(def.method, pathIn(def, ids()), init);
}

/** The same request to the child process. */
function secondRequest(
  method: string,
  path: string,
  init: { body?: unknown; rawBody?: string; headers: Record<string, string>; cookie?: string },
): Promise<Response> {
  const ca = readFileSync(api.database.stack.api.certAuthorityPath);
  return requestTo({ port: second.port, ca }, method, path, init);
}

/** `n` requests, `width` at a time; the statuses in order. */
async function burst(n: number, send: () => Promise<Response>, width = 10): Promise<number[]> {
  const statuses: number[] = [];
  for (let start = 0; start < n; start += width) {
    const answers = await Promise.all(
      Array.from({ length: Math.min(width, n - start) }, async () => {
        const response = await send();
        await response.arrayBuffer();
        return response.status;
      }),
    );
    statuses.push(...answers);
  }
  return statuses;
}

async function refusal(response: Response): Promise<{ code: string; retryAfter: number }> {
  const body = (await response.json()) as { error: { code: string } };
  return { code: body.error.code, retryAfter: Number(response.headers.get("retry-after")) };
}

const nextWindow = () =>
  api.superuser.query(
    "UPDATE app.rate_limit SET window_start = window_start - interval '1 minute'",
  );

const expectRefused = async (response: Response, scope: string): Promise<void> => {
  expect(response.status).toBe(429);
  const { code, retryAfter } = await refusal(response);
  expect(code).toBe("rate_limited");
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(60);
  expect(
    api.logs.some((entry: LogEntry) => entry.event === "rate_limited" && entry.scope === scope),
  ).toBe(true);
};

describe("per source (300)", () => {
  it("the 300th request is served, the 301st is 429, a new window serves again", async () => {
    const statuses = await burst(300, () => call("organizations.list", { cookie: null }));
    expect(statuses.filter((status) => status === 401)).toHaveLength(300);
    await expectRefused(await call("organizations.list", { cookie: null }), "rl:source");
    await nextWindow();
    expect((await call("organizations.list", { cookie: null })).status).toBe(401);
  }, 120_000);

  it("is checked before the body is read: a 400 KiB body over the limit is refused unread", async () => {
    await burst(300, () => call("organizations.list", { cookie: null }));
    const before = api.logs.length;
    // The server closes the connection without reading the body: a client still
    // writing may see the reset before the answer. The answer is then proven by
    // the server's own request line.
    const response = await api
      .request("POST", `/v1/organizations/${tenants.a.organizationId}/projects`, {
        rawBody: "x".repeat(400 * 1024),
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        cookie: await tenants.cookie("ownerA"),
      })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return null;
        throw error;
      });
    if (response !== null) {
      expect(response.status).toBe(429);
      expect(response.headers.get("connection")).toBe("close");
    }
    const line = api.logs
      .slice(before)
      .find(
        (entry): entry is Extract<LogEntry, { event: "request" }> =>
          entry.event === "request" && entry.status === 429,
      );
    expect(line?.bodyBytesRead).toBe(0);
  }, 120_000);

  it("X-Forwarded-For from a peer that is not the trusted proxy does not change the subject", async () => {
    let n = 0;
    const statuses = await burst(301, () =>
      call("organizations.list", {
        cookie: null,
        headers: { "x-forwarded-for": `198.51.100.${String((n += 1) % 250)}` },
      }),
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);
  }, 120_000);

  it("the sign-in is held by it too", async () => {
    await burst(300, () => call("organizations.list", { cookie: null }));
    const signIn = await api.request("POST", "/v1/auth/sign-in/email", {
      body: { email: "nobody@example.invalid", password: "a-long-password" },
    });
    await expectRefused(signIn, "rl:source");
  }, 120_000);
});

describe("per session (120)", () => {
  it("the 120th request is served, the 121st is 429; the limit holds across two processes", async () => {
    let n = 0;
    const statuses = await burst(120, () =>
      call("organizations.list", { to: (n += 1) % 2 === 0 ? "first" : "second" }),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(120);
    const refused = await call("organizations.list", { to: "second" });
    expect(refused.status).toBe(429);
    expect((await refusal(refused)).code).toBe("rate_limited");
    await expectRefused(await call("organizations.list"), "rl:session");
    // Another person's session is not held.
    expect(
      (await call("organizations.list", { cookie: await tenants.cookie("adminA") })).status,
    ).toBe(200);
  }, 120_000);

  it("sign-out, session revocation, credential revocation and archive are served at 121 in the minute", async () => {
    await burst(120, () => call("organizations.list"));
    await expectRefused(await call("organizations.list"), "rl:session");
    for (const id of EXEMPT_ROUTES) {
      const answer = await call(id);
      expect(answer.status, id).toBe(204);
    }
    const cookie = await tenants.cookie("ownerA");
    const revoked = await api.request("POST", "/v1/auth/revoke-sessions", { body: {}, cookie });
    expect(revoked.status).toBe(200);
    const signedOut = await api.request("POST", "/v1/auth/sign-out", { body: {}, cookie });
    expect([200, 401]).toContain(signedOut.status);
    expect(signedOut.status).not.toBe(429);
    // The fixture's session of ownerA is gone; later tests sign in again.
    tenants = await createTenants(api);
  }, 300_000);
});

describe("route classes", () => {
  const cases: [string[], string, number][] = [
    [["secrets.reveal"], "rl:reveal", 30],
    [["import.preview", "import.apply", "import.resume"], "rl:import", 5],
    [["export.create"], "rl:export", 5],
    [["credentials.issue"], "rl:issue", 5],
  ];
  for (const [routes, scope, limit] of cases) {
    it(`${routes.join(", ")}: ${String(limit)} served, the next is 429 (${scope}); a new window serves again`, async () => {
      for (let i = 0; i < limit; i += 1) {
        const id = routes[i % routes.length]!;
        expect((await call(id)).status, `${id} #${String(i + 1)}`).toBe(204);
      }
      await expectRefused(await call(routes[0]!), scope);
      // Another person is not held by ownerA's count.
      expect((await call(routes[0]!, { cookie: await tenants.cookie("adminA") })).status).toBe(204);
      await nextWindow();
      expect((await call(routes[0]!)).status).toBe(204);
    }, 120_000);
  }
});

describe("the counters", () => {
  it("two scopes with the same subject string have different rows; a row holds no subject", async () => {
    const limiter = createRateLimiter({ pool: api.pool, ring: api.keys.rateLimit });
    await limiter.hit("rl:reveal", "same-subject");
    await limiter.hit("rl:export", "same-subject");
    const rows = await api.superuser.query<{ scope: string; key_digest: Buffer }>(
      "SELECT scope, key_digest FROM app.rate_limit WHERE scope IN ('rl:reveal', 'rl:export')",
    );
    expect(rows.rows.map((row) => row.scope).sort()).toEqual(["rl:export", "rl:reveal"]);
    const [a, b] = rows.rows;
    expect(a!.key_digest.equals(b!.key_digest)).toBe(false);
    for (const row of rows.rows) {
      expect(row.key_digest.length).toBe(32);
      expect(row.key_digest.includes(Buffer.from("same-subject"))).toBe(false);
    }
  });

  it("a counter table that refuses: a list, a reveal and a sign-in are 503 and nothing else happened; with the rights back they succeed", async () => {
    const cookie = await tenants.cookie("ownerA");
    const sessionsBefore = await api.superuser.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.session",
    );
    const reachedBefore = api.reached.length;
    await api.superuser.query("REVOKE INSERT, UPDATE ON app.rate_limit FROM api_runtime");
    try {
      const list = await call("secrets.list", { cookie });
      const reveal = await call("secrets.reveal", { cookie });
      const credentials = tenants.credentials("editorA");
      const signIn = await api.request("POST", "/v1/auth/sign-in/email", {
        body: { email: credentials.email, password: credentials.password },
      });
      for (const [label, answer] of [
        ["list", list],
        ["reveal", reveal],
        ["sign-in", signIn],
      ] as const) {
        expect(answer.status, label).toBe(503);
        expect((await refusal(answer)).code, label).toBe("dependency_unavailable");
      }
      expect(api.reached.length).toBe(reachedBefore);
      const sessionsAfter = await api.superuser.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth.session",
      );
      expect(sessionsAfter.rows[0]!.n).toBe(sessionsBefore.rows[0]!.n);
    } finally {
      await api.superuser.query("GRANT INSERT, UPDATE ON app.rate_limit TO api_runtime");
    }
    expect((await call("secrets.list", { cookie })).status).toBe(204);
    expect((await call("secrets.reveal", { cookie })).status).toBe(204);
  });
});
