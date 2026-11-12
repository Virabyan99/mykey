// The HTTP surface of the auth module (P-25, D-19), seated on the API's
// pipeline in Run 3.2: the pipeline's envelope builder, request id and body
// reader come in through `AuthRouteEnv`. No Better Auth catch-all handler is
// mounted: each allowed native endpoint has its own route that calls
// `auth.api.<name>` with a strict body, and every other path under /v1/auth
// answers the contract's 404 envelope.
import { AuditUnavailable, type AuditEvent } from "@mykey/audit";
import type { ErrorCode } from "@mykey/contracts";
import type { Context, Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import { AUTH_BASE_PATH, type Auth } from "./auth.ts";
import {
  activateTotp,
  elevateWithRecoveryCode,
  elevateWithTotp,
  enrollTotp,
  regenerateRecoveryCodes,
  stepUpWithTotp,
  type FactorAudit,
  type FactorDeps,
  type FailureReason,
} from "./factors/elevate.ts";
import type { AuthKeys } from "./keys.ts";
import { changePassword, type ChangeResult } from "./password.ts";
import {
  listSessions,
  nativeSessionResponse,
  resolveSession,
  revokeSession,
  type SessionDeps,
} from "./sessions.ts";
import { signInWithPassword } from "./sign-in.ts";
import { normalizeEmail } from "./email.ts";
import type { Admission, Throttle, ThrottlePhase } from "./throttle.ts";

export interface NativeRoute {
  method: string;
  path: string;
}

/**
 * The four native endpoints MyKey serves (the password change is product-owned
 * since Run 3.5, P-49). None has a path parameter.
 */
export const NATIVE_ALLOWED: readonly NativeRoute[] = Object.freeze([
  { method: "POST", path: "/sign-in/email" },
  { method: "POST", path: "/sign-out" },
  { method: "GET", path: "/get-session" },
  { method: "POST", path: "/revoke-sessions" },
]);

/**
 * Paths of native endpoints that are served by product code instead (the
 * native handler is never called): they answer, although the native endpoint
 * is denied.
 */
export const PRODUCT_OWNED: readonly NativeRoute[] = Object.freeze([
  { method: "POST", path: "/change-password" },
]);

/**
 * Every other HTTP-reachable native endpoint of better-auth 1.7.19. An upgrade
 * that adds one fails `routes.test.ts` until it is placed in one of the lists.
 */
export const NATIVE_DENIED: readonly NativeRoute[] = Object.freeze([
  { method: "POST", path: "/change-password" },
  { method: "POST", path: "/sign-in/social" },
  { method: "GET", path: "/callback/:id" },
  { method: "POST", path: "/callback/:id" },
  { method: "POST", path: "/get-session" },
  { method: "POST", path: "/sign-up/email" },
  { method: "POST", path: "/reset-password" },
  { method: "POST", path: "/verify-password" },
  { method: "GET", path: "/verify-email" },
  { method: "POST", path: "/send-verification-email" },
  { method: "POST", path: "/change-email" },
  { method: "POST", path: "/update-session" },
  { method: "POST", path: "/update-user" },
  { method: "POST", path: "/delete-user" },
  { method: "POST", path: "/request-password-reset" },
  { method: "GET", path: "/reset-password/:token" },
  { method: "GET", path: "/list-sessions" },
  { method: "POST", path: "/revoke-session" },
  { method: "POST", path: "/revoke-other-sessions" },
  { method: "POST", path: "/link-social" },
  { method: "GET", path: "/list-accounts" },
  { method: "GET", path: "/delete-user/callback" },
  { method: "POST", path: "/unlink-account" },
  { method: "POST", path: "/refresh-token" },
  { method: "POST", path: "/get-access-token" },
  { method: "GET", path: "/account-info" },
  { method: "GET", path: "/ok" },
  { method: "GET", path: "/error" },
]);

interface Endpoint {
  path?: unknown;
  options?: { method?: unknown; metadata?: { SERVER_ONLY?: unknown } };
}

/** Every (method, path) of `auth.api` that HTTP can reach, sorted. */
export function nativeRoutes(auth: Auth): NativeRoute[] {
  const routes: NativeRoute[] = [];
  for (const endpoint of Object.values(auth.api as Record<string, Endpoint>)) {
    if (typeof endpoint.path !== "string") continue;
    if (endpoint.options?.metadata?.SERVER_ONLY === true) continue;
    const method = endpoint.options?.method;
    const methods = Array.isArray(method) ? method : [method];
    for (const one of methods) routes.push({ method: String(one), path: endpoint.path });
  }
  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

// ------------------------------------------------------------- environment

/** What the API gives the auth routes (Run 3.2). */
export interface AuthRouteEnv {
  /** Logged in as api_runtime. */
  pool: pg.Pool;
  keys: AuthKeys;
  /** The public origin. */
  baseUrl: string;
  /** The API's one envelope builder. */
  respondError(code: ErrorCode, requestId: string, headers?: Record<string, string>): Response;
  /** The pipeline's request id of `c`. */
  requestId(c: Context): string;
  /** The request source (Run 3.3: the trusted edge's forwarded address, else the peer). */
  source(c: Context): string;
  /** The pipeline's body reader: the body rules of Run 3.1 with the auth limit. */
  readBody(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }>;
  audit?: (event: AuditEvent) => Promise<void>;
  /** Throttling of password and factor attempts (Run 3.3); required. */
  throttle: Throttle;
  /**
   * The time a TOTP code is checked at (the API's clock, ±1 step). Only the
   * integration harness gives one; otherwise it is the current time.
   */
  now?: (c: Context) => Date | undefined;
}

/** Better Auth's error status → the contract's code. */
function codeForStatus(status: number): ErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "action_denied";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "dependency_unavailable";
  return "malformed_request";
}

/**
 * Passes a native answer on: errors as the envelope, JSON bodies without any
 * token. A 2xx answer that is not JSON is `dependency_unavailable` (M16).
 */
export async function relayNative(
  response: Response,
  env: Pick<AuthRouteEnv, "respondError">,
  requestId: string,
): Promise<Response> {
  if (!response.ok) {
    const envelope = env.respondError(codeForStatus(response.status), requestId);
    const headers = new Headers(envelope.headers);
    for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return new Response(envelope.body, { status: envelope.status, headers });
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return env.respondError("dependency_unavailable", requestId);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    return env.respondError("dependency_unavailable", requestId);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(withoutTokens(body)), { status: response.status, headers });
}

/** Removes every `token` field: the client has its cookie and needs no copy. */
function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, inner]) =>
      key === "token" ? [] : [[key, withoutTokens(inner)]],
    ),
  );
}

