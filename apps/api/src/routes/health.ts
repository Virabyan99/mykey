// health.get (Run 2.5): up when PostgreSQL (and OpenBao, where configured)
// answer within the deadline. A down answer names its cause in the log only.
import { now } from "../log.ts";
import type { HealthReading } from "../health.ts";
import type { Handler } from "../pipeline/context.ts";

export const healthHandler: Handler = async (ctx, deps) => {
  // A closed gate makes the service down from outside (P-43), whatever the stores say.
  // Run 6.7: up only when the gate admits all (a verifying product is down from outside).
  const gate = deps.gate?.read() ?? null;
  let reading: HealthReading;
  if (gate?.admits === "all") {
    reading = await deps.health();
  } else if (gate?.cause === "unreadable") {
    // The record or the database's incarnation could not be read: name the
    // stores' own failure when there is one; down in any case.
    const stores = await deps.health();
    reading = stores.up ? { up: false, cause: "gate", code: "unreadable" } : stores;
  } else {
    reading = { up: false, cause: "gate", code: gate?.cause ?? "missing" };
  }
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
