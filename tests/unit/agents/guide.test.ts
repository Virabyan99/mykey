// Run 10.4 Task B (P-179, D-79): llms.txt and the agent guide are kept in
// step with the code. Their commands are the rehearsed runbooks' own blocks,
// byte for byte; their exit codes are the CLI's EXIT table; their limits are
// @mykey/contracts' LIMITS; every variable they name is one the CLI or the
// launcher reads. The rule comes first, and the commands that lead to a value
// appear only in the "Never" section.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIMITS } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import { EXIT, parseArgs } from "@mykey/cli";

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (path: string): string =>
  readFileSync(join(ROOT, path), "utf8").replaceAll("\r\n", "\n");

const GUIDE_PATH = "docs/agents/connect-an-application.md";
// A broken copy, to see each test fail once (Run 10.4 Task B Step 1).
const readCopy = (variable: string, path: string): string =>
  process.env[variable] === undefined
    ? read(path)
    : readFileSync(process.env[variable], "utf8").replaceAll("\r\n", "\n");
const LLMS = readCopy("MYKEY_LLMS_COPY", "llms.txt");
const GUIDE = readCopy("MYKEY_GUIDE_COPY", GUIDE_PATH);

interface Block {
  lang: string;
  body: string;
  /** The `<!-- from: <file> §<section>[.<k>] -->` line just before it, if any. */
  from: string | null;
  /** The `## ` heading it is under. */
  section: string;
}

/** The fenced blocks of a Markdown text, with a list item's indentation removed. */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let section = "";
  let from: string | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) section = line.slice(3);
    const marker = /^\s*<!-- from: (.+?) -->$/.exec(line);
    if (marker !== null) {
      from = marker[1] ?? null;
      continue;
    }
    const open = /^( *)```(\S*)$/.exec(line);
    if (open === null) {
      if (line.trim() !== "") from = null;
      continue;
    }
    const indent = (open[1] ?? "").length;
    const body: string[] = [];
    for (i += 1; i < lines.length && !/^ *```$/.test(lines[i] ?? ""); i += 1) {
      const inner = lines[i] ?? "";
      body.push(inner.slice(Math.min(indent, inner.length - inner.trimStart().length)));
    }
    blocks.push({ lang: open[2] ?? "", body: body.join("\n"), from, section });
    from = null;
  }
  return blocks;
}

