// Run 3.1 Task C: the one place a JSON body is parsed. Duplicate keys and
// excessive depth are refused by a scanning pass before JSON.parse.
import { describe, expect, it } from "vitest";
import { parseStrictJson } from "@mykey/api";

const ok = (text: string) => parseStrictJson(text, 16);

describe("parseStrictJson", () => {
  it("parses ordinary JSON", () => {
    expect(ok('{"a":[1,{"b":"c"}],"d":null}')).toEqual({
      ok: true,
      value: { a: [1, { b: "c" }], d: null },
    });
  });

  it.each([
    ['{"a":1,"a":2}'],
    ['{"x":{"a":1,"b":{},"a":2}}'],
    ['[{"a":1},{"b":1,"b":2}]'],
    // The same key after unescaping.
    ['{"a":1,"\\u0061":2}'],
  ])("refuses a duplicate key: %s", (text) => {
    expect(ok(text)).toEqual({ ok: false });
  });

  it("does not take a key inside a string for a key", () => {
    expect(ok('{"a":"\\"a\\":1","b":"{\\"a\\":"}')).toMatchObject({ ok: true });
  });

  it("allows equal keys in sibling objects", () => {
    expect(ok('[{"a":1},{"a":2}]')).toMatchObject({ ok: true });
  });

  it("counts depth by containers: 16 accepted, 17 refused", () => {
    const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    expect(ok(nested(16))).toMatchObject({ ok: true });
    expect(ok(nested(17))).toEqual({ ok: false });
    expect(ok(`{"a":${nested(15)}}`)).toMatchObject({ ok: true });
    expect(ok(`{"a":${nested(16)}}`)).toEqual({ ok: false });
  });

  it.each([[""], ["{"], ["{'a':1}"], ['{"a":1}x'], ["NaN"]])("refuses invalid JSON: %s", (text) => {
    expect(ok(text)).toEqual({ ok: false });
  });
});
