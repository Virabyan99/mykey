import {
  DOTENV_RULES,
  checkSecretName,
  checkSecretValue,
  parseDotenv,
  serializeDotenv,
} from "@mykey/contracts";
import type { DotenvParseResult } from "@mykey/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

interface Entry {
  name: string;
  value: string;
}

const RUNS = 1000;
const utf8 = new TextEncoder();

// Everything the format treats specially, plus what loaders treat specially.
const SPECIAL = [
  "",
  '"',
  "\\",
  "$",
  "#",
  "\r",
  "\n",
  "\r\n",
  "\t",
  " ",
  "'",
  "=",
  "${X}",
  "$HOME",
  "\\n",
  "\\$",
  '\\"',
  "🔑",
  "ï",
  "\u0001",
  "\u007f",
  "\u00a0",
  "\u2028",
  "\ufeff",
  "export ",
];

const nameArbitrary = fc
  .stringMatching(/^[A-Z][A-Z0-9_]{0,11}$/)
  .filter((name) => checkSecretName(name).ok);

const valueArbitrary = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(...SPECIAL) },
      { weight: 2, arbitrary: fc.string({ unit: "grapheme", maxLength: 6 }) },
      { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 6 }) },
    ),
    { maxLength: 10 },
  )
  .map((parts) => parts.join(""))
  .filter((value) => checkSecretValue(value).ok);

const entriesArbitrary: fc.Arbitrary<Entry[]> = fc.uniqueArray(
  fc.record({ name: nameArbitrary, value: valueArbitrary }),
  { selector: (entry) => entry.name, maxLength: 12 },
);

// Named examples the generator must never be trusted to find by luck.
const EXAMPLES: [Entry[]][] = [
  [[]],
  [[{ name: "EMPTY", value: "" }]],
  [[{ name: "ASTRAL", value: "🔑\u{10ffff}\u{1f600}" }]],
  [[{ name: "QUOTES", value: '"\'""' }]],
  [[{ name: "BACKSLASHES", value: "\\\\\\n\\" }]],
  [[{ name: "DOLLARS", value: "$ $A ${A} \\$A $$" }]],
  [[{ name: "HASH", value: "# a #b" }]],
  [[{ name: "NEWLINES", value: "\r\n\n\r\t" }]],
  [[{ name: "SPACES", value: "  both ends  " }]],
  [
    [
      { name: "Z", value: "last" },
      { name: "A_1", value: "\\" },
      { name: "AB", value: "#" },
      { name: "A", value: '"' },
    ],
  ],
];

