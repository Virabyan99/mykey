import { DOTENV_RULES, LIMITS, checkSecretName, parseDotenv } from "@mykey/contracts";
import type { DotenvIssue, DotenvParseResult } from "@mykey/contracts";
import { describe, expect, it, vi } from "vitest";

const utf8 = new TextEncoder();

function bytes(...parts: (string | number[])[]): Uint8Array {
  const chunks = parts.map((part) => (typeof part === "string" ? utf8.encode(part) : part));
  return Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)));
}

function parse(input: string | Uint8Array): DotenvParseResult {
  return parseDotenv(typeof input === "string" ? utf8.encode(input) : input);
}

function accepted(input: string | Uint8Array): { name: string; value: string; line: number }[] {
  const result = parse(input);
  if (!result.ok) throw new Error(`expected acceptance, got ${JSON.stringify(result.issues)}`);
  return result.entries;
}

function values(input: string | Uint8Array): Record<string, string> {
  return Object.fromEntries(accepted(input).map((entry) => [entry.name, entry.value]));
}

function issues(input: string | Uint8Array): DotenvIssue[] {
  const result = parse(input);
  if (result.ok) throw new Error("expected a rejection");
  return result.issues;
}

describe("parseDotenv accepts format v1", () => {
  it.each<[string, string, Record<string, string>]>([
    ["a plain value", "A=1\n", { A: "1" }],
    ["an empty unquoted value", "A=\n", { A: "" }],
    ["an empty quoted value", 'A=""\n', { A: "" }],
    ["an equals sign inside the value", "A=b=c\n", { A: "b=c" }],
    ["a value that is only equals signs", "A===\n", { A: "==" }],
    ["interior spaces in an unquoted value", "A=hello world\n", { A: "hello world" }],
    ["a \\n escape as a line feed", 'A="a\\nb"\n', { A: "a\nb" }],
    ["every escape", 'A="\\\\\\"\\t\\r"\n', { A: '\\"\t\r' }],
    ["an unquoted dollar reference unchanged", "A=$HOME\n", { A: "$HOME" }],
    ["a quoted dollar-brace reference unchanged", 'A="${X}"\n', { A: "${X}" }],
    [
      "a later name referenced by an earlier one, unchanged",
      "A=${B}\nB=1\n",
      { A: "${B}", B: "1" },
    ],
    ["comment and empty lines", "# first\n\nA=1\n#B=2\n\n", { A: "1" }],
    ["a CRLF file", "A=1\r\nB=two words\r\n", { A: "1", B: "two words" }],
    ["a CRLF file with an empty value", "A=\r\nB=\r\n", { A: "", B: "" }],
    ["mixed LF and CRLF", 'A=1\r\nB=2\nC="3"\r\n', { A: "1", B: "2", C: "3" }],
    ["no trailing newline", "A=1\nB=2", { A: "1", B: "2" }],
    ["no trailing newline after a quoted value", 'A="x"', { A: "x" }],
    ["an empty file", "", {}],
    ["a file of one line feed", "\n", {}],
    ["a file of comments only", "# a\n# b", {}],
    ["a quoted Unicode value", 'A="naïve 🔑"\n', { A: "naïve 🔑" }],
    ["an unquoted Unicode value", "A=naïve 🔑\n", { A: "naïve 🔑" }],
    ["a hash inside quotes", 'A="a # b"\n', { A: "a # b" }],
    ["a single quote inside quotes", 'A="it\'s"\n', { A: "it's" }],
    ["spaces at both ends inside quotes", 'A="  x  "\n', { A: "  x  " }],
    ["a raw tab inside quotes", 'A="a\tb"\n', { A: "a\tb" }],
    ["a raw control character inside quotes", 'A="a\u0001b"\n', { A: "a\u0001b" }],
    ["a byte order mark character inside a value", 'A="a\ufeffb"\n', { A: "a\ufeffb" }],
    ["a comment that contains a quote and an equals sign", '# A="x\nB=1\n', { B: "1" }],
    ["the longest name", `${"N".repeat(128)}=1\n`, { ["N".repeat(128)]: "1" }],
  ])("%s", (_title, text, expected) => {
    expect(values(text)).toEqual(expected);
  });

  it("reports the 1-based line of every entry, in file order", () => {
    expect(accepted('# c\n\nB=2\r\nA="1"\n')).toEqual([
      { name: "B", value: "2", line: 3 },
      { name: "A", value: "1", line: 4 },
    ]);
  });

  it("accepts a value of exactly 65,536 bytes, unquoted, quoted and multi-byte", () => {
    const max = LIMITS.secret.valueMaxBytes;
    expect(values(`A=${"x".repeat(max)}\n`)).toEqual({ A: "x".repeat(max) });
    expect(values(`A="${"é".repeat(max / 2)}"\n`)).toEqual({ A: "é".repeat(max / 2) });
  });

  it("measures the value after unescaping, not the text in the file", () => {
    const max = LIMITS.secret.valueMaxBytes;
    expect(values(`A="${'\\"'.repeat(max)}"\n`)).toEqual({ A: '"'.repeat(max) });
  });

  it("accepts exactly 1,000 entries", () => {
    const lines = Array.from({ length: LIMITS.body.dotenvMaxEntries }, (_, i) => `K${i}=${i}\n`);
    expect(accepted(lines.join(""))).toHaveLength(LIMITS.body.dotenvMaxEntries);
  });

  it("accepts a file of exactly 1,048,576 bytes", () => {
    const head = "A=1\n#";
    const text = head + "c".repeat(LIMITS.body.dotenvMaxBytes - head.length);
    expect(utf8.encode(text)).toHaveLength(LIMITS.body.dotenvMaxBytes);
    expect(values(text)).toEqual({ A: "1" });
  });
});

