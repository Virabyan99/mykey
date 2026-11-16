// Run 6.3 Task C (P-115, FR-1.61, AC-1.24, D-49): disk pressure is a record
// the host writes and the API reads afresh per request. `low`: every
// state-expanding mutation is 507 capacity_exceeded { limit: "disk" } and
// nothing was written or sent; the routes that reduce exposure, sign-in and
// its factors, and every read continue. A record that is missing, unreadable
// or stale: the expanding routes are 503 dependency_unavailable.
import { randomUUID } from "node:crypto";
import { EXPANDING_ROUTES, ROUTES, type RouteDef } from "@mykey/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signInComplete } from "../../harness/api.ts";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { archive, newProject } from "../../harness/lifecycle-fixture.ts";
import { pathIn, requestOf } from "../authz/requests.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
  const made = await f.create("env1a", "CAPACITY_SEED", "synthetic-seed");
  expect(made.status).toBe(201);
}, 600_000);

afterEach(() => {
  f.api.setCapacity("ok");
});

afterAll(async () => {
  await f.close();
});

const route = (id: string): RouteDef => ROUTES.find((candidate) => candidate.id === id)!;
const ids = () => ({
  org: f.tenants.a.organizationId,
  project: f.tenants.a.project1,
  env: f.tenants.a.env1a,
});

/** Rows and backend requests a refused request must not have made. */
async function footprint(): Promise<{ operations: number; audit: number; bao: number }> {
  const counts = await f.api.superuser.query<{ operations: number; audit: number }>(
    `SELECT (SELECT count(*)::int FROM app.operation) AS operations,
            (SELECT count(*)::int FROM audit.event WHERE outcome = 'success') AS audit`,
  );
  return { ...counts.rows[0]!, bao: f.relay.forwardedAt.length };
}

/** One request of every expanding contract route as ownerA, fresh; the answers by id. */
async function everyExpandingRoute(): Promise<Map<string, { status: number; body: string }>> {
  await f.freshen();
  const cookie = await f.tenants.cookie("ownerA");
  const answers = new Map<string, { status: number; body: string }>();
  for (const def of ROUTES.filter((candidate) => EXPANDING_ROUTES.has(candidate.id))) {
    if (def.auth === "reset_flow") continue; // answered below, without a session
    const request = requestOf(def);
    const response = await f.api.request(def.method, pathIn(def, ids()), { ...request, cookie });
    answers.set(def.id, { status: response.status, body: await response.text() });
  }
  const reset = route("auth.reset.complete");
  const response = await f.api.request(reset.method, pathIn(reset, ids()), requestOf(reset));
  answers.set(reset.id, { status: response.status, body: await response.text() });
  for (const path of [
    "/v1/auth/change-password",
    "/v1/auth/totp/enroll",
    "/v1/auth/totp/activate",
    "/v1/auth/recovery/regenerate",
  ]) {
    const answer = await f.api.request("POST", path, { body: {}, cookie });
    answers.set(`POST ${path}`, { status: answer.status, body: await answer.text() });
  }
  return answers;
}

