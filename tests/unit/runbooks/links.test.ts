// Run 6.10 (P-130): every relative link of a runbook, and every repository path
// it names in backticks (`docs/…`, `infra/…`, `scripts/…`, `tests/…`), exists.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNBOOKS = join(ROOT, "docs/runbooks");
const files = readdirSync(RUNBOOKS).filter((name) => name.endsWith(".md"));

/** A path with a placeholder, a glob or a brace list names no one file. */
const concrete = (path: string): boolean => !/[<>*{}|$]|\.\.\./.test(path);

describe("runbook links and paths (P-130)", () => {
  it("every relative link resolves", () => {
    const missing: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(RUNBOOKS, name), "utf8");
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = (match[1] ?? "").split("#")[0] ?? "";
        if (target === "" || /^[a-z]+:/.test(target)) continue;
        if (!existsSync(resolve(RUNBOOKS, target))) missing.push(`${name}: ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every repository path named in backticks exists", () => {
    const missing: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(RUNBOOKS, name), "utf8");
      for (const match of text.matchAll(
        /`((?:docs|infra|scripts|tests|apps|packages|workers)\/[^`\s]+)`/g,
      )) {
        const path = (match[1] ?? "").replace(/[.,:;)]+$/, "");
        if (!concrete(path)) continue;
        if (
          !existsSync(join(ROOT, path)) &&
          !existsSync(join(ROOT, dirname(path), path.split("/").at(-1) ?? ""))
        ) {
          missing.push(`${name}: ${path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
