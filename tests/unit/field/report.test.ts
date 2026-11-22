// Run 9.6 Task A (P-166, FR-1.100): the weekly report from seven day records.
// It renders the daily table, the weekly figures and the "not measured" lines,
// and refuses a record with a key it does not know, so that a later record
// cannot carry a name into a public repository.
import { describe, expect, it } from "vitest";
import { dayRecord, healthLines, type DayRecord } from "../../../infra/hosts/field/day.ts";
import {
  FIELD_PULL_COMMAND,
  parseFieldPull,
  renderWeek,
  validateRecord,
} from "../../../scripts/field-report.ts";

function day(date: string, over: Partial<DayRecord> = {}): DayRecord {
  const base = dayRecord({
    date,
    journal: [
      ...healthLines(date),
      ...Array.from({ length: 24 }, (_, i) =>
        JSON.stringify({
          event: "request",
          time: `${date}T09:00:00.000Z`,
          requestId: "r",
          method: "POST",
          path: "/v1/machine/projects/:project/environments/:environment/resolve",
          status: 200,
          durationMs: 30 + i,
          bodyBytesRead: 0,
          peer: null,
          forwardedFor: null,
          forwardedProto: null,
        }),
      ),
    ],
    audit: [{ action: "machine.resolve", actorKind: "machine", actorId: "c1", outcome: "success" }],
    gateClosed: false,
    newestPairCapturedAt: `${date}T03:00:00Z`,
    capacity: { headroomPercent: 70 },
    labels: new Map(),
  });
  return { ...base, ...over };
}

const WEEK = [
  day("2026-11-23"),
  day("2026-11-24"),
  day("2026-11-25", { classification: "no activity" }),
  day("2026-11-26", { classification: "blocked" }),
  day("2026-11-27"),
  day("2026-11-28", { classification: "outage", gateClosed: true }),
  day("2026-11-29"),
];

describe("the weekly field report (P-166)", () => {
  it('field-report.ts renders seven day records into week-N.md with the daily table, the weekly figures and the lines "not measured" for the consumer\'s CLI errors', () => {
    const text = renderWeek({ host: "prod", week: 1, records: WEEK, expectedDays: 7 });
    expect(text).toMatch(/^# Field week 1 \(prod\)/m);
    // The daily table: one row per day, in date order.
    const rows = text.split("\n").filter((line) => /^\| 2026-11-\d\d \|/.test(line));
    expect(rows).toHaveLength(7);
    expect(rows[0]).toContain("| use |");
    expect(rows[2]).toContain("| no activity |");
    expect(rows[3]).toContain("| blocked |");
    expect(rows[5]).toContain("| outage |");
    // The weekly figures.
    expect(text).toContain("Days of use: 4 of 7");
    expect(text).toContain("Outage days: 1");
    expect(text).toMatch(/Machine reads: 7 successful/);
    // What the server cannot see.
    expect(text).toContain("CLI error categories on the consumer's side: not measured");
    expect(text).toContain("Costs: not measured");
  });

  it("a partial week says so", () => {
    const text = renderWeek({ host: "prod", week: 1, records: WEEK.slice(0, 3), expectedDays: 7 });
    expect(text).toContain("A partial week: 3 of 7 days have a record.");
  });

  it("it refuses a record with a key it does not know", () => {
    expect(() => {
      validateRecord(WEEK[0]);
    }).not.toThrow();
    const leaky = { ...WEEK[0], secretNames: ["STRIPE_SECRET_KEY"] };
    expect(() => {
      validateRecord(leaky);
    }).toThrow(/secretNames/);
    const nested = {
      ...WEEK[0],
      machineReads: { ...WEEK[0]?.machineReads, byName: { X: 1 } },
    };
    expect(() => {
      validateRecord(nested);
    }).toThrow(/byName/);
    const badLabel = {
      ...WEEK[0],
      machineReads: {
        successes: [{ label: "0b3a3c1e-9f01-4f43-9a51-6f1c2a1e1d7b", count: 1 }],
        refusedByStatus: {},
      },
    };
    expect(() => {
      validateRecord(badLabel);
    }).toThrow(/label/);
    expect(() =>
      renderWeek({
        host: "prod",
        week: 2,
        records: [leaky as unknown as DayRecord],
        expectedDays: 7,
      }),
    ).toThrow(/secretNames/);
  });

  it("field-pull copies the day records only, never the labels' mapping, and refuses a record it does not know", () => {
    expect(FIELD_PULL_COMMAND).toContain("/var/lib/mykey/field/[0-9]*.json");
    expect(FIELD_PULL_COMMAND).not.toContain("labels");
    const good = WEEK[0];
    const line = (file: string, body: unknown) => `${file}\t${JSON.stringify(body)}\n`;
    const stdout = line(`${good?.date ?? ""}.json`, good);
    expect(parseFieldPull(stdout)).toEqual([{ date: good?.date, record: good }]);
    expect(() => parseFieldPull(line("labels.json", {}))).toThrow(/file name/);
    expect(() => parseFieldPull(line("2026-11-23.json", { ...good, names: ["X"] }))).toThrow(
      /names/,
    );
    expect(() => parseFieldPull(line("2026-11-22.json", good))).toThrow(/date/);
  });
});
