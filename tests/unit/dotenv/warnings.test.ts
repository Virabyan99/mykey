import { loaderWarnings } from "@mykey/contracts";
import type { LoaderWarning } from "@mykey/contracts";
import { describe, expect, it } from "vitest";

type Kind = Omit<LoaderWarning, "name">;

function warningsFor(value: string): Kind[] {
  return loaderWarnings([{ name: "A", value }]).map(({ loader, reason }) => ({ loader, reason }));
}

const nextExpansion: Kind = { loader: "nextjs", reason: "expansion" };
const nextEscape: Kind = { loader: "nextjs", reason: "escape" };
const pythonExpansion: Kind = { loader: "python-dotenv", reason: "expansion" };

describe("loaderWarnings, one value at a time", () => {
  it.each<[string, string]>([
    ["plain text", "plain"],
    ["an empty value", ""],
    ["spaces", "  two  words  "],
    ["a hash", "a # b"],
    ["a single quote", "it's"],
    ["an equals sign", "a=b"],
    ["a line feed", "a\nb"],
    ["a carriage return", "a\rb"],
    ["Unicode", "naïve 🔑"],
    ["a brace without a dollar", "{X}"],
  ])("gives no warning for %s", (_title, value) => {
    expect(warningsFor(value)).toEqual([]);
  });

  it.each<[string, string, Kind[]]>([
    ["a dollar reference", "$HOME", [nextExpansion]],
    ["a lone dollar", "5$", [nextExpansion]],
    ["a dollar-brace reference", "${X}", [nextExpansion, pythonExpansion]],
    ["an unclosed dollar-brace", "a${b", [nextExpansion, pythonExpansion]],
    ["a backslash", "a\\b", [nextEscape]],
    ["a double quote", 'say "hi"', [nextEscape]],
    ["a tab", "a\tb", [nextEscape]],
    ["an escaped dollar", "\\$X", [nextExpansion, nextEscape]],
    ["everything at once", 'a\\"\t${X}', [nextExpansion, nextEscape, pythonExpansion]],
  ])("warns for %s", (_title, value, expected) => {
    expect(warningsFor(value)).toEqual(expected);
  });
});

