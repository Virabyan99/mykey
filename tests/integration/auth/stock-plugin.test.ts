// Run 2.3 Task B: why Better Auth's stock two-factor plugin is not used (P-24).
//
// A throw-away instance with `twoFactor()` on its own fresh database (public
// schema, tables made by the library's own migration). Each test asserts that a
// weakness is PRESENT in better-auth 1.7.19; if one is absent the test fails
// and D-19 must say so.
import { randomBytes } from "node:crypto";
import { connectionConfig } from "@mykey/db";
import { betterAuth } from "better-auth";
import { symmetricDecrypt } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import * as OTPAuth from "otpauth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, getSharedStack } from "../../harness/stack.ts";

let pool: pg.Pool;
let drop: () => Promise<void>;
let auth: ReturnType<typeof createStock>;

function createStock(database: pg.Pool) {
  return betterAuth({
    database,
    secret: randomBytes(32).toString("base64url"),
    baseURL: "https://stock.test",
    emailAndPassword: { enabled: true },
    plugins: [twoFactor({ issuer: "Stock" })],
    telemetry: { enabled: false },
  });
}

/** Every `name=value` pair a response sets, as one Cookie header. */
const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");

const owner = {
  email: `stock-${randomBytes(4).toString("hex")}@example.test`,
  password: randomBytes(18).toString("base64url"),
  name: "Synthetic Owner",
};
let totp: OTPAuth.TOTP;
let backupCodes: string[];

async function challenge(): Promise<string> {
  const response = await auth.api.signInEmail({
    body: { email: owner.email, password: owner.password },
    asResponse: true,
  });
  const body = (await response.json()) as { twoFactorRedirect?: boolean };
  expect(body.twoFactorRedirect).toBe(true);
  return cookiesOf(response);
}

beforeAll(async () => {
  const stack = await getSharedStack();
  const fresh = await freshDatabase(stack);
  drop = () => fresh.drop();
  pool = new pg.Pool(
    connectionConfig({
      host: stack.pg.host,
      port: stack.pg.port,
      database: fresh.database,
      ...stack.pg.superuser,
      caCertPath: stack.pg.caCertPath,
    }),
  );
  auth = createStock(pool);
  await (await auth.$context).runMigrations();

  const signUp = await auth.api.signUpEmail({ body: owner, asResponse: true });
  expect(signUp.status).toBe(200);
  const session = cookiesOf(signUp);
  const enabled = await auth.api.enableTwoFactor({
    body: { password: owner.password },
    headers: new Headers({ cookie: session }),
  });
  if (enabled.method !== "totp") throw new Error("enableTwoFactor did not choose TOTP");
  backupCodes = enabled.backupCodes;
  totp = OTPAuth.URI.parse(enabled.totpURI) as OTPAuth.TOTP;
  const activated = await auth.api.verifyTOTP({
    body: { code: totp.generate() },
    headers: new Headers({ cookie: session }),
    asResponse: true,
  });
  expect(activated.status).toBe(200);
});

afterAll(async () => {
  await pool.end();
  await drop();
});

describe("better-auth 1.7.19 twoFactor()", () => {
  it("accepts a TOTP code twice inside its window", async () => {
    const code = totp.generate();
    const answers: number[] = [];
    for (let round = 0; round < 2; round += 1) {
      const cookie = await challenge();
      const response = await auth.api.verifyTOTP({
        body: { code },
        headers: new Headers({ cookie }),
        asResponse: true,
      });
      answers.push(response.status);
      expect(cookiesOf(response), `round ${round}`).toContain("session_token=");
    }
    // The weakness: the second use of the same code also completes sign-in.
    expect(answers).toEqual([200, 200]);
  });

  it("stores the backup codes so that the server secret decrypts them", async () => {
    const rows = await pool.query<{ backupCodes: string }>('SELECT "backupCodes" FROM "twoFactor"');
    expect(rows.rows).toHaveLength(1);
    const stored = rows.rows[0]?.backupCodes ?? "";
    expect(stored).not.toContain(backupCodes[0]);
    const decrypted = await symmetricDecrypt({
      key: (await auth.$context).secretConfig,
      data: stored,
    });
    // The weakness: every code is recoverable from the row and the server's key.
    expect(JSON.parse(decrypted)).toEqual(backupCodes);
  });

  it("sets a trust-device cookie when the client asks for it", async () => {
    const cookie = await challenge();
    // A code of the next step: the replay of the first test is not needed here.
    const code = totp.generate({ timestamp: Date.now() + 30_000 });
    const response = await auth.api.verifyTOTP({
      body: { code, trustDevice: true },
      headers: new Headers({ cookie }),
      asResponse: true,
    });
    expect(response.status).toBe(200);
    // The weakness: a body field, with no configuration switch, skips the factor for 30 days.
    const trust = response.headers.getSetCookie().find((value) => value.includes("trust_device="));
    expect(trust).toBeDefined();
    expect(trust).toMatch(/Max-Age=2592000/i);
  });
});
