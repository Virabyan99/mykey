// Types shared by every step of the request pipeline (Run 3.1).
import type { HttpBindings } from "@hono/node-server";
import type { Auth, AuthKeys, Throttle } from "@mykey/auth";
import type { ErrorCode, RouteDef } from "@mykey/contracts";
import type pg from "pg";
import type { HealthReading } from "../health.ts";
import type { LogEntry } from "../log.ts";

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
}

export interface TestRouteEntry {
  def: RouteDef;
  handler: Handler;
}

export interface AppDeps {
  /** The API's pool, logged in as api_runtime. */
  pool: pg.Pool;
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
  test?: { routes?: readonly TestRouteEntry[] };
}

export interface ApiContext {
  requestId: string;
  source: string;
  route: RouteDef;
  body: unknown;
  query: unknown;
  params: Record<string, string>;
  principal: null;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export type Handler = (ctx: ApiContext, deps: AppDeps) => Promise<HandlerResult>;

/** An answer the handler chose. It becomes its envelope only when the route lists the code. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly reason: string | undefined;

  constructor(code: ErrorCode, reason?: string) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.reason = reason;
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
