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
  type FactorDeps,
  type FailureReason,
} from "./factors/elevate.ts";
import type { AuthKeys } from "./keys.ts";
import { signInWithPassword } from "./sign-in.ts";
import type { Throttle } from "./throttle.ts";

export interface NativeRoute {
  method: string;
  path: string;
}

/** The five native endpoints MyKey serves. None has a path parameter. */
export const NATIVE_ALLOWED: readonly NativeRoute[] = Object.freeze([
  { method: "POST", path: "/sign-in/email" },
  { method: "POST", path: "/sign-out" },
  { method: "GET", path: "/get-session" },
  { method: "POST", path: "/change-password" },
  { method: "POST", path: "/revoke-sessions" },
]);

/**
 * Every other HTTP-reachable native endpoint of better-auth 1.7.19. An upgrade
 * that adds one fails `routes.test.ts` until it is placed in one of the lists.
 */
export const NATIVE_DENIED: readonly NativeRoute[] = Object.freeze([
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
  respondError(code: ErrorCode, requestId: string): Response;
  /** The pipeline's request id of `c`. */
  requestId(c: Context): string;
  /** The request source (Run 3.3: the trusted edge's forwarded address, else the peer). */
  source(c: Context): string;
  /** The pipeline's body reader: the body rules of Run 3.1 with the auth limit. */
  readBody(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }>;
  audit?: (event: AuditEvent) => Promise<void>;
  /** Run 3.3; without it the routes refuse to mount, unless `allowUnthrottled` is "test". */
  throttle?: Throttle;
  allowUnthrottled?: "test";
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
  revokeOtherSessions: z.boolean().optional(),
});
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

/** The session of the request with its factor phase and auth epoch, or null. */
export async function currentSession(
  auth: Auth,
  headers: Headers,
): Promise<{ id: string; userId: string; phase: string; authEpoch: number } | null> {
  const found = await auth.api.getSession({ headers });
  if (found === null) return null;
  const session = found.session as unknown as {
    id: string;
    userId: string;
    phase: string;
    authEpoch?: number | string;
  };
  return {
    id: session.id,
    userId: session.userId,
    phase: session.phase,
    authEpoch: Number(session.authEpoch ?? 0),
  };
}

/**
 * A product route's guard (Doc 10 §4.1 rule 5: from current database state on
 * every request): the session completed the second factor, its account is
 * `active` and the session belongs to the account's current auth epoch.
 * Answers the refusal's code, or null. Run 3.5 replaces it by `resolveSession`.
 */
export async function requireMfaComplete(
  auth: Auth,
  headers: Headers,
  pool: pg.Pool,
): Promise<ErrorCode | null> {
  const session = await currentSession(auth, headers);
  if (session === null) return "unauthenticated";
  if (session.phase !== "mfa_complete") return "mfa_incomplete";
  const account = await pool.query<{ state: string; auth_epoch: string }>(
    "SELECT state, auth_epoch FROM auth.account_state WHERE user_id = $1",
    [session.userId],
  );
  const row = account.rows[0];
  if (row?.state !== "active") return "unauthenticated";
  if (Number(row.auth_epoch) !== session.authEpoch) return "unauthenticated";
  return null;
}

// ------------------------------------------------------------------- mount

/** A failed factor step: the same answer for a wrong, a replayed and an expired code. */
const factorFailureCode = (reason: FailureReason): ErrorCode =>
  reason === "wrong_state" ? "state_conflict" : "unauthenticated";

const codeBody = z.strictObject({ code: z.string().min(1).max(64) });

/** The raw token of the request's session (the protected adapter returns it for a lookup by token). */
async function sessionTokenOf(auth: Auth, headers: Headers): Promise<string | null> {
  const found = await auth.api.getSession({ headers });
  const token = (found?.session as { token?: unknown } | undefined)?.token;
  return typeof token === "string" && token !== "" ? token : null;
}

const FACTOR_PATHS = [
  "/totp/enroll",
  "/totp/activate",
  "/totp/verify",
  "/recovery/verify",
  "/recovery/regenerate",
] as const;

