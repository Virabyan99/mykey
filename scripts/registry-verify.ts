// Verifies docs/evidence/registry.json. Run: node scripts/registry-verify.ts
// It exits 1 and lists every problem when the registry is incomplete, claims
// something without evidence, or no longer matches the documents.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GATE_F_IDS,
  REGISTRY_FILE,
  SUPPLEMENTAL_PROOFS,
  buildRegistry,
  runsOfPlan,
  serialiseRegistry,
  type Registry,
} from "./registry-build.ts";

const ROOT = resolve(import.meta.dirname, "..");
const STATUSES = ["OPEN", "SPIKE_PASS", "PASS", "FAIL", "WATCH", "CUT"];

const DECISIONS = "docs/decisions/";
/** The release manifest of Session 8 (Run 8.7): the only evidence that makes an item PASS. */
export const RELEASE_MANIFEST = "docs/evidence/session-8/manifest.md";
const EVIDENCE_ROOTS = ["docs/evidence/", DECISIONS];

/** Whether one line of the text names exactly this id (not a longer one) together with the status. */
function statesClaim(text: string, id: string, status: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactId = new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![0-9])`);
  return text.split("\n").some((line) => exactId.test(line) && line.includes(status));
}

function expectedIds(): string[] {
  const two = (n: number) => String(n).padStart(2, "0");
  return [
    ...Array.from({ length: 102 }, (_, i) => `FR-1.${two(i + 1)}`),
    ...Array.from({ length: 60 }, (_, i) => `AC-1.${two(i + 1)}`),
    ...Array.from({ length: 24 }, (_, i) => `PO-${i + 1}`),
    ...SUPPLEMENTAL_PROOFS,
  ];
}

/** Every problem of the given registry; an empty list means it is sound. */
export function registryProblems(registry: Registry, root: string = ROOT): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of registry.items) {
    if (seen.has(item.id)) problems.push(`${item.id}: listed more than once`);
    seen.add(item.id);
  }
  for (const id of expectedIds()) {
    if (!seen.has(id)) problems.push(`${id}: missing`);
  }
  const expected = new Set(expectedIds());
  const runs = new Set(runsOfPlan(root));
  for (const item of registry.items) {
    if (!expected.has(item.id)) problems.push(`${item.id}: not a Stage 1 id`);
    for (const run of [item.ownerRun, ...item.contributingRuns]) {
      if (!runs.has(run)) problems.push(`${item.id}: Run ${run} is not a run of Document 10`);
    }
    const wantedGate = GATE_F_IDS.includes(item.id) ? "F" : "R";
    if (item.gate !== wantedGate) problems.push(`${item.id}: gate must be ${wantedGate}`);
    if (!STATUSES.includes(item.status)) problems.push(`${item.id}: unknown status ${item.status}`);
    // Run 8.7 (P-144, P-154): PASS comes only from this session's release
    // manifest (scripts/release-manifest.ts), and a Gate F item is never PASS here.
    if (item.status === "PASS") {
      if (GATE_F_IDS.includes(item.id)) {
        problems.push(`${item.id}: a Gate F item is never PASS in Stage 1's release`);
      } else if (!item.evidence.includes(RELEASE_MANIFEST)) {
        problems.push(`${item.id}: PASS needs ${RELEASE_MANIFEST} among its evidence`);
      }
    }
    if (item.status !== "OPEN" && item.evidence.length === 0) {
      problems.push(`${item.id}: status ${item.status} without evidence`);
    }
    for (const path of item.evidence) {
      if (!existsSync(join(root, path)))
        problems.push(`${item.id}: evidence ${path} does not exist`);
      if (!EVIDENCE_ROOTS.some((prefix) => path.startsWith(prefix))) {
        problems.push(`${item.id}: evidence ${path} is not under ${EVIDENCE_ROOTS.join(" or ")}`);
      }
    }
    if (item.status !== "OPEN" && item.evidence.length > 0) {
      // The registry may not claim more than a note says: one evidence file must
      // name the item and the status on the same line.
      const stated = item.evidence.some((path) => {
        const file = join(root, path);
        return existsSync(file) && statesClaim(readFileSync(file, "utf8"), item.id, item.status);
      });
      if (!stated) {
        problems.push(`${item.id}: no evidence file states ${item.id} ${item.status} on one line`);
      }
    }
    if (item.status === "CUT" && !item.evidence.some((path) => path.startsWith(DECISIONS))) {
      problems.push(`${item.id}: CUT needs a decision record under ${DECISIONS}`);
    }
  }
  let rebuilt: string;
  try {
    rebuilt = serialiseRegistry(buildRegistry(root));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return problems;
  }
  if (rebuilt !== serialiseRegistry(registry)) {
    problems.push(
      "registry.json differs from a rebuild from the documents and overrides. Run: pnpm run evidence:build",
    );
  }
  return problems;
}

export function verifyRegistry(root: string = ROOT): string[] {
  let registry: Registry;
  try {
    registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Registry;
  } catch {
    return ["docs/evidence/registry.json is missing or is not JSON"];
  }
  return registryProblems(registry, root);
}

if (import.meta.main) {
  const problems = verifyRegistry();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`evidence: ${problem}`);
    process.exit(1);
  }
  console.log("evidence: registry ok (191 items).");
}
