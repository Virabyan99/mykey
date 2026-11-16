// The capacity record's reader (Run 6.3, P-115, D-49). Opened afresh for every
// mutation, as the gate is: an atomic replacement by the host is seen by the
// next request. A record that is missing, unreadable, invalid or older than
// 180 s says nothing about the disk: `unknown`, and the expanding routes are
// 503 until the host writes one again.
import fs from "node:fs";
import { capacityRecordSchema } from "@mykey/contracts";
import { GATE_MAX_BYTES, type GateIo } from "./gate.ts";

export type CapacityReading =
  | { kind: "ok" }
  | { kind: "low" }
  | { kind: "unknown"; cause: "missing" | "unreadable" | "invalid" | "stale" };

/** A record older than this is stale (the host writes one a minute). */
export const CAPACITY_MAX_AGE_MS = 180_000;

const unknown = (cause: "missing" | "unreadable" | "invalid" | "stale"): CapacityReading => ({
  kind: "unknown",
  cause,
});

function causeOf(error: unknown): "missing" | "unreadable" | "invalid" {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "missing";
  if (code === "ELOOP" || code === "EISDIR") return "invalid";
  return "unreadable";
}

export function readCapacity(
  path: string,
  nowMs: number,
  io: GateIo = {},
): Promise<CapacityReading> {
  return Promise.resolve(readNow(path, nowMs, io));
}

function readNow(path: string, nowMs: number, io: GateIo): CapacityReading {
  const noFollow = fs.constants.O_NOFOLLOW as number | undefined;
  if (noFollow === undefined) {
    try {
      if (fs.lstatSync(path).isSymbolicLink()) return unknown("invalid");
    } catch (error) {
      return unknown(causeOf(error));
    }
  }
  let descriptor: number;
  try {
    descriptor = (io.openSync ?? fs.openSync)(path, fs.constants.O_RDONLY | (noFollow ?? 0));
  } catch (error) {
    return unknown(causeOf(error));
  }
  let text: string;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > GATE_MAX_BYTES) return unknown("invalid");
    const buffer = Buffer.alloc(GATE_MAX_BYTES + 1);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > GATE_MAX_BYTES) return unknown("invalid");
    text = buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    return unknown(causeOf(error));
  } finally {
    fs.closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unknown("invalid");
  }
  const record = capacityRecordSchema.safeParse(parsed);
  if (!record.success) return unknown("invalid");
  if (nowMs - Date.parse(record.data.observedAt) > CAPACITY_MAX_AGE_MS) return unknown("stale");
  return { kind: record.data.state };
}
