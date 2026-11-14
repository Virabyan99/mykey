// The HTTP surface of the API. Every route is mounted from the contract
// through `mountRoute` (P-40); nothing else registers a route.
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { mountAuthRoutes } from "@mykey/auth";
import { LIMITS, ROUTES } from "@mykey/contracts";
import { Hono, type Context } from "hono";
import { routePath } from "hono/route";
import { now } from "./log.ts";
import { headerBytes, readAuthBody } from "./pipeline/body.ts";
import { createLargeGate, type LargeGate } from "./large.ts";
import type { ApiEnv, AppDeps, Handler } from "./pipeline/context.ts";
import { readGate } from "./pipeline/gate.ts";
import { checkOrigin } from "./pipeline/origin.ts";
import { errorResponse } from "./pipeline/respond.ts";
import { requestSource } from "./pipeline/source.ts";
import { mountRoute, mountRouteDef } from "./pipeline/route.ts";
import { healthHandler } from "./routes/health.ts";
import { importApplyHandler, importPreviewHandler, importResumeHandler } from "./routes/imports.ts";
import { operationsGetHandler, operationsListHandler } from "./routes/operations.ts";
import { organizationsListHandler } from "./routes/organizations.ts";
import {
  environmentsCreateHandler,
  environmentsListHandler,
  environmentsRenameHandler,
  projectsCreateHandler,
  projectsListHandler,
  projectsRenameHandler,
} from "./routes/resources.ts";
import { resetCompleteHandler } from "./routes/reset.ts";
import {
  secretsCreateHandler,
  secretsDeleteHandler,
  secretsRestoreHandler,
  secretsUndeleteHandler,
  secretsHistoryHandler,
  secretsListHandler,
  secretsRevealHandler,
  secretsUpdateHandler,
} from "./routes/secrets.ts";
import { sessionActivityHandler } from "./routes/session.ts";
import { versionHandler } from "./routes/version.ts";

/** The auth module on the pipeline: its envelope, request id and body rules are the API's. */
function mountAuth(app: Hono<ApiEnv>, deps: AppDeps, module: NonNullable<AppDeps["auth"]>): void {
  mountAuthRoutes(app, module.auth, {
    pool: deps.pool,
    keys: module.keys,
    baseUrl: deps.config.baseUrl,
    originAllowed: (headers) => checkOrigin(headers, deps.config.baseUrl),
    respondError: errorResponse,
    requestId: (c) => (c as Context<ApiEnv>).get("requestId"),
    source: (c) =>
      requestSource(
        (c as Context<ApiEnv>).env.incoming.socket.remoteAddress,
        c.req.header("x-forwarded-for"),
        deps.config.trustedProxy,
      ),
    async readBody(c) {
      const context = c as Context<ApiEnv>;
      context.set("routePattern", routePath(context));
      try {
        if (headerBytes(context.env.incoming.rawHeaders) > LIMITS.body.headersMaxBytes) {
          return { ok: false };
        }
        const value = await readAuthBody(context.req.raw, (bytes) => {
          context.set("bodyBytesRead", context.get("bodyBytesRead") + bytes);
        });
        return { ok: true, value };
      } catch {
        return { ok: false };
      }
    },
    audit: async (event) => {
      await appendAudit(deps.pool, event);
    },
    throttle: module.throttle,
    ...(deps.test?.clock === undefined
      ? {}
      : { now: (c: Context) => deps.test?.clock?.(c.req.raw.headers) }),
  });
}

/** The handlers that exist; every other contract route ends in the terminal 404. */
function handlers(large: LargeGate): Partial<Record<string, Handler>> {
  return {
    "health.get": healthHandler,
    "version.get": versionHandler,
    "organizations.list": organizationsListHandler,
    "projects.list": projectsListHandler,
    "projects.create": projectsCreateHandler,
    "projects.rename": projectsRenameHandler,
    "environments.list": environmentsListHandler,
    "environments.create": environmentsCreateHandler,
    "environments.rename": environmentsRenameHandler,
    "operations.get": operationsGetHandler,
    "operations.list": operationsListHandler,
    "secrets.list": secretsListHandler,
    "secrets.history": secretsHistoryHandler,
    "secrets.reveal": secretsRevealHandler,
    "secrets.create": secretsCreateHandler,
    "secrets.update": secretsUpdateHandler,
    "secrets.delete": secretsDeleteHandler,
    "secrets.undelete": secretsUndeleteHandler,
    "secrets.restore": secretsRestoreHandler,
    "import.preview": importPreviewHandler(large),
    "import.apply": importApplyHandler(large),
    "import.resume": importResumeHandler(large),
    "session.activity": sessionActivityHandler,
    "auth.reset.complete": resetCompleteHandler,
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
    // The gate is the first step of every request, matched or not (P-43).
    // GET /health is the one exception: it reports the gate instead of refusing.
    const isHealth = c.req.method === "GET" && c.req.path === "/health";
    const gate = isHealth ? null : readGate(deps.config.gatePath, deps.config.hostInstanceId);
    if (gate !== null && !gate.open) {
      deps.log({ event: "gate_closed", time: now(), requestId, cause: gate.cause });
      c.res = errorResponse("quarantined", requestId);
    } else {
      await next();
    }
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

  // Per process (one app per process): import and export share the large-request limit.
  const known = handlers(createLargeGate(LIMITS.concurrency.largePerProcess));
  for (const route of ROUTES) mountRoute(app, deps, route.id, known[route.id] ?? null);
  for (const entry of deps.test?.routes ?? []) mountRouteDef(app, deps, entry.def, entry.handler);
  // After the contract routes: the auth module closes the rest of /v1/auth with a 404.
  if (deps.auth !== undefined) mountAuth(app, deps, deps.auth);

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
