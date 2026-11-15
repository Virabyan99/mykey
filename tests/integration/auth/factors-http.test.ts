// Run 3.4 (FR-1.02, FR-1.03, AC-1.02, PO-15): the second factor on the
// integrated app. Task A: no product route answers a session that has not
// completed it. Task B: the factor routes with audit, throttle, step-up and
// fresh regeneration.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { codeAt, hasFreshTotp, stepAt } from "@mykey/auth";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { activeTarget } from "../../harness/tenants.ts";
import type { PathIds } from "../authz/requests.ts";
import {
  enrollOwner,
  seedOwner,
  sessionCookieOf,
  startTestApi,
  type EnrolledOwner,
  type TestApi,
} from "../../harness/api.ts";

let api: TestApi;
let sources = 0;
/** A fresh forwarded source per request: these tests are not about the per-source limit. */
const from = (): Record<string, string> => {
  sources += 1;
  return { "x-forwarded-for": `198.51.100.${String(sources % 250)}` };
};

beforeAll(async () => {
  api = await startTestApi({
    stubs: true,
    // Secret, import, export, credential and lifecycle routes answer through the stub even once
    // handled: this API has no runtime or issuer identity (Runs 4.2, 4.7, 4.9, 5.1–5.3).
    stubRoutes: ROUTES.filter(
      (route) =>
        route.id.startsWith("secrets.") ||
        route.id.startsWith("import.") ||
        route.id === "export.create" ||
        route.id.startsWith("credentials.") ||
        route.id.endsWith(".archive") ||
        route.id.endsWith(".reactivate"),
    ).map((route) => route.id),
    config: { trustedProxy: "127.0.0.1" },
  });
});

afterAll(async () => {
  await api.close();
});

const HUMAN = ROUTES.filter((route) => route.auth === "human" || route.auth === "human_fresh_totp");

const BODIES: Record<string, unknown> = {
  // Run 3.9: these run for real now; names of their own, apart from the target's.
  "projects.create": { name: "Created by the control" },
  "projects.rename": { name: "Renamed by the control" },
  "projects.archive": { confirmed: true },
  "projects.reactivate": { confirmed: true },
  "environments.create": { name: "created-by-control" },
  "environments.rename": { name: "renamed-by-control" },
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

/** Ids of an active organization of the enrolled owner (Run 3.7: random ids are 404). */
let target: PathIds | undefined;

function concretePath(route: RouteDef): string {
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    if (name === "name") return "A";
    if (name === "envName") return "dev";
    if (target !== undefined && (name === "org" || name === "project" || name === "env")) {
      return target[name];
    }
    return randomUUID();
  });
}

function call(route: RouteDef, cookie?: string): Promise<Response> {
  const body = BODIES[route.id];
  const init =
    route.request.body === "raw-dotenv"
      ? { rawBody: "A=1\n", headers: { "content-type": "text/plain" } }
      : body === undefined
        ? {}
        : { body };
  return api.request(route.method, concretePath(route), {
    ...init,
    ...(cookie === undefined ? {} : { cookie }),
    headers: {
      ...("headers" in init ? init.headers : {}),
      ...from(),
      "idempotency-key": randomUUID(),
    },
  });
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await api.request("POST", "/v1/auth/sign-in/email", {
    body: { email, password },
    headers: from(),
  });
  expect(response.status).toBe(200);
  return sessionCookieOf(response);
}

