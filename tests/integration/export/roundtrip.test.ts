// The round trip (Run 4.9 Task B, AC-1.17): an environment of awkward values
// → export → preview and apply into an empty environment → export again. The
// two files are byte-identical. Values are synthetic; digests are compared.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function exportOf(env: EnvName): Promise<{ status: number; bytes: Buffer }> {
  await f.api.superuser.query("UPDATE auth.session SET totp_verified_at = now()");
  const response = await f.api.request("POST", `${f.env(env).path}/export`, {
    cookie: await f.tenants.cookie("ownerA"),
    body: { confirmed: true },
  });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

const AWKWARD: Record<string, string> = {
  RT_EMPTY: "",
  RT_MULTILINE: "line one\nline two\r\nline three\n",
  RT_DOUBLE: 'say "hello" and "bye"',
  RT_SINGLE: "it's 'quoted' too",
  RT_DOLLAR: "$HOME ${PATH} $ $$",
  RT_HASH: "# not a comment # either",
  RT_EQUALS: "a=b==c=",
  RT_BACKSLASH: "C:\\path\\to\\file \\n is not a newline \\",
  RT_SPACES: "   leading and trailing   ",
  RT_TABS: "\ta\tb\t",
  RT_FOUR_BYTE: "😀 𝄞 four-byte characters",
  RT_LARGEST: "x".repeat(65_536),
};

describe("export → import → export", () => {
  it("the two files are byte-identical and every name is created", async () => {
    for (const [name, value] of Object.entries(AWKWARD)) {
      const answer = await f.create("env1a", name, value);
      expect(answer.status, name).toBe(201);
    }
    const first = await exportOf("env1a");
    expect(first.status).toBe(200);

    const preview = await f.send("POST", `${f.env("env2a").path}/import/preview`, {
      text: first.bytes,
      key: null,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.applicable).toBe(true);
    expect(preview.body.issues).toEqual([]);
    const applied = await f.send(
      "POST",
      `${f.env("env2a").path}/import/${preview.body.previewId as string}/apply`,
      { text: first.bytes },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.state).toBe("succeeded");
    const outcomes = (applied.body.result as { entries: { name: string; outcome: string }[] })
      .entries;
    expect(outcomes.map((entry) => entry.name).sort()).toEqual(Object.keys(AWKWARD).sort());
    expect(outcomes.every((entry) => entry.outcome === "created")).toBe(true);

    const second = await exportOf("env2a");
    expect(second.status).toBe(200);
    expect(second.bytes.length).toBe(first.bytes.length);
    expect(digest(second.bytes)).toBe(digest(first.bytes));
    await expectIndexMatchesBackend(f, "env2a");
  }, 300_000);

  it("an export above 1 MiB is refused by the import body limit (the known limit)", async () => {
    await f.seedEnvironment("env1b", 200, 8192);
    const big = await exportOf("env1b");
    expect(big.status).toBe(200);
    expect(big.bytes.length).toBeGreaterThan(1024 * 1024);
    const preview = await f.send("POST", `${f.env("env2a").path}/import/preview`, {
      text: big.bytes,
      key: null,
    });
    expect(preview.status).toBe(400);
    expect(preview.code).toBe("malformed_request");
  }, 300_000);
});
