// Run 5.5 Task A (P-96, FR-1.46): exactly one credential source; the token is
// checked for shape before anything is sent; no error repeats it.
import { Readable } from "node:stream";
import { LIMITS } from "@mykey/contracts";
import { CliError, readToken } from "@mykey/cli";
import { describe, expect, it } from "vitest";

const TOKEN = ["s", ".", "synthetic", "TokenValue_0123-xyz"].join("");
const stdinOf = (text: string): Readable => Readable.from([Buffer.from(text, "utf8")]);
const empty = (): Readable => Readable.from([]);

async function usage(run: () => Promise<string>, secret = TOKEN): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).category).toBe("usage");
    expect((error as CliError).message.includes(secret)).toBe(false);
    return;
  }
  throw new Error("accepted");
}

describe("readToken", () => {
  it("reads the variable, or the whole of stdin with one line ending dropped", async () => {
    expect((await readToken({ SECRETS_MACHINE_TOKEN: TOKEN }, false, empty())) === TOKEN).toBe(
      true,
    );
    for (const text of [TOKEN, `${TOKEN}\n`, `${TOKEN}\r\n`]) {
      expect((await readToken({}, true, stdinOf(text))) === TOKEN).toBe(true);
    }
  });

  it("destroys stdin after reading it", async () => {
    const stdin = stdinOf(`${TOKEN}\n`);
    await readToken({}, true, stdin);
    expect(stdin.destroyed).toBe(true);
  });

  it("refuses no source, two sources, and a token of the wrong shape", async () => {
    await usage(() => readToken({}, false, empty()));
    await usage(() => readToken({ SECRETS_MACHINE_TOKEN: TOKEN }, true, stdinOf(TOKEN)));
    await usage(() => readToken({ SECRETS_MACHINE_TOKEN: "" }, false, empty()));
    await usage(() => readToken({}, true, stdinOf("")));
    await usage(() => readToken({}, true, stdinOf(`${TOKEN}\n\n`)));
    await usage(() => readToken({}, true, stdinOf(`${TOKEN} x`)), `${TOKEN} x`);
    await usage(() => readToken({ SECRETS_MACHINE_TOKEN: `${TOKEN}\u0007` }, false, empty()));
    const long = "a".repeat(LIMITS.body.bearerMaxBytes + 1);
    await usage(() => readToken({ SECRETS_MACHINE_TOKEN: long }, false, empty()), long);
    await usage(() => readToken({}, true, stdinOf(long)), long);
    const most = "a".repeat(LIMITS.body.bearerMaxBytes);
    expect((await readToken({ SECRETS_MACHINE_TOKEN: most }, false, empty())).length).toBe(
      LIMITS.body.bearerMaxBytes,
    );
  });
});
