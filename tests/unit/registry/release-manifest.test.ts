// Run 8.7 Task A (P-144, P-154, AC-1.56, FR-1.101): the release manifest is
// built from proof-map.json and results.json, never typed. These tests build
// it over the committed registry and Document 04 with small maps and results.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Registry } from "../../../scripts/registry-build.ts";
import {
  GATE_F_IDS,
  NOT_YET_DUE_FRS,
  buildManifest,
  releaseIds,
  scenarioRequirements,
  type Candidate,
  type ManifestInput,
  type ProofMap,
  type Results,
} from "../../../scripts/release-manifest.ts";

const root = resolve(import.meta.dirname, "../../..");
const registry = JSON.parse(
  readFileSync(join(root, "docs/evidence/registry.json"), "utf8"),
) as Registry;
const doc04 = readFileSync(
  join(
    root,
    "docs",
    readdirSync(join(root, "docs")).find((name) => name.startsWith("doc_04_"))!,
  ),
  "utf8",
);

const CANDIDATE: Candidate = {
  sourceCommit: "a".repeat(40),
  hostRelease: "host-v0.8.0",
  cliRelease: "cli-v0.1.1",
  tooling: [{ path: "scripts/host.ts", note: "a fix of the operator tool" }],
};
const TEST = "tests/integration/x.test.ts";
const STAGING = "tests/staging/x.staging.test.ts";

/** Every release id mapped to one ci file, and one green ci result at the candidate. */
function complete(): { map: ProofMap; results: Results } {
  const entries: ProofMap["entries"] = {};
  for (const id of releaseIds(registry)) entries[id] = { files: [{ path: TEST, kind: "ci" }] };
  return {
    map: { version: 1, entries },
    results: {
      version: 1,
      results: [
        { kind: "ci", files: [TEST], green: true, commit: CANDIDATE.sourceCommit, ref: "1" },
      ],
    },
  };
}

function input(map: ProofMap, results: Results, over: Partial<ManifestInput> = {}): ManifestInput {
  return {
    registry,
    doc04,
    proofMap: map,
    results,
    candidate: CANDIDATE,
    exists: (path) => path !== "tests/integration/missing.test.ts",
    changedPaths: () => [],
    ...over,
  };
}

const lineOf = (text: string, id: string) =>
  text.split("\n").find((line) => line.startsWith(`- ${id} `)) ?? "";