// ------------------------------------------------------------------- bodies

const MAX_PASSWORD = 1024;
const signInBody = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(1).max(MAX_PASSWORD),
});
const changePasswordBody = z.strictObject({
  currentPassword: z.string().min(1).max(MAX_PASSWORD),
  newPassword: z.string().min(1).max(MAX_PASSWORD),
});
const revokeSessionBody = z.strictObject({ sessionId: z.uuid() });
const emptyBody = z.strictObject({});

/** The body parsed by the pipeline's reader and by `schema`, or undefined when either refuses it. */
export async function strictBody<T>(
  c: Context,
  schema: z.ZodType<T>,
  env: Pick<AuthRouteEnv, "readBody">,
): Promise<T | undefined> {
  const read = await env.readBody(c);
  if (!read.ok) return undefined;
  const result = schema.safeParse(read.value);
  return result.success ? result.data : undefined;
}

/**
 * A product route's guard (Doc 10 §4.1 rule 5: from current database state on
 * every request), decided by `resolveSession`: the refusal's code, or null.
 */
export async function requireMfaComplete(
  deps: SessionDeps,
  headers: Headers,
): Promise<ErrorCode | null> {
  const verdict = await resolveSession(deps, headers);
  if (!verdict.ok) return "unauthenticated";
  if (verdict.session.phase !== "mfa_complete") return "mfa_incomplete";
  return null;
}

// ------------------------------------------------------------------- mount

/** A failed factor step: the same answer for a wrong, a replayed and an expired code. */
const factorFailureCode = (reason: FailureReason): ErrorCode =>
  reason === "wrong_state"
    ? "state_conflict"
    : reason === "not_fresh"
      ? "fresh_verification_required"
      : "unauthenticated";

const codeBody = z.strictObject({ code: z.string().min(1).max(64) });

/** The raw token and the user of the request's session, when `resolveSession` admits it. */
async function sessionOf(
  deps: SessionDeps,
  headers: Headers,
): Promise<{ token: string; userId: string } | null> {
  const verdict = await resolveSession(deps, headers);
  return verdict.ok ? { token: verdict.session.token, userId: verdict.session.userId } : null;
}

