// Better Auth as MyKey uses it (Run 2.3, D-19): password sign-in and sessions
// only. No sign-up, no reset, no social provider, no plugin; the second factor
// is product-owned (factors/). Session tokens reach the database only through
// the protected adapter.
import { randomUUID } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import { schema } from "@mykey/db";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { ephemeralKeys, type AuthKeys } from "./keys.ts";
import { protectedAdapter } from "./protected-adapter.ts";

export interface AuthDeps {
  db: NodePgDatabase;
  keys: AuthKeys;
  /** The public origin, e.g. https://mykey.nomikey.com. */
  baseURL: string;
  /**
   * Tests only: a layer placed between the protected adapter and the real one,
   * to observe what reaches the database.
   */
  observeAdapter?: <A>(
    inner: (options: BetterAuthOptions) => A,
  ) => (options: BetterAuthOptions) => A;
}

export const AUTH_BASE_PATH = "/v1/auth";

export function authOptions(deps: AuthDeps) {
  const inner = drizzleAdapter(deps.db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
    transaction: true,
  });
  const observed = deps.observeAdapter === undefined ? inner : deps.observeAdapter(inner);
  return {
    appName: "MyKey",
    baseURL: deps.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: deps.keys.cookieSecret,
    database: protectedAdapter(observed, deps.keys.sessionLookup),
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: {
      expiresIn: LIMITS.session.absoluteSeconds,
      disableSessionRefresh: true,
      freshAge: 0,
      cookieCache: { enabled: false },
      additionalFields: {
        phase: { type: "string", input: false, required: false, defaultValue: "password_verified" },
        authEpoch: { type: "number", input: false, required: false, defaultValue: 0 },
        authenticatedAt: {
          type: "date",
          input: false,
          required: false,
          defaultValue: () => new Date(),
        },
        lastUserActivityAt: {
          type: "date",
          input: false,
          required: false,
          defaultValue: () => new Date(),
        },
        totpVerifiedAt: { type: "date", input: false, required: false },
        enrollmentId: { type: "string", input: false, required: false },
      },
    },
    // Run 3.3 owns throttling; the built-in limiter is bypassed by auth.api anyway.
    rateLimit: { enabled: false },
    verification: { storeIdentifier: "hashed" },
    advanced: {
      database: { generateId: () => randomUUID() },
      // Explicit: both default to true under a test environment (D-19).
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: true,
    },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps));
}

/**
 * An instance whose database is never contacted and whose keys are thrown
 * away: for reading the route inventory and the cookie settings only
 * (scripts/auth-route-contract.ts, unit tests).
 */
export function offlineAuth(baseURL = "https://mykey.example") {
  return createAuth({
    // Port 1 on loopback: any query would fail at once; none is made.
    db: drizzle(new pg.Pool({ host: "127.0.0.1", port: 1, max: 1 })),
    keys: ephemeralKeys(),
    baseURL,
  });
}

export type Auth = ReturnType<typeof createAuth>;
