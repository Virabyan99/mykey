// Mounting a route (P-40). Every HTTP route of the API is registered here from
// its RouteDef: method, path, body and query schemas, response schemas and the
// error list all come from the contract. A route with no handler yet passes
// every check of the pipeline and then answers 404 not_found.
//
// Order inside a request (Doc 06 §4.4, final since Run 3.7): request id →
// gate → route match → body limits and parsing → mixed-credential check →
// Origin check → authentication → strict validation of body and query →
// ancestry and membership → visibility → action → state → freshness →
// handler → output validation; no-store and x-request-id on every response
// (app.ts).
import { createHash } from "node:crypto";
import { AuditUnavailable } from "@mykey/audit";
import { LIMITS, ROUTES, type RouteDef } from "@mykey/contracts";
import type { Context, Hono } from "hono";
import { now } from "../log.ts";
import { authenticateHuman } from "./authn.ts";
import { findOperationByKey, hasTombstone } from "@mykey/db";
import { replayAnswer, sameIntent, type Intent } from "@mykey/operations";
import type { UserPrincipal as Principal } from "./authn.ts";
import { admitStates, authorize, deny } from "./authz.ts";
import { checkOrigin, hasMixedCredentials, needsOriginCheck } from "./origin.ts";
import { headerBytes, readBody } from "./body.ts";
import { authenticateMachine, hasSelector } from "./machine.ts";
import { requestSource } from "./source.ts";
import {
  ApiError,
  type ApiEnv,
  type AppDeps,
  type Handler,
  type HandlerResult,
} from "./context.ts";
import { checkDetails, errorResponse, jsonResponse } from "./respond.ts";
import { notReplayable } from "../routes/credentials.ts";
import { validateBody, validateQuery } from "./validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The end of a route with no handler yet: written directly, since not every route lists not_found. */
class NoHandler extends Error {}

/** The path parameters that name the scope; every other one is part of the intent (P-64). */
const SCOPE_PARAMS: ReadonlySet<string> = new Set(["org", "project", "env"]);

/**
 * The intent of a mutation (P-64): the target is the deepest scope id of the
 * path; `params` holds the other path parameters, when there are any. The one
 * place target and params are derived.
 */
export function intentOf(
  route: RouteDef,
  params: Record<string, string>,
  principal: Principal,
  body: unknown,
): Intent {
  const extra = Object.fromEntries(
    Object.entries(params).filter(([name]) => !SCOPE_PARAMS.has(name)),
  );
  return {
    principalKind: "user",
    principalId: principal.userId,
    action: route.id,
    target: params.env ?? params.project ?? params.org ?? "",
    ...(Object.keys(extra).length === 0 ? {} : { params: extra }),
    // A dotenv file (Run 4.7) enters as its digest: the canonical text is only HMAC'd, never stored.
    body:
      body instanceof Uint8Array
        ? { sha256: createHash("sha256").update(body).digest("hex") }
        : body,
  };
}

/** A request that declares body bytes (a length above zero, or chunks). */
function hasBodyBytes(headers: Headers): boolean {
  const length = headers.get("content-length");
  return headers.get("transfer-encoding") !== null || (length !== null && length !== "0");
}

/** What a route with no handler does after every check has passed. */
const terminal: Handler = () => Promise.reject(new NoHandler());

function routeById(routeId: string): RouteDef {
  const route = ROUTES.find((candidate) => candidate.id === routeId);
  if (route === undefined) throw new Error(`no contract route ${routeId}`);
  return route;
}

/** The answer for a failure inside the pipeline or the handler. */
export function failureResponse(
  error: unknown,
  route: RouteDef,
  requestId: string,
  deps: AppDeps,
): Response {
  if (error instanceof NoHandler) return errorResponse("not_found", requestId);
  const code =
    error instanceof ApiError
      ? error.code
      : error instanceof AuditUnavailable
        ? "audit_unavailable"
        : null;
  if (code === null) {
    deps.log({
      event: "unhandled",
      time: now(),
      requestId,
      routeId: route.id,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
    });
    return errorResponse("dependency_unavailable", requestId);
  }
  // A route without the code in its list never sends it.
  if (route.errors.includes(code)) {
    if (!(error instanceof ApiError)) return errorResponse(code, requestId);
    if (!checkDetails(code, error.extra.details).valid) {
      deps.log({ event: "output_invalid", time: now(), requestId, routeId: route.id, status: 0 });
    }
    return errorResponse(code, requestId, error.headers, error.extra);
  }
  deps.log({ event: "unlisted_error", time: now(), requestId, routeId: route.id, code });
  return errorResponse("dependency_unavailable", requestId);
}

