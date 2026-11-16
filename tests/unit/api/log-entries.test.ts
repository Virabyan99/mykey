// Run 6.1 Task C (P-109, FR-1.80): the API's log holds no secret by
// construction. Every entry kind is built with a run-time canary in every
// string field: the written line holds none of it, because each field has a
// format (an id, a time, an enum, a route pattern, a class name, addresses)
// and a value outside it is written as "[invalid]". Control: well-formed
// entries are written unchanged.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_SETTINGS, createLogger, redactEntry, type LogEntry } from "@mykey/api";

const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const ID = "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01";
const TIME = "2026-11-16T10:00:00.000Z";

/** One well-formed entry of every kind (the Record makes a new kind fail to compile here). */
const FIXTURES: { [K in LogEntry["event"]]: Extract<LogEntry, { event: K }>[] } = {
  request: [
    {
      event: "request",
      time: TIME,
      requestId: ID,
      method: "POST",
      path: "/v1/organizations/:org/projects",
      status: 201,
      durationMs: 12,
      bodyBytesRead: 20,
      peer: "10.78.1.3",
      forwardedFor: "198.51.100.7, 10.78.1.3",
      forwardedProto: "https",
    },
  ],
  health_down: [{ event: "health_down", time: TIME, requestId: ID, cause: "timeout", code: null }],
  gate_closed: [{ event: "gate_closed", time: TIME, requestId: ID, cause: "missing" }],
  unhandled: [
    {
      event: "unhandled",
      time: TIME,
      requestId: ID,
      routeId: "secrets.create",
      errorClass: "TypeError",
    },
  ],
  unlisted_error: [
    { event: "unlisted_error", time: TIME, requestId: ID, routeId: "secrets.create", code: "busy" },
  ],
  output_invalid: [
    { event: "output_invalid", time: TIME, requestId: ID, routeId: "audit.list", status: 200 },
    { event: "output_invalid", time: TIME, requestId: ID, routeId: "audit.list", eventId: ID },
  ],
  outbox: [{ event: "outbox", time: TIME, outcome: "failed", errorClass: "DatabaseError" }],
  reference_asset_missing: [{ event: "reference_asset_missing", time: TIME }],
  throttle_sweep: [{ event: "throttle_sweep", time: TIME, outcome: "failed", errorClass: "Error" }],
  session_cleanup: [
    { event: "session_cleanup", time: TIME, outcome: "failed", errorClass: "Error" },
  ],
  operation_sweep: [
    { event: "operation_sweep", time: TIME, outcome: "failed", errorClass: "Error" },
    { event: "operation_sweep", time: TIME, uncertain: [ID], rejected: [ID] },
  ],
  archive_continue: [{ event: "archive_continue", time: TIME, archived: [ID] }],
  machine_unauthenticated: [
    { event: "machine_unauthenticated", time: TIME, requestId: ID, cause: "token" },
  ],
  machine_last_used: [
    { event: "machine_last_used", time: TIME, outcome: "failed", errorClass: "Error" },
  ],
  listening: [{ event: "listening", port: 8443 }],
  startup_refused: [{ event: "startup_refused", missing: "MYKEY_BUILD" }],
  selfcheck: [{ event: "selfcheck", runtimeLogin: "ok", issuerLogin: "refused" }],
};

const entries = (): LogEntry[] => Object.values(FIXTURES).flat();

function written(entry: unknown): string {
  const lines: string[] = [];
  createLogger((line) => lines.push(line))(entry as LogEntry);
  expect(lines).toHaveLength(1);
  return lines[0] ?? "";
}

/** Every string field of `entry` (arrays of strings included), but `event`. */
const stringFields = (entry: LogEntry): string[] =>
  Object.entries(entry)
    .filter(
      ([key, value]) =>
        key !== "event" &&
        (typeof value === "string" ||
          (Array.isArray(value) && value.every((item) => typeof item === "string"))),
    )
    .map(([key]) => key);

describe("log entries (P-109)", () => {
  it("control: every well-formed entry is written unchanged", () => {
    // The second defence still applies: a key with a denied name (`code`) is redacted.
    for (const entry of entries()) {
      expect(JSON.parse(written(entry)), entry.event).toEqual(redactEntry(entry));
    }
  });

  it("a canary in any string field of any entry kind is not written", () => {
    let fields = 0;
    for (const entry of entries()) {
      for (const key of stringFields(entry)) {
        const mark = canary();
        const value = (entry as unknown as Record<string, unknown>)[key];
        const poisoned = { ...entry, [key]: Array.isArray(value) ? [mark] : mark };
        const line = written(poisoned);
        expect(line.includes(mark), `${entry.event}.${key}`).toBe(false);
        // A denied key is redacted before its format is looked at.
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed[key], `${entry.event}.${key}`).toEqual(
          key === "code" ? "[redacted]" : Array.isArray(value) ? ["[invalid]"] : "[invalid]",
        );
        fields += 1;
      }
    }
    expect(fields).toBeGreaterThan(30);
  });

  it("a canary under a key no entry has is not written either", () => {
    const mark = canary();
    const line = written({ ...FIXTURES.listening[0], note: mark, nested: { deep: mark } });
    expect(line.includes(mark)).toBe(false);
  });

  it("the setting names a refused start may print are the ones server.ts reads", () => {
    const server = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "apps", "api", "src", "server.ts"),
      "utf8",
    );
    const read = new Set(server.match(/"MYKEY_[A-Z_]+"/g)?.map((name) => name.slice(1, -1)));
    expect([...API_SETTINGS].sort()).toEqual([...read].sort());
  });
});
