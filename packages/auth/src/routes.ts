// The HTTP surface of the auth module (P-25, D-19). No Better Auth catch-all
// handler is mounted: each allowed native endpoint has its own route that
// calls `auth.api.<name>` with a strict body, and every other path under
// /v1/auth answers the contract's 404 envelope.
import { randomUUID } from "node:crypto";
import type { ErrorCode, ErrorEnvelope } from "@mykey/contracts";
import { ERROR_CODES } from "@mykey/contracts";
import type { Context, Hono } from "hono";
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

// ------------------------------------------------------------------ envelope

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  malformed_request: "The request is not valid.",
  unauthenticated: "Sign-in is required, or the credentials are not valid.",
  mfa_incomplete: "The second factor is required.",
  action_denied: "This action is not allowed.",
  not_found: "Not found.",
  state_conflict: "The account or session is not in the state this step needs.",
  rate_limited: "Too many requests.",
  dependency_unavailable: "A service this request needs is not available.",
};

export function errorResponse(code: ErrorCode, requestId: string = randomUUID()): Response {
  const body: ErrorEnvelope = {
    error: {
      code,
      message: MESSAGES[code] ?? code,
      requestId: requestId as ErrorEnvelope["error"]["requestId"],
    },
  };
  return new Response(JSON.stringify(body), {
    status: ERROR_CODES[code].status,
    headers: { "content-type": "application/json" },
  });
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

/** Passes a native answer on: errors as the envelope, bodies without any token. */
async function relay(response: Response): Promise<Response> {
  if (!response.ok) {
    const headers = new Headers();
    for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
    const envelope = errorResponse(codeForStatus(response.status));
    for (const [name, value] of envelope.headers) headers.set(name, value);
    return new Response(envelope.body, { status: envelope.status, headers });
  }
  const text = await response.text();
  const body: unknown = text === "" ? null : JSON.parse(text);
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

/** The JSON body parsed by `schema`, or undefined when it is missing, not JSON or not valid. */
export async function strictBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await c.req.text();
  if (text.trim() === "") {
    const empty = schema.safeParse({});
    return empty.success ? empty.data : undefined;
  }
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** The session of the request with its factor phase, or null. */
export async function currentSession(
  auth: Auth,
  headers: Headers,
): Promise<{ id: string; userId: string; phase: string } | null> {
  const found = await auth.api.getSession({ headers });
  if (found === null) return null;
  const session = found.session as unknown as { id: string; userId: string; phase: string };
  return { id: session.id, userId: session.userId, phase: session.phase };
}

/** A product route's guard: the session must have completed the second factor. */
export async function requireMfaComplete(auth: Auth, headers: Headers): Promise<Response | null> {
  const session = await currentSession(auth, headers);
  if (session === null) return errorResponse("unauthenticated");
  if (session.phase !== "mfa_complete") return errorResponse("mfa_incomplete");
  return null;
}

// ------------------------------------------------------------------- mount

/** A failed factor step: the same answer for a wrong, a replayed and an expired code. */
function factorFailure(reason: FailureReason): Response {
  return errorResponse(reason === "wrong_state" ? "state_conflict" : "unauthenticated");
}

const codeBody = z.strictObject({ code: z.string().min(1).max(64) });

/** The raw token of the request's session (the protected adapter returns it for a lookup by token). */
async function sessionTokenOf(auth: Auth, headers: Headers): Promise<string | null> {
  const found = await auth.api.getSession({ headers });
  const token = (found?.session as { token?: unknown } | undefined)?.token;
  return typeof token === "string" && token !== "" ? token : null;
}

/**
 * Registers the five allowed native routes and, given the factor
 * dependencies, the five factor routes; everything else under /v1/auth is 404.
 */
export function mountAuthRoutes(app: Hono, auth: Auth, factors?: Omit<FactorDeps, "auth">): void {
  const base = AUTH_BASE_PATH;

  app.post(`${base}/sign-in/email`, async (c) => {
    const body = await strictBody(c, signInBody);
    if (body === undefined) return errorResponse("malformed_request");
    return relay(
      await auth.api.signInEmail({ body, headers: c.req.raw.headers, asResponse: true }),
    );
  });

  app.post(`${base}/sign-out`, async (c) => {
    if ((await strictBody(c, emptyBody)) === undefined) return errorResponse("malformed_request");
    return relay(await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true }));
  });

  app.get(`${base}/get-session`, async (c) =>
    relay(await auth.api.getSession({ headers: c.req.raw.headers, asResponse: true })),
  );

  app.post(`${base}/change-password`, async (c) => {
    const body = await strictBody(c, changePasswordBody);
    if (body === undefined) return errorResponse("malformed_request");
    const denied = await requireMfaComplete(auth, c.req.raw.headers);
    if (denied !== null) return denied;
    return relay(
      await auth.api.changePassword({ body, headers: c.req.raw.headers, asResponse: true }),
    );
  });

  app.post(`${base}/revoke-sessions`, async (c) => {
    if ((await strictBody(c, emptyBody)) === undefined) return errorResponse("malformed_request");
    const denied = await requireMfaComplete(auth, c.req.raw.headers);
    if (denied !== null) return denied;
    return relay(await auth.api.revokeSessions({ headers: c.req.raw.headers, asResponse: true }));
  });

  if (factors !== undefined) mountFactorRoutes(app, { ...factors, auth });
  closeAuthPaths(app);
}

