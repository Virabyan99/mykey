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
import { closedByCapture, EXPANDING_ROUTES, LIMITS, ROUTES, type RouteDef } from "@mykey/contracts";
import type { Context, Hono } from "hono";
import { now } from "../log.ts";
import { authenticateHuman } from "./authn.ts";
import { captureMode, findOperationByKey, hasTombstone } from "@mykey/db";
import { isCaptureRefusal, replayAnswer, sameIntent, type Intent } from "@mykey/operations";
import type { UserPrincipal as Principal } from "./authn.ts";
import { admitStates, authorize, deny } from "./authz.ts";
import { checkOrigin, hasMixedCredentials, needsOriginCheck } from "./origin.ts";
import { drainBody, headerBytes, readBody } from "./body.ts";
import { MISSED_LOOKUP, authenticateMachine, hasSelector } from "./machine.ts";
import { ROUTE_CLASS_LIMIT, SESSION_EXEMPT, windowSecondsLeft, type RateScope } from "./rate.ts";
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
import { createLargeGate, type LargeGate } from "../large.ts";

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

/** One rate step (P-113): a refusal is logged with its scope, never its subject. */
export async function rateStep(
  deps: AppDeps,
  requestId: string,
  scope: RateScope,
  subject: string,
): Promise<void> {
  try {
    await deps.limiter.hit(scope, subject);
  } catch (error) {
    if (error instanceof ApiError && error.code === "rate_limited") {
      deps.log({ event: "rate_limited", time: now(), requestId, scope });
    }
    throw error;
  }
}

/**
 * Machine authentication under the miss limit (P-113): a source at the limit
 * of unattributable tokens is refused before OpenBao is asked; a refusal that
 * cost a lookup is counted after it.
 */
async function machineStep(
  deps: AppDeps,
  c: Context<ApiEnv>,
  params: Record<string, string>,
  route: RouteDef,
  requestId: string,
  source: string,
): ReturnType<typeof authenticateMachine> {
  const misses = await deps.limiter.count("rl:machine-miss", source);
  if (misses >= deps.limiter.limit("rl:machine-miss")) {
    deps.log({ event: "rate_limited", time: now(), requestId, scope: "rl:machine-miss" });
    throw new ApiError("rate_limited", "rl:machine-miss", {
      "retry-after": String(windowSecondsLeft(Date.now())),
    });
  }
  try {
    return await authenticateMachine(deps, c.env.incoming.rawHeaders, params, route, requestId);
  } catch (error) {
    if (error instanceof ApiError && error.reason === MISSED_LOOKUP) {
      // Counted; this request still answers 401 (the next one meets the check above).
      await deps.limiter.hit("rl:machine-miss", source).catch((counted: unknown) => {
        if (!(counted instanceof ApiError && counted.code === "rate_limited")) throw counted;
      });
    }
    throw error;
  }
}

/**
 * P-115: an expanding mutation under disk pressure. `low` → 507
 * capacity_exceeded { limit: "disk" }; no usable record → 503.
 */
export async function capacityStep(deps: AppDeps): Promise<void> {
  const reading = await deps.capacity.read(Date.now());
  if (reading.kind === "ok") return;
  if (reading.kind === "low") {
    throw new ApiError("capacity_exceeded", "disk", undefined, { details: { limit: "disk" } });
  }
  throw new ApiError("dependency_unavailable", `capacity_${reading.cause}`);
}

/**
 * P-118: while a pair is captured (draining or capturing), a request that
 * would write is refused before it is validated or reaches a store. The
 * routes that only read, and those that reduce access, continue.
 */
