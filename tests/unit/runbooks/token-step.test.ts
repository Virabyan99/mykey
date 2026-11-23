// Run 10.1 Task B (P-172, P-173): one source for the token step. The block of
// consumer-local.md §8 is the only form; every runbook that stores a token
// holds the same bytes, and no runbook, page text or help article holds the
// old three-block step (stty, Ctrl-D, cat into the token file) or the
// names-only command that prints a multi-line value's later lines
// (F-10.0-1). docs/evidence, docs/plans and docs/decisions are history and
// are not searched.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (path: string): string =>
  readFileSync(join(ROOT, path), "utf8").replaceAll("\r\n", "\n");

/** The fenced `sh` blocks of a Markdown text, with a list item's indentation removed. */
function shBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(/^( *)```sh\n([\s\S]*?)^ *```$/gm)) {
    const indent = (match[1] ?? "").length;
    blocks.push(
      (match[2] ?? "")
        .split("\n")
        .map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length)))
        .join("\n")
        .replace(/\n$/, ""),
    );
  }
  return blocks;
}

/** The text of a section from its heading to the next heading of the same level or higher. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no heading ${heading}`);
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const rest = text.slice(start + heading.length + 2);
  const next = new RegExp(`^#{1,${String(level)}} `, "m").exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

const LOCAL = read("docs/runbooks/consumer-local.md");
const DEPLOY = read("docs/runbooks/consumer-deploy.md");
const CREDENTIALS = read("docs/runbooks/machine-credentials.md");
const STEP = shBlocks(section(LOCAL, "## 8. Store the token"))[0] ?? "";

const tokenBlocks = (text: string): string[] =>
  shBlocks(text).filter((block) => block.includes("machine-token"));

function files(directory: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(ROOT, directory))) {
    const path = `${directory}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) found.push(...files(path, keep));
    else if (keep(name)) found.push(path);
  }
  return found;
}

/** Where the token step is shown or written to a reader today. */
const SURFACES = [
  ...files("docs/runbooks", (name) => name.endsWith(".md")),
  ...files("apps/web/src/copy", (name) => name.endsWith(".ts")),
  ...files("apps/web/src/help", (name) => name.endsWith(".ts")),
  "apps/web/src/connect/commands.ts",
];

describe("the token step has one source (P-172)", () => {
  it("consumer-local.md §8 holds one bash block that reads the token silently", () => {
    expect(STEP).toMatch(/^bash -c '/);
    expect(STEP).toContain("read -rs");
    expect(STEP.split("\n")).toHaveLength(1);
  });

  it('the token block of consumer-local.md §8 is, byte for byte, the block of its "Rotate the token", of consumer-deploy.md §5 and its "Rotate the token", and of machine-credentials.md "Store a token"', () => {
    expect(tokenBlocks(section(LOCAL, "## Rotate the token"))).toEqual([STEP]);
    expect(tokenBlocks(section(DEPLOY, "## 5. Store the token on the host"))).toEqual([STEP]);
    expect(tokenBlocks(section(DEPLOY, "## Rotate the token"))).toEqual([STEP]);
    expect(tokenBlocks(section(CREDENTIALS, "## Store a token"))).toEqual([STEP]);
  });

  it("the block's character set is the CLI's own", () => {
    const shape = /const SHAPE = \/\^\[([^\]]+)\]\+\$\//.exec(read("apps/cli/src/token.ts"))?.[1];
    expect(shape).toBe("A-Za-z0-9._-");
    expect(STEP).toContain(`*[^${shape ?? ""}]*`);
  });

  it('no runbook, no page text and no help article holds stty, "Ctrl-D", or a cat into machine-token', () => {
    const found: string[] = [];
    for (const path of SURFACES) {
      const text = read(path);
      for (const pattern of [
        /\bstty\b/,
        /Ctrl-D/,
        /cat > "?\$HOME\/\.config\/mykey\/machine-token/,
      ]) {
        if (pattern.test(text)) found.push(`${path}: ${String(pattern)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('no runbook and no page text holds "env | cut"', () => {
    const found = SURFACES.filter((path) => read(path).includes("env | cut"));
    expect(found).toEqual([]);
  });
});
