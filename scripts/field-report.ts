// Run 9.6 Task A (P-166, FR-1.100, D-72): the weekly field report.
//
//   node scripts/field-report.ts <host> --week <n>
//
// It reads the day records `host.ts <host> field-pull` copied to
// ~/.mykey/field/<host>/<date>.json, checks every one against the record's
// exact shape (a key it does not know is refused, so a later record cannot
// carry a name into this public repository), and writes
// docs/evidence/field/week-<n>.md. Week 1 starts on the clock start in
// docs/evidence/field/clock.json ({ "start": "YYYY-MM-DD" }, Run 9.2).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RECORD_KEYS, type DayRecord, type Timing } from "../infra/hosts/field/day.ts";

const LABEL = /^credential-[A-Z]{1,2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLASSES = ["machine", "auth", "read", "write"];
const CLASSIFICATIONS = ["use", "blocked", "outage", "no activity"];

function exactKeys(
  value: unknown,
  keys: readonly string[],
  where: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`field record: ${where} is not an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`field record: unknown key ${where}.${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`field record: missing key ${where}.${key}`);
  }
  return value as Record<string, unknown>;
}

const isCount = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;
const isNumberOrNull = (value: unknown): boolean =>
  value === null || (typeof value === "number" && Number.isFinite(value));

/** Throws unless the record is exactly a DayRecord: every key known, every value of its kind. */
export function validateRecord(value: unknown): DayRecord {
  const record = exactKeys(value, RECORD_KEYS, "record");
  if (record.format !== "mykey-field-day/1") throw new Error("field record: format");
  if (typeof record.date !== "string" || !DATE.test(record.date))
    throw new Error("field record: date");
  if (typeof record.gateClosed !== "boolean") throw new Error("field record: gateClosed");
  const reads = exactKeys(record.machineReads, ["successes", "refusedByStatus"], "machineReads");
  if (!Array.isArray(reads.successes)) throw new Error("field record: machineReads.successes");
  for (const entry of reads.successes) {
    const item = exactKeys(entry, ["label", "count"], "machineReads.successes[]");
    if (typeof item.label !== "string" || !LABEL.test(item.label)) {
      throw new Error("field record: a credential label that is not credential-<letters>");
    }
    if (!isCount(item.count)) throw new Error("field record: machineReads count");
  }
  const refused = exactKeys(
    reads.refusedByStatus,
    Object.keys(reads.refusedByStatus as object).filter((key) => /^[45]\d\d$/.test(key)),
    "machineReads.refusedByStatus",
  );
  if (!Object.values(refused).every(isCount)) throw new Error("field record: refusedByStatus");
  const signIns = exactKeys(record.signIns, ["completed", "failed"], "signIns");
  if (!isCount(signIns.completed) || !isCount(signIns.failed))
    throw new Error("field record: signIns");
  if (!isCount(record.ownerChanges)) throw new Error("field record: ownerChanges");
  const timings = exactKeys(
    record.timings,
    Object.keys(record.timings as object).filter((key) => CLASSES.includes(key)),
    "timings",
  );
  for (const [kind, timing] of Object.entries(timings)) {
    const keys = Object.keys(timing as object).includes("note")
      ? ["samples", "p50", "p95", "note"]
      : ["samples", "p50", "p95"];
    const t = exactKeys(timing, keys, `timings.${kind}`);
    if (!isCount(t.samples) || !isNumberOrNull(t.p50) || !isNumberOrNull(t.p95)) {
      throw new Error(`field record: timings.${kind}`);
    }
    if ("note" in t && t.note !== "too few") throw new Error(`field record: timings.${kind}.note`);
  }
  if (!isCount(record.healthDownMinutes)) throw new Error("field record: healthDownMinutes");
  if (!isNumberOrNull(record.backupPairAgeHours))
    throw new Error("field record: backupPairAgeHours");
  if (!isNumberOrNull(record.capacityHeadroomPercent)) {
    throw new Error("field record: capacityHeadroomPercent");
  }
  if (
    typeof record.classification !== "string" ||
    !CLASSIFICATIONS.includes(record.classification)
  ) {
    throw new Error("field record: classification");
  }
  return value as DayRecord;
}

/**
 * Run on the host by `host.ts <host> field-pull`: each day record as
 * `<date>.json<TAB><compact JSON>`, one per line. The glob matches the day
 * records only; labels.json, which maps labels to credentials, never leaves.
 */
export const FIELD_PULL_COMMAND = [
  "for f in /var/lib/mykey/field/[0-9]*.json; do",
  '[ -e "$f" ] || continue;',
  `printf '%s\\t' "$(basename "$f")";`,
  'jq -c . "$f";',
  "done",
].join(" ");

/** The pulled lines, each checked: the file name is a date, the record is exactly a DayRecord of that date. */
export function parseFieldPull(stdout: string): { date: string; record: DayRecord }[] {
  const pulled: { date: string; record: DayRecord }[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const tab = line.indexOf("\t");
    const file = tab < 0 ? line : line.slice(0, tab);
    const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
    if (match?.[1] === undefined) throw new Error(`field-pull: unexpected file name ${file}`);
    const record = validateRecord(JSON.parse(line.slice(tab + 1)));
    if (record.date !== match[1])
      throw new Error(`field-pull: ${file} holds the date ${record.date}`);
    pulled.push({ date: match[1], record });
  }
  return pulled;
}

