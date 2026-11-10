// Builds docs/evidence/registry.json: every requirement (FR), acceptance
// scenario (AC) and proof of Stage 1, each mapped to the run that owns it.
//
// Sources, and nothing else:
// - Document 04: FR and AC titles, and the proof domains of §13.4;
// - Document 08 Part IV sections E, F, G: the old session that owns each id;
// - Document 10 §9: old session → new runs; §7 "Covers:" lines: which run owns
//   an id when its old session became several runs;
// - docs/evidence/registry-overrides.json: owners the documents leave open,
//   and every status other than OPEN.
//
// Run: node scripts/registry-build.ts          (writes the file)
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Kind = "FR" | "AC" | "PROOF";
export type Status = "OPEN" | "SPIKE_PASS" | "PASS" | "FAIL" | "WATCH" | "CUT";

export interface RegistryItem {
  id: string;
  kind: Kind;
  title: string;
  gate: "R" | "F";
  ownerRun: string;
  contributingRuns: string[];
  oldSession: string;
  status: Status;
  evidence: string[];
  note: string;
}

export interface Registry {
  version: 1;
  generatedFrom: { doc04Sha256: string; doc08Sha256: string; doc10Sha256: string };
  items: RegistryItem[];
}

export interface Overrides {
  owners: { id: string; ownerRun: string; reason: string }[];
  statuses: { id: string; status: Status; evidence: string[]; note: string }[];
}

const ROOT = resolve(import.meta.dirname, "..");
export const REGISTRY_FILE = join(ROOT, "docs/evidence/registry.json");
export const OVERRIDES_FILE = join(ROOT, "docs/evidence/registry-overrides.json");

export const GATE_F_IDS: readonly string[] = ["AC-1.53", "AC-1.54", "AC-1.58", "AC-1.59"];
export const SUPPLEMENTAL_PROOFS: readonly string[] = [
  "KMS-L1",
  "DB-G1",
  "R2-L1",
  "AGENT-B1",
  "COST-B1",
];

const ID_PATTERN = /\b(FR-1\.\d+|AC-1\.\d+|PO-\d+|KMS-L1|DB-G1|R2-L1|AGENT-B1|COST-B1)\b/g;
/** From one of these words onward, a "Covers:" part names partial coverage. */
const PARTIAL_MARKER = /\bearly\b|\bstart of\b|\bserver side of\b|\breplays of\b|\brehearsal of\b/;
const TITLE_MAX = 80;

function readDocument(root: string, prefix: string): { text: string; sha256: string } {
  const name = readdirSync(join(root, "docs")).find((entry) => entry.startsWith(prefix));
  if (name === undefined) throw new Error(`no document docs/${prefix}*`);
  const bytes = readFileSync(join(root, "docs", name));
  return { text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

function section(text: string, startHeading: RegExp, endHeading: RegExp): string {
  const start = text.search(startHeading);
  if (start < 0) throw new Error(`heading ${String(startHeading)} not found`);
  const rest = text.slice(start);
  const end = rest.slice(1).search(endHeading);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** The cells of every table row of `text` whose first cell matches `first`. */
function tableRows(text: string, first: RegExp): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells[0] !== undefined && first.test(cells[0])) rows.push(cells);
  }
  return rows;
}

function plain(text: string): string {
  return text.replaceAll("**", "").replaceAll("`", "").replaceAll("|", "/").trim();
}

