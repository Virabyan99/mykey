// Types shared by every step of the request pipeline (Run 3.1).
import type { HttpBindings } from "@hono/node-server";
import type { Auth, AuthKeys, Throttle } from "@mykey/auth";
import type { Authority, ErrorCode, RouteDef } from "@mykey/contracts";
import type { OperationRow } from "@mykey/db";
import type { IssuerBao, RuntimeBao } from "@mykey/operations";
import type pg from "pg";
import type { HealthReading } from "../health.ts";
import type { LogEntry } from "../log.ts";
import type { UserPrincipal } from "./authn.ts";
import type { MachinePrincipal } from "./machine.ts";
import type { Scope } from "./authz.ts";

export interface ApiConfig {
  /** The public origin, e.g. https://mykey-staging.nomikey.com. */
  baseUrl: string;
  /** The commit the image was built from. */
  build: string;
  /** The gate record (P-43), read afresh for every request. */
  gatePath: string;
  /** The host the gate record must name. */
  hostInstanceId: string;
  /** The edge proxy's address; only its X-Forwarded-For is believed (P-47, Run 3.3). */
  trustedProxy: string | null;
  /** Where scalar.js and scalar.json are (Run 5.9); default apps/api/assets. */
  referenceAssetDirectory?: string;
}

export interface TestRouteEntry {
  def: RouteDef;
  handler: Handler;
}

export interface AppDeps {
  /** The API's pool, logged in as api_runtime. */
  pool: pg.Pool;
  /**
   * One dedicated connection per secret action or value read (P-66, D-36): it
   * holds the environment's advisory lock. Absent: secret routes answer 503.
   */
  lockPool?: pg.Pool;
  /** The organization's runtime identity in OpenBao (P-62, D-34). */
  bao?: RuntimeBao;
  /** The organization's issuer identity (Run 5.1, P-85): one session per credential step. */
  issuer?: IssuerBao;
  /** A UUID per process start: the executor id of the operations it runs. */
  bootId: string;
  config: ApiConfig;
  health: () => Promise<HealthReading>;
  log: (entry: LogEntry) => void;
  /** The auth module (Run 3.2): Better Auth, the key rings and throttling. */
  auth?: {
    auth: Auth;
    keys: AuthKeys;
    throttle: Throttle;
  };
  /** Set by the integration harness only; the production entry never sets it. */
  test?: {
    routes?: readonly TestRouteEntry[];
    /** Replaces the terminal 404 of a route without a handler: records the id, answers 204. */
    stubs?: (routeId: string) => void | Promise<void>;
    /** The stub replaces every contract route's handler but health and version (P-80). */
    stubAll?: boolean;
    /** These contract routes answer through the stub although they have a handler (Run 4.2). */
    stubRoutes?: ReadonlySet<string>;
    /** Runs after freshness, before a real handler (Run 4.1): a state change after the pipeline. */
    beforeHandler?: (routeId: string, info: { handled: boolean }) => Promise<void>;
    /** Fault hooks of the secret protocol (Run 4.2, FAULT_POINTS). */
    faults?: (point: string, operationId: string) => Promise<void>;
    /** The time TOTP codes are checked at, from a request header. */
    clock?: (headers: Headers) => Date | undefined;
    /** An import's time budget per request (Run 4.7), read on every request; undefined: the product's. */
    importBudgetMs?: () => number | undefined;
  };
}

export interface ApiContext {
  requestId: string;
  source: string;
  route: RouteDef;
  body: unknown;
  query: unknown;
  params: Record<string, string>;
  /** The person of a human route; null on every other route. */
  principal: UserPrincipal | null;
  /** The credential of a machine route (Run 5.4, P-93); null on every other route. */
  machine: MachinePrincipal | null;
  /** The resolved organization, project and environment of a scoped human route (Run 3.7). */
  scope: Scope | null;
  /** The caller's authority in that organization, read on this request. */
  authority: Authority | null;
  /** The operation a route of scope `operation` names, read on this request (Run 4.1). */
  operation: OperationRow | null;
  /** The request's Idempotency-Key (lower case) on a mutation route (Run 3.9). */
  idempotencyKey: string | null;
  /** The harness's clock for TOTP codes (AppDeps.test.clock); undefined in production. */
  now?: Date;
}

export interface HandlerResult {
  status: number;
  body: unknown;
  /** Extra response headers (a session cookie, Run 3.6). */
  headers?: Record<string, string>;
  /**
   * Run 5.4 (P-94): the JSON body is serialized once into a buffer and sent
   * with its content-length (the machine routes).
   */
  buffered?: boolean;
  /**
   * Only for a route whose response kind is "dotenv-attachment" (Run 4.9) or
   * "html-document" (Run 5.9): the body as sent.
   */
  raw?: { bytes: Uint8Array; contentType: string };
}

export type Handler = (ctx: ApiContext, deps: AppDeps) => Promise<HandlerResult>;

/** An answer the handler chose. It becomes its envelope only when the route lists the code. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly reason: string | undefined;
  /** Headers of the error answer (Retry-After of a 429). */
  readonly headers: Record<string, string> | undefined;
  /** The operation the answer is about, and allowlisted details (Run 4.1, respond.ts). */
  readonly extra: { operationId?: string; details?: Record<string, unknown> };

  constructor(
    code: ErrorCode,
    reason?: string,
    headers?: Record<string, string>,
    extra: { operationId?: string; details?: Record<string, unknown> } = {},
  ) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.reason = reason;
    this.headers = headers;
    this.extra = extra;
  }
}

export interface ApiEnv {
  Bindings: HttpBindings;
  Variables: {
    requestId: string;
    /** The matched route pattern; null when nothing matched. */
    routePattern: string | null;
    bodyBytesRead: number;
  };
}
