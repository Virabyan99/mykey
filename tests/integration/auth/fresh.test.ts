// Run 3.5 Task C (FR-1.77, AC-1.35): the sensitive starts require a TOTP
// verification of this session in the last ten minutes; and the clean-up of
// expired sessions (API) and of spent factor rows (operator).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activeTarget } from "../../harness/tenants.ts";
import { pathIn, type PathIds } from "../authz/requests.ts";
import { cleanUpSessions, codeAt, stepAt } from "@mykey/auth";
import { cleanUpFactors } from "@mykey/auth/operator";
import { ROUTES } from "@mykey/contracts";
import {
  enrollOwner,
  seedOwner,
  sessionCookieOf,
  signInComplete,
  startTestApi,
  type EnrolledOwner,
  type TestApi,
} from "../../harness/api.ts";

let api: TestApi;
let owner: EnrolledOwner;
let target: PathIds;
let sources = 0;
const from = (): Record<string, string> => {
  sources += 1;
  return { "x-forwarded-for": `198.51.100.${String(sources % 250)}` };
};

beforeAll(async () => {
  // export.create and the credential starts answer through the stub: this API has no runtime or
  // issuer identity (Runs 4.9, 5.1, 5.2).
  api = await startTestApi({
    stubs: true,
    stubRoutes: [
      "export.create",
      "credentials.issue",
      "credentials.revoke",
      // Session 11: the two issuances of the new credentials.
      "runtime_credentials.issue",
      "automation_credentials.issue",
    ],
    config: { trustedProxy: "127.0.0.1" },
  });
  owner = await enrollOwner(api, await seedOwner(api), { source: "198.51.100.251" });
  target = await activeTarget(api, owner.organizationId);
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  await api.superuser.query("DELETE FROM app.rate_limit");
});

const FRESH = ROUTES.filter((route) => route.auth === "human_fresh_totp");
const BODIES: Record<string, unknown> = {
  "export.create": { confirmed: true },
  "credentials.issue": { name: "c" },
  "runtime_credentials.issue": { name: "c" },
  "automation_credentials.issue": {
    name: "c",
    rights: ["projects.create"],
    cidrs: ["192.0.2.0/24"],
  },
};

function start(routeId: string, cookie: string): Promise<Response> {
  const route = FRESH.find((candidate) => candidate.id === routeId)!;
  const path = pathIn(route, target);
  return api.request(route.method, path, {
    body: BODIES[route.id],
    cookie,
    headers: { ...from(), "idempotency-key": randomUUID() },
  });
}

async function ageVerification(sessionId: string, seconds: number): Promise<void> {
  await api.superuser.query(
    "UPDATE auth.session SET totp_verified_at = now() - make_interval(secs => $2) WHERE id = $1",
    [sessionId, seconds],
  );
}

describe("fresh verification on the sensitive starts", () => {
  // Session 11 (D-80; Doc 10 §4.1 rule 6): the two issuances of the new credentials join them.
  it("the fresh class and the two auth routes are the four sensitive starts of FR-1.77 and the two new issuances", () => {
    expect(
      [
        ...FRESH.map((route) => route.id),
        "auth.change_password",
        "auth.recovery_regenerate",
      ].sort(),
    ).toEqual(
      [
        "auth.change_password",
        "auth.recovery_regenerate",
        "automation_credentials.issue",
        "credentials.issue",
        "export.create",
        "runtime_credentials.issue",
      ].sort(),
    );
  });

  it.each(FRESH.map((route) => [route.id]))(
    "%s: 403 at 601 s and for a recovery-code session, reached after step-up and at 595 s",
    async (routeId) => {
      const session = await signInComplete(api, owner, { source: "198.51.100.252" });
      await ageVerification(session.sessionId, 601);
      api.reached.length = 0;
      const stale = await start(routeId, session.cookie);
      expect(stale.status).toBe(403);
      expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
        "fresh_verification_required",
      );
      expect(api.reached).toEqual([]);

      // A session completed with a recovery code has no TOTP verification.
      const signedIn = await api.request("POST", "/v1/auth/sign-in/email", {
        body: { email: owner.email, password: owner.password },
        headers: from(),
      });
      const code = owner.recoveryCodes.shift()!;
      const byRecovery = await api.request("POST", "/v1/auth/recovery/verify", {
        body: { code },
        cookie: sessionCookieOf(signedIn),
        headers: from(),
      });
      expect(byRecovery.status).toBe(200);
      expect((await start(routeId, sessionCookieOf(byRecovery))).status).toBe(403);
      expect(api.reached).toEqual([]);

      // Step-up makes the stale session fresh.
      const now = new Date(Date.now() + 40_000_000 + sources * 120_000);
      const stepped = await api.request("POST", "/v1/auth/totp/step-up", {
        body: { code: codeAt(owner.seed, stepAt(now)) },
        cookie: session.cookie,
        headers: { ...from(), "x-test-now": now.toISOString() },
      });
      expect(stepped.status).toBe(200);
      expect((await start(routeId, session.cookie)).status).toBe(204);
      await ageVerification(session.sessionId, 595);
      expect((await start(routeId, session.cookie)).status).toBe(204);
      expect(api.reached).toEqual([routeId, routeId]);
    },
  );

  it("freshness is per session", async () => {
    const fresh = await signInComplete(api, owner, { source: "198.51.100.253" });
    const stale = await signInComplete(api, owner, { source: "198.51.100.253" });
    await ageVerification(stale.sessionId, 601);
    expect((await start("export.create", fresh.cookie)).status).toBe(204);
    expect((await start("export.create", stale.cookie)).status).toBe(403);
  });
});

