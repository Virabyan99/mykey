// secrets.restore (Run 4.4, FR-1.29, AC-1.15, P-74): an older version's value
// written as a new version with cas = the current version, also over a
// deleted current version. The source value is read under the lock and held
// in memory only.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  sha256,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

interface Current {
  version: number;
  stateTag: string;
}
const unique = (prefix = "S"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const valueOf = (label: string): string => `${mark}-${label}-${randomUUID()}`;
const currentOf = (answer: Answer): Current => {
  const result = answer.body.result as Current;
  return { version: result.version, stateTag: result.stateTag };
};

/** A key with `count` versions; answers the values by version (1-based) and the current. */
async function versions(
  env: EnvName,
  count: number,
): Promise<{ name: string; values: string[]; current: Current }> {
  const name = unique();
  const values = [valueOf("v1")];
  const created = await f.create(env, name, values[0]!);
  expect(created.status).toBe(201);
  let current = currentOf(created);
  for (let v = 2; v <= count; v += 1) {
    const value = valueOf(`v${String(v)}`);
    values.push(value);
    const updated = await f.update(env, name, value, current);
    expect(updated.status).toBe(200);
    current = currentOf(updated);
  }
  return { name, values, current };
}

describe("secrets.restore", () => {
  it("versions 1, 2, 3: restore of 1 gives version 4 with version 1's digest, and history says restore", async () => {
    const { name, values, current } = await versions("env1a", 3);
    const answer = await f.act("env1a", name, "restore", current, { sourceVersion: 1 });
    expect(answer.status).toBe(200);
    expect(currentOf(answer).version).toBe(4);
    const backend = await f.backend("env1a", name);
    expect(backend?.currentVersion).toBe(4);
    expect(backend?.versions[3]?.digest).toBe(sha256(values[0]!));
    expect(backend?.versions[3]?.operationId).toBe(answer.body.operationId);
    const history = await f.send("GET", `${f.env("env1a").path}/secrets/${name}/history`, {
      key: null,
    });
    const newest = (history.body.versions as { version: number; written: { action: string } }[])[0];
    expect(newest).toMatchObject({ version: 4, written: { action: "restore" } });
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("history through the routes: create, update, update, delete, undelete, restore (Run 4.3's case)", async () => {
    const { name, current } = await versions("env1a", 3);
    const deleted = currentOf(await f.act("env1a", name, "delete", current));
    const undeleted = currentOf(await f.act("env1a", name, "undelete", deleted));
    expect((await f.act("env1a", name, "restore", undeleted, { sourceVersion: 1 })).status).toBe(
      200,
    );
    const history = await f.send("GET", `${f.env("env1a").path}/secrets/${name}/history`, {
      key: null,
    });
    const entries = history.body.versions as {
      version: number;
      written: { action: string; actor: { id: string } };
      lastChange: { action: string } | null;
    }[];
    expect(entries.map((v) => [v.version, v.written.action, v.lastChange?.action ?? null])).toEqual(
      [
        [4, "restore", null],
        [3, "update", "undelete"],
        [2, "update", null],
        [1, "create", null],
      ],
    );
    for (const entry of entries) expect(entry.written.actor.id).toBe(f.tenants.userId("ownerA"));
    expect(history.text.includes(mark)).toBe(false);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("sourceVersion equal to or above expectedVersion is 422", async () => {
    const { name, current } = await versions("env1a", 2);
    for (const sourceVersion of [2, 3]) {
      const answer = await f.act("env1a", name, "restore", current, { sourceVersion });
      expect(answer.status, String(sourceVersion)).toBe(422);
      expect(answer.code).toBe("validation_failed");
    }
    expect((await f.backend("env1a", name))?.versions).toHaveLength(2);
  });

  it("restore over a deleted current version gives a live new version (AC-1.15); a deleted source is 409", async () => {
    const { name, values, current } = await versions("env1a", 2);
    const deleted = currentOf(await f.act("env1a", name, "delete", current));
    const restored = await f.act("env1a", name, "restore", deleted, { sourceVersion: 1 });
    expect(restored.status).toBe(200);
    const result = restored.body.result as { version: number; state: string };
    expect(result).toMatchObject({ version: 3, state: "live" });
    const backend = await f.backend("env1a", name);
    expect(backend?.versions[2]?.digest).toBe(sha256(values[0]!));
    // Version 2 is deleted: as a source it is state_conflict.
    const fromDeleted = await f.act("env1a", name, "restore", currentOf(restored), {
      sourceVersion: 2,
    });
    expect(fromDeleted.status).toBe(409);
    expect(fromDeleted.code).toBe("state_conflict");
    expect((await f.backend("env1a", name))?.versions).toHaveLength(3);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a trimmed source (after 21 writes, source 1) is 409 state_conflict", async () => {
    const { name, current } = await versions("env1b", 21);
    const answer = await f.act("env1b", name, "restore", current, { sourceVersion: 1 });
    expect(answer.status).toBe(409);
    expect(answer.code).toBe("state_conflict");
    await expectIndexMatchesBackend(f, "env1b");
  }, 120_000);

  it("a stale tag is 409 version_conflict and writes nothing", async () => {
    const { name, current } = await versions("env1a", 2);
    const answer = await f.act(
      "env1a",
      name,
      "restore",
      { version: current.version, stateTag: randomBytes(16).toString("base64url") },
      { sourceVersion: 1 },
    );
    expect(answer.status).toBe(409);
    expect(answer.code).toBe("version_conflict");
    expect((await f.backend("env1a", name))?.versions).toHaveLength(2);
  });

  it("the restored value is in no row of app.operation, app.operation_step or audit.event; a replay writes no second version", async () => {
    const { name, current } = await versions("env1a", 2);
    const key = randomUUID();
    const first = await f.act("env1a", name, "restore", current, { sourceVersion: 1, key });
    const again = await f.act("env1a", name, "restore", current, { sourceVersion: 1, key });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.operationId).toBe(first.body.operationId);
    expect((await f.backend("env1a", name))?.versions).toHaveLength(3);
    const db = f.api.superuser;
    for (const [table, column] of [
      ["app.operation", "o"],
      ["app.operation_step", "o"],
      ["audit.event", "o"],
    ] as const) {
      const found = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} ${column} WHERE strpos(row_to_json(${column})::text, $1) > 0`,
        [mark],
      );
      expect(found.rows[0]?.count, table).toBe(0);
    }
    const audit = await db.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit.event WHERE operation_id = $1 AND outcome = 'success'",
      [first.body.operationId],
    );
    expect(audit.rows[0]?.details).toEqual({ name, version: 3, sourceVersion: 1 });
    await expectIndexMatchesBackend(f, "env1a");
  });
});