function mountFactorRoutes(app: Hono, deps: FactorDeps): void {
  const base = AUTH_BASE_PATH;
  const json = (body: unknown, setCookie?: string): Response => {
    const headers = new Headers({ "content-type": "application/json" });
    if (setCookie !== undefined) headers.append("set-cookie", setCookie);
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  /** Body and session token of a factor request, or the error to answer. */
  const prepare = async <T>(
    c: Context,
    schema: z.ZodType<T>,
  ): Promise<{ body: T; token: string } | Response> => {
    const body = await strictBody(c, schema);
    if (body === undefined) return errorResponse("malformed_request");
    const token = await sessionTokenOf(deps.auth, c.req.raw.headers);
    if (token === null) return errorResponse("unauthenticated");
    return { body, token };
  };

  app.post(`${base}/totp/enroll`, async (c) => {
    const ready = await prepare(c, emptyBody);
    if (ready instanceof Response) return ready;
    const result = await enrollTotp(deps, { sessionToken: ready.token });
    if (!result.ok) return factorFailure(result.reason);
    return json({ enrollmentId: result.enrollmentId, secret: result.secret, uri: result.uri });
  });

  app.post(`${base}/totp/activate`, async (c) => {
    const ready = await prepare(c, codeBody);
    if (ready instanceof Response) return ready;
    const result = await activateTotp(deps, { sessionToken: ready.token, code: ready.body.code });
    if (!result.ok) return factorFailure(result.reason);
    return json({ recoveryCodes: result.recoveryCodes }, result.setCookie);
  });

  app.post(`${base}/totp/verify`, async (c) => {
    const ready = await prepare(c, codeBody);
    if (ready instanceof Response) return ready;
    const result = await elevateWithTotp(deps, {
      sessionToken: ready.token,
      code: ready.body.code,
    });
    if (!result.ok) return factorFailure(result.reason);
    return json({ phase: "mfa_complete" }, result.setCookie);
  });

  app.post(`${base}/recovery/verify`, async (c) => {
    const ready = await prepare(c, codeBody);
    if (ready instanceof Response) return ready;
    const result = await elevateWithRecoveryCode(deps, {
      sessionToken: ready.token,
      code: ready.body.code,
    });
    if (!result.ok) return factorFailure(result.reason);
    return json({ phase: "mfa_complete" }, result.setCookie);
  });

  app.post(`${base}/recovery/regenerate`, async (c) => {
    const ready = await prepare(c, emptyBody);
    if (ready instanceof Response) return ready;
    const result = await regenerateRecoveryCodes(deps, { sessionToken: ready.token });
    if (!result.ok) return factorFailure(result.reason);
    return json({ recoveryCodes: result.recoveryCodes });
  });
}

/** Everything else under the auth base path: the contract's 404, registered after every auth route. */
function closeAuthPaths(app: Hono): void {
  app.all(AUTH_BASE_PATH, () => errorResponse("not_found"));
  app.all(`${AUTH_BASE_PATH}/*`, () => errorResponse("not_found"));
}
