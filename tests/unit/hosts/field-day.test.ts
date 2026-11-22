// Run 9.6 Task A (P-166, FR-1.100, D-72): one record per calendar day from the
// host's own facts. Over a fixture of the API's journal lines and audit rows:
// what a record holds (counts and timings only), how a day is classified,
// and that a day with the gate closed is an outage whatever else happened.
import { describe, expect, it } from "vitest";
import {
  RECORD_KEYS,
  classifyDay,
  dayRecord,
  healthLines,
  type AuditFact,
  type DayInput,
} from "../../../infra/hosts/field/day.ts";
import { gateClosedIn, headroomOf, parseAudit } from "../../../infra/hosts/field/collect.ts";

const DATE = "2026-11-24";
const CREDENTIAL = "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01";
const OWNER = "0b3a3c1e-9f01-4f43-9a51-6f1c2a1e1d7b";
const SECRET_NAME = "STRIPE_SECRET_KEY";

const request = (path: string, method: string, status: number, durationMs: number, minute = 0) =>
  JSON.stringify({
    event: "request",
    time: `${DATE}T10:${String(minute).padStart(2, "0")}:00.000Z`,
    requestId: "11111111-2222-4333-8444-555555555555",
    method,
    path,
    status,
    durationMs,
    bodyBytesRead: 0,
    peer: "10.78.1.2",
    forwardedFor: "203.0.113.9",
    forwardedProto: "https",
  });

const MACHINE = "/v1/machine/projects/:project/environments/:environment/resolve";

function input(over: Partial<DayInput> = {}): DayInput {
  const lines = [
    ...Array.from({ length: 25 }, (_, i) => request(MACHINE, "POST", 200, 40 + i)),
    request(MACHINE, "POST", 401, 5),
    request("/v1/organizations/:org/projects", "GET", 200, 12),
    "not json at all",
    // The probe's minute check: up all day but for 03:01 and 03:02.
    ...healthLines(DATE, new Set(["03:01", "03:02"])),
    JSON.stringify({
      event: "health_down",
      time: `${DATE}T03:01:10Z`,
      requestId: "r",
      cause: "db",
      code: null,
    }),
    JSON.stringify({
      event: "health_down",
      time: `${DATE}T03:01:50Z`,
      requestId: "r",
      cause: "db",
      code: null,
    }),
    JSON.stringify({
      event: "health_down",
      time: `${DATE}T03:02:05Z`,
      requestId: "r",
      cause: "db",
      code: null,
    }),
  ];
  const audit: AuditFact[] = [
    { action: "machine.resolve", actorKind: "machine", actorId: CREDENTIAL, outcome: "success" },
    { action: "machine.resolve", actorKind: "machine", actorId: CREDENTIAL, outcome: "success" },
    { action: "auth.mfa_complete", actorKind: "user", actorId: OWNER, outcome: "success" },
    { action: "auth.sign_in", actorKind: "user", actorId: OWNER, outcome: "failure" },
    { action: "secret.update", actorKind: "user", actorId: OWNER, outcome: "success" },
    { action: "secret.reveal", actorKind: "user", actorId: OWNER, outcome: "success" },
  ];
  return {
    date: DATE,
    journal: lines,
    audit,
    gateClosed: false,
    newestPairCapturedAt: "2026-11-24T03:00:05Z",
    capacity: { headroomPercent: 71.5 },
    labels: new Map(),
    ...over,
  };
}

