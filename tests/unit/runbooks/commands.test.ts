// Run 6.10 (P-130): every host.ts, probe.ts and ops command a runbook names in
// a fenced block exists: in host.ts's usage, in probe.ts's usage line, or as
// an ops command (apps/ops COMMANDS).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "@mykey/ops";
import { USAGE } from "../../../scripts/host.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNBOOKS = join(ROOT, "docs/runbooks");
const probeUsage =
  /usage: node scripts\/probe\.ts ([^"]+)"/.exec(
    readFileSync(join(ROOT, "scripts/probe.ts"), "utf8"),
  )?.[1] ?? "";
const hostCommands = new Set(
  [...USAGE.matchAll(/^ {2}([a-z][a-z0-9-]*)/gm)].map((m) => m[1] ?? ""),
);
const probeCommands = new Set(
  probeUsage
    .split("|")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((word) => /^[a-z][a-z-]*$/.test(word)),
);

/** The shell lines of every ```sh block of a runbook (continuations joined). */
function shellLines(text: string): string[] {
  const lines: string[] = [];
  for (const block of text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)) {
    lines.push(...(block[1] ?? "").replace(/\\\n\s*/g, " ").split("\n"));
  }
  return lines;
}

describe("runbook commands (P-130)", () => {
  it("reads the tools' command lists", () => {
    expect(hostCommands.has("deploy")).toBe(true);
    expect(hostCommands.has("restore")).toBe(true);
    expect(probeCommands.has("secrets")).toBe(true);
    expect(Object.keys(COMMANDS)).toContain("reset-account");
  });

  it("every command in a fenced block exists", () => {
    const unknown: string[] = [];
    for (const name of readdirSync(RUNBOOKS).filter((n) => n.endsWith(".md"))) {
      for (const line of shellLines(readFileSync(join(RUNBOOKS, name), "utf8"))) {
        const code = line.replace(/#.*$/, "");
        for (const m of code.matchAll(
          /scripts\/host\.ts\s+(\S+)\s+([a-z][a-z0-9-]*)(?:\s+(\S+))?/g,
        )) {
          const command = m[2] ?? "";
          if (command === "ops") {
            // `ops <command>` is a template, not a command.
            const sub = m[3] ?? "";
            if (!sub.startsWith("<") && !(sub in COMMANDS)) unknown.push(`${name}: ops ${sub}`);
          } else if (!hostCommands.has(command)) {
            unknown.push(`${name}: host.ts ${command}`);
          }
        }
        for (const m of code.matchAll(/scripts\/probe\.ts\s+([a-z][a-z0-9-]*)/g)) {
          if (!probeCommands.has(m[1] ?? "")) unknown.push(`${name}: probe.ts ${m[1] ?? ""}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
