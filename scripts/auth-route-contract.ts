// Writes docs/auth-route-contract.md: the HTTP surface of the auth module
// (Run 2.3 Task E, D-19). The native route inventory, the request schemas and
// the session cookie come from the code; the rest is the table below.
// With --check it writes nothing and exits 1 when the file is stale.
// Run: node scripts/auth-route-contract.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format, resolveConfig } from "prettier";
import {
  AUTH_BASE_PATH,
  AUTH_BODIES,
  NATIVE_ALLOWED,
  authBodyJsonSchema,
  NATIVE_DENIED,
  nativeRoutes,
  offlineAuth,
} from "@mykey/auth";

const ROOT = resolve(import.meta.dirname, "..");
const CONTRACT_FILE = resolve(ROOT, "docs/auth-route-contract.md");

interface RouteContract {
  method: "GET" | "POST";
  path: string;
  kind: "native" | "factor";
  body: keyof typeof AUTH_BODIES | null;
  success: string;
  errors: string[];
  cookies: string;
  accountStates: string;
  phases: string;
}

// Run 3.3: the password phase throttles sign-in; the factor phase is shared by
// TOTP activation and verification and recovery codes.
const COMMON_ERRORS = [
  "400 `malformed_request` (body not JSON, a field missing, an unknown field)",
];

