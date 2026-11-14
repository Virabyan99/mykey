// import.preview (Run 4.7 Task A, P-76, FR-1.35): the file is parsed, every
// entry classified against the index under the environment's lock, values
// compared in memory only. What is stored is names, lines, classifications,
// versions and tags; nothing is written to the backend. Values are synthetic
// and carry a run-time canary; assertions compare digests, counts and booleans.
import { randomBytes, randomUUID } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import { sweepStaleOperations } from "@mykey/operations";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  idleAdvisoryLocks,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import { readAuditLog } from "../../harness/stack.ts";
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
  f.setFaults(null);
  f.setBao("relay");
  expect(await idleAdvisoryLocks(f)).toBe(0);
});

const unique = (prefix = "I"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const valueOf = (label: string): string => `${mark}-${label}-${randomUUID()}`;
const fileOf = (...entries: [string, string][]): string =>
  entries.map(([name, value]) => `${name}=${value}\n`).join("");

function preview(env: EnvName, text: string | Uint8Array, user: FixtureUser = "ownerA") {
  return f.send("POST", `${f.env(env).path}/import/preview`, { text, user, key: null });
}

async function created(env: EnvName, name: string, value: string) {
  const answer = await f.create(env, name, value);
  expect(answer.status).toBe(201);
  return answer.body.result as { version: number; stateTag: string };
}

async function previewRows(env: EnvName): Promise<number> {
  const result = await f.api.superuser.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM app.import_preview WHERE environment_id = $1",
    [f.env(env).environmentId],
  );
  return result.rows[0]?.count ?? 0;
}

/** Requests in OpenBao's audit device that change KV (any operation id). */
/** KV changes in A's namespace: other files write to the shared stack meanwhile. */
async function kvChanges(): Promise<number> {
  return (await readAuditLog(f.stack)).filter(
    (entry) =>
      entry.type === "request" &&
      entry.namespacePath.startsWith(f.fx.namespace) &&
      /^kv\/(data|delete|undelete)\//.test(entry.path) &&
      (entry.operation === "create" || entry.operation === "update"),
  ).length;
}

const counts = (answer: Answer) => answer.body.counts as Record<string, number>;
const entries = (answer: Answer) =>
  answer.body.entries as {
    ordinal: number;
    line: number;
    name: string | null;
    classification: string;
  }[];

