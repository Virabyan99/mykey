// The HTTP surface of the API. Every route is mounted from the contract
// through `mountRoute` (P-40); nothing else registers a route.
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { mountAuthRoutes } from "@mykey/auth";
import { EXPANDING_ROUTES, LIMITS, ROUTES, buildOpenApiDocument } from "@mykey/contracts";
import { Hono, type Context } from "hono";
import { routePath } from "hono/route";
import { now } from "./log.ts";
import { headerBytes, readAuthBody } from "./pipeline/body.ts";
import { HELD_BY_PIPELINE, createLargeGate, type LargeGate } from "./large.ts";
import { createInflightGate } from "./pipeline/inflight.ts";
import type { ApiEnv, AppDeps, Handler } from "./pipeline/context.ts";
import { createServiceGate, verificationServes } from "./pipeline/gate.ts";
import { checkOrigin } from "./pipeline/origin.ts";
import { errorResponse } from "./pipeline/respond.ts";
import { requestSource } from "./pipeline/source.ts";
import {
  capacityStep,
  captureStep,
  mountRoute,
  mountRouteDef,
  rateStep,
} from "./pipeline/route.ts";
import { ApiError } from "./pipeline/context.ts";
import {
  credentialsIssueHandler,
  credentialsListHandler,
  credentialsRevokeHandler,
  credentialsSummaryHandler,
} from "./routes/credentials.ts";
import { exportCreateHandler } from "./routes/export.ts";
import { archiveHandler, reactivateHandler } from "./routes/lifecycle.ts";
import { machineKeysHandler, machineResolveHandler } from "./routes/machine.ts";
import { healthHandler } from "./routes/health.ts";
import { importApplyHandler, importPreviewHandler, importResumeHandler } from "./routes/imports.ts";
import { activityListHandler } from "./routes/activity.ts";
import { metricsGetHandler } from "./routes/metrics.ts";
import { overviewGetHandler } from "./routes/overview.ts";
import { auditListHandler } from "./routes/audit.ts";
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
import { openapiGetHandler, referenceGetHandler } from "./routes/reference.ts";
import { servedDocument, type OpenApiDocument } from "./reference/document.ts";
import {
  DEFAULT_ASSET_DIRECTORY,
  buildReferencePage,
  loadScalarAsset,
  type ReferencePage,
} from "./reference/page.ts";
import { resetCompleteHandler } from "./routes/reset.ts";
import { DEFAULT_WEB_DIRECTORY, loadWebShell, shellAnswer } from "./web/shell.ts";
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
function handlers(
  held: LargeGate,
  served: () => OpenApiDocument,
  page: () => ReferencePage | null,
): Partial<Record<string, Handler>> {
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
    "audit.list": auditListHandler,
    "activity.list": activityListHandler,
    "overview.get": overviewGetHandler,
    "metrics.get": metricsGetHandler,
    "secrets.list": secretsListHandler,
    "secrets.history": secretsHistoryHandler,
    "secrets.reveal": secretsRevealHandler,
    "secrets.create": secretsCreateHandler,
    "secrets.update": secretsUpdateHandler,
    "secrets.delete": secretsDeleteHandler,
    "secrets.undelete": secretsUndeleteHandler,
    "secrets.restore": secretsRestoreHandler,
    "import.preview": importPreviewHandler(held),
    "import.apply": importApplyHandler(held),
    "import.resume": importResumeHandler(held),
    "export.create": exportCreateHandler(held),
    "credentials.list": credentialsListHandler,
    "credentials.issue": credentialsIssueHandler,
    "credentials.revoke": credentialsRevokeHandler,
    "credentials.summary": credentialsSummaryHandler,
    "projects.archive": archiveHandler,
    "environments.archive": archiveHandler,
    "projects.reactivate": reactivateHandler,
    "environments.reactivate": reactivateHandler,
    "machine.keys": machineKeysHandler,
    "machine.resolve": machineResolveHandler(held),
    "session.activity": sessionActivityHandler,
    "auth.reset.complete": resetCompleteHandler,
    "openapi.get": openapiGetHandler(served),
    "reference.get": referenceGetHandler(page),
  };
}

/** The ids of the contract routes this build has a handler for (Run 5.9). */
export function handledRouteIds(): ReadonlySet<string> {
  const known = handlers(
    createLargeGate(1),
    () => ({ paths: {} }),
    () => null,
  );
  return new Set(ROUTES.filter((route) => known[route.id] !== undefined).map((route) => route.id));
}

