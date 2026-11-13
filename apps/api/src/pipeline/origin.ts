// Browser protection the API owns (FR-1.76, Run 3.7): a state-changing request
// of a browser session must come from the product's own page, and a request
// carries one kind of credential only.
import { SESSION_COOKIE_NAME } from "@mykey/auth";
import type { RouteDef } from "@mykey/contracts";

/**
 * True when `Origin` is present and equals the origin of `baseUrl` exactly,
 * and `Sec-Fetch-Site`, when present, is `same-origin`. A missing Origin is a refusal.
 */
export function checkOrigin(headers: Headers, baseUrl: string): boolean {
  const origin = headers.get("origin");
  if (origin === null || origin !== new URL(baseUrl).origin) return false;
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

/** Every non-GET request of a browser class (human, fresh, reset flow) is checked. */
export function needsOriginCheck(route: RouteDef): boolean {
  return (
    route.method !== "GET" &&
    (route.auth === "human" || route.auth === "human_fresh_totp" || route.auth === "reset_flow")
  );
}

/** A session cookie and an Authorization header in one request (P-52): refused before any read. */
export function hasMixedCredentials(headers: Headers): boolean {
  if (!headers.has("authorization")) return false;
  const cookie = headers.get("cookie") ?? "";
  return cookie.split(";").some((pair) => pair.trim().split("=")[0] === SESSION_COOKIE_NAME);
}