describe("loaderWarnings over a set of entries", () => {
  it("lists warnings by name in canonical order, whatever the input order", () => {
    const entries = [
      { name: "B", value: "$X" },
      { name: "PLAIN", value: "x" },
      { name: "A_1", value: "${X}" },
      { name: "AB", value: "a\tb" },
    ];
    const expected = [
      { name: "AB", loader: "nextjs", reason: "escape" },
      { name: "A_1", loader: "nextjs", reason: "expansion" },
      { name: "A_1", loader: "python-dotenv", reason: "expansion" },
      { name: "B", loader: "nextjs", reason: "expansion" },
    ];
    expect(loaderWarnings(entries)).toEqual(expected);
    expect(loaderWarnings([...entries].reverse())).toEqual(expected);
  });

  it("gives one warning per name, loader and reason", () => {
    expect(loaderWarnings([{ name: "A", value: '$a$b${c}${d}\\\\""\t\t' }])).toEqual([
      { name: "A", loader: "nextjs", reason: "expansion" },
      { name: "A", loader: "nextjs", reason: "escape" },
      { name: "A", loader: "python-dotenv", reason: "expansion" },
    ]);
  });

  it("returns nothing for no entries", () => {
    expect(loaderWarnings([])).toEqual([]);
  });

  it("never contains a value", () => {
    const canary = "MYKEY_" + "CANARY_" + "A".repeat(32);
    const warnings = loaderWarnings([
      { name: "A", value: `${canary}$\\"\t\${${canary}}` },
      { name: "B", value: `#${canary}` },
    ]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(warnings)).not.toContain(canary);
    for (const warning of warnings) {
      expect(Object.keys(warning).sort()).toEqual(["loader", "name", "reason"]);
    }
  });

  it("refuses the entries serializeDotenv refuses, without echoing them", () => {
    const canary = "MYKEY_" + "CANARY_" + "A".repeat(32);
    const lower = canary.toLowerCase();
    const attempts = [
      [{ name: lower, value: "$" }],
      [
        { name: "A", value: "1" },
        { name: "A", value: "2" },
      ],
      [{ name: "A", value: `${canary}\u0000` }],
    ];
    for (const entries of attempts) {
      let message = "";
      try {
        loaderWarnings(entries);
      } catch (error) {
        if (error instanceof Error) message = error.message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(canary);
      expect(message).not.toContain(lower);
    }
  });
});

// Found by the loader test (tests/integration/dotenv-loaders): @next/env reads
// `\"` as an escaped quote wherever it stands, so the closing quote of a value
// that ends with a backslash can be taken for data and the next line with it.
describe("loaderWarnings for the entry after a value that ends with a backslash", () => {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const NBSP = String.fromCharCode(0xa0);
  const VT = String.fromCharCode(0x0b);
  const backslashEnded = { name: "A", value: "path\\" };
  const ownWarning = { name: "A", loader: "nextjs", reason: "escape" };

  function nextWarnedNames(entries: { name: string; value: string }[]): string[] {
    return loaderWarnings(entries)
      .filter((warning) => warning.loader === "nextjs" && warning.reason === "escape")
      .map((warning) => warning.name);
  }

  it.each<[string, string]>([
    ["a hash", "#x"],
    ["a hash alone", "#"],
    ["a space and a hash", " #x"],
    ["spaces, a no-break space, a vertical tab and a hash", `  ${NBSP}${VT}#x`],
  ])("warns for a next value that starts with %s", (_title, value) => {
    expect(
      loaderWarnings([backslashEnded, { name: "B", value }, { name: "C", value: "c" }]),
    ).toEqual([ownWarning, { name: "B", loader: "nextjs", reason: "escape" }]);
  });

  it.each<[string, string]>([
    ["plain text", "x"],
    ["an empty value", ""],
    ["a hash after a letter", "x#"],
    ["spaces only", "   "],
    ["a line feed and a hash (the line feed is written as an escape)", "\n#x"],
    ["a carriage return and a hash", "\r#x"],
  ])("does not warn for a next value that is %s", (_title, value) => {
    expect(loaderWarnings([backslashEnded, { name: "B", value }])).toEqual([ownWarning]);
  });

  it("uses canonical order to decide which entry is next", () => {
    const entries = [
      { name: "C", value: "#c" },
      { name: "A", value: "a\\" },
      { name: "B", value: "b" },
    ];
    expect(nextWarnedNames(entries)).toEqual(["A"]);
    expect(nextWarnedNames([...entries, { name: "AA", value: "#aa" }])).toEqual(["A", "AA"]);
  });

  it("does not warn when the earlier value does not end with a backslash", () => {
    const entries = [
      { name: "A", value: 'ends with quote"' },
      { name: "B", value: "#b" },
      { name: "C", value: "back\\slash inside" },
      { name: "D", value: "#d" },
    ];
    expect(nextWarnedNames(entries)).toEqual(["A", "C"]);
  });

  it("gives no python-dotenv warning for it", () => {
    const warnings = loaderWarnings([backslashEnded, { name: "B", value: "#x" }]);
    expect(warnings.filter((warning) => warning.loader === "python-dotenv")).toEqual([]);
  });

  it.each<[string, string]>([
    ["starts with U+2028", `${LS}Z=1`],
    ["starts with U+2029", `${PS}Z=1`],
    ["starts with a space and U+2028", ` ${LS}Z=1`],
    ["starts with a hash and holds U+2028", `#x${LS}Z=1`],
    ["starts with a hash and holds U+2029", `#x${PS}Z=1`],
  ])("warns for every entry when the next value %s", (_title, value) => {
    const entries = [
      { name: "B", value: "b\\" },
      { name: "C", value },
      { name: "D", value: "d" },
      { name: "A", value: "first" },
    ];
    expect(nextWarnedNames(entries)).toEqual(["A", "B", "C", "D"]);
  });

  it("does not warn for a line separator when no value before it ends with a backslash", () => {
    const entries = [
      { name: "A", value: "a" },
      { name: "B", value: `${LS}Z=1` },
      { name: "C", value: `#x${PS}` },
    ];
    expect(loaderWarnings(entries)).toEqual([]);
  });
});