describe("clean-up", () => {
  it("cleanUpSessions removes expired sessions and nothing live", async () => {
    const live = await signInComplete(api, owner, { source: "198.51.100.254" });
    const absolute = await signInComplete(api, owner, { source: "198.51.100.254" });
    const idle = await signInComplete(api, owner, { source: "198.51.100.254" });
    await api.superuser.query(
      "UPDATE auth.session SET authenticated_at = now() - interval '43201 seconds' WHERE id = $1",
      [absolute.sessionId],
    );
    await api.superuser.query(
      "UPDATE auth.session SET last_user_activity_at = now() - interval '1801 seconds' WHERE id = $1",
      [idle.sessionId],
    );
    const removed = await cleanUpSessions(api.pool);
    expect(removed).toBeGreaterThanOrEqual(2);
    const left = await api.superuser.query<{ id: string }>(
      "SELECT id FROM auth.session WHERE id = ANY ($1::uuid[])",
      [[live.sessionId, absolute.sessionId, idle.sessionId]],
    );
    expect(left.rows.map((row) => row.id)).toEqual([live.sessionId]);
  });

  it("cleanUpFactors removes old steps, consumed codes and codes of retired enrollments, and nothing live", async () => {
    const superuser = api.superuser;
    // maintenance holds the two DELETE rights from migration 0006 (Run 3.6).
    const enrollment = await superuser.query<{ id: string }>(
      "SELECT id FROM auth.totp_enrollment WHERE user_id = $1 AND state = 'active'",
      [owner.userId],
    );
    const active = enrollment.rows[0]!.id;
    const oldStep = stepAt(new Date()) - 5000;
    await superuser.query(
      "INSERT INTO auth.totp_step_used (enrollment_id, step, used_at) VALUES ($1, $2, now() - interval '2 days'), ($1, $3, now())",
      [active, oldStep, oldStep + 1],
    );
    const retired = randomUUID();
    await superuser.query(
      "INSERT INTO auth.totp_enrollment (id, user_id, seed_jwe, key_id, state) VALUES ($1, $2, '', 'k1', 'retired')",
      [retired, owner.userId],
    );
    await superuser.query(
      "INSERT INTO auth.recovery_code (id, enrollment_id, verifier, key_id) VALUES (gen_random_uuid(), $1, '\\x01', 'k1')",
      [retired],
    );
    const before = await counts(active);
    const removed = await cleanUpFactors(api.database.pool("maintenance"));
    const after = await counts(active);
    expect(removed.steps).toBeGreaterThanOrEqual(1);
    expect(removed.codes).toBeGreaterThanOrEqual(1 + before.consumed);
    expect(after.oldSteps).toBe(0);
    expect(after.newSteps).toBe(before.newSteps);
    expect(after.consumed).toBe(0);
    expect(after.unconsumed).toBe(before.unconsumed);
    expect(after.retiredCodes).toBe(0);
    // A step removed after a day is long out of its window: it cannot be replayed.
    expect(stepAt(new Date()) - oldStep).toBeGreaterThan(1);
  });
});

async function counts(active: string): Promise<{
  oldSteps: number;
  newSteps: number;
  consumed: number;
  unconsumed: number;
  retiredCodes: number;
}> {
  const result = await api.superuser.query<{
    old_steps: number;
    new_steps: number;
    consumed: number;
    unconsumed: number;
    retired_codes: number;
  }>(
    `SELECT (SELECT count(*)::int FROM auth.totp_step_used WHERE used_at < now() - interval '1 day') AS old_steps,
            (SELECT count(*)::int FROM auth.totp_step_used WHERE used_at >= now() - interval '1 day') AS new_steps,
            (SELECT count(*)::int FROM auth.recovery_code WHERE consumed_at IS NOT NULL) AS consumed,
            (SELECT count(*)::int FROM auth.recovery_code WHERE consumed_at IS NULL AND enrollment_id = $1) AS unconsumed,
            (SELECT count(*)::int FROM auth.recovery_code r JOIN auth.totp_enrollment e ON e.id = r.enrollment_id
               WHERE e.state = 'retired') AS retired_codes`,
    [active],
  );
  const row = result.rows[0]!;
  return {
    oldSteps: row.old_steps,
    newSteps: row.new_steps,
    consumed: row.consumed,
    unconsumed: row.unconsumed,
    retiredCodes: row.retired_codes,
  };
}