export function createApp(given: AppDeps): Hono<ApiEnv> {
  // Run 6.7 (P-122): one gate per process, shared by its listeners when given.
  const gate = given.gate ?? createServiceGate(given.config, given.pool);
  const listener = given.listener ?? "public";
  const deps: AppDeps = { ...given, gate, listener };
  const app = new Hono<ApiEnv>();
  const inflight = createInflightGate(LIMITS.concurrency.httpPerProcess);

  /** The gate, then the source limit, then the route (P-43, P-113). */
  const admitted = async (c: Context<ApiEnv>, next: () => Promise<void>, requestId: string) => {
    // The gate is the first check of every request, matched or not (P-43).
    // GET /health is the one exception: it reports the gate instead of refusing.
    const isHealth = c.req.method === "GET" && c.req.path === "/health";
    await gate.refresh();
    const reading = isHealth ? null : gate.read();
    // P-123: on the verification listener, while the record says closed +
    // verifying, reads, the auth module and a reveal are served.
    const verifying =
      listener === "verify" &&
      reading?.admits === "verification" &&
      verificationServes(c.req.method, c.req.path);
    if (reading !== null && reading.admits !== "all" && !verifying) {
      deps.log({ event: "gate_closed", time: now(), requestId, cause: reading.cause ?? "closed" });
      c.res = errorResponse("quarantined", requestId);
      return;
    }
    if (isHealth) {
      await next();
      return;
    }
    // P-113: the source limit, before anything of the request is read.
    const refusal = await rateStep(
      deps,
      requestId,
      "rl:source",
      requestSource(
        c.env.incoming.socket.remoteAddress,
        c.req.header("x-forwarded-for"),
        deps.config.trustedProxy,
      ),
    ).then(
      () => null,
      (error: unknown) =>
        error instanceof ApiError ? error : new ApiError("dependency_unavailable"),
    );
    if (refusal !== null) {
      // The body stays unread: the connection closes after the answer.
      c.res = errorResponse(refusal.code, requestId, { ...refusal.headers, connection: "close" });
      return;
    }
    // P-118: the auth module's paths that write, while a pair is captured.
    if (c.req.path.startsWith("/v1/auth/")) {
      const closed = await captureStep(deps, `${c.req.method} ${c.req.path}`, c.req.method).then(
        () => null,
        (error: unknown) =>
          error instanceof ApiError ? error : new ApiError("dependency_unavailable"),
      );
      if (closed !== null) {
        c.res = errorResponse(closed.code, requestId, closed.headers, closed.extra);
        return;
      }
    }
    // P-115: the auth module's expanding paths (enrolment, password change) under disk pressure.
    if (EXPANDING_ROUTES.has(`${c.req.method} ${c.req.path}`)) {
      const refused = await capacityStep(deps).then(
        () => null,
        (error: unknown) =>
          error instanceof ApiError ? error : new ApiError("dependency_unavailable"),
      );
      if (refused !== null) {
        c.res = errorResponse(refused.code, requestId, refused.headers, refused.extra);
        return;
      }
    }
    await next();
  };

  app.use(async (c, next) => {
    const started = performance.now();
    // Always the API's own: a client-sent x-request-id is ignored.
    const requestId = randomUUID();
    c.set("requestId", requestId);
    c.set("routePattern", null);
    c.set("bodyBytesRead", 0);
    // P-114: the in-flight gate, before anything else; the 65th request is
    // refused at once, its body unread, and the connection closes.
    if (!inflight.enter()) {
      c.res = errorResponse("busy", requestId, { connection: "close" });
    } else {
      try {
        await admitted(c, next, requestId);
      } finally {
        inflight.leave();
      }
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
  // The document this build serves and its page (Run 5.9): computed once, from the handlers it has.
  let served: OpenApiDocument = { paths: {} };
  let page: ReferencePage | null = null;
  // Run 6.3 (P-114): the pipeline takes the large slot before the body; the handlers take none.
  const large = createLargeGate(LIMITS.concurrency.largePerProcess);
  const known = handlers(
    HELD_BY_PIPELINE,
    () => served,
    () => page,
  );
  served = servedDocument(
    buildOpenApiDocument(ROUTES) as OpenApiDocument,
    new Set(Object.keys(known).filter((id) => known[id] !== undefined)),
  );
  const asset = loadScalarAsset(deps.config.referenceAssetDirectory ?? DEFAULT_ASSET_DIRECTORY);
  if (asset === null) deps.log({ event: "reference_asset_missing", time: now() });
  else page = buildReferencePage(asset, served);
  for (const route of ROUTES) mountRoute(app, deps, route.id, known[route.id] ?? null, large);
  for (const entry of deps.test?.routes ?? []) {
    mountRouteDef(app, deps, entry.def, entry.handler, large);
  }
  // After the contract routes: the auth module closes the rest of /v1/auth with a 404.
  if (deps.auth !== undefined) mountAuth(app, deps, deps.auth);

  // Run 7.1 (P-134): the workspace's shell answers where the terminal 404
  // would be, on the paths of WEB_ROUTES and for the files of its manifest,
  // after the gate and the source limit like every request. No route is
  // registered for it.
  const webDirectory =
    deps.config.webDirectory === undefined ? DEFAULT_WEB_DIRECTORY : deps.config.webDirectory;
  const shell = webDirectory === null ? null : loadWebShell(webDirectory);
  if (webDirectory !== null && shell === null) {
    deps.log({ event: "web_shell_missing", time: now() });
  }
  app.notFound((c) => {
    if (webDirectory === null) return errorResponse("not_found", c.get("requestId"));
    const answer = shellAnswer(c.req.method, c.req.path, shell);
    if (answer === null) return errorResponse("not_found", c.get("requestId"));
    if (answer.kind === "unavailable") {
      return errorResponse("dependency_unavailable", c.get("requestId"));
    }
    return answer.response;
  });
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