function shorten(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  const cut = text.slice(0, TITLE_MAX);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** FR titles are the bold lead-in of the defining row; AC rows have none, so the first clause is used. */
function titlesFromDoc04(doc04: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const cells of tableRows(doc04, /^(FR|AC)-1\.\d+$/)) {
    const [id, body] = cells as [string, string | undefined];
    if (titles.has(id) || body === undefined) continue; // the first row defines the id
    const bold = /^\*\*(.+?)\*\*/.exec(body);
    if (id.startsWith("FR-")) {
      if (bold?.[1] === undefined) throw new Error(`${id} has no bold lead-in in Document 04`);
      titles.set(id, plain(bold[1]).replace(/\.$/, ""));
    } else {
      const clause = plain(body).split(/[:;]\s|\.\s/)[0] ?? "";
      titles.set(id, shorten(clause.replace(/\.$/, "")));
    }
  }
  // Proofs PO-1 … PO-24: the "Required domain" of their group in §13.4.
  const proofSection = section(doc04, /^### 13\.4 /m, /^### 13\.5 /m);
  for (const [ids, domain] of tableRows(proofSection, /^PO-\d+/) as [string, string][]) {
    for (const part of ids.split(",")) {
      const range = /PO-(\d+)(?:–PO-(\d+))?/.exec(part);
      if (range?.[1] === undefined) throw new Error(`cannot read proof list "${ids}"`);
      const from = Number(range[1]);
      const to = Number(range[2] ?? range[1]);
      for (let n = from; n <= to; n += 1) titles.set(`PO-${n}`, shorten(plain(domain)));
    }
  }
  return titles;
}

interface Doc08Index {
  session: Map<string, string>;
  gate: Map<string, "R" | "F">;
  supplementalTitles: Map<string, string>;
}

function indexFromDoc08(doc08: string): Doc08Index {
  const session = new Map<string, string>();
  const gate = new Map<string, "R" | "F">();
  const supplementalTitles = new Map<string, string>();
  const oldSession = (cell: string, id: string): string => {
    const match = /^S(\d\d)\b/.exec(cell);
    if (match?.[1] === undefined) throw new Error(`${id}: no owning session in "${cell}"`);
    return `D08-S${match[1]}`;
  };
  const partFour = doc08.slice(doc08.search(/^## Part IV /m));
  const e = section(partFour, /^### E\. /m, /^### F\. /m);
  for (const [id, owner] of tableRows(e, /^FR-1\.\d+$/) as [string, string][]) {
    session.set(id, oldSession(owner, id));
  }
  const f = section(partFour, /^### F\. /m, /^### G\. /m);
  for (const [id, owner, gateCell] of tableRows(f, /^AC-1\.\d+$/) as [string, string, string][]) {
    session.set(id, oldSession(owner, id));
    const letter = gateCell.trim().charAt(0);
    if (letter !== "R" && letter !== "F") throw new Error(`${id}: unknown gate "${gateCell}"`);
    gate.set(id, letter);
  }
  const g = section(partFour, /^### G\. /m, /^### H\. /m);
  for (const [id, owner, maturity] of tableRows(g, /^(PO-\d+|[A-Z0-9]+-[LGB]1)$/) as [
    string,
    string,
    string,
  ][]) {
    session.set(id, oldSession(owner, id));
    const description = /—\s*(.+)$/.exec(maturity);
    if (description?.[1] !== undefined) {
      supplementalTitles.set(id, shorten(plain(description[1])));
    }
  }
  return { session, gate, supplementalTitles };
}

function compareRuns(a: string, b: string): number {
  const [a1 = 0, a2 = 0] = a.split(".").map(Number);
  const [b1 = 0, b2 = 0] = b.split(".").map(Number);
  return a1 - b1 || a2 - b2;
}

interface Doc10Map {
  runs: string[];
  runsOfSession: Map<string, string[]>;
  idsOfSession: Map<string, string[]>;
  fullCover: Map<string, string[]>;
  partialCover: Map<string, string[]>;
}

function mapFromDoc10(doc10: string): Doc10Map {
  const runs = [...doc10.matchAll(/^\*\*Run (\d+\.\d+) /gm)].map((match) => match[1] ?? "");

  const runsOfSession = new Map<string, string[]>();
  const idsOfSession = new Map<string, string[]>();
  const traceability = section(doc10, /^## 9\. /m, /^## 10\. /m);
  for (const cells of tableRows(traceability, /^D08-S\d\d$/)) {
    const [old, runCell, fr, ac, proofs] = cells as [string, string, string, string, string];
    const expanded: string[] = [];
    for (const part of runCell.split(",")) {
      const range = /^(\d+)\.(\d+)(?:–(\d+)\.(\d+))?$/.exec(part.trim());
      if (range === null) throw new Error(`${old}: cannot read runs "${runCell}"`);
      const session = range[1] ?? "";
      const from = Number(range[2]);
      const to = Number(range[4] ?? range[2]);
      for (let n = from; n <= to; n += 1) expanded.push(`${session}.${n}`);
    }
    runsOfSession.set(old, expanded);
    const ids: string[] = [];
    for (const number of fr.matchAll(/\d+\.\d+/g)) ids.push(`FR-${number[0]}`);
    for (const number of ac.matchAll(/\d+\.\d+/g)) ids.push(`AC-${number[0]}`);
    // Proofs in parentheses are early or partial work, not ownership.
    for (const id of proofs.replace(/\([^)]*\)/g, "").matchAll(ID_PATTERN)) ids.push(id[0]);
    idsOfSession.set(old, ids);
  }

  const fullCover = new Map<string, string[]>();
  const partialCover = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, id: string, run: string) => {
    const list = map.get(id) ?? [];
    if (!list.includes(run)) list.push(run);
    map.set(id, list);
  };
  let run = "";
  for (const line of doc10.split("\n")) {
    const heading = /^\*\*Run (\d+\.\d+) /.exec(line);
    if (heading?.[1] !== undefined) run = heading[1];
    if (!line.startsWith("- Covers:")) continue;
    for (const part of line.slice("- Covers:".length).split(";")) {
      const marker = PARTIAL_MARKER.exec(part);
      for (const match of part.matchAll(ID_PATTERN)) {
        const after = part.slice(match.index + match[0].length);
        const partial =
          (marker !== null && marker.index < match.index) || /^\s+inventory\b/.test(after);
        add(partial ? partialCover : fullCover, match[0], run);
      }
    }
  }
  return { runs, runsOfSession, idsOfSession, fullCover, partialCover };
}

export function loadOverrides(file: string = OVERRIDES_FILE): Overrides {
  return JSON.parse(readFileSync(file, "utf8")) as Overrides;
}

function expectedIds(): { id: string; kind: Kind }[] {
  const two = (n: number) => String(n).padStart(2, "0");
  return [
    ...Array.from({ length: 102 }, (_, i) => ({ id: `FR-1.${two(i + 1)}`, kind: "FR" as const })),
    ...Array.from({ length: 60 }, (_, i) => ({ id: `AC-1.${two(i + 1)}`, kind: "AC" as const })),
    ...Array.from({ length: 24 }, (_, i) => ({ id: `PO-${i + 1}`, kind: "PROOF" as const })),
    ...SUPPLEMENTAL_PROOFS.map((id) => ({ id, kind: "PROOF" as const })),
  ];
}

/**
 * Builds the registry. Throws, listing every id, when the documents and the
 * overrides file together do not give each id exactly one owner.
 */
export function buildRegistry(
  root: string = ROOT,
  overrides: Overrides = loadOverrides(),
): Registry {
  const doc04 = readDocument(root, "doc_04_");
  const doc08 = readDocument(root, "doc_08_");
  const doc10 = readDocument(root, "doc_10_");
  const titles = titlesFromDoc04(doc04.text);
  const index = indexFromDoc08(doc08.text);
  const map = mapFromDoc10(doc10.text);
  const ownerOverride = new Map(overrides.owners.map((entry) => [entry.id, entry.ownerRun]));
  const statusOverride = new Map(overrides.statuses.map((entry) => [entry.id, entry]));

  const problems: string[] = [];
  const items: RegistryItem[] = [];
  for (const { id, kind } of expectedIds()) {
    const oldSession = index.session.get(id);
    const title = titles.get(id) ?? index.supplementalTitles.get(id);
    if (oldSession === undefined || title === undefined) {
      problems.push(
        `${id}: ${oldSession === undefined ? "no owning session in Document 08" : "no title"}`,
      );
      continue;
    }
    if (!(map.idsOfSession.get(oldSession) ?? []).includes(id)) {
      problems.push(
        `${id}: Document 08 gives ${oldSession}, but Document 10 §9 does not list it there`,
      );
    }
    const candidates = map.runsOfSession.get(oldSession) ?? [];
    const full = map.fullCover.get(id) ?? [];
    let ownerRun = ownerOverride.get(id);
    if (ownerRun !== undefined) {
      if (full.length > 0 || candidates.length === 1) {
        problems.push(`${id}: has an override although the documents already settle its owner`);
      }
    } else if (full.length === 1) {
      ownerRun = full[0];
    } else if (full.length === 0 && candidates.length === 1) {
      ownerRun = candidates[0];
    }
    if (ownerRun === undefined) {
      problems.push(
        `${id}: owner is not settled (Covers: ${full.join(", ") || "none"}; ${oldSession} → ${candidates.join(", ")}). Add it to registry-overrides.json`,
      );
      continue;
    }
    if (!candidates.includes(ownerRun)) {
      problems.push(`${id}: owner Run ${ownerRun} is not one of the runs of ${oldSession}`);
    }
    const status = statusOverride.get(id);
    items.push({
      id,
      kind,
      title,
      gate: index.gate.get(id) ?? "R",
      ownerRun,
      contributingRuns: (map.partialCover.get(id) ?? [])
        .filter((run) => run !== ownerRun)
        .sort(compareRuns),
      oldSession,
      status: status?.status ?? "OPEN",
      evidence: status?.evidence ?? [],
      note: status?.note ?? "",
    });
  }
  const known = new Set(expectedIds().map((entry) => entry.id));
  for (const entry of [...overrides.owners, ...overrides.statuses]) {
    if (!known.has(entry.id)) problems.push(`${entry.id}: override for an unknown id`);
  }
  if (problems.length > 0) {
    throw new Error(`registry cannot be built:\n  ${problems.join("\n  ")}`);
  }
  return {
    version: 1,
    generatedFrom: {
      doc04Sha256: doc04.sha256,
      doc08Sha256: doc08.sha256,
      doc10Sha256: doc10.sha256,
    },
    items,
  };
}

/** The runs of Document 10 §7, in order. */
export function runsOfPlan(root: string = ROOT): string[] {
  return mapFromDoc10(readDocument(root, "doc_10_").text).runs;
}

export function serialiseRegistry(registry: Registry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

if (import.meta.main) {
  const registry = buildRegistry();
  writeFileSync(REGISTRY_FILE, serialiseRegistry(registry));
  const count = (kind: Kind) => registry.items.filter((item) => item.kind === kind).length;
  console.log(
    `Wrote docs/evidence/registry.json: ${count("FR")} FR, ${count("AC")} AC, ${count("PROOF")} proofs.`,
  );
}
