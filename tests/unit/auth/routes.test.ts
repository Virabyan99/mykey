// Run 2.3 Task A: the native Better Auth routes, each either allowed or denied (P-25).
import {
  NATIVE_ALLOWED,
  NATIVE_DENIED,
  nativeRoutes,
  offlineAuth,
  type NativeRoute,
} from "@mykey/auth";
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

  it("allows exactly five routes, none with a path parameter", () => {
    expect(NATIVE_ALLOWED.map(key)).toEqual([
      "POST /sign-in/email",
      "POST /sign-out",
      "GET /get-session",
      "POST /change-password",
      "POST /revoke-sessions",
    ]);
    expect(NATIVE_ALLOWED.filter((route) => route.path.includes(":"))).toEqual([]);
  });

  it("keeps the origin and CSRF checks on, also in a test run", () => {
    expect(auth.options.advanced.disableOriginCheck).toBe(false);
    expect(auth.options.advanced.disableCSRFCheck).toBe(false);
  });
});