describe("the field day record (P-166)", () => {
  it('the day record holds counts, P50 and P95 with their sample count, "too few" under 20 samples, and no name, no id, no value', () => {
    const record = dayRecord(input());
    expect(Object.keys(record).sort()).toEqual([...RECORD_KEYS].sort());
    expect(record.date).toBe(DATE);
    expect(record.machineReads.successes).toEqual([{ label: "credential-A", count: 2 }]);
    expect(record.machineReads.refusedByStatus).toEqual({ "401": 1 });
    expect(record.signIns).toEqual({ completed: 1, failed: 1 });
    expect(record.ownerChanges).toBe(1);
    const machine = record.timings.machine;
    expect(machine?.samples).toBe(26);
    expect(machine?.p50).toBe(51);
    expect(machine?.p95).toBe(63);
    expect(record.timings.read).toEqual({ samples: 1, p50: null, p95: null, note: "too few" });
    expect(record.healthDownMinutes).toBe(2);
    expect(record.backupPairAgeHours).toBe(21);
    expect(record.capacityHeadroomPercent).toBe(71.5);
    const text = JSON.stringify(record);
    for (const forbidden of [
      CREDENTIAL,
      OWNER,
      SECRET_NAME,
      "203.0.113.9",
      "10.78.1.2",
      "11111111-2222",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // The label is stable: the same credential is credential-A the next day; a new one is B.
    const labels = new Map([[CREDENTIAL, "credential-A"]]);
    const next = dayRecord(
      input({
        labels,
        audit: [
          { action: "machine.keys", actorKind: "machine", actorId: CREDENTIAL, outcome: "success" },
          {
            action: "machine.keys",
            actorKind: "machine",
            actorId: "9f010b3a-3c1e-4f43-9a51-6f1c2a1e1d7b",
            outcome: "success",
          },
        ],
      }),
    );
    expect(next.machineReads.successes).toEqual([
      { label: "credential-A", count: 1 },
      { label: "credential-B", count: 1 },
    ]);
  });

  it("a day is use, blocked, outage or no activity by the rules of P-166", () => {
    expect(dayRecord(input()).classification).toBe("use");
    // An owner's change alone is use.
    expect(
      classifyDay({
        machineSuccesses: 0,
        machineRefusals: 0,
        ownerChanges: 1,
        healthDownMinutes: 0,
        gateClosed: false,
      }),
    ).toBe("use");
    // Refusals and no success.
    expect(
      classifyDay({
        machineSuccesses: 0,
        machineRefusals: 3,
        ownerChanges: 0,
        healthDownMinutes: 0,
        gateClosed: false,
      }),
    ).toBe("blocked");
    // Over 30 minutes down is an outage; 30 is not.
    expect(
      classifyDay({
        machineSuccesses: 4,
        machineRefusals: 0,
        ownerChanges: 0,
        healthDownMinutes: 31,
        gateClosed: false,
      }),
    ).toBe("outage");
    expect(
      classifyDay({
        machineSuccesses: 4,
        machineRefusals: 0,
        ownerChanges: 0,
        healthDownMinutes: 30,
        gateClosed: false,
      }),
    ).toBe("use");
    expect(
      classifyDay({
        machineSuccesses: 0,
        machineRefusals: 0,
        ownerChanges: 0,
        healthDownMinutes: 0,
        gateClosed: false,
      }),
    ).toBe("no activity");
    expect(dayRecord(input({ journal: healthLines(DATE), audit: [] })).classification).toBe(
      "no activity",
    );
  });

  it("a day with the gate closed is outage, whatever else happened", () => {
    const record = dayRecord(input({ gateClosed: true }));
    expect(record.gateClosed).toBe(true);
    expect(record.classification).toBe("outage");
  });

  it("a day whose journal holds no /health answer at all is an outage, not a quiet day", () => {
    const record = dayRecord(input({ journal: [], audit: [] }));
    expect(record.healthDownMinutes).toBe(1440);
    expect(record.classification).toBe("outage");
  });

  it("what the host could not read is null, never zero", () => {
    const record = dayRecord(input({ newestPairCapturedAt: null, capacity: null }));
    expect(record.backupPairAgeHours).toBeNull();
    expect(record.capacityHeadroomPercent).toBeNull();
  });

  it("the collector reads the audit lines, the gate's refusals and the smallest volume's free share", () => {
    expect(
      parseAudit(
        [
          JSON.stringify({
            action: "machine.keys",
            actorKind: "machine",
            actorId: CREDENTIAL,
            outcome: "success",
          }),
          "",
          "garbage",
          JSON.stringify({ action: "x" }),
        ].join("\n"),
      ),
    ).toEqual([
      { action: "machine.keys", actorKind: "machine", actorId: CREDENTIAL, outcome: "success" },
    ]);
    const closed = JSON.stringify({
      event: "gate_closed",
      time: `${DATE}T05:00:00Z`,
      requestId: "r",
      cause: "closed",
    });
    expect(gateClosedIn([closed], DATE)).toBe(true);
    expect(gateClosedIn([closed], "2026-11-25")).toBe(false);
    expect(gateClosedIn(healthLines(DATE), DATE)).toBe(false);
    expect(
      headroomOf(
        JSON.stringify({
          version: 1,
          volumes: {
            postgres: { freeBytes: 80, sizeBytes: 100, freeInodesPercent: 90 },
            docker: { freeBytes: 333, sizeBytes: 1000, freeInodesPercent: 90 },
          },
        }),
      ),
    ).toEqual({ headroomPercent: 33.3 });
    expect(headroomOf(null)).toBeNull();
    expect(headroomOf("{")).toBeNull();
  });
});
