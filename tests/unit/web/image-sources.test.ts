// Session 8 gate (Run 8.1 Task B Step 1): the image's web stage builds the
// workspace from what it copies. A file the workspace imports from outside the
// copied sources (known-limits.md for Help, Run 8.0) failed only the image
// build, which a draft pull request never runs.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");

function sourcesOf(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) return sourcesOf(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** The repository paths the web sources import by a relative specifier. */
function relativeImports(): string[] {
  const found = new Set<string>();
  for (const file of sourcesOf("apps/web/src")) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
      const specifier = match[1] ?? "";
      const target = relative(ROOT, resolve(ROOT, dirname(file), specifier)).replaceAll("\\", "/");
      found.add(target);
    }
  }
  return [...found];
}

/** The sources of every COPY of the Dockerfile stage named `web`. */
function webStageCopies(): string[] {
  const text = readFileSync(join(ROOT, "apps/api/Dockerfile"), "utf8");
  const start = text.search(/^FROM .* AS web$/m);
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.search(/^FROM /m);
  const stage = end === -1 ? rest : rest.slice(0, end);
  return [...stage.matchAll(/^COPY (?!--from)(.+)$/gm)].flatMap((match) => {
    const parts = (match[1] ?? "").trim().split(/\s+/);
    return parts.slice(0, -1).map((part) => part.replace(/\/$/, ""));
  });
}

describe("the image's web stage", () => {
  it("copies every file the workspace imports from outside its own sources", () => {
    const copies = webStageCopies();
    const covered = (path: string): boolean =>
      copies.some((copy) => path === copy || path.startsWith(`${copy}/`));
    const outside = relativeImports().filter(
      (path) => !path.startsWith("apps/web/src/") && !path.startsWith("packages/contracts/src/"),
    );
    expect(outside).toContain("docs/runbooks/known-limits.md");
    expect(outside.filter((path) => !covered(path))).toEqual([]);
    // The build context leaves everything out but what .dockerignore lets in.
    const allowed = readFileSync(join(ROOT, ".dockerignore"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1).trim().replace(/\/$/, ""));
    expect(
      outside.filter(
        (path) => !allowed.some((entry) => path === entry || path.startsWith(`${entry}/`)),
      ),
    ).toEqual([]);
  });
});
