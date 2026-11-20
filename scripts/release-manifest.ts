// Run 8.7 (P-144, P-154, AC-1.56, FR-1.101): the release manifest, built, not typed.
//
//   node scripts/release-manifest.ts            check, and write docs/evidence/session-8/manifest.md
//   node scripts/release-manifest.ts --apply    also set the statuses in registry-overrides.json
//
// Reads docs/evidence/session-8/proof-map.json (by hand: for each of the 56
// release scenarios and 29 proofs, the files that prove it and the kind of
// each), docs/evidence/session-8/results.json (by hand: one entry per thing
// that ran), docs/evidence/session-8/candidate.json, the registry and Doc 04.
// It refuses an id with no entry, a file that does not exist, a file with no
// green result of its kind, a ci result whose commit differs from the
// candidate's in more than P-145 allows, a staging or cli result of another
// release, and an "earlier" entry without its evidence, what changed since,
// and its covering files. FRs are derived: an FR is PASS when every release
// scenario of Doc 04 §12 that names it is PASS. The Gate F scenarios and
// FR-1.98, 1.99 and 1.100 are NOT YET DUE.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GATE_F_IDS,
  OVERRIDES_FILE,
  REGISTRY_FILE,
  type Overrides,
  type Registry,
} from "./registry-build.ts";

export { GATE_F_IDS };

const ROOT = resolve(import.meta.dirname, "..");
const SESSION = "docs/evidence/session-8";
export const MANIFEST_PATH = `${SESSION}/manifest.md`;
export const NOT_YET_DUE_FRS: readonly string[] = ["FR-1.98", "FR-1.99", "FR-1.100"];

export type ProofKind = "ci" | "staging" | "cloud" | "cli" | "consumers" | "review" | "owner";
const KINDS: readonly string[] = ["ci", "staging", "cloud", "cli", "consumers", "review", "owner"];

export interface ProofEntry {
  files: { path: string; kind: ProofKind }[];
  /** A proof that needs a calendar or a clean server keeps the evidence of the run that made it. */
  earlier?: { evidence: string; changedSince: string; covering: string[] };
}
export interface ProofMap {
  version: 1;
  entries: Record<string, ProofEntry>;
  /** Gaps, for the owner: never PASS. */
  notProven?: Record<string, string>;
}
export interface Result {
  kind: ProofKind;
  /** The files this run proves (test files, or the evidence file of a review or the owner's hour). */
  files: string[];
  green: boolean;
  /** ci: the commit the run tested. */
  commit?: string;
  /** staging: the host release; cli: the CLI release. */
  release?: string;
  /** A run id, a log, a date: how to find the run again. */
  ref?: string;
  note?: string;
}
export interface Results {
  version: 1;
  results: Result[];
}
export interface Candidate {
  sourceCommit: string;
  hostRelease: string;
  cliRelease: string;
  /** P-145: operator-tool and host-file changes after the freeze; they build nothing. */
  tooling?: { path: string; note: string }[];
}
export interface ManifestInput {
  registry: Registry;
  doc04: string;
  proofMap: ProofMap;
  results: Results;
  candidate: Candidate;
  exists: (path: string) => boolean;
  /** The paths that differ between two commits. */
  changedPaths: (from: string, to: string) => string[];
}
export interface Manifest {
  problems: string[];
  /** Per id: PASS, NOT YET DUE, NOT PROVEN, or the registry's status unchanged. */
  statuses: Map<string, string>;
  earlier: string[];
  text: string;
}

/** The 56 release scenarios and the 29 proofs: every AC and proof but Gate F's. */
export function releaseIds(registry: Registry): string[] {
  return registry.items
    .filter((item) => item.kind !== "FR" && !GATE_F_IDS.includes(item.id))
    .map((item) => item.id);
}

