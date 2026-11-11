// Run 2.3 Task D: nothing usable is at rest (PO-15). The whole flow runs while
// every raw session token, the TOTP seed, the recovery codes and the passwords
// are collected; then a plain pg_dump of the database and the PostgreSQL log
// are searched for each of them.
import { codeAt, stepAt } from "@mykey/auth";
import * as OTPAuth from "otpauth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDump, postgresLog } from "../../harness/stack.ts";
import { authFixture, cookieOf, tokenOf, type AuthFixture } from "./fixture.ts";

let fixture: AuthFixture;
const secrets = new Map<string, string>();
let email = "";
let dump = "";
let log = "";

const keep = (what: string, value: string | undefined): string => {
  if (value === undefined || value.length < 8) throw new Error(`nothing collected for ${what}`);
  secrets.set(`${what} #${secrets.size}`, value);
  return value;
};

beforeAll(async () => {
  fixture = await authFixture();
  const since = new Date(Date.now() - 2_000).toISOString();
  const user = await fixture.seedUser("enrollment_pending");
  email = user.email;
  keep("password", user.password);

  const first = await fixture.signIn(user);
  keep("session token", tokenOf(first));
  const enrolled = await fixture.request("POST", "/v1/auth/totp/enroll", {
    cookie: first,
    body: {},
  });
  const { secret } = (await enrolled.json()) as { secret: string };
  keep("seed (base32)", secret);
  const seed = OTPAuth.Secret.fromBase32(secret).bytes;
  keep("seed (hex)", Buffer.from(seed).toString("hex"));

  const activated = await fixture.request("POST", "/v1/auth/totp/activate", {
    cookie: first,
    body: { code: codeAt(seed, stepAt(new Date())) },
  });
  expect(activated.status).toBe(200);
  const { recoveryCodes } = (await activated.json()) as { recoveryCodes: string[] };
  for (const code of recoveryCodes) {
    keep("recovery code", code);
    keep("recovery code (bare)", code.replaceAll("-", ""));
  }
  const elevated = cookieOf(activated);
  keep("session token", tokenOf(elevated ?? ""));

  const second = await fixture.signIn(user);
  keep("session token", tokenOf(second));
  const verified = await fixture.request("POST", "/v1/auth/totp/verify", {
    cookie: second,
    body: { code: codeAt(seed, stepAt(new Date()) + 1) },
  });
  expect(verified.status).toBe(200);
  keep("session token", tokenOf(cookieOf(verified) ?? ""));

  const third = await fixture.signIn(user);
  keep("session token", tokenOf(third));
  const recovered = await fixture.request("POST", "/v1/auth/recovery/verify", {
    cookie: third,
    body: { code: recoveryCodes[0] },
  });
  expect(recovered.status).toBe(200);
  const recoveredCookie = cookieOf(recovered) ?? "";
  keep("session token", tokenOf(recoveredCookie));

  const regenerated = await fixture.request("POST", "/v1/auth/recovery/regenerate", {
    cookie: recoveredCookie,
    body: {},
  });
  expect(regenerated.status).toBe(200);
  for (const code of ((await regenerated.json()) as { recoveryCodes: string[] }).recoveryCodes) {
    keep("recovery code", code);
  }

  // Last: Better Auth replaces the caller's session by a new one here.
  const newPassword = keep("password", `${user.password}-changed`);
  const changed = await fixture.request("POST", "/v1/auth/change-password", {
    cookie: recoveredCookie,
    body: { currentPassword: user.password, newPassword, revokeOtherSessions: true },
  });
  expect(changed.status).toBe(200);
  keep("session token", tokenOf(cookieOf(changed) ?? ""));

  // One failing statement with a raw token as its bind parameter.
  const failing = fixture.pool.query(
    "SELECT token FROM auth.session WHERE token = $1 AND 1 / 0 = 1",
    [tokenOf(second)],
  );
  await expect(failing).rejects.toBeInstanceOf(pg.DatabaseError);

  dump = await pgDump(fixture.db.stack, fixture.db.database);
  log = await postgresLog(fixture.db.stack, since);
}, 300_000);

afterAll(async () => {
  await fixture.close();
});

describe("at rest", () => {
  it("the dump holds the account (control) but none of the collected secrets", () => {
    expect(dump).toContain(email);
    expect(dump).toContain("CREATE TABLE auth.session");
    expect(secrets.size).toBeGreaterThan(25);
    const found = [...secrets].filter(([, value]) => dump.includes(value)).map(([what]) => what);
    expect(found).toEqual([]);
  });

  it("the PostgreSQL log shows the failing statement (control) but none of the collected secrets", () => {
    expect(log).toContain("division by zero");
    const found = [...secrets].filter(([, value]) => log.includes(value)).map(([what]) => what);
    expect(found).toEqual([]);
  });
});