function sortByName(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function pairs(result: DotenvParseResult): Entry[] {
  if (!result.ok) throw new Error(`expected acceptance, got ${JSON.stringify(result.issues)}`);
  return result.entries.map(({ name, value }) => ({ name, value }));
}

function expectWellFormedResult(result: DotenvParseResult): void {
  if (result.ok) {
    const names = new Set<string>();
    for (const entry of result.entries) {
      expect(checkSecretName(entry.name).ok).toBe(true);
      expect(checkSecretValue(entry.value).ok).toBe(true);
      expect(Number.isInteger(entry.line) && entry.line >= 1).toBe(true);
      names.add(entry.name);
    }
    expect(names.size).toBe(result.entries.length);
    return;
  }
  expect(result.issues.length).toBeGreaterThanOrEqual(1);
  expect(result.issues.length).toBeLessThanOrEqual(100);
  for (const issue of result.issues) {
    expect(DOTENV_RULES).toContain(issue.rule);
    expect(Number.isInteger(issue.line) && issue.line >= 0).toBe(true);
    if (issue.name !== undefined) expect(checkSecretName(issue.name).ok).toBe(true);
  }
}

describe("dotenv round trip", () => {
  it("the value generator produces every character class the format cares about", () => {
    const sample = fc.sample(valueArbitrary, { numRuns: 2000, seed: 1 });
    const has = (test: (value: string) => boolean): boolean => sample.some(test);
    expect(has((value) => value === "")).toBe(true);
    expect(has((value) => /[\u{10000}-\u{10ffff}]/u.test(value))).toBe(true);
    for (const character of ['"', "\\", "$", "#", "\r", "\n", "\t", "'"]) {
      expect(has((value) => value.includes(character))).toBe(true);
    }
    expect(has((value) => value.startsWith(" "))).toBe(true);
    expect(has((value) => value.endsWith(" "))).toBe(true);
    expect(has((value) => value.endsWith("\\"))).toBe(true);
  });

  it("parse(serialize(x)) is x sorted by name", () => {
    fc.assert(
      fc.property(entriesArbitrary, (entries) => {
        expect(pairs(parseDotenv(serializeDotenv(entries)))).toEqual(sortByName(entries));
      }),
      { numRuns: RUNS, examples: EXAMPLES },
    );
  });

  it("serialize(parse(serialize(x))) is byte-identical to serialize(x)", () => {
    fc.assert(
      fc.property(entriesArbitrary, (entries) => {
        const first = serializeDotenv(entries);
        const second = serializeDotenv(pairs(parseDotenv(first)));
        expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
        const reversed = serializeDotenv([...entries].reverse());
        expect(Buffer.from(reversed).equals(Buffer.from(first))).toBe(true);
      }),
      { numRuns: RUNS, examples: EXAMPLES },
    );
  });

  it("canonical lines are numbered in name order", () => {
    fc.assert(
      fc.property(entriesArbitrary, (entries) => {
        const result = parseDotenv(serializeDotenv(entries));
        if (!result.ok) throw new Error("expected acceptance");
        expect(result.entries.map((entry) => entry.line)).toEqual(entries.map((_, i) => i + 1));
      }),
      { numRuns: RUNS, examples: EXAMPLES },
    );
  });
});

describe("dotenv parser fuzz", () => {
  it("never throws on arbitrary bytes and returns a well-formed result", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expectWellFormedResult(parseDotenv(bytes));
      }),
      { numRuns: RUNS },
    );
  });

  // Random bytes almost never form `NAME=value`; these are the tokens the
  // grammar reacts to.
  const TOKENS = [
    "A",
    "B",
    "C1",
    "SECRETS_",
    "a",
    "=",
    "=",
    '"',
    '"',
    "'",
    "\\",
    "\\n",
    "\\q",
    "\n",
    "\n",
    "\r\n",
    "\r",
    " ",
    "\t",
    "#",
    "$",
    "export ",
    "x",
    "é",
    "🔑",
    "\u0000",
    "\ufeff",
    "\u2028",
  ];

  it("never throws on token soup", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...TOKENS), { maxLength: 24 }), (tokens) => {
        expectWellFormedResult(parseDotenv(utf8.encode(tokens.join(""))));
      }),
      { numRuns: RUNS },
    );
  });

  // Lines shaped like entries, so that a useful share of the files is accepted
  // and both the quoted and the unquoted path are reached.
  const lineArbitrary = fc.oneof(
    {
      weight: 8,
      arbitrary: fc
        .tuple(
          fc.constantFrom("A", "B", "C1", "D_2", "E", "F", "a", "SECRETS_X", "export G", " H"),
          fc.oneof(
            fc.constantFrom("", "x", "two words", '""', '"x"', '"a\\nb"', '"\\\\"', '"#"', "$X"),
            fc.array(fc.constantFrom(...TOKENS), { maxLength: 5 }).map((tokens) => tokens.join("")),
            fc
              .array(fc.constantFrom("x", " ", "#", "$", "\\n", "\\t", '\\"', "\\\\", "é", "\t"), {
                maxLength: 5,
              })
              .map((tokens) => `"${tokens.join("")}"`),
          ),
        )
        .map(([name, value]) => `${name}=${value}`),
    },
    { weight: 2, arbitrary: fc.constantFrom("", "# comment", " ", "junk", "#") },
  );
  const fileArbitrary = fc
    .array(fc.tuple(lineArbitrary, fc.constantFrom("\n", "\n", "\n", "\r\n", "\r\n", "\r", "")), {
      maxLength: 5,
    })
    .map((lines) => lines.map(([line, ending]) => line + ending).join(""));

  it("never throws on entry-shaped lines; an accepted file round-trips through the canonical form", () => {
    let acceptedEntries = 0;
    let acceptedQuoted = 0;
    let rejectedFiles = 0;
    fc.assert(
      fc.property(fileArbitrary, (file) => {
        const result = parseDotenv(utf8.encode(file));
        expectWellFormedResult(result);
        if (!result.ok) {
          rejectedFiles += 1;
          return;
        }
        acceptedEntries += result.entries.length;
        acceptedQuoted += result.entries.filter((entry) => /[\n\t"\\#]/.test(entry.value)).length;
        const entries = result.entries.map(({ name, value }) => ({ name, value }));
        expect(pairs(parseDotenv(serializeDotenv(entries)))).toEqual(sortByName(entries));
      }),
      { numRuns: 5 * RUNS, seed: 20261110 },
    );
    // The fuzz is only worth something if every outcome actually happens.
    expect(acceptedEntries).toBeGreaterThan(500);
    expect(acceptedQuoted).toBeGreaterThan(50);
    expect(rejectedFiles).toBeGreaterThan(500);
  });

  it("never throws on invalid UTF-8 spliced into an otherwise valid file", () => {
    fc.assert(
      fc.property(
        entriesArbitrary,
        fc.nat(),
        fc.constantFrom(0xff, 0xc0, 0x80, 0xed, 0xf8),
        (entries, position, byte) => {
          const valid = serializeDotenv(entries);
          const spliced = new Uint8Array(valid.length + 1);
          const at = valid.length === 0 ? 0 : position % valid.length;
          spliced.set(valid.subarray(0, at), 0);
          spliced[at] = byte;
          spliced.set(valid.subarray(at), at + 1);
          const result = parseDotenv(spliced);
          expectWellFormedResult(result);
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
