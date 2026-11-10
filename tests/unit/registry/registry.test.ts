import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REGISTRY_FILE,
  buildRegistry,
  serialiseRegistry,
  type Registry,
} from "../../../scripts/registry-build.ts";
import { registryProblems, verifyRegistry } from "../../../scripts/registry-verify.ts";

const root = resolve(import.meta.dirname, "../../..");
const committedText = readFileSync(REGISTRY_FILE, "utf8");
const registry = JSON.parse(committedText) as Registry;
const byId = new Map(registry.items.map((item) => [item.id, item]));

const numbered = (prefix: string, count: number, width: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(width, "0")}`);

const FR_IDS = numbered("FR-1.", 102, 2);
const AC_IDS = numbered("AC-1.", 60, 2);
const PROOF_IDS = [...numbered("PO-", 24, 1), "KMS-L1", "DB-G1", "R2-L1", "AGENT-B1", "COST-B1"];

/** Document 10, read independently of the build script. */
const doc10 = readFileSync(
  join(
    root,
    "docs",
    readdirSync(join(root, "docs")).find((name) => name.startsWith("doc_10_"))!,
  ),
  "utf8",
);

function runsOfDoc10(): string[] {
  return [...doc10.matchAll(/^\*\*Run (\d+\.\d+) /gm)].map((match) => match[1]!);
}

/**
 * Every id on a "Covers:" line, with whether the line gives it in full.
 * A part of the line (between semicolons) is partial from the first of these
 * words onward: the three the session plan names, and three more that Document 10
 * uses the same way ("DB-G1 inventory", "integrated replays of", "synthetic rehearsal of").
 */
function coversOfDoc10(): { run: string; id: string; partial: boolean }[] {
  const found: { run: string; id: string; partial: boolean }[] = [];
  let run = "";
  for (const line of doc10.split("\n")) {
    const heading = /^\*\*Run (\d+\.\d+) /.exec(line);
    if (heading) run = heading[1]!;
    if (!line.startsWith("- Covers:")) continue;
    for (const part of line.slice("- Covers:".length).split(";")) {
      const marker =
        /\bearly\b|\bstart of\b|\bserver side of\b|\breplays of\b|\brehearsal of\b/.exec(part);
      for (const match of part.matchAll(/\b(FR-1\.\d+|AC-1\.\d+|PO-\d+|[A-Z0-9]+-[LGB]1)\b/g)) {
        const after = part.slice(match.index + match[0].length);
        const partial =
          (marker !== null && marker.index < match.index) || /^\s+inventory\b/.test(after);
        found.push({ run, id: match[1]!, partial });
      }
    }
  }
  return found;
}

describe("evidence registry", () => {
  it("has exactly 102 FR, 60 AC and 29 proofs, each once", () => {
    const ids = (kind: string) =>
      registry.items.filter((item) => item.kind === kind).map((item) => item.id);
    expect(ids("FR")).toEqual(FR_IDS);
    expect(ids("AC")).toEqual(AC_IDS);
    expect(ids("PROOF")).toEqual(PROOF_IDS);
    expect(registry.items).toHaveLength(191);
    expect(byId.size).toBe(191);
  });

  it("gives every item a title, an old session and a known kind and status", () => {
    for (const item of registry.items) {
      // The shortest real lead-in is three letters ("run", FR-1.48).
      expect(item.title.length, item.id).toBeGreaterThanOrEqual(3);
      expect(item.title, item.id).not.toMatch(/\*\*|`|\|/);
      expect(item.oldSession, item.id).toMatch(/^D08-S\d\d$/);
      expect(["OPEN", "SPIKE_PASS", "PASS", "FAIL", "WATCH", "CUT"], item.id).toContain(
        item.status,
      );
    }
    expect(byId.get("FR-1.33")?.title).toBe("Format v1");
    expect(byId.get("FR-1.01")?.title).toBe("Bootstrap");
    expect(byId.get("FR-1.33")?.oldSession).toBe("D08-S22");
  });

  it("maps every item to runs that exist in Document 10", () => {
    const runs = runsOfDoc10();
    expect(runs).toHaveLength(89);
    expect(new Set(runs).size).toBe(89);
    for (const item of registry.items) {
      expect(runs, item.id).toContain(item.ownerRun);
      for (const run of item.contributingRuns) expect(runs, item.id).toContain(run);
      expect(item.contributingRuns, item.id).not.toContain(item.ownerRun);
      expect(new Set(item.contributingRuns).size, item.id).toBe(item.contributingRuns.length);
    }
  });

  it("follows the Covers lines: full coverage owns, partial coverage contributes", () => {
    const covers = coversOfDoc10();
    expect(covers.length).toBeGreaterThan(180);
    expect(covers.filter((cover) => cover.partial).length).toBeGreaterThan(15);
    for (const cover of covers) {
      const item = byId.get(cover.id);
      expect(item, `${cover.id} on the Covers line of Run ${cover.run}`).toBeDefined();
      if (cover.partial) {
        expect(item!.contributingRuns, `${cover.id} Run ${cover.run}`).toContain(cover.run);
      } else {
        expect(item!.ownerRun, `${cover.id} Run ${cover.run}`).toBe(cover.run);
      }
    }
    expect(byId.get("FR-1.33")?.ownerRun).toBe("1.8");
    expect(byId.get("DB-G1")).toMatchObject({ ownerRun: "6.8", contributingRuns: ["1.7", "2.9"] });
    expect(byId.get("R2-L1")).toMatchObject({ ownerRun: "6.6", contributingRuns: ["1.9"] });
    expect(byId.get("PO-24")?.ownerRun).toBe("1.3");
  });

  it("puts exactly four items behind gate F", () => {
    expect(registry.items.filter((item) => item.gate === "F").map((item) => item.id)).toEqual([
      "AC-1.53",
      "AC-1.54",
      "AC-1.58",
      "AC-1.59",
    ]);
    // The file is parsed JSON, so check the value itself, not the declared type.
    expect(registry.items.filter((item) => !["F", "R"].includes(item.gate as string))).toEqual([]);
  });

  it("claims no PASS, and backs every other claim with a file that exists", () => {
    expect(registry.items.filter((item) => item.status === "PASS")).toEqual([]);
    const claimed = registry.items.filter((item) => item.status !== "OPEN");
    expect(claimed.map((item) => item.id)).toContain("PO-24");
    for (const item of claimed) {
      expect(item.evidence.length, item.id).toBeGreaterThan(0);
    }
    for (const item of registry.items) {
      for (const path of item.evidence) expect(existsSync(join(root, path)), path).toBe(true);
    }
  });

  it("is reproduced byte for byte by a rebuild from the documents", () => {
    expect(serialiseRegistry(buildRegistry(root))).toBe(committedText);
    expect(registry.version).toBe(1);
    for (const hash of Object.values(registry.generatedFrom))
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("evidence:verify", () => {
  it("accepts the committed registry", () => {
    expect(verifyRegistry(root)).toEqual([]);
  });

  it("reports a missing item, a duplicate, an unknown run, a PASS and a claim without evidence", () => {
    const tamper = (change: (copy: Registry) => void): string[] => {
      const copy = structuredClone(registry);
      change(copy);
      return registryProblems(copy, root);
    };
    expect(tamper((copy) => copy.items.splice(5, 1)).join("\n")).toMatch(/FR-1\.06/);
    expect(tamper((copy) => copy.items.push(copy.items[0]!)).join("\n")).toMatch(/FR-1\.01/);
    expect(tamper((copy) => (copy.items[0]!.ownerRun = "12.1")).join("\n")).toMatch(/12\.1/);
    expect(tamper((copy) => (copy.items[0]!.status = "PASS")).join("\n")).toMatch(/PASS/);
    expect(
      tamper((copy) => {
        copy.items[0]!.status = "SPIKE_PASS";
        copy.items[0]!.evidence = [];
      }).join("\n"),
    ).toMatch(/evidence/);
    expect(
      tamper((copy) => (copy.items[0]!.evidence = ["docs/evidence/does-not-exist.md"])).join("\n"),
    ).toMatch(/does-not-exist/);
    expect(tamper((copy) => (copy.items[200 - 60]!.gate = "F")).join("\n")).toMatch(/gate/);
    expect(tamper((copy) => (copy.items[0]!.title = "changed")).join("\n")).toMatch(/rebuild/);
  });
});