const timingText = (timing: Timing | undefined): string =>
  timing === undefined
    ? "–"
    : timing.p50 === null
      ? `too few (${String(timing.samples)})`
      : `${String(timing.p50)} / ${String(timing.p95)} ms (${String(timing.samples)})`;

const orDash = (value: number | null, unit: string): string =>
  value === null ? "not read" : `${String(value)}${unit}`;

export function renderWeek(input: {
  host: string;
  week: number;
  records: readonly DayRecord[];
  expectedDays: number;
}): string {
  const records = input.records.map(validateRecord).sort((a, b) => a.date.localeCompare(b.date));
  const successes = (record: DayRecord): number =>
    record.machineReads.successes.reduce((sum, entry) => sum + entry.count, 0);
  const refusals = (record: DayRecord): number =>
    Object.values(record.machineReads.refusedByStatus).reduce((sum, count) => sum + count, 0);
  const count = (kind: string): number =>
    records.filter((record) => record.classification === kind).length;
  const lines: string[] = [];
  lines.push(`# Field week ${String(input.week)} (${input.host})`, "");
  lines.push(
    "Built by `scripts/field-report.ts` from the host's day records (P-166). Counts and timings only: no secret name, no id, no value. Credentials appear as labels whose mapping stays on the host.",
    "",
  );
  if (records.length < input.expectedDays) {
    lines.push(
      `A partial week: ${String(records.length)} of ${String(input.expectedDays)} days have a record.`,
      "",
    );
  }
  lines.push("## Days", "");
  lines.push(
    "| date | class | machine reads (ok / refused) | sign-ins | owner changes | machine P50 / P95 | down min | gate closed | pair age h | headroom % |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const record of records) {
    lines.push(
      `| ${record.date} | ${record.classification} | ${String(successes(record))} / ${String(refusals(record))} | ${String(record.signIns.completed)} | ${String(record.ownerChanges)} | ${timingText(record.timings.machine)} | ${String(record.healthDownMinutes)} | ${record.gateClosed ? "yes" : "no"} | ${orDash(record.backupPairAgeHours, "")} | ${orDash(record.capacityHeadroomPercent, "")} |`,
    );
  }
  const totalOk = records.reduce((sum, record) => sum + successes(record), 0);
  const totalRefused = records.reduce((sum, record) => sum + refusals(record), 0);
  const labels = new Set(records.flatMap((r) => r.machineReads.successes.map((e) => e.label)));
  const ages = records
    .map((record) => record.backupPairAgeHours)
    .filter((age): age is number => age !== null);
  lines.push("", "## The week", "");
  lines.push(`- Days of use: ${String(count("use"))} of ${String(records.length)}`);
  lines.push(`- Blocked days: ${String(count("blocked"))}`);
  lines.push(`- Outage days: ${String(count("outage"))}`);
  lines.push(`- Days without activity: ${String(count("no activity"))}`);
  lines.push(
    `- Machine reads: ${String(totalOk)} successful, ${String(totalRefused)} refused, by ${String(labels.size)} credential label(s)`,
  );
  lines.push(
    `- Sign-ins: ${String(records.reduce((sum, r) => sum + r.signIns.completed, 0))} completed, ${String(records.reduce((sum, r) => sum + r.signIns.failed, 0))} failed`,
  );
  lines.push(
    `- Minutes with the health check down: ${String(records.reduce((sum, r) => sum + r.healthDownMinutes, 0))}`,
  );
  lines.push(
    `- Oldest backup pair at a day's end: ${ages.length === 0 ? "not read" : `${String(Math.max(...ages))} h`}`,
  );
  lines.push("", "## Not measured", "");
  lines.push(
    "- CLI error categories on the consumer's side: not measured (the server sees refusals only).",
  );
  lines.push(
    "- Costs: not measured here (the owner's invoice lines, entered by hand in the dossier).",
  );
  lines.push("- Operator minutes: not measured here (they come from the run notes).");
  return `${lines.join("\n")}\n`;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

if (import.meta.main) {
  const [host, flag, value] = process.argv.slice(2);
  if ((host !== "prod" && host !== "staging") || flag !== "--week" || value === undefined) {
    console.error("usage: node scripts/field-report.ts <prod|staging> --week <n>");
    process.exit(64);
  }
  const week = Number(value);
  if (!Number.isInteger(week) || week < 1)
    throw new Error("field-report: --week is a whole number from 1");
  const clock = JSON.parse(readFileSync("docs/evidence/field/clock.json", "utf8")) as {
    start: string;
  };
  if (!DATE.test(clock.start)) throw new Error("field-report: clock.json has no start date");
  const first = addDays(clock.start, (week - 1) * 7);
  const directory = join(homedir(), ".mykey", "field", host);
  const records: DayRecord[] = [];
  for (let index = 0; index < 7; index += 1) {
    const file = join(directory, `${addDays(first, index)}.json`);
    if (existsSync(file)) records.push(validateRecord(JSON.parse(readFileSync(file, "utf8"))));
  }
  mkdirSync("docs/evidence/field", { recursive: true });
  const out = `docs/evidence/field/week-${String(week)}.md`;
  writeFileSync(out, renderWeek({ host, week, records, expectedDays: 7 }));
  console.log(`field-report: ${out} (${String(records.length)} of 7 days)`);
}