function outputResponse(
  result: HandlerResult,
  route: RouteDef,
  requestId: string,
  deps: AppDeps,
): Response {
  const schema = route.responses[result.status];
  // An attachment (Run 4.9): the bytes as they are, their length, no transformation.
  if (schema === "dotenv-attachment" || result.raw !== undefined) {
    if (schema !== "dotenv-attachment" || result.raw === undefined) {
      deps.log({
        event: "output_invalid",
        time: now(),
        requestId,
        routeId: route.id,
        status: result.status,
      });
      return errorResponse("dependency_unavailable", requestId);
    }
    return new Response(result.raw.bytes, {
      status: result.status,
      headers: {
        ...result.headers,
        "content-type": result.raw.contentType,
        "content-length": String(result.raw.bytes.length),
      },
    });
  }
  if (schema === undefined || typeof schema === "string") {
    deps.log({
      event: "output_invalid",
      time: now(),
      requestId,
      routeId: route.id,
      status: result.status,
    });
    return errorResponse("dependency_unavailable", requestId);
  }
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) {
    deps.log({
      event: "output_invalid",
      time: now(),
      requestId,
      routeId: route.id,
      status: result.status,
    });
    return errorResponse("dependency_unavailable", requestId);
  }
  if (result.buffered === true) {
    const bytes = Buffer.from(JSON.stringify(parsed.data), "utf8");
    const headers = new Headers(result.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    headers.set("content-length", String(bytes.length));
    return new Response(bytes, { status: result.status, headers });
  }
  return jsonResponse(result.status, parsed.data, result.headers);
}

