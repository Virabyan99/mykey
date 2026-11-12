// Run 2.3 Task A: the native Better Auth routes, each either allowed or denied (P-25).
import {
  NATIVE_ALLOWED,
  NATIVE_DENIED,
  ephemeralKeys,
  mountAuthRoutes,
  nativeRoutes,
  offlineAuth,
  sessionCookie,
  type AuthRouteEnv,
  type NativeRoute,
  type Throttle,
} from "@mykey/auth";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

// The database is never contacted: listing routes reads no table.
const auth = offlineAuth();

const key = (route: NativeRoute): string => `${route.method} ${route.path}`;

describe("native routes", () => {
  const routes = nativeRoutes(auth);

  it("lists the HTTP-reachable endpoints of the pinned version", () => {
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.map(key)).toContain("POST /sign-up/email");
    // Server-only endpoints have no path.
    expect(routes.map((route) => route.path)).not.toContain(undefined);
  });

  it("puts every route in exactly one of the allowed and the denied list", () => {
    const allowed = new Set(NATIVE_ALLOWED.map(key));
    const denied = new Set(NATIVE_DENIED.map(key));
    const unplaced = routes.map(key).filter((route) => allowed.has(route) === denied.has(route));
    expect(unplaced, "a route in neither or in both lists").toEqual([]);
    // The lists name nothing the library does not have.
    expect([...allowed, ...denied].filter((route) => !routes.map(key).includes(route))).toEqual([]);
  });

  it("allows exactly four routes, none with a path parameter (Run 3.5: the password change is product-owned)", () => {
    expect(NATIVE_ALLOWED.map(key)).toEqual([
      "POST /sign-in/email",
      "POST /sign-out",
      "GET /get-session",
      "POST /revoke-sessions",
    ]);
    expect(NATIVE_ALLOWED.filter((route) => route.path.includes(":"))).toEqual([]);
  });

  it("keeps the origin and CSRF checks on, also in a test run", () => {
    expect(auth.options.advanced.disableOriginCheck).toBe(false);
    expect(auth.options.advanced.disableCSRFCheck).toBe(false);
  });
});

describe("auth routes on the pipeline (Run 3.2)", () => {
  const env = {
    pool: {} as never,
    keys: ephemeralKeys(),
    baseUrl: "https://mykey.example",
    originAllowed: () => false,
    respondError: () => new Response(null, { status: 500 }),
    requestId: () => "6f1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f",
    source: () => "127.0.0.1",
    readBody: () => Promise.resolve({ ok: false as const }),
  };

  it("mountAuthRoutes without a throttle throws", () => {
    expect(() => {
      mountAuthRoutes(new Hono(), auth, env as unknown as AuthRouteEnv);
    }).toThrow(/throttl/);
    // Control: with a throttle it mounts.
    const throttle: Throttle = {
      admit: () => Promise.resolve({ allowed: true }),
      recordFailure: () => Promise.resolve(),
      clearAccount: () => Promise.resolve(),
    };
    expect(() => {
      mountAuthRoutes(new Hono(), auth, { ...env, throttle });
    }).not.toThrow();
  });

  it("the session cookie is Strict, Secure, HttpOnly, Path=/ and host-only, in one helper", async () => {
    const cookie = await sessionCookie(auth, "token-value", new Date(Date.now() + 60_000));
    const parts = cookie.split("; ");
    expect(parts[0]?.startsWith("__Secure-better-auth.session_token=")).toBe(true);
    expect(parts).toEqual(
      expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]),
    );
    expect(parts.some((part) => part.toLowerCase().startsWith("domain="))).toBe(false);
    const signIn = await sessionCookie(auth, "token-value", new Date(), 43_200);
    expect(signIn.split("; ")).toContain("Max-Age=43200");
  });
});

describe("one validity decision (Run 3.5)", () => {
  it("no source file but packages/auth/src/sessions.ts calls Better Auth's getSession", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          entry.name.endsWith(".ts") &&
          readFileSync(path, "utf8").includes("api.getSession")
        ) {
          offenders.push(path.slice(root.length + 1).replaceAll("\\", "/"));
        }
      }
    };
    for (const top of ["apps", "packages"]) walk(join(root, top));
    expect(offenders).toEqual(["packages/auth/src/sessions.ts"]);
  });
});
