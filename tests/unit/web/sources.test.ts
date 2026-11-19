// Run 7.1 Task B (Doc 10 §4.1 rule 2, Doc 06 §9 and §18.2): what the
// workspace's sources may not name. The page keeps nothing outside its own
// memory, writes nothing to the console, and builds no markup from text.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../apps/web/src");

function sources(directory: string = ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : [];
  });
}

/** Names assembled here so this file would pass its own search. */
const BANNED: [string, RegExp][] = [
  ["local storage", new RegExp(["local", "Storage"].join(""))],
  ["session storage", new RegExp(["session", "Storage"].join(""))],
  ["IndexedDB", new RegExp(["indexed", "DB"].join(""), "i")],
  ["the cookie jar", new RegExp(["document", "cookie"].join("\\."))],
  ["Cache Storage", new RegExp(`\\b${["cach", "es"].join("")}\\b\\s*\\.`)],
  ["a service worker", new RegExp(["service", "Worker"].join(""))],
  ["a broadcast channel", new RegExp(["Broadcast", "Channel"].join(""))],
  ["the console", new RegExp(`\\b${["con", "sole"].join("")}\\s*\\.`)],
  ["markup from text", new RegExp(["dangerously", "SetInnerHTML"].join(""))],
  ["inner HTML", new RegExp(`\\.${["inner", "HTML"].join("")}\\b`)],
  ["eval", new RegExp(`\\b${["ev", "al"].join("")}\\s*\\(`)],
  ["a Function constructor", new RegExp(`new\\s+${["Func", "tion"].join("")}\\s*\\(`)],
  ["a query persister", new RegExp(["persist", "QueryClient"].join(""), "i")],
  ["an optimistic update", new RegExp(["on", "Mutate"].join(""))],
];

describe("the workspace's sources", () => {
  const files = sources();

  it("exist (the search has something to read)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((file) => file.endsWith(".tsx"))).toBe(true);
  });

  it.each(BANNED)("never name %s", (_what, pattern) => {
    const hits = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"));
    expect(hits).toEqual([]);
  });

  it("the search finds a banned name when one is there (control)", () => {
    const sample = `window.${["con", "sole"].join("")}.log("a")`;
    const pattern = BANNED.find(([what]) => what === "the console")![1];
    expect(pattern.test(sample)).toBe(true);
    expect(pattern.test("a console is a desk")).toBe(false);
  });
});
