// Mounting a route (P-40). Every HTTP route of the API is registered here from
// its RouteDef: method, path, body and query schemas, response schemas and the
// error list all come from the contract. A route with no handler yet passes
// every check of the pipeline and then answers 404 not_found.
//
// Order inside a request (this run's outer frame; Run 3.7 completes it):
// request id → gate → route match → body limits and parsing → strict
// validation → handler → output validation; no-store and x-request-id on every
// response (app.ts).
import { AuditUnavailable } from "@mykey/audit";
import { LIMITS, ROUTES, type RouteDef } from "@mykey/contracts";
import type { Context, Hono } from "hono";
import { now } from "../log.ts";
import { headerBytes, readBody } from "./body.ts";
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
    return errorResponse(code, requestId);
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
  return jsonResponse(result.status, parsed.data);
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
    const query = validateQuery(route, new URL(c.req.url).searchParams);
    const body = validateBody(route, raw);
    const result = await handler(
      {
        requestId,
        source: c.env.incoming.socket.remoteAddress ?? "",
        route,
        body,
        query,
        params: c.req.param(),
        principal: null,
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