/** What a throttled step answers before its credential is looked at, or null to go on. */
async function throttled(
  env: AuthRouteEnv,
  c: Context,
  phase: ThrottlePhase,
  account: string | null,
): Promise<Response | null> {
  const requestId = env.requestId(c);
  let admission: Admission;
  try {
    admission = await env.throttle.admit(phase, { source: env.source(c), account });
  } catch {
    return env.respondError("dependency_unavailable", requestId);
  }
  if (admission.allowed) return null;
  try {
    // No user id: a refusal must not tell whether the account exists.
    await env.audit?.({
      action: "auth.throttled",
      actor: { kind: "anonymous", id: null },
      source: "api",
      organizationId: null,
      target: null,
      outcome: "denied",
      requestId,
      operationId: null,
      details: { phase },
    });
  } catch {
    return env.respondError("audit_unavailable", requestId);
  }
  return env.respondError("rate_limited", requestId, {
    "retry-after": String(admission.retryAfterSeconds),
  });
}

/** Counts a failed credential; a counter that cannot be written is never answered as a success. */
async function failed(
  env: AuthRouteEnv,
  c: Context,
  phase: ThrottlePhase,
  account: string,
  code: ErrorCode,
): Promise<Response> {
  try {
    await env.throttle.recordFailure(phase, account);
  } catch {
    return env.respondError("dependency_unavailable", env.requestId(c));
  }
  return env.respondError(code, env.requestId(c));
}

const FACTOR_PATHS = [
  "/totp/enroll",
  "/totp/activate",
  "/totp/verify",
  "/totp/step-up",
  "/recovery/verify",
  "/recovery/regenerate",
] as const;

/** Product routes of the auth module that have no native counterpart (P-50). */
const PRODUCT_ROUTES: readonly NativeRoute[] = [
  { method: "GET", path: "/sessions" },
  { method: "POST", path: "/sessions/revoke" },
];

/** Every route the auth module serves, as the app registers it (full paths). */
export function servedAuthRoutes(): NativeRoute[] {
  return [...NATIVE_ALLOWED, ...PRODUCT_OWNED, ...PRODUCT_ROUTES]
    .map((route) => ({ method: route.method, path: `${AUTH_BASE_PATH}${route.path}` }))
    .concat(FACTOR_PATHS.map((path) => ({ method: "POST", path: `${AUTH_BASE_PATH}${path}` })));
}

const json = (body: unknown, setCookie?: string): Response => {
  const headers = new Headers({ "content-type": "application/json" });
  if (setCookie !== undefined) headers.append("set-cookie", setCookie);
  return new Response(JSON.stringify(body), { status: 200, headers });
};

/** Any Env of the API's Hono app. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHono = Hono<any>;

/**
 * Registers the allowed native routes and the factor routes; everything else
 * under /v1/auth is 404. Refuses to mount without throttling (Run 3.3).
 */