describe("release-manifest", () => {
  it("knows 56 release scenarios and 29 proofs, and the requirements of Doc 04 §12 with ranges expanded", () => {
    const ids = releaseIds(registry);
    expect(ids.filter((id) => id.startsWith("AC-"))).toHaveLength(56);
    expect(ids.filter((id) => !id.startsWith("AC-") && !id.startsWith("FR-"))).toHaveLength(29);
    for (const id of GATE_F_IDS) expect(ids).not.toContain(id);
    const requirements = scenarioRequirements(doc04);
    expect(requirements.get("AC-1.07")).toEqual([
      "FR-1.09",
      "FR-1.10",
      "FR-1.11",
      "FR-1.13",
      "FR-1.40",
    ]);
    // A range of the table is expanded: every scenario names at least one FR, and none is unknown.
    expect(requirements.size).toBe(60);
    const named = new Set([...requirements.values()].flat());
    for (const fr of named)
      expect(
        registry.items.some((item) => item.id === fr),
        fr,
      ).toBe(true);
  });

  it("a release scenario or proof with no entry in the map is refused, by id", () => {
    const { map, results } = complete();
    delete map.entries["AC-1.13"];
    delete map.entries["PO-7"];
    const problems = buildManifest(input(map, results)).problems.join("\n");
    expect(problems).toMatch(/AC-1\.13: no entry in proof-map\.json/);
    expect(problems).toMatch(/PO-7: no entry in proof-map\.json/);
    // Listed as not proven, it is no problem, and it is not PASS.
    map.notProven = { "AC-1.13": "the walkthrough is not done", "PO-7": "no file proves it" };
    const built = buildManifest(input(map, results));
    expect(built.problems).toEqual([]);
    expect(lineOf(built.text, "AC-1.13")).toMatch(/NOT PROVEN/);
    expect(lineOf(built.text, "AC-1.13")).not.toMatch(/\bPASS\b/);
  });

  it("an entry that names a file that does not exist is refused", () => {
    const { map, results } = complete();
    map.entries["AC-1.01"] = { files: [{ path: "tests/integration/missing.test.ts", kind: "ci" }] };
    expect(buildManifest(input(map, results)).problems.join("\n")).toMatch(
      /AC-1\.01: tests\/integration\/missing\.test\.ts does not exist/,
    );
  });

  it("a file with no result, or with a result that is not green, is refused", () => {
    const { map, results } = complete();
    map.entries["AC-1.02"] = { files: [{ path: STAGING, kind: "staging" }] };
    expect(buildManifest(input(map, results)).problems.join("\n")).toMatch(
      /AC-1\.02: tests\/staging\/x\.staging\.test\.ts \(staging\) has no result/,
    );
    results.results.push({
      kind: "staging",
      files: [STAGING],
      green: false,
      release: "host-v0.8.0",
    });
    expect(buildManifest(input(map, results)).problems.join("\n")).toMatch(
      /AC-1\.02: tests\/staging\/x\.staging\.test\.ts \(staging\) has no green result/,
    );
    // A green staging result of another release is not the candidate's.
    results.results.push({
      kind: "staging",
      files: [STAGING],
      green: true,
      release: "host-v0.7.0",
    });
    expect(buildManifest(input(map, results)).problems.join("\n")).toMatch(
      /AC-1\.02: .*host-v0\.7\.0, not the candidate's host-v0\.8\.0/,
    );
    results.results.push({
      kind: "staging",
      files: [STAGING],
      green: true,
      release: "host-v0.8.0",
    });
    expect(buildManifest(input(map, results)).problems).toEqual([]);
  });

  it("a ci result at a commit that differs from the candidate's in a product path is refused, and one that differs only in the paths P-145 allows is taken", () => {
    const { map } = complete();
    const at = (commit: string): Results => ({
      version: 1,
      results: [{ kind: "ci", files: [TEST], green: true, commit, ref: "2" }],
    });
    const later = "b".repeat(40);
    const refused = buildManifest(
      input(map, at(later), { changedPaths: () => ["apps/api/src/app.ts", "docs/x.md"] }),
    );
    expect(refused.problems.join("\n")).toMatch(
      /differs from the candidate in apps\/api\/src\/app\.ts/,
    );
    for (const allowed of [
      ["tests/unit/x.test.ts", "docs/evidence/session-8/run-8.7.md", ".github/workflows/ci.yml"],
      ["scripts/release-manifest.ts", "scripts/registry-verify.ts", "scripts/sweep-ci.ts"],
      ["scripts/host.ts"], // listed under tooling in candidate.json
    ]) {
      expect(
        buildManifest(input(map, at(later), { changedPaths: () => allowed })).problems,
      ).toEqual([]);
    }
    // A tooling path that candidate.json does not list is a product change here.
    expect(
      buildManifest(
        input(map, at(later), { changedPaths: () => ["scripts/probe.ts"] }),
      ).problems.join("\n"),
    ).toMatch(/scripts\/probe\.ts/);
    for (const product of [
      "packages/db/src/x.ts",
      "infra/compose/host.compose.yml",
      "infra/dependencies.lock.json",
      "pnpm-lock.yaml",
    ]) {
      expect(
        buildManifest(input(map, at(later), { changedPaths: () => [product] })).problems.join("\n"),
        product,
      ).toMatch(/differs from the candidate/);
    }
  });

  it('an "earlier" entry needs its evidence file, what changed since, and the covering files', () => {
    const { map, results } = complete();
    map.entries["PO-3"] = {
      files: [{ path: TEST, kind: "ci" }],
      earlier: { evidence: "tests/integration/missing.test.ts", changedSince: "", covering: [] },
    };
    const problems = buildManifest(input(map, results)).problems.join("\n");
    expect(problems).toMatch(
      /PO-3: earlier evidence tests\/integration\/missing\.test\.ts does not exist/,
    );
    expect(problems).toMatch(/PO-3: earlier needs what changed since/);
    expect(problems).toMatch(/PO-3: earlier needs the covering files/);
    map.entries["PO-3"] = {
      files: [{ path: TEST, kind: "ci" }],
      earlier: {
        evidence: "docs/evidence/session-6/run-6.8.md",
        changedSince: "the restore code is unchanged since host-v0.6.1",
        covering: ["tests/integration/other.test.ts"],
      },
    };
    expect(buildManifest(input(map, results)).problems.join("\n")).toMatch(
      /PO-3: covering file tests\/integration\/other\.test\.ts is not among the entry's files/,
    );
    map.entries["PO-3"].earlier!.covering = [TEST];
    const built = buildManifest(input(map, results));
    expect(built.problems).toEqual([]);
    expect(lineOf(built.text, "PO-3")).toMatch(
      /PASS \(earlier: docs\/evidence\/session-6\/run-6\.8\.md/,
    );
    expect(built.earlier).toEqual(["PO-3"]);
  });

  it("an FR is PASS when every release scenario of Doc 04 §12 that names it is PASS; FR-1.98, 1.99 and 1.100 stay OPEN", () => {
    const { map, results } = complete();
    const all = buildManifest(input(map, results));
    expect(all.problems).toEqual([]);
    expect(all.statuses.get("FR-1.01")).toBe("PASS");
    for (const fr of NOT_YET_DUE_FRS) {
      expect(all.statuses.get(fr), fr).toBe("NOT YET DUE");
      expect(lineOf(all.text, fr)).toMatch(/NOT YET DUE/);
    }
    // FR-1.13 is named by AC-1.06 and AC-1.07: one of them not proven, and FR-1.13 is not PASS.
    map.notProven = { "AC-1.06": "the drill did not run" };
    delete map.entries["AC-1.06"];
    const one = buildManifest(input(map, results));
    expect(one.statuses.get("FR-1.13")).not.toBe("PASS");
    expect(lineOf(one.text, "FR-1.13")).toMatch(/AC-1\.06/);
    expect(one.statuses.get("FR-1.09")).toBe("PASS"); // AC-1.07 only
  });

  it("the four Gate F scenarios are written NOT YET DUE and are never PASS", () => {
    const { map, results } = complete();
    const built = buildManifest(input(map, results));
    for (const id of GATE_F_IDS) {
      expect(built.statuses.get(id), id).toBe("NOT YET DUE");
      expect(lineOf(built.text, id)).toMatch(/NOT YET DUE/);
    }
    // An entry for one is refused, never taken.
    map.entries["AC-1.53"] = { files: [{ path: TEST, kind: "ci" }] };
    const refused = buildManifest(input(map, results));
    expect(refused.problems.join("\n")).toMatch(/AC-1\.53: a Gate F scenario/);
    expect(refused.statuses.get("AC-1.53")).toBe("NOT YET DUE");
  });

  it("manifest.md has one line per id with its status on the line", () => {
    const { map, results } = complete();
    map.notProven = { "AC-1.60": "the claims walk is not done" };
    delete map.entries["AC-1.60"];
    const built = buildManifest(input(map, results));
    const lines = built.text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(registry.items.length);
    for (const item of registry.items) {
      const line = lineOf(built.text, item.id);
      expect(line, item.id).not.toBe("");
      expect(line).toContain(built.statuses.get(item.id) ?? "-");
    }
    expect(built.text).toMatch(/PASS: \d+ \(of them earlier: 0\)/);
  });
});
