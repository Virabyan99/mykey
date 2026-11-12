// The HTTP surface of the API. Every route is mounted from the contract
// through `mountRoute` (P-40); nothing else registers a route.
import { randomUUID } from "node:crypto";
import { ROUTES } from "@mykey/contracts";
import { Hono } from "hono";
import { now } from "./log.ts";
import type { ApiEnv, AppDeps, Handler } from "./pipeline/context.ts";
import { errorResponse } from "./pipeline/respond.ts";
import { mountRoute, mountRouteDef } from "./pipeline/route.ts";
import { healthHandler } from "./routes/health.ts";
import { versionHandler } from "./routes/version.ts";

/** The handlers that exist; every other contract route ends in the terminal 404. */
function handlers(): Partial<Record<string, Handler>> {
  return {
    "health.get": healthHandler,
    "version.get": versionHandler,
  };
}

export function createApp(deps: AppDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.use(async (c, next) => {
    const started = performance.now();
    // Always the API's own: a client-sent x-request-id is ignored.
    const requestId = randomUUID();
    c.set("requestId", requestId);
    c.set("routePattern", null);
    c.set("bodyBytesRead", 0);
    await next();
    c.res.headers.set("x-request-id", requestId);
    c.res.headers.set("cache-control", "no-store");
    deps.log({
      event: "request",
      time: now(),
      requestId,
      method: c.req.method,
      path: c.get("routePattern"),
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
      bodyBytesRead: c.get("bodyBytesRead"),
      peer: c.env.incoming.socket.remoteAddress ?? null,
      forwardedFor: c.req.header("x-forwarded-for")?.slice(0, 256) ?? null,
      forwardedProto: c.req.header("x-forwarded-proto")?.slice(0, 16) ?? null,
    });
  });

  const known = handlers();
  for (const route of ROUTES) mountRoute(app, deps, route.id, known[route.id] ?? null);
  for (const entry of deps.test?.routes ?? []) mountRouteDef(app, deps, entry.def, entry.handler);

  app.notFound((c) => errorResponse("not_found", c.get("requestId")));
  app.onError((error, c) => {
    deps.log({
      event: "unhandled",
      time: now(),
      requestId: c.get("requestId"),
      routeId: null,
      errorClass: error.constructor.name,
    });
    return errorResponse("dependency_unavailable", c.get("requestId"));
  });

  return app;
}