export function mountAuthRoutes(app: AnyHono, auth: Auth, env: AuthRouteEnv): void {
  // The type requires it; this guards callers that bypass the type.
  if ((env.throttle as Throttle | undefined) === undefined) {
    throw new Error("the auth routes need throttling (Run 3.3); none was given");
  }
  const base = AUTH_BASE_PATH;
  const refuse = (c: Context, code: ErrorCode): Response =>
    env.respondError(code, env.requestId(c));
  const sessions: SessionDeps = { auth, pool: env.pool, keys: env.keys };

  app.post(`${base}/sign-in/email`, async (c) => {
    const body = await strictBody(c, signInBody, env);
    if (body === undefined) return refuse(c, "malformed_request");
    // The account is the e-mail as submitted, whether or not such a user exists.
    const account = normalizeEmail(body.email);
    const refusal = await throttled(env, c, "password", account);
    if (refusal !== null) return refusal;
    try {
      const result = await signInWithPassword(
        { auth, pool: env.pool, keys: env.keys },
        { ...body, headers: c.req.raw.headers, requestId: env.requestId(c) },
      );
      if (!result.ok) return await failed(env, c, "password", account, "unauthenticated");
      return json({ phase: result.phase }, result.setCookie);
    } catch (error) {
      if (error instanceof AuditUnavailable) return refuse(c, "audit_unavailable");
      throw error;
    }
  });

  app.post(`${base}/sign-out`, async (c) => {
    if ((await strictBody(c, emptyBody, env)) === undefined) return refuse(c, "malformed_request");
    return relayNative(
      await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true }),
      env,
      env.requestId(c),
    );
  });

  app.get(`${base}/get-session`, async (c) => {
    if (!(await env.readBody(c)).ok) return refuse(c, "malformed_request");
    // The same decision as every product route: a session it refuses does not exist here either.
    const verdict = await resolveSession(sessions, c.req.raw.headers);
    if (!verdict.ok) return json(null);
    return relayNative(await nativeSessionResponse(auth, c.req.raw.headers), env, env.requestId(c));
  });

  // The product-owned password change (P-49): see password.ts.
  app.post(`${base}/change-password`, async (c) => {
    const body = await strictBody(c, changePasswordBody, env);
    if (body === undefined) return refuse(c, "malformed_request");
    const verdict = await resolveSession(sessions, c.req.raw.headers);
    if (!verdict.ok) return refuse(c, "unauthenticated");
    if (verdict.session.phase !== "mfa_complete") return refuse(c, "mfa_incomplete");
    const email = await env.pool.query<{ email: string }>(
      'SELECT email FROM auth."user" WHERE id = $1',
      [verdict.session.userId],
    );
    const account = email.rows[0]?.email ?? verdict.session.userId;
    const refusal = await throttled(env, c, "password", account);
    if (refusal !== null) return refusal;
    let result: ChangeResult;
    try {
      result = await changePassword(
        { auth, pool: env.pool },
        { ...body, sessionId: verdict.session.id, requestId: env.requestId(c) },
      );
    } catch (error) {
      if (error instanceof AuditUnavailable) return refuse(c, "audit_unavailable");
      throw error;
    }
    if (result.ok) return json({ revokedSessions: result.revoked });
    if (result.reason === "wrong_password") {
      return failed(env, c, "password", account, "unauthenticated");
    }
    return refuse(
      c,
      result.reason === "not_fresh"
        ? "fresh_verification_required"
        : result.reason === "password_rejected"
          ? "validation_failed"
          : "unauthenticated",
    );
  });

  // P-50: the user's sessions and the revocation of one of them. No token leaves.
  app.get(`${base}/sessions`, async (c) => {
    if (!(await env.readBody(c)).ok) return refuse(c, "malformed_request");
    const verdict = await resolveSession(sessions, c.req.raw.headers);
    if (!verdict.ok) return refuse(c, "unauthenticated");
    if (verdict.session.phase !== "mfa_complete") return refuse(c, "mfa_incomplete");
    return json({
      sessions: await listSessions(env.pool, verdict.session.userId, verdict.session.id),
    });
  });

  app.post(`${base}/sessions/revoke`, async (c) => {
    const body = await strictBody(c, revokeSessionBody, env);
    if (body === undefined) return refuse(c, "malformed_request");
    const verdict = await resolveSession(sessions, c.req.raw.headers);
    if (!verdict.ok) return refuse(c, "unauthenticated");
    if (verdict.session.phase !== "mfa_complete") return refuse(c, "mfa_incomplete");
    // Another user's session is the same 404 as an absent one.
    if (!(await revokeSession(env.pool, verdict.session.userId, body.sessionId))) {
      return refuse(c, "not_found");
    }
    return json({});
  });

  app.post(`${base}/revoke-sessions`, async (c) => {
    if ((await strictBody(c, emptyBody, env)) === undefined) return refuse(c, "malformed_request");
    const denied = await requireMfaComplete(sessions, c.req.raw.headers);
    if (denied !== null) return refuse(c, denied);
    return relayNative(
      await auth.api.revokeSessions({ headers: c.req.raw.headers, asResponse: true }),
      env,
      env.requestId(c),
    );
  });

  mountFactorRoutes(app, { pool: env.pool, keys: env.keys, auth }, env, refuse);
  // Everything else under the auth base path: the contract's 404, registered last.
  app.all(base, (c) => refuse(c, "not_found"));
  app.all(`${base}/*`, (c) => refuse(c, "not_found"));
}

