// The external service gate (P-43, Doc 06 §14.1), version 2 since Run 6.7
// (P-122, D-54). The API and the provisioner serve only while a root-owned
// gate record, mounted read-only, admits them. The file is opened afresh for
// every reading (no cache), so an atomic replacement is seen at once.
//
// A reading admits:
// - `all`: state open, phase serving, and the record's host instance,
//   backend incarnation and release build equal to the process's own;
// - `verification`: state closed, phase verifying, the same three equal — only
//   the private verification listener serves (P-123), and no write-time
//   gateOpen() passes;
// - `none`: anything else, a v1 record included, with its cause.
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  REPORT_MAX_AGE_MS,
  REQUIRED_CHECKS,
  gateRecordV2Schema,
  type GateRecordV2,
  type VerificationReport,
} from "@mykey/contracts";

export type GateAdmits = "all" | "verification" | "none";
export type GateCause =
  "missing" | "unreadable" | "invalid" | "version" | "host" | "incarnation" | "build" | "closed";

/** What this process is: from host.env (host, incarnation) and the image (build). */
export interface GateExpect {
  hostInstanceId: string;
  backendIncarnation: string;
  releaseBuild: string;
}

export interface GateReading {
  admits: GateAdmits;
  cause: GateCause | null;
  record: GateRecordV2 | null;
}

/** The previous name of the record type. */
export type GateRecord = GateRecordV2;

export const GATE_MAX_BYTES = 4096;

/** File operations, replaceable in unit tests only (a permission error on Windows). */
export interface GateIo {
  openSync?: (path: string, flags: number) => number;
}

const none = (cause: GateCause, record: GateRecordV2 | null = null): GateReading => ({
  admits: "none",
  cause,
  record,
});

function causeOfOpenError(error: unknown): GateCause {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "missing";
  // A symbolic link (O_NOFOLLOW) or a directory is not a record.
  if (code === "ELOOP" || code === "EISDIR") return "invalid";
  return "unreadable";
}

export function readGate(path: string, expect: GateExpect, io: GateIo = {}): GateReading {
  // O_NOFOLLOW where the platform has it (Linux, the hosts); elsewhere lstat first.
  const noFollow = fs.constants.O_NOFOLLOW as number | undefined;
  if (noFollow === undefined) {
    try {
      if (fs.lstatSync(path).isSymbolicLink()) return none("invalid");
    } catch (error) {
      return none(causeOfOpenError(error));
    }
  }
  let descriptor: number;
  try {
    descriptor = (io.openSync ?? fs.openSync)(path, fs.constants.O_RDONLY | (noFollow ?? 0));
  } catch (error) {
    return none(causeOfOpenError(error));
  }
  let text: string;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > GATE_MAX_BYTES) return none("invalid");
    const buffer = Buffer.alloc(GATE_MAX_BYTES + 1);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > GATE_MAX_BYTES) return none("invalid");
    text = buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    return none(causeOfOpenError(error));
  } finally {
    fs.closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none("invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return none("invalid");
  }
  if ((parsed as { version?: unknown }).version !== 2) {
    return none("version" in parsed ? "version" : "invalid");
  }
  const result = gateRecordV2Schema.safeParse(parsed);
  if (!result.success) return none("invalid");
  const record = result.data;
  if (record.hostInstanceId !== expect.hostInstanceId) return none("host", record);
  if (record.backendIncarnation !== expect.backendIncarnation) return none("incarnation", record);
  if (record.releaseBuild !== expect.releaseBuild) return none("build", record);
  if (record.state === "open" && record.phase === "serving") {
    return { admits: "all", cause: null, record };
  }
  if (record.state === "closed" && record.phase === "verifying") {
    return { admits: "verification", cause: "closed", record };
  }
  return none("closed", record);
}

/** JSON with object keys sorted, no whitespace: the form a report is hashed in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The hash a gate record names for a report. */
export function reportSha256(report: VerificationReport): string {
  return createHash("sha256").update(canonical(report)).digest("hex");
}

/**
 * Whether a report may open the gate: of this host, incarnation and build,
 * younger than 30 minutes (and not from the future), every required check of
 * its kind present and `ok`. `unknown` refuses as `failed` does.
 */
export function mayOpen(
  report: VerificationReport,
  expect: GateExpect,
  kind: "restore" | "deploy",
  nowMs: number,
): { ok: true; sha256: string } | { ok: false; cause: string } {
  const created = Date.parse(report.createdAt);
  if (Number.isNaN(created)) return { ok: false, cause: "the report has no time" };
  if (created > nowMs + 60_000) return { ok: false, cause: "the report is in the future" };
  if (nowMs - created > REPORT_MAX_AGE_MS) {
    return { ok: false, cause: "the report is older than 30 minutes" };
  }
  if (report.hostInstanceId !== expect.hostInstanceId) {
    return { ok: false, cause: "the report is of another host" };
  }
  if (report.backendIncarnation !== expect.backendIncarnation) {
    return { ok: false, cause: "the report is of another incarnation" };
  }
  if (report.releaseBuild !== expect.releaseBuild) {
    return { ok: false, cause: "the report is of another build" };
  }
  for (const id of REQUIRED_CHECKS[kind]) {
    const check = report.checks.find((c) => c.id === id);
    if (check === undefined) return { ok: false, cause: `check ${id} is missing` };
    if (check.state !== "ok") return { ok: false, cause: `check ${id} is ${check.state}` };
  }
  const notOk = report.checks.find((c) => c.state !== "ok");
  if (notOk !== undefined) return { ok: false, cause: `check ${notOk.id} is ${notOk.state}` };
  return { ok: true, sha256: reportSha256(report) };
}
