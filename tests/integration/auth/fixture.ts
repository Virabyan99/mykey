// Shared set-up of the auth suites (Run 2.3): a fresh database with every
// migration, Better Auth connected as api_runtime, keys generated in memory,
// and users created through the operator path a bootstrap will use (sign-up
// stays closed).
import { randomBytes, randomUUID } from "node:crypto";
import {
  codeAt,
  createAuth,
  stepAt,
  type FactorDeps,
  mountAuthRoutes,
  type Auth,
  type AuthDeps,
  type AuthKeys,
  type KeyRing,
} from "@mykey/auth";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import * as OTPAuth from "otpauth";
import type pg from "pg";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

export const BASE_URL = "https://mykey.test";
export const COOKIE_NAME = "__Secure-better-auth.session_token";

export function keyRing(...ids: string[]): KeyRing {
  const sorted = [...ids].sort();
  return {
    current: sorted.at(-1) ?? "k1",
    keys: Object.fromEntries(sorted.map((id) => [id, new Uint8Array(randomBytes(32))])),
  };
}

export function testKeys(): AuthKeys {
  return {
    cookieSecret: randomBytes(32).toString("base64url"),
    sessionLookup: keyRing("k1"),
    seedEncryption: keyRing("k1"),
    recoveryVerifier: keyRing("k1"),
  };
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
}

export interface AuthFixture {
  db: TestDatabase;
  /** The pool Better Auth uses: logged in as api_runtime. */
  pool: pg.Pool;
  keys: AuthKeys;
  auth: Auth;
  app: Hono;
  /** Creates a user, its credential account and its account state, as an operator would. */
  seedUser(state?: string): Promise<SeededUser>;
  /** One request to the app, with the Origin of the product. */
  request(
    method: string,
    path: string,
    init?: { body?: unknown; cookie?: string },
  ): Promise<Response>;
  /** Signs in and returns the cookie pair `name=value` to send back. */
  signIn(user: SeededUser): Promise<string>;
  /** Rebuilds auth and app over the same database, e.g. with other keys. */
  rebuild(change: {
    keys?: AuthKeys;
    observeAdapter?: AuthDeps["observeAdapter"] | undefined;
  }): void;
  close(): Promise<void>;
}

export function cookieOf(response: Response): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0] ?? "";
    if (pair.startsWith(`${COOKIE_NAME}=`) && pair.length > COOKIE_NAME.length + 1) return pair;
  }
  return undefined;
}

/** The raw session token inside a cookie pair (Better Auth signs it as `<token>.<signature>`). */
export function tokenOf(cookie: string): string {
  const value = decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1));
  return value.slice(0, value.lastIndexOf("."));
}

export async function authFixture(): Promise<AuthFixture> {
  const db = await prepareDatabase();
  const pool = db.pool("api_runtime");
  let keys = testKeys();
  let observeAdapter: AuthDeps["observeAdapter"];
  let auth: Auth;
  let app: Hono;
  const build = (): void => {
    auth = createAuth({
      db: drizzle(pool),
      keys,
      baseURL: BASE_URL,
      ...(observeAdapter === undefined ? {} : { observeAdapter }),
    });
    app = new Hono();
    mountAuthRoutes(app, auth, { pool, keys });
  };
  build();

  const request: AuthFixture["request"] = async (method, path, init = {}) => {
    const headers: Record<string, string> = { origin: BASE_URL };
    if (init.cookie !== undefined) headers.cookie = init.cookie;
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    return app.request(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  };

  return {
    db,
    pool,
    get keys() {
      return keys;
    },
    get auth() {
      return auth;
    },
    get app() {
      return app;
    },
    async seedUser(state = "active") {
      const user: SeededUser = {
        id: randomUUID(),
        email: `user-${randomBytes(4).toString("hex")}@example.test`,
        password: randomBytes(18).toString("base64url"),
      };
      const hash = await (await auth.$context).password.hash(user.password);
      await run(
        pool,
        'INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
        [user.id, "Synthetic Owner", user.email],
      );
      await run(
        pool,
        "INSERT INTO auth.account (id, account_id, provider_id, user_id, password) VALUES ($1, $2, 'credential', $3, $4)",
        [randomUUID(), user.id, user.id, hash],
      );
      await run(pool, "INSERT INTO auth.account_state (user_id, state) VALUES ($1, $2)", [
        user.id,
        state,
      ]);
      return user;
    },
    request,
    async signIn(user) {
      const response = await request("POST", "/v1/auth/sign-in/email", {
        body: { email: user.email, password: user.password },
      });
      if (response.status !== 200) {
        throw new Error(`sign-in answered ${response.status}: ${await response.text()}`);
      }
      const cookie = cookieOf(response);
      if (cookie === undefined) throw new Error("sign-in set no session cookie");
      return cookie;
    },
    rebuild(change) {
      if (change.keys !== undefined) keys = change.keys;
      if ("observeAdapter" in change) observeAdapter = change.observeAdapter;
      build();
    },
    close: () => db.drop(),
  };
}

/** Number of rows in every table of schema auth, to show a request created none. */
export async function authRowCounts(pool: pg.Pool): Promise<Record<string, number>> {
  const rows = await run<{ table: string; count: string }>(
    pool,
    `SELECT 'user' AS table, count(*) FROM auth."user" UNION ALL
     SELECT 'session', count(*) FROM auth.session UNION ALL
     SELECT 'account', count(*) FROM auth.account UNION ALL
     SELECT 'verification', count(*) FROM auth.verification`,
  );
  return Object.fromEntries(rows.map((row) => [row.table, Number(row.count)]));
}

export interface EnrolledUser extends SeededUser {
  /** The TOTP seed as the authenticator app holds it. */
  seed: Uint8Array;
  recoveryCodes: string[];
  /** The mfa_complete cookie that activation set. */
  elevatedCookie: string;
}

/** An account taken through the HTTP enrollment routes: sign-in, enroll, activate. */
export async function enrolledUser(fixture: AuthFixture): Promise<EnrolledUser> {
  const user = await fixture.seedUser("enrollment_pending");
  const cookie = await fixture.signIn(user);
  const enrolled = await fixture.request("POST", "/v1/auth/totp/enroll", { cookie, body: {} });
  if (enrolled.status !== 200) throw new Error(`enroll answered ${enrolled.status}`);
  const { secret } = (await enrolled.json()) as { secret: string };
  const seed = OTPAuth.Secret.fromBase32(secret).bytes;
  const activated = await fixture.request("POST", "/v1/auth/totp/activate", {
    cookie,
    body: { code: codeAt(seed, stepAt(new Date())) },
  });
  if (activated.status !== 200) throw new Error(`activate answered ${activated.status}`);
  const { recoveryCodes } = (await activated.json()) as { recoveryCodes: string[] };
  const elevatedCookie = cookieOf(activated);
  if (elevatedCookie === undefined) throw new Error("activation set no session cookie");
  return { ...user, seed, recoveryCodes, elevatedCookie };
}

export function factorDeps(fixture: AuthFixture): FactorDeps {
  return { pool: fixture.pool, keys: fixture.keys, auth: fixture.auth };
}
