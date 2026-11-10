import { LIMITS, parseDotenv, serializeDotenv } from "@mykey/contracts";
import { describe, expect, it } from "vitest";

const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function text(entries: readonly { name: string; value: string }[]): string {
  return decoder.decode(serializeDotenv(entries));
}

function thrownMessage(entries: readonly { name: string; value: string }[]): string {
  try {
    serializeDotenv(entries);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("expected serializeDotenv to throw");
}

describe("serializeDotenv writes the canonical form", () => {
  it("sorts names in ASCII order", () => {
    const entries = [
      { name: "B", value: "2" },
      { name: "A", value: "1" },
      { name: "A_1", value: "3" },
      { name: "AB", value: "4" },
      { name: "A1", value: "5" },
    ];
    expect(text(entries)).toBe('A="1"\nA1="5"\nAB="4"\nA_1="3"\nB="2"\n');
  });

  it("does not depend on the order of its input and does not change it", () => {
    const entries = Object.freeze([
      Object.freeze({ name: "B", value: "2" }),
      Object.freeze({ name: "A", value: "1" }),
    ]);
    expect(text(entries)).toBe(text([...entries].reverse()));
    expect(entries.map((entry) => entry.name)).toEqual(["B", "A"]);
  });

  it("double-quotes every value, including empty and plain ones", () => {
    expect(text([{ name: "A", value: "" }])).toBe('A=""\n');
    expect(text([{ name: "A", value: "plain" }])).toBe('A="plain"\n');
    expect(text([{ name: "A", value: "0" }])).toBe('A="0"\n');
  });

  it("escapes exactly LF, CR, TAB, backslash and double quote", () => {
    const bytes = serializeDotenv([{ name: "X", value: 'a\nb\rc\td\\e"f' }]);
    expect(Array.from(bytes)).toEqual(Array.from(utf8.encode('X="a\\nb\\rc\\td\\\\e\\"f"\n')));
  });

  it.each<[string, string, string]>([
    ["a line feed", "\n", "\\n"],
    ["a carriage return", "\r", "\\r"],
    ["a tab", "\t", "\\t"],
    ["a backslash", "\\", "\\\\"],
    ["a double quote", '"', '\\"'],
    ["a backslash followed by n", "\\n", "\\\\n"],
    ["CRLF", "\r\n", "\\r\\n"],
  ])("writes %s as the right escape", (_title, value, escaped) => {
    expect(text([{ name: "A", value }])).toBe(`A="${escaped}"\n`);
  });

  it("leaves every other character as it is", () => {
    const value = "$HOME ${X} #x 'q' = naïve 🔑 \u0001\u000b\u001b\u007f\u0085\u2028\ufeff  ";
    const bytes = serializeDotenv([{ name: "A", value }]);
    expect(Array.from(bytes)).toEqual(Array.from(utf8.encode(`A="${value}"\n`)));
  });

  it("ends every line, and so the file, with one LF and never writes a CR", () => {
    const bytes = serializeDotenv([
      { name: "A", value: "1\r\n" },
      { name: "B", value: "" },
    ]);
    expect(bytes.at(-1)).toBe(0x0a);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(Array.from(bytes).filter((byte) => byte === 0x0a)).toHaveLength(2);
  });

  it("writes zero bytes for zero entries", () => {
    expect(serializeDotenv([])).toHaveLength(0);
  });

  it("writes no byte order mark", () => {
    expect(Array.from(serializeDotenv([{ name: "A", value: "\ufeff" }]).slice(0, 3))).toEqual(
      Array.from(utf8.encode('A="')),
    );
  });

  it("accepts a value of exactly 65,536 bytes that doubles when escaped", () => {
    const value = '"'.repeat(LIMITS.secret.valueMaxBytes);
    const bytes = serializeDotenv([{ name: "A", value }]);
    expect(bytes).toHaveLength(2 * LIMITS.secret.valueMaxBytes + 5);
    expect(parseDotenv(bytes)).toEqual({ ok: true, entries: [{ name: "A", value, line: 1 }] });
  });
});

describe("serializeDotenv refuses what the parser would not give back", () => {
  it.each<[string, { name: string; value: string }[], string]>([
    [
      "a duplicate name",
      [
        { name: "A", value: "1" },
        { name: "B", value: "2" },
        { name: "A", value: "1" },
      ],
      "duplicate_name",
    ],
    ["a lowercase name", [{ name: "lower", value: "1" }], "invalid_name"],
    ["an empty name", [{ name: "", value: "1" }], "invalid_name"],
    ["a name with an equals sign", [{ name: "A=B", value: "1" }], "invalid_name"],
    ["a name with a line feed", [{ name: "A\nB", value: "1" }], "invalid_name"],
    ["a reserved name", [{ name: "SECRETS_X", value: "1" }], "reserved_name"],
    ["a NUL in a value", [{ name: "A", value: "a\u0000b" }], "nul"],
    [
      "a value of 65,537 bytes",
      [{ name: "A", value: "x".repeat(LIMITS.secret.valueMaxBytes + 1) }],
      "value_too_large",
    ],
    ["a lone surrogate", [{ name: "A", value: "a\ud800b" }], "ill_formed_value"],
  ])("throws on %s", (_title, entries, rule) => {
    expect(() => serializeDotenv(entries)).toThrow(Error);
    expect(thrownMessage(entries)).toContain(rule);
  });

  it("puts no value and no rejected name in the thrown message", () => {
    const canary = "MYKEY_" + "CANARY_" + "A".repeat(32);
    const lower = canary.toLowerCase();
    const messages = [
      thrownMessage([{ name: "A", value: `${canary}\u0000` }]),
      thrownMessage([{ name: "A", value: `${canary}\ud800` }]),
      thrownMessage([{ name: "A", value: canary.repeat(2000) }]),
      thrownMessage([{ name: lower, value: canary }]),
      thrownMessage([{ name: `SECRETS_${canary}`, value: canary }]),
      thrownMessage([
        { name: "A", value: canary },
        { name: "A", value: canary },
      ]),
    ];
    for (const message of messages) {
      expect(message).not.toContain(canary);
      expect(message).not.toContain(lower);
      expect(message.length).toBeLessThan(200);
    }
  });
});