const ROUTES: RouteContract[] = [
  {
    method: "POST",
    path: "/sign-in/email",
    kind: "native",
    body: "signIn",
    success: '200, exactly `{"phase":"password_verified"}` (Run 3.2)',
    errors: [
      ...COMMON_ERRORS,
      "401 `unauthenticated`, byte-identical but for the request id, for an unknown e-mail, a wrong password, an account that is `disabled` or `recovery_pending`, and an epoch that moved during the sign-in; no cookie, no session row",
      "503 `audit_unavailable` (the audit row could not be written; no session remains)",
      "429 `rate_limited` with `Retry-After` (P-48, Run 3.3: more than 5 attempts a minute from the source, or the account locked for 900 s after 5 failures in the current and previous 15-minute window; checked before any credential, alike for known and unknown accounts)",
      "503 `dependency_unavailable` (the rate counter could not be written: nothing is checked)",
    ],
    cookies:
      "sets the session cookie of a new `password_verified` session bound to the account's current auth epoch; `Max-Age=43200`",
    accountStates: "`enrollment_pending` or `active`",
    phases: "none needed; creates `password_verified`",
  },
  {
    method: "POST",
    path: "/sign-out",
    kind: "native",
    body: "empty",
    success: "200, `{ success: true }`",
    errors: [...COMMON_ERRORS],
    cookies: "expires the session cookie; the session row is deleted",
    accountStates: "any",
    phases: "any",
  },
  {
    method: "GET",
    path: "/get-session",
    kind: "native",
    body: null,
    success: "200, `{ session, user }` without `session.token`, or `null` without a valid cookie",
    errors: [],
    cookies: "none",
    accountStates: "any",
    phases: "any; the answer names the phase",
  },
  {
    method: "POST",
    path: "/change-password",
    kind: "native",
    body: "changePassword",
    success: "200, `{ user }` without `token`",
    errors: [
      ...COMMON_ERRORS,
      "401 `unauthenticated` (no session, or wrong current password)",
      "401 `mfa_incomplete` (session not `mfa_complete`)",
    ],
    cookies:
      "with `revokeOtherSessions: true`: every session of the user is removed and a new `password_verified` session cookie is set (observed on 1.7.19, D-19); the owner passes the factor again",
    accountStates: "any (Run 3.5 adds fresh verification)",
    phases: "`mfa_complete`",
  },
  {
    method: "POST",
    path: "/revoke-sessions",
    kind: "native",
    body: "empty",
    success: "200, `{ status: true }`; every session of the user is removed, this one included",
    errors: [...COMMON_ERRORS, "401 `unauthenticated`", "401 `mfa_incomplete`"],
    cookies: "none (the cookie no longer resolves)",
    accountStates: "any",
    phases: "`mfa_complete`",
  },
  {
    method: "POST",
    path: "/totp/enroll",
    kind: "factor",
    body: "empty",
    success:
      "200, `{ enrollmentId, secret, uri }`: the base32 seed and the `otpauth://` URI, shown once; a new call replaces a pending enrollment",
    errors: [...COMMON_ERRORS, "401 `unauthenticated`", "409 `state_conflict`"],
    cookies: "none; the session moves to phase `enrollment`",
    accountStates: "`enrollment_pending`",
    phases: "`password_verified` or `enrollment`, within 600 s of the password",
  },
  {
    method: "POST",
    path: "/totp/activate",
    kind: "factor",
    body: "code",
    success:
      "200, `{ recoveryCodes }`: ten codes, shown once; the enrollment and the account become `active`",
    errors: [
      ...COMMON_ERRORS,
      "401 `unauthenticated` (wrong, replayed or expired code, or no session)",
      "409 `state_conflict`",
      "429 `rate_limited` with `Retry-After` (P-48, Run 3.3: more than 5 attempts a minute from the source, or the account locked for 900 s after 5 failures in the current and previous 15-minute window; checked before any credential, alike for known and unknown accounts)",
      "503 `dependency_unavailable` (the rate counter could not be written: nothing is checked)",
    ],
    cookies: "sets the cookie of a new `mfa_complete` session; the old cookie stops working",
    accountStates: "`enrollment_pending`",
    phases: "`enrollment`, within 600 s of the password",
  },
  {
    method: "POST",
    path: "/totp/verify",
    kind: "factor",
    body: "code",
    success: '200, `{ phase: "mfa_complete" }`',
    errors: [
      ...COMMON_ERRORS,
      "401 `unauthenticated` (wrong, replayed or expired code, or no session)",
      "409 `state_conflict`",
      "429 `rate_limited` with `Retry-After` (P-48, Run 3.3: more than 5 attempts a minute from the source, or the account locked for 900 s after 5 failures in the current and previous 15-minute window; checked before any credential, alike for known and unknown accounts)",
      "503 `dependency_unavailable` (the rate counter could not be written: nothing is checked)",
    ],
    cookies: "sets the cookie of a new `mfa_complete` session; the old cookie stops working",
    accountStates: "`active`",
    phases: "`password_verified`, within 600 s of the password",
  },
  {
    method: "POST",
    path: "/recovery/verify",
    kind: "factor",
    body: "code",
    success:
      '200, `{ phase: "mfa_complete" }`; the code is consumed; `totp_verified_at` stays empty',
    errors: [
      ...COMMON_ERRORS,
      "401 `unauthenticated` (unknown or used code, or no session)",
      "409 `state_conflict`",
      "429 `rate_limited` with `Retry-After` (P-48, Run 3.3: more than 5 attempts a minute from the source, or the account locked for 900 s after 5 failures in the current and previous 15-minute window; checked before any credential, alike for known and unknown accounts)",
      "503 `dependency_unavailable` (the rate counter could not be written: nothing is checked)",
    ],
    cookies: "sets the cookie of a new `mfa_complete` session; the old cookie stops working",
    accountStates: "`active`",
    phases: "`password_verified`, within 600 s of the password",
  },
  {
    method: "POST",
    path: "/recovery/regenerate",
    kind: "factor",
    body: "empty",
    success:
      "200, `{ recoveryCodes }`: every unused code is invalid before the ten new ones are returned",
    errors: [
      ...COMMON_ERRORS,
      "401 `unauthenticated`",
      "403 `fresh_verification_required` (no TOTP verification of this session in the last 600 s, on database time; a session completed with a recovery code has none — step up first)",
      "409 `state_conflict`",
    ],
    cookies: "none",
    accountStates: "`active`",
    phases: "`mfa_complete`",
  },
  {
    method: "POST",
    path: "/totp/step-up",
    kind: "factor",
    body: "code",
    success:
      "200, `{ fresh: true }`: the session's TOTP verification is now (database time); the step is used once; the token does not change (Run 3.4)",
    errors: [
      ...COMMON_ERRORS,
      "401 `unauthenticated` (a wrong, replayed or expired code, alike; the session goes on)",
      "409 `state_conflict` (not an `mfa_complete` session of an `active` account)",
      "429 `rate_limited` with `Retry-After` (the `factor` phase of P-48)",
      "503 `dependency_unavailable` (the rate counter could not be written)",
    ],
    cookies: "none",
    accountStates: "`active`",
    phases: "`mfa_complete`",
  },
];

