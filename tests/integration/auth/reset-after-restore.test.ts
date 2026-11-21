// R1-2 / R4-1 (Run 8.6, rule 9: restored MFA is never trusted). A restore
// keeps the pair's TOTP enrolments and recovery codes, so a `password` reset,
// which accepts a code of the active factor, would trust them. The operator's
// reset therefore refuses `password` while the account's active enrolment is
// older than the latest restore (its `operator.restore_begin` row), and issues
// `mfa`, which retires that factor. Once the person has enrolled anew, a
// `password` reset is allowed again.
import { randomBytes, randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { codeAt, createThrottle, stepAt } from "@mykey/auth";
import { initiateReset, type ResetKind } from "@mykey/auth/operator";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  enrollOwner,
  seedOwner,
  sessionCookieOf,
  startTestApi,
  type EnrolledOwner,
  type TestApi,
} from "../../harness/api.ts";

let api: TestApi;
let owner: EnrolledOwner;
let sources = 0;
const from = (): Record<string, string> => {
  sources += 1;
  return { "x-forwarded-for": `198.51.100.${String(sources % 250)}` };
};

beforeAll(async () => {
  api = await startTestApi({ stubs: true, config: { trustedProxy: "127.0.0.1" } });
  owner = await enrollOwner(api, await seedOwner(api), { source: "198.51.100.251" });
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  await api.superuser.query("DELETE FROM app.rate_limit");
});

function issue(kind: ResetKind) {
  const pool = api.database.pool("maintenance");
  return initiateReset(
    { pool, keys: api.keys, throttle: createThrottle({ pool, ring: api.keys.rateLimit }) },
    { email: owner.email, kind },
  );
}

/** The mark a restore leaves: its `operator.restore_begin` row, written now. */
async function restoreBegins(): Promise<void> {
  await appendAudit(api.database.pool("maintenance"), {
    action: "operator.restore_begin",
    actor: { kind: "operator", id: null },
    source: "operator",
    organizationId: null,
    target: null,
    outcome: "success",
    requestId: null,
    operationId: null,
    details: { pairId: randomUUID() },
  });
}

const newPassword = (): string => `reset-${randomBytes(12).toString("base64url")}`;

describe("an operator reset after a restore", () => {
  it("before any restore, a password reset is issued (control)", async () => {
    expect((await issue("password")).outcome).toBe("issued");
  });

  it("after a restore, a password reset is refused while the restored factor is active; mfa is issued and retires it; after enrolling anew, password is issued again", async () => {
    // The restore begins after the enrolment the pair holds.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await restoreBegins();

    const refused = await issue("password");
    expect(refused).toEqual({ outcome: "refused", reason: "restored_factor" });

    const mfa = await issue("mfa");
    if (mfa.outcome !== "issued") throw new Error(`mfa reset ${mfa.outcome}`);
    const completed = await api.request("POST", "/v1/auth/reset/complete", {
      body: { token: mfa.token, newPassword: newPassword() },
      headers: from(),
    });
    expect(completed.status).toBe(200);
    const challenge = sessionCookieOf(completed);
    const active = await api.superuser.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.totp_enrollment WHERE user_id = $1 AND state = 'active'",
      [owner.userId],
    );
    expect(active.rows[0]?.n).toBe(0);
    const enrolled = await api.request("POST", "/v1/auth/totp/enroll", {
      body: {},
      cookie: challenge,
      headers: from(),
    });
    expect(enrolled.status).toBe(200);
    const seed = OTPAuth.Secret.fromBase32(
      ((await enrolled.json()) as { secret: string }).secret,
    ).bytes;
    const activated = await api.request("POST", "/v1/auth/totp/activate", {
      body: { code: codeAt(seed, stepAt(new Date())) },
      cookie: challenge,
      headers: from(),
    });
    expect(activated.status).toBe(200);

    expect((await issue("password")).outcome).toBe("issued");
  });
});