describe("parseDotenv rejects everything else with a rule and a line", () => {
  const big = LIMITS.secret.valueMaxBytes + 1;

  it.each<[string, string | Uint8Array, DotenvIssue[]]>([
    ["a byte order mark", bytes([0xef, 0xbb, 0xbf], "A=1\n"), [{ line: 1, rule: "bom" }]],
    ["an invalid UTF-8 byte", bytes("A=1\nB=", [0xff], "\n"), [{ line: 2, rule: "invalid_utf8" }]],
    [
      "a truncated UTF-8 sequence at the end of the file",
      bytes("A=1\nB=2\nC=", [0xe2, 0x82]),
      [{ line: 3, rule: "invalid_utf8" }],
    ],
    [
      "a UTF-8 encoded surrogate",
      bytes('A="', [0xed, 0xa0, 0x80], '"\n'),
      [{ line: 1, rule: "invalid_utf8" }],
    ],
    ["a NUL in a value", "A=1\nB=a\u0000b\n", [{ line: 2, rule: "nul" }]],
    ["a NUL inside quotes", 'A="a\u0000b"\n', [{ line: 1, rule: "nul" }]],
    ["a NUL in a comment", "A=1\n\n# a\u0000\n", [{ line: 3, rule: "nul" }]],
    ["a lone CR between two entries", "A=1\rB=2\n", [{ line: 1, rule: "lone_cr" }]],
    ["a lone CR at the end of the file", "A=1\nB=2\r", [{ line: 2, rule: "lone_cr" }]],
    ["a CR before a CRLF", "A=1\r\r\n", [{ line: 1, rule: "lone_cr" }]],
    ["a raw CR inside quotes", 'A="a\rb"\n', [{ line: 1, rule: "lone_cr" }]],
    ["an export prefix", "export A=1\n", [{ line: 1, rule: "export_prefix" }]],
    ["an export prefix followed by a tab", "export\tA=1\n", [{ line: 1, rule: "export_prefix" }]],
    ["a single-quoted value", "A='x'\n", [{ line: 1, rule: "single_quote", name: "A" }]],
    [
      "a value that starts with a single quote",
      "A='\n",
      [{ line: 1, rule: "single_quote", name: "A" }],
    ],
    ["a duplicate name", "A=1\nB=2\nA=3\n", [{ line: 3, rule: "duplicate_name", name: "A" }]],
    [
      "a duplicate name with the same value",
      "A=1\nA=1\n",
      [{ line: 2, rule: "duplicate_name", name: "A" }],
    ],
    ["an unknown escape", 'A="\\q"\n', [{ line: 1, rule: "unknown_escape", name: "A" }]],
    ["an escaped dollar", 'A="\\$X"\n', [{ line: 1, rule: "unknown_escape", name: "A" }]],
    ["an escaped single quote", 'A="\\\'"\n', [{ line: 1, rule: "unknown_escape", name: "A" }]],
    ["a trailing inline comment", "A=1 # c\n", [{ line: 1, rule: "inline_comment", name: "A" }]],
    [
      "a hash inside an unquoted value",
      "A=x#y\n",
      [{ line: 1, rule: "inline_comment", name: "A" }],
    ],
    [
      "a hash as the whole unquoted value",
      "A=#\n",
      [{ line: 1, rule: "inline_comment", name: "A" }],
    ],
    [
      "a space after the equals sign",
      "A= x\n",
      [{ line: 1, rule: "unquoted_whitespace", name: "A" }],
    ],
    ["a trailing space", "A=x \n", [{ line: 1, rule: "unquoted_whitespace", name: "A" }]],
    ["a value that is one space", "A= \n", [{ line: 1, rule: "unquoted_whitespace", name: "A" }]],
    [
      "a space before a quoted value",
      'A= "x"\n',
      [{ line: 1, rule: "unquoted_whitespace", name: "A" }],
    ],
    ["a leading tab", "A=\tx\n", [{ line: 1, rule: "unquoted_whitespace", name: "A" }]],
    [
      "a leading no-break space",
      "A=\u00a0x\n",
      [{ line: 1, rule: "unquoted_whitespace", name: "A" }],
    ],
    [
      "a trailing line separator",
      "A=x\u2028\n",
      [{ line: 1, rule: "unquoted_whitespace", name: "A" }],
    ],
    [
      "a leading next-line character, which only Python strips",
      `A=${String.fromCharCode(0x85)}x\n`,
      [{ line: 1, rule: "unquoted_whitespace", name: "A" }],
    ],
    [
      "a trailing unit separator, which only Python strips",
      `A=x${String.fromCharCode(0x1f)}\n`,
      [{ line: 1, rule: "unquoted_whitespace", name: "A" }],
    ],
    [
      "a trailing byte order mark character, which only JavaScript trims",
      `A=x${String.fromCharCode(0xfeff)}\n`,
      [{ line: 1, rule: "unquoted_whitespace", name: "A" }],
    ],
    [
      "a line that holds only a no-break space",
      `${String.fromCharCode(0xa0)}\n`,
      [{ line: 1, rule: "invalid_line" }],
    ],
    [
      "a backslash in an unquoted value",
      "A=a\\b\n",
      [{ line: 1, rule: "unquoted_forbidden_character", name: "A" }],
    ],
    [
      "a tab in an unquoted value",
      "A=a\tb\n",
      [{ line: 1, rule: "unquoted_forbidden_character", name: "A" }],
    ],
    [
      "a double quote inside an unquoted value",
      'A=a"b\n',
      [{ line: 1, rule: "unquoted_forbidden_character", name: "A" }],
    ],
    [
      "a single quote inside an unquoted value",
      "A=it's\n",
      [{ line: 1, rule: "unquoted_forbidden_character", name: "A" }],
    ],
    ["an unterminated quote", 'A="x\n', [{ line: 1, rule: "unterminated_quote", name: "A" }]],
    [
      "an unterminated quote on the last line",
      'A=1\nB="',
      [{ line: 2, rule: "unterminated_quote", name: "B" }],
    ],
    [
      "a quote closed only by an escaped quote",
      'A="x\\"\n',
      [{ line: 1, rule: "unterminated_quote", name: "A" }],
    ],
    [
      "a backslash at the end of a quoted line",
      'A="x\\\n',
      [{ line: 1, rule: "unterminated_quote", name: "A" }],
    ],
    [
      "a quoted value spanning two lines",
      'A="x\ny"\nB=1\n',
      [{ line: 1, rule: "raw_newline_in_quotes", name: "A" }],
    ],
    [
      "a quoted value spanning two CRLF lines",
      'A="x\r\ny"\r\n',
      [{ line: 1, rule: "raw_newline_in_quotes", name: "A" }],
    ],
    [
      "a quoted value spanning four lines",
      'A=1\nB="x\n\n#\ny"\nC=2\n',
      [{ line: 2, rule: "raw_newline_in_quotes", name: "B" }],
    ],
    [
      "text after the closing quote",
      'A="x" y\n',
      [{ line: 1, rule: "text_after_quote", name: "A" }],
    ],
    [
      "a space after the closing quote",
      'A="x" \n',
      [{ line: 1, rule: "text_after_quote", name: "A" }],
    ],
    [
      "a comment after the closing quote",
      'A="x" # c\n',
      [{ line: 1, rule: "text_after_quote", name: "A" }],
    ],
    [
      "two quoted strings in a row",
      'A="x""y"\n',
      [{ line: 1, rule: "text_after_quote", name: "A" }],
    ],
    ["leading whitespace", " A=1\n", [{ line: 1, rule: "invalid_line" }]],
    ["a leading tab before the name", "\tA=1\n", [{ line: 1, rule: "invalid_line" }]],
    ["a space before the equals sign", "A =1\n", [{ line: 1, rule: "invalid_line" }]],
    ["a whitespace-only line", "A=1\n   \nB=2\n", [{ line: 2, rule: "invalid_line" }]],
    ["a tab-only line", "\t\n", [{ line: 1, rule: "invalid_line" }]],
    ["an indented comment", "  # c\n", [{ line: 1, rule: "invalid_line" }]],
    ["a lowercase name", "a=1\n", [{ line: 1, rule: "invalid_name" }]],
    ["a name that starts with a digit", "1A=1\n", [{ line: 1, rule: "invalid_name" }]],
    ["an empty name", "=1\n", [{ line: 1, rule: "invalid_name" }]],
    ["a name with a hyphen", "A-B=1\n", [{ line: 1, rule: "invalid_name" }]],
    ["a name of 129 characters", `${"N".repeat(129)}=1\n`, [{ line: 1, rule: "invalid_name" }]],
    ["a quoted name", '"A"=1\n', [{ line: 1, rule: "invalid_name" }]],
    ["the word export as a name", "export=1\n", [{ line: 1, rule: "invalid_name" }]],
    ["a reserved name", "SECRETS_X=1\n", [{ line: 1, rule: "reserved_name" }]],
    ["a line without an equals sign", "A=1\nJUSTTEXT\n", [{ line: 2, rule: "missing_equals" }]],
    ["an export line without an equals sign", "export A\n", [{ line: 1, rule: "missing_equals" }]],
    [
      "an unquoted value of 65,537 bytes",
      `A=${"x".repeat(big)}\n`,
      [{ line: 1, rule: "value_too_large", name: "A" }],
    ],
    [
      "a quoted value of 65,537 bytes",
      `B=1\nA="${"x".repeat(big)}"\n`,
      [{ line: 2, rule: "value_too_large", name: "A" }],
    ],
    [
      "a multi-byte value of 65,538 bytes",
      `A="${"é".repeat((big + 1) / 2)}"\n`,
      [{ line: 1, rule: "value_too_large", name: "A" }],
    ],
  ])("%s", (_title, input, expected) => {
    expect(issues(input)).toEqual(expected);
  });

  it("rejects 1,001 entries once, at the line of entry 1,001", () => {
    const count = LIMITS.body.dotenvMaxEntries + 5;
    const lines = Array.from({ length: count }, (_, i) => `K${i}=${i}\n`);
    expect(issues("# header\n" + lines.join(""))).toEqual([
      { line: LIMITS.body.dotenvMaxEntries + 2, rule: "too_many_entries" },
    ]);
  });

  it("rejects a file of 1,048,577 bytes before reading it, as line 0 (the whole file)", () => {
    const tooLarge = new Uint8Array(LIMITS.body.dotenvMaxBytes + 1).fill(0x23);
    expect(issues(tooLarge)).toEqual([{ line: 0, rule: "file_too_large" }]);
    // Not decoded: the same size full of invalid bytes gives the same single issue.
    expect(issues(new Uint8Array(LIMITS.body.dotenvMaxBytes + 1).fill(0xff))).toEqual([
      { line: 0, rule: "file_too_large" },
    ]);
  });

  it("collects every issue in line order, one per line", () => {
    const text = ["A=1", "export B=2", "c=3", "D='x'", "A=5", "E=ok", "F=a\\b", " "].join("\n");
    expect(issues(text)).toEqual([
      { line: 2, rule: "export_prefix" },
      { line: 3, rule: "invalid_name" },
      { line: 4, rule: "single_quote", name: "D" },
      { line: 5, rule: "duplicate_name", name: "A" },
      { line: 7, rule: "unquoted_forbidden_character", name: "F" },
      { line: 8, rule: "invalid_line" },
    ]);
  });

  it("keeps parsing the other lines of a file that has invalid UTF-8 or a byte order mark", () => {
    expect(issues(bytes([0xef, 0xbb, 0xbf], "a=1\nB=", [0xc0], "\nc=1\nD=1\n"))).toEqual([
      { line: 1, rule: "bom" },
      { line: 2, rule: "invalid_utf8" },
      { line: 3, rule: "invalid_name" },
    ]);
  });

  it("treats U+FEFF at the start of a later line as a character, with or without invalid UTF-8", () => {
    const markLine = [0xef, 0xbb, 0xbf];
    expect(issues(bytes("A=1\n", markLine, "B=2\n"))).toEqual([{ line: 2, rule: "invalid_line" }]);
    expect(issues(bytes("A=", [0xff], "\n", markLine, "B=2\nC=3\n"))).toEqual([
      { line: 1, rule: "invalid_utf8" },
      { line: 2, rule: "invalid_line" },
    ]);
  });

  it("names a duplicate before any problem with its value", () => {
    expect(issues("A=1\nA='x'\n")).toEqual([{ line: 2, rule: "duplicate_name", name: "A" }]);
  });

  it("counts a name as seen even when its first line was rejected", () => {
    expect(issues("A='x'\nA=1\n")).toEqual([
      { line: 1, rule: "single_quote", name: "A" },
      { line: 2, rule: "duplicate_name", name: "A" },
    ]);
  });

  it("stops at 100 issues", () => {
    const text = Array.from({ length: 150 }, () => "bad line").join("\n");
    const found = issues(text);
    expect(found).toHaveLength(100);
    expect(found[99]).toEqual({ line: 100, rule: "missing_equals" });
  });

  it("does not decode the rest of a file once it has 100 issues", () => {
    // 20,000 lines that are each invalid UTF-8: a failed decode is expensive,
    // so a hostile file must not buy one for every line.
    const lineCount = 20_000;
    const hostile = new Uint8Array(lineCount * 2);
    for (let index = 0; index < lineCount; index += 1) {
      hostile[2 * index] = 0xff;
      hostile[2 * index + 1] = 0x0a;
    }
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const found = issues(hostile);
      expect(found).toHaveLength(100);
      expect(found[99]).toEqual({ line: 100, rule: "invalid_utf8" });
      expect(decode.mock.calls.length).toBeLessThan(500);
    } finally {
      decode.mockRestore();
    }
  });

  it("uses only declared rules", () => {
    expect(DOTENV_RULES).toHaveLength(21);
    expect(new Set(DOTENV_RULES).size).toBe(21);
  });
});