function mountFactorRoutes(
  app: AnyHono,
  deps: FactorDeps,
  env: AuthRouteEnv,
  refuse: (c: Context, code: ErrorCode) => Response,
): void {
  const base = AUTH_BASE_PATH;
  /** Body, session token and user of a factor request, or the error to answer. */
  const prepare = async <T>(
    c: Context,
    schema: z.ZodType<T>,
  ): Promise<{ body: T; token: string; userId: string } | Response> => {
    const body = await strictBody(c, schema, env);
    if (body === undefined) return refuse(c, "malformed_request");
    const session = await sessionOf(deps, c.req.raw.headers);
    if (session === null) return refuse(c, "unauthenticated");
    return { body, ...session };
  };
  /**
   * A factor step under the `factor` throttle of the session's user: admitted
   * first, a failure counted (TOTP, activation and recovery codes share it).
   */
  /** What every factor function is given besides its own input: the clock and the audit. */
  const context = (c: Context): { now?: Date; audit: FactorAudit } => {
    const now = env.now?.(c);
    return { ...(now === undefined ? {} : { now }), audit: { requestId: env.requestId(c) } };
  };
  const factorStep = async <T>(
    c: Context,
    schema: z.ZodType<T>,
    step: (ready: {
      body: T;
      token: string;
    }) => Promise<
      { ok: true; body: unknown; setCookie?: string } | { ok: false; reason: FailureReason }
    >,
    opts: { throttled: boolean } = { throttled: true },
  ): Promise<Response> => {
    const ready = await prepare(c, schema);
    if (ready instanceof Response) return ready;
    if (opts.throttled) {
      const refusal = await throttled(env, c, "factor", ready.userId);
      if (refusal !== null) return refusal;
    }
    let result: Awaited<ReturnType<typeof step>>;
    try {
      result = await step(ready);
    } catch (error) {
      if (error instanceof AuditUnavailable) return refuse(c, "audit_unavailable");
      throw error;
    }
    if (result.ok) return json(result.body, result.setCookie);
    // A refused state or a stale session is not a wrong credential: not counted.
    if (!opts.throttled || result.reason === "wrong_state" || result.reason === "not_fresh") {
      return refuse(c, factorFailureCode(result.reason));
    }
    return failed(env, c, "factor", ready.userId, factorFailureCode(result.reason));
  };

  app.post(`${base}/totp/enroll`, (c) =>
    factorStep(
      c,
      emptyBody,
      async (ready) => {
        const result = await enrollTotp(deps, { sessionToken: ready.token, ...context(c) });
        return result.ok
          ? {
              ok: true,
              body: { enrollmentId: result.enrollmentId, secret: result.secret, uri: result.uri },
            }
          : result;
      },
      { throttled: false },
    ),
  );

  app.post(`${base}/totp/activate`, (c) =>
    factorStep(c, codeBody, async (ready) => {
      const result = await activateTotp(deps, {
        sessionToken: ready.token,
        code: ready.body.code,
        ...context(c),
      });
      return result.ok
        ? { ok: true, body: { recoveryCodes: result.recoveryCodes }, setCookie: result.setCookie }
        : result;
    }),
  );

  app.post(`${base}/totp/verify`, (c) =>
    factorStep(c, codeBody, async (ready) => {
      const result = await elevateWithTotp(deps, {
        sessionToken: ready.token,
        code: ready.body.code,
        ...context(c),
      });
      return result.ok
        ? { ok: true, body: { phase: "mfa_complete" }, setCookie: result.setCookie }
        : result;
    }),
  );

  app.post(`${base}/recovery/verify`, (c) =>
    factorStep(c, codeBody, async (ready) => {
      const result = await elevateWithRecoveryCode(deps, {
        sessionToken: ready.token,
        code: ready.body.code,
        ...context(c),
      });
      return result.ok
        ? { ok: true, body: { phase: "mfa_complete" }, setCookie: result.setCookie }
        : result;
    }),
  );

  // Run 3.4: a fresh TOTP verification for an mfa_complete session; no new token.
  app.post(`${base}/totp/step-up`, (c) =>
    factorStep(c, codeBody, async (ready) => {
      const result = await stepUpWithTotp(deps, {
        sessionToken: ready.token,
        code: ready.body.code,
        ...context(c),
      });
      return result.ok ? { ok: true, body: { fresh: true } } : result;
    }),
  );

  app.post(`${base}/recovery/regenerate`, (c) =>
    factorStep(
      c,
      emptyBody,
      async (ready) => {
        const result = await regenerateRecoveryCodes(deps, {
          sessionToken: ready.token,
          ...context(c),
        });
        return result.ok ? { ok: true, body: { recoveryCodes: result.recoveryCodes } } : result;
      },
      { throttled: false },
    ),
  );
}

/** The strict request bodies, for the route contract (scripts/auth-route-contract.ts). */
export const AUTH_BODIES = {
  signIn: signInBody,
  changePassword: changePasswordBody,
  revokeSession: revokeSessionBody,
  empty: emptyBody,
  code: codeBody,
} as const;

/** A request body as JSON Schema, for the route contract. */
export function authBodyJsonSchema(name: keyof typeof AUTH_BODIES): Record<string, unknown> {
  const schema = z.toJSONSchema(AUTH_BODIES[name]) as Record<string, unknown>;
  // The dialect URL says nothing about the body.
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema"));
}