/** Doc 04 §12 and §12.1: the FRs each scenario names, ranges (FR-1.09–FR-1.12) expanded. */
export function scenarioRequirements(doc04: string): Map<string, string[]> {
  const start = doc04.search(/^## 12\. /m);
  const end = doc04.search(/^### 12\.2 /m);
  if (start < 0 || end < 0) throw new Error("Document 04 has no §12 or §12.2");
  const out = new Map<string, string[]>();
  for (const line of doc04.slice(start, end).split("\n")) {
    if (!line.startsWith("| AC-1.")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const id = cells[0] ?? "";
    const frs: string[] = [];
    const text = cells[2] ?? "";
    for (const match of text.matchAll(/FR-1\.(\d+)(?:\s*[–-]\s*FR-1\.(\d+))?/g)) {
      const from = Number(match[1]);
      const to = Number(match[2] ?? match[1]);
      for (let n = from; n <= to; n += 1) frs.push(`FR-1.${String(n).padStart(2, "0")}`);
    }
    out.set(id, [...new Set(frs)]);
  }
  return out;
}

/** P-145: the paths a ci result's commit may differ from the candidate's in. */
function allowedChange(path: string, candidate: Candidate): boolean {
  if (path.startsWith("tests/") || path.startsWith("docs/") || path.startsWith(".github/"))
    return true;
  if (/^scripts\/registry-[^/]+\.ts$/.test(path)) return true;
  if (path === "scripts/release-manifest.ts" || path === "scripts/sweep-ci.ts") return true;
  return (candidate.tooling ?? []).some(
    (entry) => path === entry.path || (entry.path.endsWith("/") && path.startsWith(entry.path)),
  );
}

export function buildManifest(input: ManifestInput): Manifest {
  const { registry, proofMap, results, candidate } = input;
  const problems: string[] = [];
  const statuses = new Map<string, string>();
  const details = new Map<string, string>();
  const earlier: string[] = [];
  const notProven = proofMap.notProven ?? {};
  const changes = new Map<string, string[]>();
  const changedFrom = (commit: string): string[] => {
    let list = changes.get(commit);
    if (list === undefined) {
      list =
        commit === candidate.sourceCommit ? [] : input.changedPaths(candidate.sourceCommit, commit);
      changes.set(commit, list);
    }
    return list;
  };

  /** Problems of one proving file; empty when a green result of the candidate covers it. */
  const fileProblems = (id: string, path: string, kind: ProofKind): string[] => {
    if (!KINDS.includes(kind)) return [`${id}: ${path}: unknown kind ${kind}`];
    if (!input.exists(path)) return [`${id}: ${path} does not exist`];
    const mine = results.results.filter((r) => r.kind === kind && r.files.includes(path));
    if (mine.length === 0) return [`${id}: ${path} (${kind}) has no result`];
    const green = mine.filter((r) => r.green);
    if (green.length === 0) return [`${id}: ${path} (${kind}) has no green result`];
    const wrong: string[] = [];
    for (const r of green) {
      if (kind === "ci") {
        if (r.commit === undefined) {
          wrong.push(`${id}: ${path}: a ci result without its commit`);
          continue;
        }
        const product = changedFrom(r.commit).filter((p) => !allowedChange(p, candidate));
        if (product.length === 0) return [];
        wrong.push(
          `${id}: ${path}: the ci result at ${r.commit.slice(0, 7)} differs from the candidate in ${product.join(", ")}`,
        );
      } else if (kind === "staging" || kind === "cli") {
        const wanted = kind === "staging" ? candidate.hostRelease : candidate.cliRelease;
        if (r.release === wanted) return [];
        wrong.push(
          `${id}: ${path}: the ${kind} result ran on ${r.release ?? "no release"}, not the candidate's ${wanted}`,
        );
      } else {
        return [];
      }
    }
    return wrong;
  };

  const release = new Set(releaseIds(registry));
  for (const id of Object.keys(proofMap.entries)) {
    if (GATE_F_IDS.includes(id)) {
      problems.push(`${id}: a Gate F scenario has no entry; it is not yet due`);
    } else if (!release.has(id)) {
      problems.push(`${id}: not a release scenario or proof`);
    }
  }
  for (const id of release) {
    const entry = proofMap.entries[id];
    if (entry === undefined) {
      if (notProven[id] === undefined) {
        problems.push(`${id}: no entry in proof-map.json`);
      } else {
        statuses.set(id, "NOT PROVEN");
        details.set(id, notProven[id]);
      }
      continue;
    }
    if (notProven[id] !== undefined) problems.push(`${id}: both an entry and "not proven"`);
    const own: string[] = [];
    if (entry.files.length === 0) own.push(`${id}: an entry with no file`);
    for (const file of entry.files) own.push(...fileProblems(id, file.path, file.kind));
    if (entry.earlier !== undefined) {
      const e = entry.earlier;
      if (!input.exists(e.evidence))
        own.push(`${id}: earlier evidence ${e.evidence} does not exist`);
      if (e.changedSince.trim() === "") own.push(`${id}: earlier needs what changed since`);
      if (e.covering.length === 0) own.push(`${id}: earlier needs the covering files`);
      for (const path of e.covering) {
        if (!entry.files.some((file) => file.path === path)) {
          own.push(`${id}: covering file ${path} is not among the entry's files`);
        }
      }
    }
    problems.push(...own);
    if (own.length > 0) {
      statuses.set(id, "REFUSED");
      continue;
    }
    statuses.set(id, "PASS");
    const files = entry.files.map((file) => `${file.kind}: ${file.path}`).join("; ");
    if (entry.earlier === undefined) {
      details.set(id, files);
    } else {
      earlier.push(id);
      details.set(
        id,
        `(earlier: ${entry.earlier.evidence}; changed since: ${entry.earlier.changedSince}; covered by: ${entry.earlier.covering.join(", ")}) ${files}`,
      );
    }
  }
  for (const id of GATE_F_IDS) {
    statuses.set(id, "NOT YET DUE");
    details.set(id, "Gate F (stage completion)");
  }

  // FRs: PASS when every release scenario that names it is PASS.
  const requirements = scenarioRequirements(input.doc04);
  const namedBy = new Map<string, string[]>();
  for (const [scenario, frs] of requirements) {
    if (GATE_F_IDS.includes(scenario)) continue;
    for (const fr of frs) namedBy.set(fr, [...(namedBy.get(fr) ?? []), scenario]);
  }
  for (const item of registry.items.filter((candidateItem) => candidateItem.kind === "FR")) {
    if (NOT_YET_DUE_FRS.includes(item.id)) {
      statuses.set(item.id, "NOT YET DUE");
      details.set(item.id, "proven in field use (Gate F)");
      continue;
    }
    const scenarios = namedBy.get(item.id) ?? [];
    const open = scenarios.filter((scenario) => statuses.get(scenario) !== "PASS");
    if (scenarios.length > 0 && open.length === 0) {
      statuses.set(item.id, "PASS");
      details.set(item.id, `by ${scenarios.join(", ")}`);
    } else {
      statuses.set(item.id, item.status);
      details.set(
        item.id,
        scenarios.length === 0
          ? "named by no release scenario"
          : `not PASS until ${open.join(", ")}`,
      );
    }
  }

  const count = (status: string) => [...statuses.values()].filter((s) => s === status).length;
  const lines = [
    "# Release manifest of Stage 1 (Run 8.7, P-144, P-154)",
    "",
    "Built by `node scripts/release-manifest.ts` from `proof-map.json`, `results.json` and `candidate.json`; never typed.",
    "",
    `Candidate: ${candidate.hostRelease}, ${candidate.cliRelease}, source ${candidate.sourceCommit}.`,
    "",
    `PASS: ${String(count("PASS"))} (of them earlier: ${String(earlier.length)}); NOT YET DUE: ${String(count("NOT YET DUE"))}; NOT PROVEN: ${String(count("NOT PROVEN"))}.`,
    "",
    ...registry.items.map(
      (item) =>
        `- ${item.id} ${statuses.get(item.id) ?? item.status}${earlier.includes(item.id) ? " " : " — "}${details.get(item.id) ?? ""}`,
    ),
    "",
  ];
  return { problems, statuses, earlier, text: lines.join("\n") };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

function main(argv: string[]): number {
  const doc04 = readFileSync(
    join(
      ROOT,
      "docs",
      readdirSync(join(ROOT, "docs")).find((name) => name.startsWith("doc_04_")) ?? "",
    ),
    "utf8",
  );
  const manifest = buildManifest({
    registry: JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Registry,
    doc04,
    proofMap: readJson(`${SESSION}/proof-map.json`) as ProofMap,
    results: readJson(`${SESSION}/results.json`) as Results,
    candidate: readJson(`${SESSION}/candidate.json`) as Candidate,
    exists: (path) => existsSync(join(ROOT, path)),
    changedPaths: (from, to) =>
      execFileSync("git", ["diff", "--name-only", from, to], { cwd: ROOT, encoding: "utf8" })
        .split("\n")
        .filter((line) => line !== ""),
  });
  if (manifest.problems.length > 0) {
    for (const problem of manifest.problems) process.stderr.write(`manifest: ${problem}\n`);
    return 1;
  }
  writeFileSync(join(ROOT, MANIFEST_PATH), manifest.text);
  if (argv.includes("--apply")) {
    const overrides = JSON.parse(readFileSync(OVERRIDES_FILE, "utf8")) as Overrides;
    for (const [id, status] of manifest.statuses) {
      if (status !== "PASS") continue;
      const existing = overrides.statuses.find((entry) => entry.id === id);
      if (existing === undefined) {
        overrides.statuses.push({
          id,
          status: "PASS",
          evidence: [MANIFEST_PATH],
          note: "The release manifest of Stage 1.",
        });
      } else {
        existing.status = "PASS";
        if (!existing.evidence.includes(MANIFEST_PATH)) existing.evidence.push(MANIFEST_PATH);
      }
    }
    writeFileSync(OVERRIDES_FILE, `${JSON.stringify(overrides, null, 2)}\n`);
  }
  process.stdout.write(
    `manifest: ${MANIFEST_PATH} written${argv.includes("--apply") ? "; statuses applied" : ""}\n`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
