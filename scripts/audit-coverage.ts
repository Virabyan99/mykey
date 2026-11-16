// The audit runbook's coverage list (Run 6.1, P-105): writes renderCoverage()
// between the coverage markers of docs/runbooks/audit.md.
// Run: pnpm run audit:coverage   (--check: exit 1 when the file differs)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderCoverage } from "@mykey/audit";

export const RUNBOOK = resolve(import.meta.dirname, "../docs/runbooks/audit.md");
const START = "<!-- coverage:start -->";
const END = "<!-- coverage:end -->";

/** The runbook's text with the generated list between the markers. */
export function withCoverage(text: string): string {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start) throw new Error("audit.md has no coverage markers");
  return `${text.slice(0, start + START.length)}\n\n${renderCoverage().trimEnd()}\n\n${text.slice(end)}`;
}

if (import.meta.main) {
  const text = readFileSync(RUNBOOK, "utf8");
  const next = withCoverage(text);
  if (process.argv.includes("--check")) {
    if (next !== text) {
      process.stderr.write("audit.md: the coverage list is stale (pnpm run audit:coverage)\n");
      process.exit(1);
    }
    process.stdout.write("audit coverage: current\n");
  } else {
    writeFileSync(RUNBOOK, next);
    process.stdout.write("audit coverage: written\n");
  }
}
