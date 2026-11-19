// Run 6.7 (P-122, D-54): writing the gate record, v2.
//
// - open: only with a verification report that `mayOpen` accepts (this host,
//   incarnation and build, younger than 30 minutes, every required check ok),
//   and only after `operator.gate_open` is in the audit table: with audit
//   unavailable the record is not changed. The record names the report's hash.
// - close: needs nothing. The record is written first (closing is always
//   safe); `operator.gate_close` is appended when the database answers.
//
// The writer is the record's file: a local path in tests, the host's
// /etc/mykey/gate/gate.json through SSH in `host.ts <host> gate`.
import { appendAudit } from "@mykey/audit";
import {
  gateRecordV2Schema,
  verificationReportSchema,
  type GateRecordV2,
  type VerificationReport,
} from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import type pg from "pg";
import { mayOpen, type GateExpect } from "./gate.ts";

export interface GateWriter {
  /** The current record's text, or null when there is none. */
  read(): Promise<string | null>;
  /** Replaces the record atomically. */
  write(text: string): Promise<void>;
}

function nextEpoch(previous: string | null): number {
  if (previous === null) return 1;
  try {
    const value = (JSON.parse(previous) as { gateEpoch?: unknown }).gateEpoch;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value + 1;
  } catch {
    // An unreadable previous record: start above 0 again; readers see it as closed anyway.
  }
  return 1;
}

const auditGate = (
  pool: pg.Pool,
  action: "operator.gate_open" | "operator.gate_close",
  details: { gateEpoch: number; origin?: "fresh_install" | "restore" },
): Promise<string> =>
  withTransaction(pool, (tx) =>
    appendAudit(tx, {
      action,
      actor: { kind: "operator", id: null },
      source: "operator",
      organizationId: null,
      target: null,
      outcome: "success",
      requestId: null,
      operationId: null,
      details,
    }),
  );

export type GateWriteResult = { ok: true; record: GateRecordV2 } | { ok: false; cause: string };

export async function openGate(deps: {
  writer: GateWriter;
  /** As maintenance. */
  pool: pg.Pool;
  expect: GateExpect;
  report: unknown;
  kind: "restore" | "deploy";
  now: () => Date;
  /**
   * Checks the command performs again itself right before opening (P-124:
   * sessions, accessors, control row, incarnation); a check that is not ok refuses.
   */
  recheck?: () => Promise<readonly { id: string; state: "ok" | "failed" | "unknown" }[]>;
}): Promise<GateWriteResult> {
  const parsed = verificationReportSchema.safeParse(deps.report);
  if (!parsed.success) return { ok: false, cause: "the report is not a verification report" };
  const report: VerificationReport = parsed.data;
  const allowed = mayOpen(report, deps.expect, deps.kind, deps.now().getTime());
  if (!allowed.ok) return allowed;
  for (const check of (await deps.recheck?.()) ?? []) {
    if (check.state !== "ok") {
      return { ok: false, cause: `check ${check.id} is ${check.state} now` };
    }
  }
  const gateEpoch = nextEpoch(await deps.writer.read());
  try {
    await auditGate(deps.pool, "operator.gate_open", { gateEpoch, origin: report.origin.kind });
  } catch {
    return { ok: false, cause: "audit unavailable: the gate stays as it is" };
  }
  const record = gateRecordV2Schema.parse({
    version: 2,
    state: "open",
    gateEpoch,
    hostInstanceId: deps.expect.hostInstanceId,
    backendIncarnation: deps.expect.backendIncarnation,
    origin: report.origin,
    releaseBuild: deps.expect.releaseBuild,
    reportSha256: allowed.sha256,
    phase: "serving",
    writtenAt: deps.now().toISOString(),
  });
  await deps.writer.write(JSON.stringify(record));
  return { ok: true, record };
}

export async function closeGate(deps: {
  writer: GateWriter;
  /** As maintenance; null or failing: the close is still written. */
  pool: pg.Pool | null;
  expect: GateExpect;
  origin: GateRecordV2["origin"];
  /** `verifying` lets the private verification listener serve (P-123). */
  phase: "verifying" | "serving";
  now: () => Date;
}): Promise<{ record: GateRecordV2; audited: boolean }> {
  const gateEpoch = nextEpoch(await deps.writer.read());
  const record = gateRecordV2Schema.parse({
    version: 2,
    state: "closed",
    gateEpoch,
    hostInstanceId: deps.expect.hostInstanceId,
    backendIncarnation: deps.expect.backendIncarnation,
    origin: deps.origin,
    releaseBuild: deps.expect.releaseBuild,
    reportSha256: null,
    phase: deps.phase,
    writtenAt: deps.now().toISOString(),
  });
  await deps.writer.write(JSON.stringify(record));
  let audited = false;
  if (deps.pool !== null) {
    audited = await auditGate(deps.pool, "operator.gate_close", { gateEpoch }).then(
      () => true,
      () => false,
    );
  }
  return { record, audited };
}
