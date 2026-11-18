// Run 6.10 (P-130; FR-1.75, AC-1.33): one runbook section per probe condition,
// each with Means, Check, Fix and Confirm and at least one command, and for
// each condition a dated line of a real delivery in the session's evidence.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONDITIONS } from "@mykey/probe/evaluate";

const ROOT = resolve(import.meta.dirname, "../../..");
const runbook = readFileSync(resolve(ROOT, "docs/runbooks/alerts.md"), "utf8");
const evidence = readFileSync(resolve(ROOT, "docs/evidence/session-6/alerts.md"), "utf8");

/** The `## <name>` sections of the runbook, with their bodies. */
function sections(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const title = part.slice(0, newline).trim().replace(/^`|`$/g, "");
    found.set(title, part.slice(newline + 1));
  }
  return found;
}

describe("alerts.md (P-130)", () => {
  const bySection = sections(runbook);

  it("has one section per condition of the probe, and no other", () => {
    expect([...bySection.keys()].sort()).toEqual([...CONDITIONS].sort());
  });

  it("every section says what it means, how to check, how to fix and how to confirm, with a command", () => {
    for (const [condition, body] of bySection) {
      for (const heading of ["Means", "Check", "Fix", "Confirm"]) {
        expect(body, `${condition}: ### ${heading}`).toMatch(new RegExp(`^### ${heading}$`, "m"));
      }
      expect(body, `${condition}: a fenced command`).toMatch(/^```sh$/m);
    }
  });

  it("every condition was seen to fire: a dated line of its delivery in the session's evidence", () => {
    for (const condition of CONDITIONS) {
      const line = evidence
        .split("\n")
        .find(
          (l) =>
            /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(l) &&
            l.includes(`**${condition}**`) &&
            l.includes("delivered"),
        );
      expect(line, condition).toBeDefined();
    }
  });
});
