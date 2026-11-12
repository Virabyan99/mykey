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
import { AuditUnavailable } from "@mykey/audit";
import { LIMITS, ROUTES, type RouteDef } from "@mykey/contracts";
import type { Context, Hono } from "hono";
import { now } from "../log.ts";
import { authenticateHuman } from "./authn.ts";
import { authorize, deny } from "./authz.ts";
import { checkOrigin, hasMixedCredentials, needsOriginCheck } from "./origin.ts";
import { headerBytes, readBody } from "./body.ts";
import { requestSource } from "./source.ts";
import {
  ApiError,
  type ApiEnv,
  type AppDeps,
  type Handler,
  type HandlerResult,
} from "./context.ts";
import { errorResponse, jsonResponse } from "./respond.ts";
import { validateBody, validateQuery } from "./validate.ts";

/** The end of a route with no handler yet: written directly, since not every route lists not_found. */
class NoHandler extends Error {}

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
    return errorResponse(code, requestId, error instanceof ApiError ? error.headers : undefined);
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
    const raw = await readBody(c.req.raw, route, (bytes) => {
      c.set("bodyBytesRead", c.get("bodyBytesRead") + bytes);
    });
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
    const clock = deps.test?.clock?.(headers);
    const query = validateQuery(route, new URL(c.req.url).searchParams);
    const body = validateBody(route, raw);
    const params = c.req.param();
    const access =
      principal === null
        ? { scope: null, authority: null }
        : await authorize(deps, route, params, principal, requestId);
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
    if (handler === terminal && deps.test?.stubs !== undefined) {
      // The harness's stub: every check of the pipeline has passed.
      await deps.test.stubs(route.id);
      return new Response(null, { status: 204 });
    }
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
        scope: access.scope,
        authority: access.authority,
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
