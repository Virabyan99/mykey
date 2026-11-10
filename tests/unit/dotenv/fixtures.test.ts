// Review focus 1: a checkout that converts line endings must not change what
// these files prove. `tests/fixtures/**` is `-text` in .gitattributes; this
// suite fails if a fixture arrives with other bytes than it was written with.
import { DOTENV_RULES, parseDotenv, serializeDotenv } from "@mykey/contracts";
import type { DotenvRule } from "@mykey/contracts";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../fixtures/dotenv");
const ACCEPTED = join(ROOT, "accepted");
const REJECTED = join(ROOT, "rejected");

// Too large to be worth a file in the repository; parse.test.ts builds it.
const RULES_WITHOUT_FIXTURE: readonly DotenvRule[] = ["file_too_large"];

function list(directory: string): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".env"))
    .sort();
}

function hasCrlf(bytes: Uint8Array): boolean {
  return bytes.some((byte, index) => byte === 0x0d && bytes[index + 1] === 0x0a);
}

const accepted = list(ACCEPTED);
const rejected = list(REJECTED);
const all = [
  ...accepted.map((file) => join(ACCEPTED, file)),
  ...rejected.map((file) => join(REJECTED, file)),
];

describe("dotenv fixtures", () => {
  it("exist", () => {
    expect(accepted.length).toBeGreaterThanOrEqual(10);
    expect(rejected.length).toBeGreaterThanOrEqual(DOTENV_RULES.length - 1);
    expect(readdirSync(ACCEPTED).sort()).toEqual(accepted);
    expect(readdirSync(REJECTED).sort()).toEqual(rejected);
  });

  it.each(accepted)("accepted/%s parses and survives the canonical round trip", (file) => {
    const result = parseDotenv(readFileSync(join(ACCEPTED, file)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.entries.map(({ name, value }) => ({ name, value }));
    const again = parseDotenv(serializeDotenv(entries));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(new Map(again.entries.map(({ name, value }) => [name, value]))).toEqual(
      new Map(entries.map(({ name, value }) => [name, value])),
    );
  });

  it("accepted/canonical.env is already in canonical form", () => {
    const bytes = readFileSync(join(ACCEPTED, "canonical.env"));
    const result = parseDotenv(bytes);
    if (!result.ok) throw new Error("expected acceptance");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(Buffer.from(serializeDotenv(result.entries)).equals(bytes)).toBe(true);
  });

  it("accepted/empty.env has no bytes and no entries", () => {
    const bytes = readFileSync(join(ACCEPTED, "empty.env"));
    expect(bytes).toHaveLength(0);
    expect(parseDotenv(bytes)).toEqual({ ok: true, entries: [] });
  });

  it.each(rejected)("rejected/%s fails with the rule in its name, and only that rule", (file) => {
    const match = /^reject\.([a-z0-9_]+)\.\d+(\.crlf)?\.env$/.exec(file);
    expect(
      match,
      "file name is reject.<rule>.<n>.env or reject.<rule>.<n>.crlf.env",
    ).not.toBeNull();
    const rule = match?.[1] as DotenvRule;
    expect(DOTENV_RULES).toContain(rule);
    const result = parseDotenv(readFileSync(join(REJECTED, file)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.rule)).toEqual(result.issues.map(() => rule));
  });

  it("every rule has a rejected fixture", () => {
    const covered = new Set(rejected.map((file) => file.split(".")[1]));
    const missing = DOTENV_RULES.filter(
      (rule) => !covered.has(rule) && !RULES_WITHOUT_FIXTURE.includes(rule),
    );
    expect(missing).toEqual([]);
  });

  it("no fixture has a name Windows reserves for a device", () => {
    // `nul.1.env` is the NUL device on Windows whatever follows the first dot:
    // Git for Windows can neither add nor check out such a file. That is why
    // rejected fixtures carry the `reject.` prefix.
    const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
    const offenders = [...accepted, ...rejected].filter((file) =>
      reserved.test(file.split(".")[0] ?? ""),
    );
    expect(offenders).toEqual([]);
  });

  it("only a fixture named *.crlf.env contains CRLF, and each of those does", () => {
    const withCrlf = all.filter((path) => hasCrlf(readFileSync(path)));
    const namedCrlf = all.filter((path) => path.endsWith(".crlf.env"));
    expect(withCrlf).toEqual(namedCrlf);
    expect(namedCrlf.length).toBeGreaterThanOrEqual(3);
  });

  it("the byte-level fixtures still hold the bytes they are named for", () => {
    const read = (file: string): Buffer => readFileSync(join(REJECTED, `reject.${file}`));
    expect(Array.from(read("bom.1.env").subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(read("invalid_utf8.1.env").includes(0xff)).toBe(true);
    expect(read("nul.1.env").includes(0x00)).toBe(true);
    const loneCr = read("lone_cr.1.env");
    expect(loneCr.includes(0x0d)).toBe(true);
    expect(hasCrlf(loneCr)).toBe(false);
    expect(read("unquoted_forbidden_character.2.env").includes(0x09)).toBe(true);
    expect(readFileSync(join(ACCEPTED, "no-trailing-newline.env")).at(-1)).not.toBe(0x0a);
  });
});
