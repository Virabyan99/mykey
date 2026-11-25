// Run 5.5 Task A (P-96, FR-1.49, Review focus 4): a response is used only when
// it is provably the complete set the API sent. Each check fails on its own.
import { API_MAJOR } from "@mykey/contracts";
import { CliError, validateExchange, validateKeys, validateResolve } from "@mykey/cli";
import { describe, expect, it } from "vitest";

const ENVIRONMENT = "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f";
const resolveBody = {
  apiMajor: API_MAJOR,
  environmentId: ENVIRONMENT,
  generation: "4",
  count: 2,
  entries: [
    { name: "A", value: "synthetic-a" },
    { name: "B", value: "synthetic-b" },
  ],
  complete: true,
};
const keysBody = {
  apiMajor: API_MAJOR,
  environmentId: ENVIRONMENT,
  generation: "4",
  count: 2,
  names: ["A", "B"],
  complete: true,
};

type Head = Parameters<typeof validateResolve>[1];
const headOf = (raw: Buffer, over: Partial<Head> = {}): Head => ({
  status: 200,
  contentLength: String(raw.length),
  contentType: "application/json; charset=utf-8",
  contentEncoding: undefined,
  ...over,
});
const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");

function malformed(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).category).toBe("malformed");
    expect((error as CliError).message.includes("synthetic")).toBe(false);
    return;
  }
  throw new Error("accepted");
}

describe("validateResolve", () => {
  it("passes a good body", () => {
    const raw = bytes(resolveBody);
    expect(validateResolve(raw, headOf(raw))).toEqual(resolveBody);
  });

  it("fails each check on its own", () => {
    const raw = bytes(resolveBody);
    malformed(() => validateResolve(raw, headOf(raw, { status: 201 })));
    malformed(() => validateResolve(raw, headOf(raw, { contentType: "text/html" })));
    malformed(() => validateResolve(raw, headOf(raw, { contentType: undefined })));
    malformed(() => validateResolve(raw, headOf(raw, { contentEncoding: "gzip" })));
    malformed(() => validateResolve(raw, headOf(raw, { contentLength: undefined })));
    malformed(() => validateResolve(raw, headOf(raw, { contentLength: String(raw.length + 1) })));
    malformed(() => validateResolve(raw, headOf(raw, { contentLength: "12abc" })));

    // Cut at a JSON boundary: what is left still parses, and the length says more.
    const whole = bytes({ ...resolveBody, entries: [resolveBody.entries[0]] });
    const cut = Buffer.from(JSON.stringify({ apiMajor: API_MAJOR }), "utf8");
    malformed(() => validateResolve(cut, headOf(cut, { contentLength: String(whole.length) })));

    const variants: unknown[] = [
      { ...resolveBody, count: 3 },
      { ...resolveBody, complete: false },
      Object.fromEntries(Object.entries(resolveBody).filter(([key]) => key !== "complete")),
      { ...resolveBody, entries: [resolveBody.entries[0], resolveBody.entries[0]] },
      { ...resolveBody, count: 2, entries: [{ name: "A" }, resolveBody.entries[1]] },
      { ...resolveBody, extra: true },
      { ...resolveBody, apiMajor: API_MAJOR + 1 },
      {
        ...resolveBody,
        entries: [{ name: "lower", value: "synthetic-x" }, resolveBody.entries[1]],
      },
      {
        ...resolveBody,
        entries: [{ name: "SECRETS_X", value: "synthetic-x" }, resolveBody.entries[1]],
      },
      { ...resolveBody, generation: 4 },
    ];
    for (const variant of variants) {
      const body = bytes(variant);
      malformed(() => validateResolve(body, headOf(body)));
    }
    const notJson = Buffer.from("<html>synthetic</html>", "utf8");
    malformed(() => validateResolve(notJson, headOf(notJson)));
  });
});

describe("validateKeys", () => {
  it("passes a good body and fails each check on its own", () => {
    const raw = bytes(keysBody);
    expect(validateKeys(raw, headOf(raw))).toEqual(keysBody);
    malformed(() => validateKeys(raw, headOf(raw, { contentEncoding: "br" })));
    malformed(() => validateKeys(raw, headOf(raw, { contentLength: String(raw.length - 1) })));
    for (const variant of [
      { ...keysBody, count: 3 },
      { ...keysBody, names: ["A", "A"] },
      { ...keysBody, names: ["a", "B"] },
      { ...keysBody, complete: false },
      { ...keysBody, entries: [] },
      { ...keysBody, apiMajor: API_MAJOR + 1 },
    ]) {
      const body = bytes(variant);
      malformed(() => validateKeys(body, headOf(body)));
    }
  });
});

// Run 11.4 (Session 11, P-187): the answer of an exchange. Its token goes into
// the next request's Authorization header, so it must have a token's shape.
describe("validateExchange", () => {
  const exchangeBody = {
    apiMajor: API_MAJOR,
    // Assembled at run time: a literal of a token's shape reads as a key to the secret scan.
    token: `s.${Buffer.from("synthetic-token").toString("base64url")}`,
    expiresAt: "2026-11-26T00:15:00.000Z",
    projectId: ENVIRONMENT,
    environmentName: "dev",
  };

  it("passes a good body", () => {
    const raw = bytes(exchangeBody);
    expect(validateExchange(raw, headOf(raw))).toEqual(exchangeBody);
  });

  it("fails each check on its own, and no message repeats the token", () => {
    const raw = bytes(exchangeBody);
    malformed(() => validateExchange(raw, headOf(raw, { status: 201 })));
    malformed(() => validateExchange(raw, headOf(raw, { contentType: "text/html" })));
    malformed(() => validateExchange(raw, headOf(raw, { contentEncoding: "gzip" })));
    malformed(() => validateExchange(raw, headOf(raw, { contentLength: String(raw.length + 1) })));
    const without = (key: string): Record<string, unknown> =>
      Object.fromEntries(Object.entries(exchangeBody).filter(([name]) => name !== key));
    for (const variant of [
      without("token"),
      without("expiresAt"),
      { ...exchangeBody, token: "" },
      { ...exchangeBody, token: "s.abc def" },
      { ...exchangeBody, token: "s.abc\r\nx-injected: 1" },
      { ...exchangeBody, token: "s.".padEnd(4097, "a") },
      { ...exchangeBody, token: 7 },
      { ...exchangeBody, expiresAt: "soon" },
      { ...exchangeBody, apiMajor: API_MAJOR + 1 },
      { ...exchangeBody, extra: true },
    ]) {
      const body = bytes(variant);
      try {
        validateExchange(body, headOf(body));
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).category).toBe("malformed");
        expect((error as CliError).message.includes("s.")).toBe(false);
        continue;
      }
      throw new Error("accepted");
    }
  });
});