describe("product routes are closed to incomplete sessions (Task A)", () => {
  let enrolled: EnrolledOwner;

  beforeAll(async () => {
    enrolled = await enrollOwner(api, await seedOwner(api), { source: "198.51.100.251" });
    target = await activeTarget(api, enrolled.organizationId);
  });

  it("a password-only session reaches no product route", async () => {
    const cookie = await signIn(enrolled.email, enrolled.password);
    api.reached.length = 0;
    for (const route of HUMAN) {
      const response = await call(route, cookie);
      expect(response.status, route.id).toBe(401);
      expect(await codeOf(response), route.id).toBe("mfa_incomplete");
    }
    expect(api.reached).toEqual([]);
  });

  it("control: an mfa_complete session reaches every product route's stub", async () => {
    api.reached.length = 0;
    for (const route of HUMAN.filter((r) => r.scope !== "operation")) {
      const response = await call(route, enrolled.cookie);
      expect([200, 201, 204], route.id).toContain(response.status);
    }
    // Every route without a real handler (session.activity since Run 3.5,
    // organizations.list since Run 3.7, projects and environments since Run 3.9);
    // operations.list since Run 4.1; the secret routes stay stubbed here (stubRoutes).
    const handled = [
      "operations.list",
      "session.activity",
      "organizations.list",
      "projects.list",
      "projects.create",
      "projects.rename",
      "environments.list",
      "environments.create",
      "environments.rename",
    ];
    const stubbed = HUMAN.filter(
      (route) => !handled.includes(route.id) && route.scope !== "operation",
    );
    expect(new Set(api.reached)).toEqual(new Set(stubbed.map((route) => route.id)));
  });

  it("an enrollment-phase session reaches no product route", async () => {
    const owner = await seedOwnerLike();
    const cookie = await signIn(owner.email, owner.password);
    const enroll = await api.request("POST", "/v1/auth/totp/enroll", {
      body: {},
      cookie,
      headers: from(),
    });
    expect(enroll.status).toBe(200);
    api.reached.length = 0;
    for (const route of HUMAN) {
      const response = await call(route, cookie);
      expect(response.status, route.id).toBe(401);
      expect(await codeOf(response), route.id).toBe("mfa_incomplete");
    }
    expect(api.reached).toEqual([]);
  });

  it("no cookie and a cookie with a broken signature are 401 unauthenticated", async () => {
    const [name, value] = enrolled.cookie.split("=") as [string, string];
    const broken = `${name}=${value.slice(0, -4)}AAAA`;
    api.reached.length = 0;
    for (const cookie of [undefined, broken]) {
      for (const route of HUMAN) {
        const response = await call(route, cookie);
        expect(response.status, route.id).toBe(401);
        expect(await codeOf(response), route.id).toBe("unauthenticated");
      }
    }
    expect(api.reached).toEqual([]);
  });

  it("an enrollment_pending account can only sign in, enroll, activate and sign out", async () => {
    const owner = await seedOwnerLike();
    const cookie = await signIn(owner.email, owner.password);
    const before = await rowCounts();
    const answers: Record<string, number> = {};
    for (const [path, body] of [
      ["/v1/auth/totp/verify", { code: "123456" }],
      ["/v1/auth/recovery/verify", { code: "AAAA-AAAA-AAAA" }],
      ["/v1/auth/recovery/regenerate", {}],
      ["/v1/auth/totp/step-up", { code: "123456" }],
      [
        "/v1/auth/change-password",
        { currentPassword: owner.password, newPassword: "x".repeat(16) },
      ],
      ["/v1/auth/revoke-sessions", {}],
    ] as const) {
      const response = await api.request("POST", path, { body, cookie, headers: from() });
      answers[path] = response.status;
    }
    for (const [path, status] of Object.entries(answers)) {
      expect([401, 409], path).toContain(status);
    }
    expect(await rowCounts()).toEqual(before);
  });
});

/** Another enrollment_pending account (the bootstrap allows one owner). */
async function seedOwnerLike(): Promise<{ userId: string; email: string; password: string }> {
  const email = `user-${randomBytes(4).toString("hex")}@mykey.invalid`;
  const password = randomBytes(18).toString("base64url");
  const hash = await (await api.auth.$context).password.hash(password);
  const operator = api.database.pool("maintenance");
  const user = await operator.query<{ id: string }>(
    `INSERT INTO auth."user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'User', $1, true) RETURNING id`,
    [email],
  );
  const userId = user.rows[0]!.id;
  await operator.query(
    "INSERT INTO auth.account (id, account_id, provider_id, user_id, password) VALUES (gen_random_uuid(), $1, 'credential', $2, $3)",
    [userId, userId, hash],
  );
  await operator.query(
    "INSERT INTO auth.account_state (user_id, state) VALUES ($1, 'enrollment_pending')",
    [userId],
  );
  return { userId, email, password };
}

async function rowCounts(): Promise<Record<string, number>> {
  const result = await api.superuser.query<{ table: string; n: number }>(
    `SELECT 'session' AS table, count(*)::int AS n FROM auth.session UNION ALL
     SELECT 'enrollment', count(*)::int FROM auth.totp_enrollment UNION ALL
     SELECT 'recovery', count(*)::int FROM auth.recovery_code UNION ALL
     SELECT 'steps', count(*)::int FROM auth.totp_step_used`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.table, row.n]));
}

// ------------------------------------------------------------------ Task B

