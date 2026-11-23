// Run 10.5 (a finding on both hosts): field-day.sh runs under `set -euf`, and
// `-f` turns pathname expansion off, so its `chmod 0644 "$work"/*` met a file
// literally named `*` and failed the unit every night from its first run
// (23 Nov 2026, 00:10 UTC; `unit_failed` on staging and production). A host
// script that turns globbing off names no path pattern; `case` patterns are
// not pathname expansion, so they stay allowed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scripts = execFileSync("git", ["ls-files", "infra/hosts"], { encoding: "utf8" })
  .split("\n")
  .filter((path) => path.endsWith(".sh"));

/** The script's command lines: comments and here-document bodies left out. */
function commandLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let heredoc: string | null = null;
  text.split("\n").forEach((raw, index) => {
    if (heredoc !== null) {
      if (raw.replace(/^\t+/, "") === heredoc) heredoc = null;
      return;
    }
    const code = raw.replace(/(^|\s)#.*$/, "");
    const start = /<<-?\s*['"]?([A-Za-z_]+)['"]?/.exec(code);
    if (start !== null) heredoc = start[1] ?? null;
    if (code.trim() !== "") out.push({ line: index + 1, text: code });
  });
  return out;
}

const noglob = (text: string) => /^\s*set\s+-[a-z]*f[a-z]*\b/m.test(text);

describe("host scripts that turn globbing off (set -f)", () => {
  it("finds the host scripts, and some of them turn globbing off", () => {
    expect(scripts.length).toBeGreaterThan(5);
    expect(scripts.filter((path) => noglob(readFileSync(path, "utf8")))).toContain(
      "infra/hosts/field/field-day.sh",
    );
  });

  it("name no path pattern: under set -f a `/*` is a literal star", () => {
    const found: string[] = [];
    for (const path of scripts) {
      const text = readFileSync(path, "utf8");
      if (!noglob(text)) continue;
      for (const { line, text: code } of commandLines(text)) {
        if (/\/["']?[*?]|\/\[/.test(code)) found.push(`${path}:${String(line)}: ${code.trim()}`);
      }
    }
    expect(found).toEqual([]);
  });
});
