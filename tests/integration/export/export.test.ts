// export.create (Run 4.9 Task A, P-79, FR-1.37): the environment as a dotenv
// attachment, read completely under the lock (Run 4.8), audited before the
// bytes leave. Values are synthetic with a run-time canary; assertions
// compare digests, lengths and booleans.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseDotenv } from "@mykey/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  idleAdvisoryLocks,
  sha256,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import type { FixtureUser } from "../../harness/tenants.ts";

let f: SecretsFixture;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  expect(await idleAdvisoryLocks(f)).toBe(0);
});

const unique = (prefix = "E"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const valueOf = (label: string): string => `${mark}-${label}-${randomUUID()}`;
const bytewise = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

interface Exported {
  status: number;
  headers: Headers;
  bytes: Buffer;
  code: string | undefined;
  requestId: string | null;
}

/** Every session of the test database becomes freshly verified (the sensitive start, FR-1.77). */
async function freshen(): Promise<void> {
  await f.api.superuser.query("UPDATE auth.session SET totp_verified_at = now()");
}

async function exportOf(
  env: EnvName,
  opts: {
    user?: FixtureUser;
    body?: unknown;
    headers?: Record<string, string>;
    fresh?: boolean;
  } = {},
): Promise<Exported> {
  if (opts.fresh !== false) await freshen();
  const response = await f.api.request("POST", `${f.env(env).path}/export`, {
    cookie: await f.tenants.cookie(opts.user ?? "ownerA"),
    body: opts.body ?? { confirmed: true },
    headers: opts.headers ?? {},
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const isJson = response.headers.get("content-type")?.startsWith("application/json") === true;
  const code = isJson
    ? (JSON.parse(bytes.toString("utf8")) as { error?: { code?: string } }).error?.code
    : undefined;
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    code,
    requestId: response.headers.get("x-request-id"),
  };
}

async function created(env: EnvName, name: string, value: string): Promise<void> {
  expect((await f.create(env, name, value)).status).toBe(201);
}

async function exportRows(requestId: string | null): Promise<number> {
  const result = await f.api.superuser.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit.event WHERE action = 'secret.export' AND request_id = $1",
    [requestId],
  );
  return result.rows[0]?.count ?? 0;
}

const warningsOf = (headers: Headers): unknown =>
  JSON.parse(Buffer.from(headers.get("mykey-export-warnings") ?? "", "base64url").toString("utf8"));

describe("export.create", () => {
  it("an empty environment → 200, length 0", async () => {
    const answer = await exportOf("env2a");
    expect(answer.status).toBe(200);
    expect(answer.bytes.length).toBe(0);
    expect(answer.headers.get("content-length")).toBe("0");
  });

  it("200 with exactly the headers of P-79; content-length equals the body; content-digest verifies; no content-encoding even when the request accepts gzip", async () => {
    await created("env1a", unique(), valueOf("headers"));
    const answer = await exportOf("env1a", { headers: { "accept-encoding": "gzip, br" } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const name = (
      await f.api.superuser.query<{ name: string }>(
        "SELECT name FROM app.environment WHERE id = $1",
        [f.env("env1a").environmentId],
      )
    ).rows[0]?.name;
    const safe = (name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    expect(answer.headers.get("content-disposition")).toBe(
      `attachment; filename="mykey-${safe}.env"`,
    );
    expect(answer.headers.get("content-length")).toBe(String(answer.bytes.length));
    expect(answer.headers.get("content-digest")).toBe(
      `sha-256=:${createHash("sha256").update(answer.bytes).digest("base64")}:`,
    );
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("content-encoding")).toBeNull();
    expect(Array.isArray(warningsOf(answer.headers))).toBe(true);
  });

  it("the body parses to the environment's names with equal digests, in bytewise order", async () => {
    const prefix = unique("P");
    const values = new Map([
      [`${prefix}_Z`, valueOf("z")],
      [`${prefix}1`, valueOf("one")],
      [`${prefix}_A`, `${valueOf("a")}\nsecond line\t"quoted"`],
    ]);
    for (const [name, value] of values) await created("env1b", name, value);
    const answer = await exportOf("env1b");
    expect(answer.status).toBe(200);
    const parsed = parseDotenv(answer.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const names = parsed.entries.map((entry) => entry.name);
    expect(names).toEqual([...names].sort(bytewise));
    const mine = parsed.entries.filter((entry) => entry.name.startsWith(prefix));
    expect(mine.map((entry) => entry.name)).toEqual([...values.keys()].sort(bytewise));
    for (const entry of mine)
      expect(sha256(entry.value)).toBe(sha256(values.get(entry.name) ?? ""));
  });

  it("the audit row secret.export is committed when the answer arrives", async () => {
    await created("env1b", unique(), valueOf("audited"));
    const answer = await exportOf("env1b");
    expect(answer.status).toBe(200);
    expect(await exportRows(answer.requestId)).toBe(1);
  });

  it("without a fresh TOTP → 403 fresh_verification_required; confirmed missing → 422", async () => {
    await f.api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '11 minutes'",
    );
    const stale = await exportOf("env1b", { fresh: false });
    expect(stale.status).toBe(403);
    expect(stale.code).toBe("fresh_verification_required");
    expect(await exportRows(stale.requestId)).toBe(0);
    const missing = await exportOf("env1b", { body: {} });
    expect(missing.status).toBe(422);
    expect(await exportRows(missing.requestId)).toBe(0);
  });

  it("audit cannot be written → 503 as JSON, and the body does not contain the canary", async () => {
    await created("env1a", unique(), valueOf("audit"));
    await f.api.superuser.query("REVOKE INSERT ON audit.event FROM api_runtime");
    try {
      const answer = await exportOf("env1a");
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("audit_unavailable");
      expect(answer.headers.get("content-type")?.startsWith("application/json")).toBe(true);
      expect(answer.bytes.toString("utf8").includes(mark)).toBe(false);
    } finally {
      await f.api.superuser.query("GRANT INSERT ON audit.event TO api_runtime");
    }
  });

  it("a key in review → 409 key_under_review as JSON", async () => {
    const name = unique("R");
    await f.seedIndex("env1a", [name], "needs_review");
    try {
      const answer = await exportOf("env1a");
      expect(answer.status).toBe(409);
      expect(answer.code).toBe("key_under_review");
      expect(answer.bytes.toString("utf8").includes(mark)).toBe(false);
    } finally {
      await f.unseedIndex("env1a", [name]);
    }
  });

  it("the @next/env case of the dotenv tests appears in mykey-export-warnings by name", async () => {
    // A value ending in a backslash, then a value starting with `#`: @next/env loses the second.
    const prefix = unique("W");
    const lost = `${prefix}_B`;
    await created("env1b", `${prefix}_A`, `${valueOf("tail")}\\`);
    await created("env1b", lost, `# ${valueOf("lost")}`);
    const answer = await exportOf("env1b");
    expect(answer.status).toBe(200);
    expect(warningsOf(answer.headers)).toEqual(
      expect.arrayContaining([{ name: lost, loader: "nextjs", kind: "escape" }]),
    );
  });

  it("roles per decide with controls; a denied export leaves no secret.export", async () => {
    const expected: [FixtureUser, EnvName, number][] = [
      ["ownerA", "env1a", 200],
      ["adminA", "env1a", 200],
      ["editorA", "env1a", 200],
      ["readerA", "env1a", 200],
      ["envEditorA", "env1a", 200],
      ["envEditorA", "env1b", 404],
      ["ungrantedA", "env1a", 404],
      ["ownerB", "env1a", 404],
    ];
    for (const [user, env, status] of expected) {
      const answer = await exportOf(env, { user });
      expect(answer.status, `${user} ${env}`).toBe(status);
      expect(await exportRows(answer.requestId), `${user} ${env}`).toBe(status === 200 ? 1 : 0);
    }
  });

  it("an 8 MiB environment exports", async () => {
    await f.seedEnvironment("env2a", 1000, 8388);
    const started = performance.now();
    const answer = await exportOf("env2a");
    const seconds = (performance.now() - started) / 1000;
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-digest")).toBe(
      `sha-256=:${createHash("sha256").update(answer.bytes).digest("base64")}:`,
    );
    // Above the parser's 1 MiB: one line per name, each `SEED_nnnn="<8,388 bytes>"`.
    const lines = answer.bytes
      .toString("utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines.length).toBe(1000);
    expect(lines.every((line) => /^SEED_\d{4}="[0-9a-f]{8388}"$/.test(line))).toBe(true);
    expect(answer.bytes.length).toBeGreaterThan(8_388_000);
    console.log(`export of 1,000 names of 8,388 bytes: ${seconds.toFixed(2)} s`);
    await expectIndexMatchesBackend(f, "env2a");
  }, 300_000);
});
