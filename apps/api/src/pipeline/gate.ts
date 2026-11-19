// The service gate of the API (P-43; v2 since Run 6.7, P-122, P-123, D-54).
// The record reader lives in @mykey/operations (the provisioner reads the same
// record); here it is combined with the database's backend incarnation, which
// must equal this process's own: a restored database carries the old one, so a
// host that was not taken through the restore cannot serve on it.
//
// The incarnation is read at the first request and then reused for 5 s; a
// failed read counts as "no incarnation" (closed). The middleware refreshes it
// before every request, so write-time `gateOpen()` checks see a fresh value.
import type pg from "pg";
import { readGate, type GateReading } from "@mykey/operations";
import type { ApiConfig } from "./context.ts";

export {
  GATE_MAX_BYTES,
  readGate,
  type GateAdmits,
  type GateCause,
  type GateExpect,
  type GateIo,
  type GateReading,
  type GateRecord,
} from "@mykey/operations";

/** Which listener a request came in on (P-123). */
export type Listener = "public" | "verify";

export const INCARNATION_REUSE_MS = 5_000;

export interface ServiceGate {
  /** Reads the database's incarnation when the last reading is older than 5 s. */
  refresh(): Promise<void>;
  /** The record, bound to this host, incarnation and build, and the database's incarnation. */
  read(): GateReading;
  /** Write time (every effect on OpenBao, every state change): only `all`. */
  open(): boolean;
}

export function createServiceGate(
  config: ApiConfig,
  pool: pg.Pool,
  clock: () => number = Date.now,
): ServiceGate {
  // undefined: not readable (no answer yet, or the last read failed).
  let incarnation: string | null | undefined = undefined;
  let readAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> | null = null;
  const expect = {
    hostInstanceId: config.hostInstanceId,
    backendIncarnation: config.backendIncarnation,
    releaseBuild: config.build,
  };
  const load = async (): Promise<void> => {
    try {
      const result = await pool.query<{ incarnation: string | null }>(
        "SELECT backend_incarnation AS incarnation FROM app.service_control LIMIT 1",
      );
      incarnation = result.rows[0]?.incarnation ?? null;
    } catch {
      incarnation = undefined;
    }
    readAt = clock();
  };
  const read = (): GateReading => {
    const reading = readGate(config.gatePath, expect);
    if (reading.admits !== "none" && incarnation !== config.backendIncarnation) {
      // Closed either way; "unreadable" lets /health name the database's own failure.
      const cause = incarnation === undefined ? "unreadable" : "incarnation";
      return { admits: "none", cause, record: reading.record };
    }
    return reading;
  };
  return {
    refresh() {
      if (clock() - readAt < INCARNATION_REUSE_MS) return Promise.resolve();
      pending ??= load().finally(() => {
        pending = null;
      });
      return pending;
    },
    read,
    open: () => read().admits === "all",
  };
}

/**
 * P-123: what the verification listener serves while the gate admits only
 * `verification`: reads, the auth module (reset completion, enrolment,
 * sign-in, sign-out) and a reveal, which audits first. Every other write and
 * both machine routes are quarantined; write-time gateOpen() refuses any
 * effect on OpenBao in any case.
 */
export function verificationServes(method: string, path: string): boolean {
  if (path.startsWith("/v1/machine/")) return false;
  if (method === "GET") return true;
  if (path.startsWith("/v1/auth/")) return true;
  return (
    method === "POST" &&
    /^\/v1\/organizations\/[^/]+\/projects\/[^/]+\/environments\/[^/]+\/secrets\/[^/]+\/reveal$/.test(
      path,
    )
  );
}
