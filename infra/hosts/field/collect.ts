// Run 9.6 Task A (P-166, D-72): the field day's collector. field-day.sh runs
// it with the node of the API image (no network, read-only root):
//
//   node /field/collect.ts <YYYY-MM-DD>
//
// It reads what field-day.sh gathered under /in (the API's journal of the day,
// the day's audit rows as JSON lines, the newest eligible pair's capture time,
// the capacity record), keeps the credential labels in /state/labels.json
// (which stays on the host), and writes /state/<date>.json: the day record of
// day.ts, counts and timings only.
//
// Run by Node's type stripping (erasable syntax only).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dayRecord, type AuditFact, type DayRecord } from "./day.ts";

/** The day's audit rows, one JSON object per line; a line that is not one is skipped. */
export function parseAudit(text: string): AuditFact[] {
  const facts: AuditFact[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof row.action === "string" &&
        typeof row.actorKind === "string" &&
        typeof row.outcome === "string" &&
        (row.actorId === null || typeof row.actorId === "string")
      ) {
        facts.push({
          action: row.action,
          actorKind: row.actorKind,
          actorId: row.actorId,
          outcome: row.outcome,
        });
      }
    } catch {
      // not a row
    }
  }
  return facts;
}

/** Whether the API refused a request at its gate during the day (P-43's gate_closed line). */
export function gateClosedIn(journal: readonly string[], date: string): boolean {
  return journal.some((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      return (
        entry.event === "gate_closed" &&
        typeof entry.time === "string" &&
        entry.time.startsWith(date)
      );
    } catch {
      return false;
    }
  });
}

/** The smallest free share of any measured volume, in percent with one decimal; null when unread. */
export function headroomOf(text: string | null): { headroomPercent: number } | null {
  if (text === null) return null;
  try {
    const record = JSON.parse(text) as {
      volumes?: Record<string, { freeBytes?: unknown; sizeBytes?: unknown }>;
    };
    const shares = Object.values(record.volumes ?? {}).flatMap((volume) =>
      typeof volume.freeBytes === "number" &&
      typeof volume.sizeBytes === "number" &&
      volume.sizeBytes > 0
        ? [(volume.freeBytes / volume.sizeBytes) * 100]
        : [],
    );
    if (shares.length === 0) return null;
    return { headroomPercent: Math.round(Math.min(...shares) * 10) / 10 };
  } catch {
    return null;
  }
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function collect(date: string, inDir: string, stateDir: string): DayRecord {
  const journal = (readOrNull(join(inDir, "journal.txt")) ?? "").split("\n");
  const labelsFile = join(stateDir, "labels.json");
  const labels = new Map<string, string>(
    Object.entries(JSON.parse(readOrNull(labelsFile) ?? "{}") as Record<string, string>),
  );
  const pair = (readOrNull(join(inDir, "pair.txt")) ?? "").trim();
  const record = dayRecord({
    date,
    journal,
    audit: parseAudit(readOrNull(join(inDir, "audit.jsonl")) ?? ""),
    gateClosed: gateClosedIn(journal, date),
    newestPairCapturedAt: pair === "" ? null : pair,
    capacity: headroomOf(readOrNull(join(inDir, "capacity.json"))),
    labels,
  });
  writeAtomic(labelsFile, `${JSON.stringify(Object.fromEntries(labels), null, 2)}\n`);
  writeAtomic(join(stateDir, `${date}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (import.meta.main) {
  const date = process.argv[2] ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("usage: node collect.ts <YYYY-MM-DD>");
    process.exit(64);
  }
  const record = collect(date, "/in", "/state");
  console.log(`field-day: ${date} ${record.classification}`);
}