describe("import.preview", () => {
  it("one new, one changed, one equal name → create, update, unchanged; counts; a previewId; expiresAt 900 s ahead on database time", async () => {
    const [fresh, changed, equal] = [unique(), unique(), unique()];
    const same = valueOf("equal");
    await created("env1a", changed, valueOf("old"));
    await created("env1a", equal, same);
    const answer = await preview(
      "env1a",
      fileOf([fresh, valueOf("new")], [changed, valueOf("changed")], [equal, same]),
    );
    expect(answer.status).toBe(200);
    expect(answer.body.applicable).toBe(true);
    expect(counts(answer)).toEqual({
      create: 1,
      update: 1,
      unchanged: 1,
      conflict: 0,
      invalid: 0,
      duplicate: 0,
    });
    expect(entries(answer)).toEqual([
      { ordinal: 1, line: 1, name: fresh, classification: "create" },
      { ordinal: 2, line: 2, name: changed, classification: "update" },
      { ordinal: 3, line: 3, name: equal, classification: "unchanged" },
    ]);
    expect(answer.body.previewId).toMatch(/^[0-9a-f-]{36}$/);
    const ahead = await f.api.superuser.query<{ seconds: number }>(
      "SELECT extract(epoch FROM ($1::timestamptz - now()))::float8 AS seconds",
      [answer.body.expiresAt],
    );
    const seconds = ahead.rows[0]?.seconds ?? 0;
    expect(seconds).toBeGreaterThan(LIMITS.importPreview.ttlSeconds - 10);
    expect(seconds).toBeLessThanOrEqual(LIMITS.importPreview.ttlSeconds);
    const audit = await f.api.superuser.query<{ details: unknown; outcome: string }>(
      "SELECT details, outcome FROM audit.event WHERE action = 'import.preview' AND request_id = $1",
      [answer.headers.get("x-request-id")],
    );
    expect(audit.rows).toEqual([{ details: { entries: 3 }, outcome: "success" }]);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("nothing is written: no audited change, index unchanged", async () => {
    const name = unique();
    await created("env1a", name, valueOf("kept"));
    const before = {
      row: await f.indexRow("env1a", name),
      backend: await f.backend("env1a", name),
      changes: await kvChanges(),
    };
    const answer = await preview(
      "env1a",
      fileOf([name, valueOf("other")], [unique(), valueOf("new")]),
    );
    expect(answer.status).toBe(200);
    expect(await f.indexRow("env1a", name)).toEqual(before.row);
    expect(await f.backend("env1a", name)).toEqual(before.backend);
    expect(await kvChanges()).toBe(before.changes);
    const secretRows = await f.api.superuser.query(
      "SELECT 1 FROM audit.event WHERE action LIKE 'secret.%' AND request_id = $1",
      [answer.headers.get("x-request-id")],
    );
    expect(secretRows.rowCount).toBe(0);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("the stored row, the response, the API log and audit.event do not contain the run-time canary the values carry", async () => {
    const name = unique();
    await created("env1b", name, valueOf("stored"));
    const answer = await preview(
      "env1b",
      fileOf([name, valueOf("next")], [unique(), valueOf("new")]),
    );
    expect(answer.status).toBe(200);
    expect(answer.text.includes(mark)).toBe(false);
    const stored = await f.api.superuser.query<{ row: string }>(
      "SELECT row_to_json(p)::text AS row FROM app.import_preview p WHERE id = $1",
      [answer.body.previewId],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]?.row.includes(mark)).toBe(false);
    expect(JSON.stringify(f.api.logs).includes(mark)).toBe(false);
    const audit = await f.api.superuser.query<{ text: string }>(
      "SELECT coalesce(string_agg(row_to_json(e)::text, ''), '') AS text FROM audit.event e",
    );
    expect(audit.rows[0]?.text.includes(mark)).toBe(false);
  });

  it("an unterminated quote → 200, applicable false, the issue with its line, previewId null, no row", async () => {
    const before = await previewRows("env1a");
    const answer = await preview("env1a", `${unique()}=ok\n${unique()}="open\n`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ applicable: false, previewId: null, expiresAt: null });
    expect(answer.body.issues).toEqual([{ line: 2, rule: "unterminated_quote" }]);
    expect(entries(answer)).toEqual([]);
    expect(await previewRows("env1a")).toBe(before);
  });

  it("an invalid name, a reserved prefix, a duplicate, a 65,537-byte value → applicable false, no row, and the invalid name is not in the response", async () => {
    const invalid = `bad-${randomBytes(4).toString("hex")}`;
    const twice = unique();
    const files: [string, string][] = [
      [`${invalid}=1\n`, "invalid_name"],
      [
        `${LIMITS.secret.reservedPrefix}${randomBytes(3).toString("hex").toUpperCase()}=1\n`,
        "reserved_name",
      ],
      [`${twice}=1\n${twice}=2\n`, "duplicate_name"],
      [`${unique()}=${"a".repeat(LIMITS.secret.valueMaxBytes + 1)}\n`, "value_too_large"],
    ];
    const before = await previewRows("env1a");
    for (const [text, rule] of files) {
      const answer = await preview("env1a", text);
      expect(answer.status, rule).toBe(200);
      expect(answer.body.applicable, rule).toBe(false);
      expect(answer.body.previewId, rule).toBeNull();
      expect(
        (answer.body.issues as { rule: string }[]).map((issue) => issue.rule),
        rule,
      ).toEqual([rule]);
      expect(answer.text.includes(invalid), rule).toBe(false);
    }
    expect(await previewRows("env1a")).toBe(before);
  });

  it("an empty file → applicable false", async () => {
    const before = await previewRows("env1a");
    const answer = await preview("env1a", "# only a comment\n");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ applicable: false, previewId: null, entries: [] });
    expect(await previewRows("env1a")).toBe(before);
  });

  it("a deleted name → conflict and still applicable", async () => {
    const name = unique();
    const current = await created("env1a", name, valueOf("gone"));
    expect((await f.act("env1a", name, "delete", current)).status).toBe(200);
    const answer = await preview(
      "env1a",
      fileOf([name, valueOf("back")], [unique(), valueOf("new")]),
    );
    expect(answer.status).toBe(200);
    expect(answer.body.applicable).toBe(true);
    expect(entries(answer).map((entry) => entry.classification)).toEqual(["conflict", "create"]);
    expect(answer.body.previewId).not.toBeNull();
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("projected names 1,001 → 507 { limit: names }; projected bytes above 8 MiB → 507 { limit: bytes }", async () => {
    const { environmentId } = f.env("env2a");
    const db = f.api.superuser;
    const filler = "PFILL_";
    await db.query(
      `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version,
         state_tag, state, live_value_bytes, last_changed_at)
       SELECT $1, $2 || lpad(n::text, 4, '0'), $3, 1, md5(n::text), 'deleted', 0, now()
         FROM generate_series(1, 999) AS n`,
      [environmentId, filler, f.tenants.a.organizationId],
    );
    try {
      const names = await preview("env2a", fileOf([unique(), "a"], [unique(), "b"]));
      expect(names.status).toBe(507);
      expect(names.code).toBe("capacity_exceeded");
      expect(names.details).toEqual({ limit: "names" });
      const one = await preview("env2a", fileOf([unique(), "a"]));
      expect(one.status).toBe(200);
    } finally {
      await db.query(
        "DELETE FROM app.secret_index WHERE environment_id = $1 AND name LIKE $2 || '%'",
        [environmentId, filler],
      );
    }
    const live = await db.query<{ live_value_bytes: string }>(
      "SELECT live_value_bytes FROM app.environment WHERE id = $1",
      [environmentId],
    );
    const actual = live.rows[0]?.live_value_bytes ?? "0";
    await db.query("UPDATE app.environment SET live_value_bytes = $2 WHERE id = $1", [
      environmentId,
      LIMITS.environment.maxLiveValueBytes - 10,
    ]);
    try {
      const over = await preview(
        "env2a",
        fileOf([unique(), "a".repeat(6)], [unique(), "b".repeat(5)]),
      );
      expect(over.status).toBe(507);
      expect(over.details).toEqual({ limit: "bytes" });
      const fits = await preview(
        "env2a",
        fileOf([unique(), "a".repeat(5)], [unique(), "b".repeat(5)]),
      );
      expect(fits.status).toBe(200);
    } finally {
      await db.query("UPDATE app.environment SET live_value_bytes = $2 WHERE id = $1", [
        environmentId,
        actual,
      ]);
    }
    await expectIndexMatchesBackend(f, "env2a");
  });

  it("1,001 entries and 1 MiB + 1 byte are refused before any backend read", async () => {
    f.setBao("closed");
    const many = Array.from(
      { length: LIMITS.body.dotenvMaxEntries + 1 },
      (_, index) => `${"N_" + String(index).padStart(4, "0")}=v\n`,
    ).join("");
    const tooMany = await preview("env1a", many);
    expect(tooMany.status).toBe(200);
    expect(tooMany.body.applicable).toBe(false);
    expect(tooMany.body.issues).toEqual([
      { line: LIMITS.body.dotenvMaxEntries + 1, rule: "too_many_entries" },
    ]);
    const big = `${unique()}=${"a".repeat(LIMITS.body.dotenvMaxBytes)}\n`;
    const tooBig = await preview("env1a", big);
    expect(tooBig.status).toBe(400);
    expect(tooBig.code).toBe("malformed_request");
  });

  it("loader warnings name the key", async () => {
    const name = unique();
    const answer = await preview("env1a", fileOf([name, `${valueOf("dollar")}$HOME`]));
    expect(answer.status).toBe(200);
    expect(answer.body.warnings).toEqual([{ name, loader: "nextjs", kind: "expansion" }]);
  });

  it("a third large request at once → 503 busy", async () => {
    const held: (() => void)[] = [];
    let arrived = 0;
    let bothHeld: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      bothHeld = resolve;
    });
    f.setFaults(async (point) => {
      if (point !== "after_backend_read") return;
      arrived += 1;
      if (arrived === 2) bothHeld();
      await new Promise<void>((resolve) => {
        held.push(resolve);
      });
    });
    const first = preview("env1a", fileOf([unique(), "a"]));
    const second = preview("env1b", fileOf([unique(), "b"]));
    await ready;
    const third = await preview("env2a", fileOf([unique(), "c"]));
    expect(third.status).toBe(503);
    expect(third.code).toBe("busy");
    for (const release of held) release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it("the lock is held elsewhere → 503 busy", async () => {
    const key = (
      await f.api.superuser.query<{ lock_key: string }>(
        "SELECT lock_key FROM app.environment WHERE id = $1",
        [f.env("env1a").environmentId],
      )
    ).rows[0]?.lock_key;
    const holder = await f.api.superuser.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [key]);
      const answer = await preview("env1a", fileOf([unique(), "a"]));
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("busy");
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [key]);
      holder.release();
    }
  });

  it("a dead preview is removed by the sweep", async () => {
    const answer = await preview("env1a", fileOf([unique(), "a"]));
    expect(answer.status).toBe(200);
    const id = answer.body.previewId as string;
    const live = await preview("env1a", fileOf([unique(), "b"]));
    await f.api.superuser.query(
      "UPDATE app.import_preview SET expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    const result = await sweepStaleOperations(f.api.pool);
    expect(result.previewsRemoved).toBeGreaterThanOrEqual(1);
    const left = await f.api.superuser.query<{ id: string }>(
      "SELECT id FROM app.import_preview WHERE id = ANY($1::uuid[])",
      [[id, live.body.previewId]],
    );
    expect(left.rows.map((row) => row.id)).toEqual([live.body.previewId]);
  });

  it("roles per decide: owner, admin and editors preview; a reader is 403; an ungranted member and another organization are 404", async () => {
    const file = fileOf([unique(), "a"]);
    const expected: [FixtureUser, EnvName, number][] = [
      ["ownerA", "env1a", 200],
      ["adminA", "env1a", 200],
      ["editorA", "env1a", 200],
      ["envEditorA", "env1a", 200],
      ["envEditorA", "env1b", 404],
      ["readerA", "env1a", 403],
      ["ungrantedA", "env1a", 404],
      ["ownerB", "env1a", 404],
    ];
    for (const [user, env, status] of expected) {
      const answer = await preview(env, file, user);
      expect(answer.status, `${user} ${env}`).toBe(status);
      const rows = await f.api.superuser.query(
        "SELECT 1 FROM audit.event WHERE action = 'import.preview' AND request_id = $1",
        [answer.headers.get("x-request-id")],
      );
      expect(rows.rowCount, `${user} ${env}`).toBe(status === 200 ? 1 : 0);
    }
  });
});
