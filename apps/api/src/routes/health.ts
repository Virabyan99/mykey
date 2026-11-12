// health.get (Run 2.5): up when PostgreSQL (and OpenBao, where configured)
// answer within the deadline. A down answer names its cause in the log only.
import { now } from "../log.ts";
import type { Handler } from "../pipeline/context.ts";

export const healthHandler: Handler = async (ctx, deps) => {
  const reading = await deps.health();
  if (reading.up) return { status: 200, body: { status: "up" } };
  deps.log({
    event: "health_down",
    time: now(),
    requestId: ctx.requestId,
    cause: reading.cause,
    code: reading.code,
  });
  return { status: 503, body: { status: "down" } };
};