describe("low", () => {
  it("every expanding route is 507 { limit: disk }; no operation, no audit row of success, no OpenBao request", async () => {
    f.api.setCapacity("low");
    const before = await footprint();
    const answers = await everyExpandingRoute();
    expect(answers.size).toBe(EXPANDING_ROUTES.size);
    for (const [id, answer] of answers) {
      expect(answer.status, `${id}: ${answer.body}`).toBe(507);
      const error = (JSON.parse(answer.body) as { error: { code: string; details?: unknown } })
        .error;
      expect(error.code, id).toBe("capacity_exceeded");
      expect(error.details, id).toEqual({ limit: "disk" });
    }
    expect(await footprint()).toEqual(before);
  }, 300_000);

  it("a list and a reveal succeed", async () => {
    f.api.setCapacity("low");
    const list = await f.send("GET", `${f.env("env1a").path}/secrets`);
    expect(list.status).toBe(200);
    const reveal = await f.send("POST", `${f.env("env1a").path}/secrets/CAPACITY_SEED/reveal`, {
      body: {},
    });
    expect(reveal.status, reveal.code ?? "").toBe(200);
  });

  it("credential revocation, environment and project archive succeed with their audit rows", async () => {
    const credential = await issueFor(f, "env1a");
    const place = await newProject(f);
    f.api.setCapacity("low");
    const revoked = await f.send(
      "POST",
      `${f.env("env1a").path}/credentials/${credential.credentialId}/revoke`,
      { body: { confirmed: true }, key: randomUUID() },
    );
    expect(revoked.status, revoked.code ?? "").toBe(200);
    const environment = await archive(f, place.path);
    expect(environment.status, environment.code ?? "").toBe(200);
    const project = await archive(f, place.projectPath);
    expect(project.status, project.code ?? "").toBe(200);
    const rows = await f.api.superuser.query<{ action: string }>(
      `SELECT action FROM audit.event WHERE outcome = 'success' AND operation_id = ANY($1::uuid[])`,
      [[revoked.operationId, environment.operationId, project.operationId]],
    );
    expect(rows.rows.map((row) => row.action).sort()).toEqual([
      "credential.revoke",
      "environment.archive",
      "project.archive",
    ]);
  }, 600_000);

  it("sign-in and its second factor, sign-out and session revocation continue", async () => {
    f.api.setCapacity("low");
    const { email, password, seed } = f.tenants.credentials("readerA");
    const signedIn = await signInComplete(f.api, { email, password, seed });
    expect(signedIn.cookie).toBeTruthy();
    for (const path of [
      "/v1/auth/sessions/revoke",
      "/v1/auth/totp/step-up",
      "/v1/auth/recovery/verify",
    ]) {
      const answer = await f.api.request("POST", path, { body: {}, cookie: signedIn.cookie });
      expect([503, 507], path).not.toContain(answer.status);
    }
    const revokedAll = await f.api.request("POST", "/v1/auth/revoke-sessions", {
      body: {},
      cookie: signedIn.cookie,
    });
    expect(revokedAll.status).toBe(200);
    const again = await signInComplete(f.api, { email, password, seed });
    const signedOut = await f.api.request("POST", "/v1/auth/sign-out", {
      body: {},
      cookie: again.cookie,
    });
    expect(signedOut.status).toBe(200);
  }, 120_000);
});

describe("unknown", () => {
  // "unreadable" (a permission error) is proven in tests/unit/api/capacity.test.ts.
  for (const state of ["missing", "stale", "invalid"] as const) {
    it(`${state}: the expanding routes are 503 dependency_unavailable; a revocation succeeds`, async () => {
      const credential = await issueFor(f, "env1a");
      f.api.setCapacity(state);
      const created = await f.create("env1a", `CAP_${randomUUID().slice(0, 8).toUpperCase()}`, "x");
      expect([created.status, created.code]).toEqual([503, "dependency_unavailable"]);
      const revoked = await f.send(
        "POST",
        `${f.env("env1a").path}/credentials/${credential.credentialId}/revoke`,
        { body: { confirmed: true }, key: randomUUID() },
      );
      expect(revoked.status, revoked.code ?? "").toBe(200);
    }, 120_000);
  }
});

describe("read per request", () => {
  it("flipping the file between two requests flips the answer", async () => {
    const name = () => `CAP_${randomUUID().slice(0, 8).toUpperCase()}`;
    f.api.setCapacity("low");
    expect((await f.create("env1a", name(), "x")).status).toBe(507);
    f.api.setCapacity("ok");
    expect((await f.create("env1a", name(), "x")).status).toBe(201);
    f.api.setCapacity("low");
    expect((await f.create("env1a", name(), "x")).status).toBe(507);
  });
});