/** Every route the auth module serves, as the app registers it (full paths). */
export function servedAuthRoutes(): NativeRoute[] {
  return [
    ...NATIVE_ALLOWED.map((route) => ({
      method: route.method,
      path: `${AUTH_BASE_PATH}${route.path}`,
    })),
    ...FACTOR_PATHS.map((path) => ({ method: "POST", path: `${AUTH_BASE_PATH}${path}` })),
  ];
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
 * under /v1/auth is 404. Refuses to mount without throttling (Run 3.3) unless
 * the harness says `allowUnthrottled: "test"`.
 */
export function mountAuthRoutes(app: AnyHono, auth: Auth, env: AuthRouteEnv): void {
  if (env.throttle === undefined && env.allowUnthrottled !== "test") {
    throw new Error("the auth routes need throttling (Run 3.3); none was given");
  }
  const base = AUTH_BASE_PATH;
  const refuse = (c: Context, code: ErrorCode): Response =>
    env.respondError(code, env.requestId(c));

  app.post(`${base}/sign-in/email`, async (c) => {
    const body = await strictBody(c, signInBody, env);
    if (body === undefined) return refuse(c, "malformed_request");
    try {
      const result = await signInWithPassword(
        { auth, pool: env.pool, keys: env.keys },
        { ...body, headers: c.req.raw.headers, requestId: env.requestId(c) },
      );
      if (!result.ok) return refuse(c, "unauthenticated");
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
    return relayNative(
      await auth.api.getSession({ headers: c.req.raw.headers, asResponse: true }),
      env,
      env.requestId(c),
    );
  });

  app.post(`${base}/change-password`, async (c) => {
    const body = await strictBody(c, changePasswordBody, env);
    if (body === undefined) return refuse(c, "malformed_request");
    const denied = await requireMfaComplete(auth, c.req.raw.headers, env.pool);
    if (denied !== null) return refuse(c, denied);
    return relayNative(
      await auth.api.changePassword({ body, headers: c.req.raw.headers, asResponse: true }),
      env,
      env.requestId(c),
    );
  });

  app.post(`${base}/revoke-sessions`, async (c) => {
    if ((await strictBody(c, emptyBody, env)) === undefined) return refuse(c, "malformed_request");
    const denied = await requireMfaComplete(auth, c.req.raw.headers, env.pool);
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
  /** Body and session token of a factor request, or the error to answer. */
  const prepare = async <T>(
    c: Context,
    schema: z.ZodType<T>,
  ): Promise<{ body: T; token: string } | Response> => {
    const body = await strictBody(c, schema, env);
    if (body === undefined) return refuse(c, "malformed_request");
    const token = await sessionTokenOf(deps.auth, c.req.raw.headers);
    if (token === null) return refuse(c, "unauthenticated");
    return { body, token };
  };

  app.post(`${base}/totp/enroll`, async (c) => {
    const ready = await prepare(c, emptyBody);
    if (ready instanceof Response) return ready;
    const result = await enrollTotp(deps, { sessionToken: ready.token });
    if (!result.ok) return refuse(c, factorFailureCode(result.reason));
    return json({ enrollmentId: result.enrollmentId, secret: result.secret, uri: result.uri });
  });

  app.post(`${base}/totp/activate`, async (c) => {
    const ready = await prepare(c, codeBody);
    if (ready instanceof Response) return ready;
    const result = await activateTotp(deps, { sessionToken: ready.token, code: ready.body.code });
    if (!result.ok) return refuse(c, factorFailureCode(result.reason));
    return json({ recoveryCodes: result.recoveryCodes }, result.setCookie);
  });

  app.post(`${base}/totp/verify`, async (c) => {
    const ready = await prepare(c, codeBody);
    if (ready instanceof Response) return ready;
    const result = await elevateWithTotp(deps, {
      sessionToken: ready.token,
      code: ready.body.code,
    });
    if (!result.ok) return refuse(c, factorFailureCode(result.reason));
    return json({ phase: "mfa_complete" }, result.setCookie);
  });

  app.post(`${base}/recovery/verify`, async (c) => {
    const ready = await prepare(c, codeBody);
    if (ready instanceof Response) return ready;
    const result = await elevateWithRecoveryCode(deps, {
      sessionToken: ready.token,
      code: ready.body.code,
    });
    if (!result.ok) return refuse(c, factorFailureCode(result.reason));
    return json({ phase: "mfa_complete" }, result.setCookie);
  });

  app.post(`${base}/recovery/regenerate`, async (c) => {
    const ready = await prepare(c, emptyBody);
    if (ready instanceof Response) return ready;
    const result = await regenerateRecoveryCodes(deps, { sessionToken: ready.token });
    if (!result.ok) return refuse(c, factorFailureCode(result.reason));
    return json({ recoveryCodes: result.recoveryCodes });
  });
}

/** The strict request bodies, for the route contract (scripts/auth-route-contract.ts). */
export const AUTH_BODIES = {
  signIn: signInBody,
  changePassword: changePasswordBody,
  empty: emptyBody,
  code: codeBody,
} as const;

/** A request body as JSON Schema, for the route contract. */
export function authBodyJsonSchema(name: keyof typeof AUTH_BODIES): Record<string, unknown> {
  const schema = z.toJSONSchema(AUTH_BODIES[name]) as Record<string, unknown>;
  // The dialect URL says nothing about the body.
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema"));
}