export async function captureStep(deps: AppDeps, id: string, method: string): Promise<void> {
  if (!closedByCapture(id, method)) return;
  const { mode } = await captureMode(deps.pool);
  if (mode !== "idle") throw new ApiError("busy", "capture");
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
  // P-118: a statement the capture barrier refused (a race with the change of mode).
  const code =
    error instanceof ApiError
      ? error.code
      : error instanceof AuditUnavailable
        ? "audit_unavailable"
        : isCaptureRefusal(error)
          ? "busy"
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
  // An attachment (Run 4.9) or a page (Run 5.9): the bytes as they are, their length.
  const rawKind = schema === "dotenv-attachment" || schema === "html-document";
  if (rawKind || result.raw !== undefined) {
    if (!rawKind || result.raw === undefined) {
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

/**
 * Run 6.3 (P-114, M-5): the routes that read or write up to a whole
 * environment. For them authentication, the session or credential limit and
 * the large slot come before the body is read.
 */
export const LARGE_ROUTES: ReadonlySet<string> = new Set([
  "import.preview",
  "import.apply",
  "import.resume",
  "export.create",
  "machine.resolve",
]);

async function run(
  c: Context<ApiEnv>,
  route: RouteDef,
  handler: Handler,
  deps: AppDeps,
  large: LargeGate,
): Promise<Response> {
  const requestId = c.get("requestId");
  c.set("routePattern", route.path);
  let slot = false;
  try {
    if (headerBytes(c.env.incoming.rawHeaders) > LIMITS.body.headersMaxBytes) {
      throw new ApiError("malformed_request");
    }
    const counted = (bytes: number) => {
      c.set("bodyBytesRead", c.get("bodyBytesRead") + bytes);
    };
    const machineRoute = route.auth === "machine";
    // A machine route takes no body; any JSON it is sent is read only to be refused as a selector.
    const readRaw = () =>
      readBody(
        c.req.raw,
        machineRoute && route.method !== "GET" && hasBodyBytes(c.req.raw.headers)
          ? { ...route, request: { ...route.request, body: "pending" } }
          : route,
        counted,
      );
    const early = LARGE_ROUTES.has(route.id);
    let raw = early || route.id === "health.get" ? undefined : await readRaw();
    // Session 11 (Run 11.2): the contract names two classes this build cannot
    // authenticate yet. A route of them is the terminal 404 for every caller,
    // before a header, a query or a state is looked at; no handler of such a
    // route can be reached. Runs 11.3 and 11.5 put their authentication here.
    if (route.auth === "machine_exchange" || route.auth === "automation") throw new NoHandler();
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
    const source = requestSource(
      c.env.incoming.socket.remoteAddress,
      c.req.header("x-forwarded-for"),
      deps.config.trustedProxy,
    );
    // Authentication before strict validation: an anonymous caller learns nothing from a 422.
    const principal = human ? await authenticateHuman(deps, headers) : null;
    // P-113: the session limit, but for the routes that reduce exposure.
    if (principal !== null && !SESSION_EXEMPT.has(route.id)) {
      await rateStep(deps, requestId, "rl:session", principal.sessionId);
    }
    // A machine request (P-93): the token, its catalog row, its own path; then
    // no selector. No Origin, no authorize (the binding is the authorization),
    // no replay, no freshness, no validation.
    const params = c.req.param();
    const machine = machineRoute
      ? await machineStep(deps, c, params, route, requestId, source)
      : null;
    if (machine !== null) await rateStep(deps, requestId, "rl:credential", machine.credentialId);
    // P-118: after the gate and the limits, before validation.
    await captureStep(deps, route.id, route.method);
    if (early) {
      // P-114: a slot, or busy at once; only then the body.
      if (!large.enter()) throw new ApiError("busy");
      slot = true;
      raw = await readRaw();
    }
    if (machine !== null && hasSelector(c.req.url, raw)) throw new ApiError("forbidden_selector");
    const clock = deps.test?.clock?.(headers);
    // Run 8.2: health lists no error code (it answers its body); it reads no query and no body
    // (`raw` above is not read for it either).
    const unread = machineRoute || route.id === "health.get";
    const query = unread ? undefined : validateQuery(route, new URL(c.req.url).searchParams);
    const body = unread ? undefined : validateBody(route, raw);
    const access =
      principal === null
        ? { scope: null, authority: null, resolved: null }
        : await authorize(deps, route, params, principal, requestId);
    // P-113: the route's own class, per person, after authorization.
    const routeClass = ROUTE_CLASS_LIMIT[route.id];
    if (routeClass !== undefined && principal !== null) {
      await rateStep(deps, requestId, routeClass.scope, principal.userId);
    }
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
    // P-115: after a replay (which adds nothing), before any state is read or written.
    if (EXPANDING_ROUTES.has(route.id)) await capacityStep(deps);
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
    // `handled`: false for the terminal 404 of a route this build has no handler for (Run 5.9).
    await deps.test?.beforeHandler?.(route.id, { handled: handler !== terminal });
    const result = await handler(
      {
        requestId,
        source,
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
    // P-114: a large route refused before its body was read drains it first.
    if (LARGE_ROUTES.has(route.id) && hasBodyBytes(c.req.raw.headers)) {
      await drainBody(c.req.raw);
    }
    return failureResponse(error, route, requestId, deps);
  } finally {
    if (slot) large.leave();
  }
}

/** Mounts a route from its definition. */
export function mountRouteDef(
  app: Hono<ApiEnv>,
  deps: AppDeps,
  route: RouteDef,
  handler: Handler | null,
  large: LargeGate = createLargeGate(LIMITS.concurrency.largePerProcess),
): void {
  app.on(route.method, route.path, (c) => run(c, route, handler ?? terminal, deps, large));
}

/** Mounts the contract route `routeId`; a null handler gives the terminal 404. */
export function mountRoute(
  app: Hono<ApiEnv>,
  deps: AppDeps,
  routeId: string,
  handler: Handler | null,
  large?: LargeGate,
): void {
  mountRouteDef(app, deps, routeById(routeId), handler, large);
}