/** Sends `now` to the factor routes (honoured only because the harness set a test clock). */
const at = (now: Date): Record<string, string> => ({ ...from(), "x-test-now": now.toISOString() });

async function factor(
  path: string,
  cookie: string,
  body: unknown,
  now: Date = new Date(),
): Promise<Response> {
  return api.request("POST", `/v1/auth${path}`, { body, cookie, headers: at(now) });
}

async function sessionRow(cookie: string): Promise<{ id: string; authenticated_at: Date } | null> {
  const response = await api.request("GET", "/v1/auth/get-session", { cookie, headers: from() });
  const body = (await response.json()) as { session?: { id: string } } | null;
  if (body?.session === undefined) return null;
  const row = await api.superuser.query<{ id: string; authenticated_at: Date }>(
    "SELECT id, authenticated_at FROM auth.session WHERE id = $1",
    [body.session.id],
  );
  return row.rows[0] ?? null;
}

/** Bodies of refusals, with the request id removed. */
async function refusal(response: Response): Promise<unknown> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  return { status: response.status, error: { ...body.error, requestId: "" } };
}

/** Audit rows of one request id. */
async function auditOf(
  response: Response,
): Promise<{ action: string; outcome: string; details: Record<string, unknown> }[]> {
  const result = await api.superuser.query<{
    action: string;
    outcome: string;
    details: Record<string, unknown>;
  }>(
    "SELECT action, outcome, details FROM audit.event WHERE request_id = $1 ORDER BY occurred_at",
    [response.headers.get("x-request-id")],
  );
  return result.rows;
}