describe("no issue leaks input", () => {
  // Assembled at run time: the literal must never appear in the repository.
  const canary = "MYKEY_" + "CANARY_" + "A".repeat(32);
  const lower = canary.toLowerCase();

  const text = [
    `GOOD=${canary}`,
    `bad_${lower}=1`,
    lower,
    `SECRETS_${canary}=1`,
    `B='${canary}'`,
    `C="${canary}\\q"`,
    `D=${canary} # ${canary}`,
    `export F=${canary}`,
    ` G=${canary}`,
    `H =${canary}`,
    `GOOD=${canary}`,
    `I="${canary}" ${canary}`,
    `J=${canary}\\${canary}`,
    `K=${canary}\u0000`,
    `L=${canary}\r${canary}`,
    `${canary} ${lower}`,
    `M="${canary}`,
  ].join("\n");

  it("returns rules, lines and validated names only", () => {
    const result = parse(text);
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(lower);
    expect(serialized.toLowerCase()).not.toContain("canary");
    if (result.ok) return;
    expect(result.issues).toHaveLength(16);
    for (const issue of result.issues) {
      expect(Object.keys(issue).every((key) => ["line", "rule", "name"].includes(key))).toBe(true);
      if (issue.name !== undefined) expect(checkSecretName(issue.name).ok).toBe(true);
    }
    expect(result.issues.flatMap((issue) => issue.name ?? []).sort()).toEqual(
      ["B", "C", "D", "GOOD", "I", "J", "M"].sort(),
    );
  });

  it("does not echo an invalid name, a reserved name or an exported name", () => {
    expect(issues("lowercase_name=1\nSECRETS_HIDDEN=1\nexport EXPORTED=1\n")).toEqual([
      { line: 1, rule: "invalid_name" },
      { line: 2, rule: "reserved_name" },
      { line: 3, rule: "export_prefix" },
    ]);
  });

  it("does not echo values of accepted lines when the file is rejected", () => {
    const result = parse(`A=${canary}\nb=1\n`);
    expect(result).toEqual({ ok: false, issues: [{ line: 2, rule: "invalid_name" }] });
  });
});
