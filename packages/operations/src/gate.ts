// The external service gate (P-43, Doc 06 §14.1). The API serves only while a
// root-owned gate record, mounted read-only, says `open` and names this host.
// The file is opened afresh for every request (no cache), so an atomic
// replacement is seen by the next request. Anything unexpected is closed.
//
// Record v1: {"version":1,"state":"open"|"closed","gateEpoch":<int>,
// "hostInstanceId":"<uuid>","writtenAt":"<iso>"}, at most 4,096 bytes, strict.
// The bindings to backend incarnation, restore pair, release and report hash
// are version 2 (Run 6.7); an unknown version is closed.
import fs from "node:fs";
import { z } from "zod";

export type GateCause = "missing" | "unreadable" | "invalid" | "version" | "host" | "closed";

export type GateReading = { open: true; gateEpoch: number } | { open: false; cause: GateCause };

export const GATE_MAX_BYTES = 4096;

const recordSchema = z.strictObject({
  version: z.literal(1),
  state: z.enum(["open", "closed"]),
  gateEpoch: z.int().nonnegative(),
  hostInstanceId: z.uuid(),
  writtenAt: z.iso.datetime(),
});

export type GateRecord = z.infer<typeof recordSchema>;

/** File operations, replaceable in unit tests only (a permission error on Windows). */
export interface GateIo {
  openSync?: (path: string, flags: number) => number;
}

const closed = (cause: GateCause): GateReading => ({ open: false, cause });

function causeOfOpenError(error: unknown): GateCause {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "missing";
  // A symbolic link (O_NOFOLLOW) or a directory is not a record.
  if (code === "ELOOP" || code === "EISDIR") return "invalid";
  return "unreadable";
}

export function readGate(path: string, hostInstanceId: string, io: GateIo = {}): GateReading {
  // O_NOFOLLOW where the platform has it (Linux, the hosts); elsewhere lstat first.
  const noFollow = fs.constants.O_NOFOLLOW as number | undefined;
  if (noFollow === undefined) {
    try {
      if (fs.lstatSync(path).isSymbolicLink()) return closed("invalid");
    } catch (error) {
      return closed(causeOfOpenError(error));
    }
  }
  let descriptor: number;
  try {
    descriptor = (io.openSync ?? fs.openSync)(path, fs.constants.O_RDONLY | (noFollow ?? 0));
  } catch (error) {
    return closed(causeOfOpenError(error));
  }
  let text: string;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > GATE_MAX_BYTES) return closed("invalid");
    const buffer = Buffer.alloc(GATE_MAX_BYTES + 1);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > GATE_MAX_BYTES) return closed("invalid");
    text = buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    return closed(causeOfOpenError(error));
  } finally {
    fs.closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return closed("invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return closed("invalid");
  }
  if ((parsed as { version?: unknown }).version !== 1) {
    return closed("version" in parsed ? "version" : "invalid");
  }
  const record = recordSchema.safeParse(parsed);
  if (!record.success) return closed("invalid");
  if (record.data.hostInstanceId !== hostInstanceId) return closed("host");
  if (record.data.state !== "open") return closed("closed");
  return { open: true, gateEpoch: record.data.gateEpoch };
}