/** A runbook's section: `§<n>` is "## <n>. …", `§preamble` the text before the first `## `, else a heading. */
function sourceSection(file: string, name: string): string {
  const text = read(`docs/runbooks/${file}`);
  if (name === "preamble") return text.slice(0, text.indexOf("\n## "));
  const heading = /^\d+$/.test(name) ? `\n## ${name}. ` : `\n## ${name}\n`;
  const start = text.indexOf(heading);
  if (start === -1) throw new Error(`${file} has no section ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

const GUIDE_BLOCKS = blocksOf(GUIDE);
const NEVER = "13. Never";
const shellLines = (blocks: Block[]): string[] =>
  blocks
    .filter((b) => b.lang === "sh")
    .flatMap((b) => b.body.split("\n"))
    .map((l) => l.trim());

/** Commands that lead to a value or a token; allowed only in the "Never" section. */
const LEADS_TO_A_VALUE: RegExp[] = [
  /machine-token(?!["']?\s*(?:&&|;|\)|$|,|dst=))/, // the token file read (the store and the mount are allowed)
  /\bcat\b[^\n]*machine-token/,
  /(^|[\s;|&('"])(printenv|env)(\s|$|['";|,])/,
  /\becho\s+["']?\$[A-Z]/,
  /\/proc\/[^\s]*\/environ/,
  /\bsecrets\s+export\b/,
  /(^|\s)(cat|less|head|tail|grep|source|\.)\s+[^\n]*\.env\b/,
  /\bdocker\s+inspect\b/,
  /--build-arg/,
];

describe("llms.txt", () => {
  it("an H1, a quoted summary, the rule before any link, exactly one link under Guide, and every link is a path that exists", () => {
    const lines = LLMS.split("\n");
    expect(lines[0]).toMatch(/^# \S/);
    expect(lines.find((l) => l.startsWith(">"))).toBeDefined();
    const rule = LLMS.indexOf("never handles a machine token or a secret value");
    const firstLink = LLMS.search(/\]\(/);
    expect(rule).toBeGreaterThan(0);
    expect(rule).toBeLessThan(firstLink);
    const guide = LLMS.slice(LLMS.indexOf("## Guide"), LLMS.indexOf("## Optional"));
    expect([...guide.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])).toEqual([GUIDE_PATH]);
    for (const match of LLMS.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1] ?? "";
      expect(target, target).not.toMatch(/^[a-z]+:/);
      expect(() =>
        readdirSync(join(ROOT, target.endsWith("/") ? target : join(target, ".."))),
      ).not.toThrow();
    }
  });
});

describe("the agent guide (D-79)", () => {
  it("its first section is the rule, and no fenced block comes before its end", () => {
    const sections = [...GUIDE.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(sections[0]).toBe("0. The rule");
    const ruleEnd = GUIDE.indexOf("\n## ", GUIDE.indexOf("## 0. The rule") + 1);
    expect(GUIDE.slice(0, ruleEnd)).not.toContain("```");
    expect(GUIDE.slice(0, ruleEnd)).toContain("You never read, print, copy, move or ask for");
  });

  it("every block marked <!-- from: <runbook> §N --> is that runbook's block, byte for byte", () => {
    const marked = GUIDE_BLOCKS.filter((b) => b.from !== null);
    expect(marked.length).toBeGreaterThanOrEqual(10);
    for (const block of marked) {
      const found = /^(\S+\.md) §([^.\s]+(?: [^.]+)?)(?:\.(\d+))?$/.exec(block.from ?? "");
      expect(found, block.from ?? "").not.toBeNull();
      const [, file = "", name = "", k = "1"] = found ?? [];
      const source = blocksOf(sourceSection(file, name)).filter((b) => b.lang === block.lang);
      expect(source[Number(k) - 1]?.body, block.from ?? "").toBe(block.body);
    }
  });

  it("every other shell line that starts with secrets is accepted by the CLI's own parseArgs, and every secrets-launch.sh line has -- as its second word", () => {
    for (const line of shellLines(GUIDE_BLOCKS)) {
      const words = line.split(/\s+/);
      if (words[0] === "secrets") expect(() => parseArgs(words.slice(1)), line).not.toThrow();
      if (words[0] === "secrets-launch.sh") expect(words[1], line).toBe("--");
    }
    for (const code of GUIDE.matchAll(/`(secrets(?:-launch\.sh)? [^`]+)`/g)) {
      const words = (code[1] ?? "").split(/\s+/);
      if (words[0] === "secrets-launch.sh") expect(words[1], code[1]).toBe("--");
      if (words[0] === "secrets" && words[1] !== "export") {
        expect(() => parseArgs(words.slice(1)), code[1]).not.toThrow();
      }
    }
  });

  it("the exit-code table is EXIT, code for code and category for category; 78 names the launcher", () => {
    const table = GUIDE.slice(GUIDE.indexOf("## 10. Exit codes"), GUIDE.indexOf("## 11."));
    // Prettier pads the columns.
    const rows = [...table.matchAll(/^\|\s*(\d+)\s*\|\s*(\w+)\s*\|(.*)$/gm)];
    expect(Object.fromEntries(rows.map((r) => [r[2], Number(r[1])]))).toEqual({ ...EXIT });
    expect(rows).toHaveLength(Object.keys(EXIT).length);
    expect(rows.find((r) => r[1] === "78")?.[3]).toContain("secrets-launch.sh");
    expect(read("tests/fixtures/consumers/secrets-launch.sh")).toContain("exit 78");
  });

  it("the limits' numbers are those of @mykey/contracts", () => {
    const limits = GUIDE.slice(GUIDE.indexOf("## 12. Limits"), GUIDE.indexOf("## 13."));
    const mib = (bytes: number): string => `${String(bytes / 1048576)} MiB`;
    for (const text of [
      `at most ${String(LIMITS.secret.nameMaxLength)} characters`,
      `\`${LIMITS.secret.reservedPrefix}\``,
      `${LIMITS.environment.maxNames.toLocaleString("en")} names`,
      `${mib(LIMITS.environment.maxLiveValueBytes)} of values`,
      `${LIMITS.secret.valueMaxBytes.toLocaleString("en")} bytes`,
      `${String(LIMITS.machineToken.maxTtlSeconds / 86400)} days`,
      `at most ${mib(LIMITS.body.dotenvMaxBytes)}`,
    ]) {
      expect(limits, text).toContain(text);
    }
  });

  it("the CLI version named is apps/cli/package.json's", () => {
    const version = (JSON.parse(read("apps/cli/package.json")) as { version: string }).version;
    const named = new Set([...GUIDE.matchAll(/cli-v(\d+\.\d+\.\d+)/g)].map((m) => m[1]));
    expect([...named]).toEqual([version]);
    expect(GUIDE).toContain(`mykey-cli-${version}.tgz`);
  });

  it("every SECRETS_ variable the guide names is read by apps/cli/src or by secrets-launch.sh", () => {
    const sources = [
      ...readdirSync(join(ROOT, "apps/cli/src"))
        .filter((n) => n.endsWith(".ts"))
        .map((n) => read(`apps/cli/src/${n}`)),
      read("tests/fixtures/consumers/secrets-launch.sh"),
    ].join("\n");
    const named = new Set([...GUIDE.matchAll(/SECRETS_[A-Z][A-Z_]*/g)].map((m) => m[0]));
    expect(named.size).toBeGreaterThanOrEqual(4);
    for (const name of named) expect(sources, name).toContain(name);
  });

  it('outside the "Never" section, no fenced block holds a command that reads the token file, prints the environment, runs secrets export or opens .env', () => {
    const found: string[] = [];
    for (const block of GUIDE_BLOCKS.filter((b) => b.section !== NEVER)) {
      for (const line of block.body.split("\n")) {
        for (const pattern of LEADS_TO_A_VALUE) {
          if (pattern.test(line))
            found.push(`${block.section}: ${String(pattern)}: ${line.slice(0, 80)}`);
        }
      }
    }
    expect(found).toEqual([]);
    // The "Never" section names them: the patterns are known to match.
    const never = GUIDE_BLOCKS.filter((b) => b.section === NEVER)
      .map((b) => b.body)
      .join("\n");
    for (const pattern of LEADS_TO_A_VALUE.slice(1, 7))
      expect(never, String(pattern)).toMatch(pattern);
  });

  it("the hand-over ids are exactly put-secrets, store-token, remove-dotenv, replace-token, and store-token's text holds the token block", () => {
    const ids = [...GUIDE.matchAll(/^### Your step \(([a-z-]+)\)$/gm)].map((m) => m[1]);
    expect(ids).toEqual(["put-secrets", "store-token", "remove-dotenv", "replace-token"]);
    for (const id of ids) expect(GUIDE).toContain(`> Your step (${id}):`);
    const store = GUIDE.slice(
      GUIDE.indexOf("### Your step (store-token)"),
      GUIDE.indexOf("### Your step (remove-dotenv)"),
    );
    const token = blocksOf(sourceSection("consumer-local.md", "8")).find((b) => b.lang === "sh");
    expect(blocksOf(store).map((b) => b.body)).toEqual([token?.body]);
  });

  it("the lint: no canary-shaped string, no IP address, no host name but the allowed ones, nothing shaped like a token", () => {
    for (const [name, text] of [
      ["llms.txt", LLMS],
      [GUIDE_PATH, GUIDE],
    ] as const) {
      expect(text, name).not.toMatch(/MYKEY_CANARY_[A-Z0-9]{8,}/);
      expect(text, name).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(?<!127\.0\.0\.1)/);
      expect(text, name).not.toMatch(/\bhv[sbr]\.[A-Za-z0-9_-]{20,}/);
      const hosts = new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1] ?? ""));
      for (const host of hosts) {
        expect(
          ["mykey.example", "github.com", "raw.githubusercontent.com", "nodejs.org", "127.0.0.1"],
          `${name}: ${host}`,
        ).toContain(host);
      }
      expect(text, name).not.toMatch(/\bstty\b/);
    }
  });
});