function schemaText(name: keyof typeof AUTH_BODIES | null): string {
  if (name === null) return "no body";
  return `\`${JSON.stringify(authBodyJsonSchema(name))}\``;
}

async function render(): Promise<string> {
  const auth = offlineAuth();
  const context = await auth.$context;
  const cookie = context.authCookies.sessionToken;
  const version = (
    JSON.parse(
      readFileSync(resolve(ROOT, "packages/auth/node_modules/better-auth/package.json"), "utf8"),
    ) as { version: string }
  ).version;
  const allowed = new Set(NATIVE_ALLOWED.map((route) => `${route.method} ${route.path}`));
  const denied = new Set(NATIVE_DENIED.map((route) => `${route.method} ${route.path}`));
  const lines: string[] = [
    "# Auth route contract",
    "",
    "Generated by `node scripts/auth-route-contract.ts` from `@mykey/auth`. Do not edit by hand; `pnpm run auth:contract:check` fails when this file is stale. Decision record: `docs/decisions/D-19-auth-storage-design.md`.",
    "",
    `- **Library:** better-auth ${version}, password sign-in and sessions only. No catch-all handler is mounted (P-25); every route below has its own handler, and every other path under \`${AUTH_BASE_PATH}\` answers \`404 not_found\`.`,
    `- **Session cookie:** \`${cookie.name}\`, attributes \`${JSON.stringify(cookie.attributes)}\`. Its value is \`<token>.<signature>\`, signed by Better Auth; the database stores only \`v1.<keyId>.<HMAC>\` of the token (P-26).`,
    "- **Errors:** the contract envelope `{ error: { code, message, requestId } }`. A wrong, a replayed and an expired code get the same answer.",
    "- **Origin check:** product (Run 3.7). `auth.api` calls bypass Better Auth's own Origin and CSRF checks, which stay enabled in its options.",
    "- **Throttling:** product (Run 3.3). Better Auth's limiter is off.",
    "",
    "## Native routes",
    "",
    "| Method | Path | Here |",
    "| --- | --- | --- |",
  ];
  for (const route of nativeRoutes(auth)) {
    const key = `${route.method} ${route.path}`;
    const placed = allowed.has(key) ? "allowed" : denied.has(key) ? "denied (404)" : "UNPLACED";
    lines.push(`| ${route.method} | \`${route.path}\` | ${placed} |`);
  }
  lines.push("", "## Served routes", "");
  for (const route of ROUTES) {
    lines.push(
      `### ${route.method} \`${AUTH_BASE_PATH}${route.path}\` (${route.kind})`,
      "",
      `- **Request body:** ${schemaText(route.body)}`,
      `- **Success:** ${route.success}`,
      `- **Errors:** ${route.errors.length === 0 ? "none of its own" : route.errors.join("; ")}`,
      `- **Cookies:** ${route.cookies}`,
      `- **Account states:** ${route.accountStates}`,
      `- **Session phases:** ${route.phases}`,
      "- **Origin check:** product (Run 3.7)",
      "",
    );
  }
  return lines.join("\n");
}

async function formatted(text: string): Promise<string> {
  const options = (await resolveConfig(CONTRACT_FILE)) ?? {};
  return format(text, { ...options, filepath: CONTRACT_FILE });
}

if (import.meta.main) {
  const text = await formatted(await render());
  const unplaced = text.includes("UNPLACED");
  if (process.argv.includes("--check")) {
    let committed: string;
    try {
      committed = readFileSync(CONTRACT_FILE, "utf8");
    } catch {
      committed = "";
    }
    if (committed !== text || unplaced) {
      console.error(
        unplaced
          ? "auth route contract: a native route is neither allowed nor denied"
          : "auth route contract: docs/auth-route-contract.md is out of date",
      );
      console.error("Run: node scripts/auth-route-contract.ts");
      process.exit(1);
    }
    console.log(`auth route contract: current (${ROUTES.length} served routes).`);
  } else {
    writeFileSync(CONTRACT_FILE, text);
    console.log(`Wrote ${CONTRACT_FILE} (${ROUTES.length} served routes).`);
    if (unplaced) process.exit(1);
  }
  // The offline instance holds a pool that was never used.
  process.exit(0);
}