async function run(
  c: Context<ApiEnv>,
  route: RouteDef,
  handler: Handler,
  deps: AppDeps,
): Promise<Response> {
  const requestId = c.get("requestId");
  c.set("routePattern", route.path);
  try {
    if (headerBytes(c.env.incoming.rawHeaders) > LIMITS.body.headersMaxBytes) {
      throw new ApiError("malformed_request");
    }
    const counted = (bytes: number) => {
      c.set("bodyBytesRead", c.get("bodyBytesRead") + bytes);
    };
    const machineRoute = route.auth === "machine";
    // A machine route takes no body; any JSON it is sent is read only to be refused as a selector.
    const raw = await readBody(
      c.req.raw,
      machineRoute && route.method !== "GET" && hasBodyBytes(c.req.raw.headers)
        ? { ...route, request: { ...route.request, body: "pending" } }
        : route,
      counted,
    );
    const headers = c.req.raw.headers;
    const human = route.auth === "human" || route.auth === "human_fresh_totp";
    // One kind of credential per request, refused before any database read.
    if ((human || route.auth === "machine") && hasMixedCredentials(headers)) {
      throw new ApiError("mixed_authentication");
    }
    // FR-1.76: before the session is read.
    if (needsOriginCheck(route) && !checkOrigin(headers, deps.config.baseUrl)) {
      throw new ApiError("origin_rejected");
    }
    // Authentication before strict validation: an anonymous caller learns nothing from a 422.
    const principal = human ? await authenticateHuman(deps, headers) : null;
    // A machine request (P-93): the token, its catalog row, its own path; then
    // no selector. No Origin, no authorize (the binding is the authorization),
    // no replay, no freshness, no validation.
    const params = c.req.param();
    const machine = machineRoute
      ? await authenticateMachine(deps, c.env.incoming.rawHeaders, params, route, requestId)
      : null;
    if (machine !== null && hasSelector(c.req.url, raw)) throw new ApiError("forbidden_selector");
    const clock = deps.test?.clock?.(headers);
    const query = machineRoute ? undefined : validateQuery(route, new URL(c.req.url).searchParams);
    const body = machineRoute ? undefined : validateBody(route, raw);
    const access =
      principal === null
        ? { scope: null, authority: null, resolved: null }
        : await authorize(deps, route, params, principal, requestId);
    // A mutation (P-58): its key first; a request already made answers its
    // stored outcome before the state and freshness checks (Doc 06 §6.2 step 1).
    let idempotencyKey: string | null = null;
    if (route.idempotent && principal !== null) {
      const header = headers.get("idempotency-key")?.toLowerCase() ?? "";
      if (!UUID.test(header)) throw new ApiError("precondition_required");
      idempotencyKey = header;
      const ring = deps.auth?.keys.replayFingerprint;
      if (ring === undefined) throw new ApiError("dependency_unavailable");
      const intent = intentOf(route, params, principal, body);
      const key = {
        principalKind: "user" as const,
        principalId: principal.userId,
        action: route.id,
        target: intent.target,
        idempotencyKey,
      };
      const stored = await findOperationByKey(deps.pool, key);
      if (stored === null) {
        if (await hasTombstone(deps.pool, key)) throw new ApiError("replay_expired");
      } else {
        // An expired record has lost its fingerprint: it answers replay_expired, never a conflict.
        const expired =
          stored.expired && ["succeeded", "partial", "rejected"].includes(stored.state);
        if (!expired && !sameIntent(ring, stored, intent)) {
          throw new ApiError("idempotency_conflict");
        }
        const answer = replayAnswer(route, stored);
        if ("error" in answer && answer.error === "credential_not_replayable") {
          throw await notReplayable(deps.pool, stored.id);
        }
        if ("error" in answer) {
          throw new ApiError(answer.error, "replay", undefined, {
            ...(answer.operationId === undefined ? {} : { operationId: answer.operationId }),
          });
        }
        return outputResponse(answer, route, requestId, deps);
      }
    }
    if (principal !== null) await admitStates(deps, route, params, principal, requestId, access);
    // Freshness (FR-1.77): last before the handler, after visibility, action and state.
    if (route.auth === "human_fresh_totp" && principal !== null && !principal.fresh) {
      await deny(deps, {
        route,
        principal,
        requestId,
        reason: "fresh",
        code: "fresh_verification_required",
        organizationId: access.scope?.organizationId ?? null,
        targetId: params.env ?? params.project ?? params.org ?? null,
      });
    }
    const stubbed =
      handler === terminal ||
      deps.test?.stubRoutes?.has(route.id) === true ||
      (deps.test?.stubAll === true &&
        route.id !== "health.get" &&
        route.id !== "version.get" &&
        ROUTES.some((contract) => contract.id === route.id));
    if (stubbed && deps.test?.stubs !== undefined) {
      // The harness's stub: every check of the pipeline has passed.
      await deps.test.stubs(route.id);
      return new Response(null, { status: 204 });
    }
    await deps.test?.beforeHandler?.(route.id);
    const result = await handler(
      {
        requestId,
        source: requestSource(
          c.env.incoming.socket.remoteAddress,
          c.req.header("x-forwarded-for"),
          deps.config.trustedProxy,
        ),
        route,
        body,
        query,
        params,
        principal,
        machine,
        scope: access.scope,
        authority: access.authority,
        operation: access.operation ?? null,
        idempotencyKey,
        ...(clock === undefined ? {} : { now: clock }),
      },
      deps,
    );
    return outputResponse(result, route, requestId, deps);
  } catch (error) {
    return failureResponse(error, route, requestId, deps);
  }
}

/** Mounts a route from its definition. */
export function mountRouteDef(
  app: Hono<ApiEnv>,
  deps: AppDeps,
  route: RouteDef,
  handler: Handler | null,
): void {
  app.on(route.method, route.path, (c) => run(c, route, handler ?? terminal, deps));
}

/** Mounts the contract route `routeId`; a null handler gives the terminal 404. */
export function mountRoute(
  app: Hono<ApiEnv>,
  deps: AppDeps,
  routeId: string,
  handler: Handler | null,
): void {
  mountRouteDef(app, deps, routeById(routeId), handler);
}
