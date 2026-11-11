// The HTTP surface of the API stub (Run 2.5): GET /health and nothing else.
// Run 3.1 replaces this piece by piece with the routes of @mykey/contracts.
import { randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import type { ErrorEnvelope } from "@mykey/contracts";
import { Hono } from "hono";
import type { HealthCause, HealthReading } from "./health.ts";

export type RequestLogEntry =
  | {
      event: "request";
      time: string;
      requestId: string;
      method: string;
      path: string;
      status: number;
      durationMs: number;
      /** The address of the TCP peer: the proxy in production. */
      peer: string | null;
      /** The X-Forwarded-For value as received. Informational; nothing trusts it. */
      forwardedFor: string | null;
      /** The X-Forwarded-Proto value as received. Informational; nothing trusts it. */
      forwardedProto: string | null;
    }
  | {
      event: "health_down";
      time: string;
      requestId: string;
      cause: HealthCause;
      code: string | null;
    };

export interface AppDependencies {
  health: () => Promise<HealthReading>;
  /** One call per line. The entry never holds a request body, a credential or a database setting. */
  log: (entry: RequestLogEntry) => void;
}

interface Environment {
  Bindings: HttpBindings;
  Variables: { requestId: string };
}

export function createApp(deps: AppDependencies): Hono<Environment> {
  const app = new Hono<Environment>();

  app.use(async (c, next) => {
    const started = performance.now();
    const requestId = randomUUID();
    c.set("requestId", requestId);
    await next();
    // Names the log line of this request, so it can be found from outside.
    c.header("x-request-id", requestId);
    deps.log({
      event: "request",
      time: new Date().toISOString(),
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
      peer: c.env.incoming.socket.remoteAddress ?? null,
      forwardedFor: c.req.header("x-forwarded-for") ?? null,
      forwardedProto: c.req.header("x-forwarded-proto") ?? null,
    });
  });

  app.get("/health", async (c) => {
    const reading = await deps.health();
    if (reading.up) return c.json({ status: "up" }, 200);
    deps.log({
      event: "health_down",
      time: new Date().toISOString(),
      requestId: c.get("requestId"),
      cause: reading.cause,
      code: reading.code,
    });
    return c.json({ status: "down" }, 503);
  });

  app.notFound((c) => {
    const body = {
      error: { code: "not_found", message: "Not found.", requestId: c.get("requestId") },
    } as ErrorEnvelope;
    return c.json(body, 404);
  });

  return app;
}