describe("factor routes on the pipeline (Task B)", () => {
  let owner: EnrolledOwner;
  const usedCodes: string[] = [];

  beforeAll(async () => {
    const seeded = await seedOwnerLike();
    owner = await enrollOwner(api, { ...seeded, organizationId: "" }, { source: "198.51.100.252" });
  });

  // The cases share one user; their deliberate failures must not add up to a
  // throttle lock (throttle.test.ts covers the lock).
  beforeEach(async () => {
    await api.superuser.query("DELETE FROM app.rate_limit");
  });

  it("activation shows ten codes once; the database holds verifiers only; no later answer repeats them", async () => {
    expect(owner.recoveryCodes).toHaveLength(10);
    for (const code of owner.recoveryCodes) expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    const stored = await api.superuser.query<{ text: string }>(
      "SELECT row_to_json(r)::text AS text FROM auth.recovery_code r JOIN auth.totp_enrollment e ON e.id = r.enrollment_id WHERE e.user_id = $1",
      [owner.userId],
    );
    expect(stored.rows).toHaveLength(10);
    const storedText = stored.rows.map((row) => row.text).join("\n");
    for (const code of owner.recoveryCodes) {
      expect(storedText.includes(code)).toBe(false);
      expect(storedText.includes(code.replaceAll("-", ""))).toBe(false);
    }
    const answers: string[] = [];
    for (const [method, path, body] of [
      ["GET", "/v1/auth/get-session", undefined],
      ["POST", "/v1/auth/totp/verify", { code: "000000" }],
      ["POST", "/v1/auth/totp/step-up", { code: "000000" }],
    ] as const) {
      const response = await api.request(method, path, {
        ...(body === undefined ? {} : { body }),
        cookie: owner.cookie,
        headers: from(),
      });
      answers.push(await response.text());
    }
    for (const code of owner.recoveryCodes) {
      expect(answers.some((answer) => answer.includes(code))).toBe(false);
    }
  });

  it("verify rotates the session token; the old cookie ends; authenticated_at is unchanged", async () => {
    const password = await signIn(owner.email, owner.password);
    const before = await sessionRow(password);
    // Activation used the current step; this case takes one of its own.
    const now = new Date(Date.now() + 1_800_000);
    const response = await factor(
      "/totp/verify",
      password,
      { code: codeAt(owner.seed, stepAt(now)) },
      now,
    );
    expect(response.status).toBe(200);
    const elevated = sessionCookieOf(response);
    expect(elevated).not.toBe(password);
    expect(await sessionRow(password)).toBeNull();
    const after = await sessionRow(elevated);
    expect(after?.authenticated_at.getTime()).toBe(before?.authenticated_at.getTime());
    expect(await auditOf(response)).toEqual([
      { action: "auth.mfa_complete", outcome: "success", details: { method: "totp" } },
    ]);
  });

  it("a wrong, a replayed and an expired code answer alike", async () => {
    // Steps far from any other test's, so no earlier use interferes.
    const now = new Date(Date.now() + 3_600_000);
    const right = codeAt(owner.seed, stepAt(now));
    const first = await signIn(owner.email, owner.password);
    expect((await factor("/totp/verify", first, { code: right }, now)).status).toBe(200);
    const answers: unknown[] = [];
    const reasons: unknown[] = [];
    for (const code of [
      codeAt(owner.seed, stepAt(now) + 7), // wrong
      right, // replayed
      codeAt(owner.seed, stepAt(now) - 5), // expired
    ]) {
      const cookie = await signIn(owner.email, owner.password);
      const response = await factor("/totp/verify", cookie, { code }, now);
      const audit = await auditOf(response);
      reasons.push(audit.map((row) => row.details.reason));
      answers.push(await refusal(response));
    }
    expect(answers[0]).toMatchObject({ status: 401, error: { code: "unauthenticated" } });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(reasons).toEqual([["invalid"], ["replayed"], ["invalid"]]);
  });

  it("a consumed recovery code is refused; the other nine work once each", async () => {
    const [first, ...rest] = owner.recoveryCodes as [string, ...string[]];
    const cookie = await signIn(owner.email, owner.password);
    const used = await factor("/recovery/verify", cookie, { code: first });
    expect(used.status).toBe(200);
    expect(await auditOf(used)).toEqual([
      { action: "auth.mfa_complete", outcome: "success", details: { method: "recovery" } },
    ]);
    usedCodes.push(first);
    const again = await factor("/recovery/verify", await signIn(owner.email, owner.password), {
      code: first,
    });
    expect(again.status).toBe(401);
    // Four more, each once (the throttle allows five failures; successes do not count).
    for (const code of rest.slice(0, 4)) {
      const ok = await factor("/recovery/verify", await signIn(owner.email, owner.password), {
        code,
      });
      expect(ok.status).toBe(200);
      usedCodes.push(code);
    }
  });

  it("step-up: a wrong code is 401 and the session still works; the right code makes it fresh", async () => {
    const now = new Date(Date.now() + 7_200_000);
    const password = await signIn(owner.email, owner.password);
    const signInStep = codeAt(owner.seed, stepAt(now));
    const elevated = await factor("/totp/verify", password, { code: signInStep }, now);
    expect(elevated.status).toBe(200);
    const cookie = sessionCookieOf(elevated);
    const session = await sessionRow(cookie);
    // Not fresh yet after... it is fresh: completed with TOTP. Age it first.
    await api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '601 seconds' WHERE id = $1",
      [session?.id],
    );
    expect(await hasFreshTotp(api.pool, session!.id)).toBe(false);
    const wrong = await factor(
      "/totp/step-up",
      cookie,
      { code: codeAt(owner.seed, stepAt(now) + 9) },
      now,
    );
    expect(wrong.status).toBe(401);
    expect(
      (await api.request("GET", "/v1/auth/get-session", { cookie, headers: from() })).status,
    ).toBe(200);
    // The step used for the elevation cannot be used again.
    const reused = await factor("/totp/step-up", cookie, { code: signInStep }, now);
    expect(reused.status).toBe(401);
    const right = await factor(
      "/totp/step-up",
      cookie,
      { code: codeAt(owner.seed, stepAt(now) + 1) },
      now,
    );
    expect(right.status).toBe(200);
    expect(await hasFreshTotp(api.pool, session!.id)).toBe(true);
    expect(await auditOf(right)).toEqual([
      { action: "auth.step_up", outcome: "success", details: {} },
    ]);
  });

  it("regeneration needs fresh TOTP: 403 at 601 s and for a recovery-code session, allowed at 595 s", async () => {
    const now = new Date(Date.now() + 10_800_000);
    const password = await signIn(owner.email, owner.password);
    const elevated = await factor(
      "/totp/verify",
      password,
      { code: codeAt(owner.seed, stepAt(now)) },
      now,
    );
    const cookie = sessionCookieOf(elevated);
    const session = await sessionRow(cookie);
    const age = (seconds: number) =>
      api.superuser.query(
        "UPDATE auth.session SET totp_verified_at = now() - make_interval(secs => $2) WHERE id = $1",
        [session?.id, seconds],
      );
    await age(601);
    const stale = await factor("/recovery/regenerate", cookie, {});
    expect(stale.status).toBe(403);
    expect(await refusal(stale)).toMatchObject({
      error: { code: "fresh_verification_required" },
    });
    // A session completed with a recovery code has no TOTP verification at all.
    const recoveryCode = owner.recoveryCodes[5]!;
    const byRecovery = await factor("/recovery/verify", await signIn(owner.email, owner.password), {
      code: recoveryCode,
    });
    expect(byRecovery.status).toBe(200);
    const notFresh = await factor("/recovery/regenerate", sessionCookieOf(byRecovery), {});
    expect(notFresh.status).toBe(403);
    await age(595);
    const ok = await factor("/recovery/regenerate", cookie, {});
    expect(ok.status).toBe(200);
    const { recoveryCodes } = (await ok.json()) as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    // Every old code is dead, and every old row is marked consumed.
    for (const code of owner.recoveryCodes.slice(6, 8)) {
      const old = await factor("/recovery/verify", await signIn(owner.email, owner.password), {
        code,
      });
      expect(old.status).toBe(401);
    }
    const open = await api.superuser.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth.recovery_code r JOIN auth.totp_enrollment e ON e.id = r.enrollment_id
        WHERE e.user_id = $1 AND r.consumed_at IS NULL`,
      [owner.userId],
    );
    expect(open.rows[0]?.n).toBe(10);
    owner = { ...owner, recoveryCodes };
  });

  it("hasFreshTotp is false when the session's enrollment is not the active one", async () => {
    const now = new Date(Date.now() + 14_400_000);
    const elevated = await factor(
      "/totp/verify",
      await signIn(owner.email, owner.password),
      { code: codeAt(owner.seed, stepAt(now)) },
      now,
    );
    const session = await sessionRow(sessionCookieOf(elevated));
    expect(await hasFreshTotp(api.pool, session!.id)).toBe(true);
    await api.superuser.query(
      "UPDATE auth.totp_enrollment SET state = 'retired' WHERE user_id = $1 AND state = 'active'",
      [owner.userId],
    );
    try {
      expect(await hasFreshTotp(api.pool, session!.id)).toBe(false);
    } finally {
      await api.superuser.query(
        "UPDATE auth.totp_enrollment SET state = 'active' WHERE user_id = $1 AND state = 'retired'",
        [owner.userId],
      );
    }
  });

  it("a password-only session older than ten minutes cannot verify; at 595 s it can", async () => {
    const now = new Date(Date.now() + 18_000_000);
    const old = await signIn(owner.email, owner.password);
    const oldRow = await sessionRow(old);
    await api.superuser.query(
      "UPDATE auth.session SET authenticated_at = now() - interval '601 seconds' WHERE id = $1",
      [oldRow?.id],
    );
    const refused = await factor(
      "/totp/verify",
      old,
      { code: codeAt(owner.seed, stepAt(now)) },
      now,
    );
    expect(refused.status).toBe(401);
    const gone = await api.superuser.query("SELECT 1 FROM auth.session WHERE id = $1", [
      oldRow?.id,
    ]);
    expect(gone.rowCount).toBe(0);
    const young = await signIn(owner.email, owner.password);
    const youngRow = await sessionRow(young);
    await api.superuser.query(
      "UPDATE auth.session SET authenticated_at = now() - interval '595 seconds' WHERE id = $1",
      [youngRow?.id],
    );
    const accepted = await factor(
      "/totp/verify",
      young,
      { code: codeAt(owner.seed, stepAt(now) + 1) },
      now,
    );
    expect(accepted.status).toBe(200);
  });

  it("there is no trusted device and no way to switch the factor off", async () => {
    const response = await factor("/totp/verify", await signIn(owner.email, owner.password), {
      code: "123456",
      trustDevice: true,
    });
    expect(response.status).toBe(400);
    for (const path of ["/v1/auth/totp/disable", "/v1/auth/two-factor/disable"]) {
      const disabled = await api.request("POST", path, {
        body: {},
        cookie: owner.cookie,
        headers: from(),
      });
      expect(disabled.status, path).toBe(404);
    }
  });

  it("no audit row holds a code", async () => {
    const rows = await api.superuser.query<{ text: string }>(
      "SELECT details::text AS text FROM audit.event WHERE action LIKE 'auth.%'",
    );
    const text = rows.rows.map((row) => row.text).join("\n");
    for (const code of usedCodes) {
      expect(text.includes(code)).toBe(false);
      expect(text.includes(code.replaceAll("-", ""))).toBe(false);
    }
    expect(text.length).toBeGreaterThan(0);
  });
});
