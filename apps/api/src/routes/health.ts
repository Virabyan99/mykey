// health.get (Run 2.5): up when PostgreSQL (and OpenBao, where configured)
// answer within the deadline. A down answer names its cause in the log only.
import { now } from "../log.ts";
import type { HealthReading } from "../health.ts";
import type { Handler } from "../pipeline/context.ts";
import { readGate } from "../pipeline/gate.ts";

export const healthHandler: Handler = async (ctx, deps) => {
  // A closed gate makes the service down from outside (P-43), whatever the stores say.
  const gate = readGate(deps.config.gatePath, deps.config.hostInstanceId);
  const reading: HealthReading = gate.open
    ? await deps.health()
    : { up: false, cause: "gate", code: gate.cause };
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
