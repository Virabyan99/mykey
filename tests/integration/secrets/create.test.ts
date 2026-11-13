// Secret create through the mutation protocol (Run 4.2 Task B, FR-1.20,
// FR-1.24, FR-1.25). Every test ends with the index matching the backend.
// Values are synthetic; assertions compare digests and lengths, never values.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  idleAdvisoryLocks,
  sha256,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import { secretPath } from "@mykey/openbao";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture({ processes: 2 });
}, 600_000);

afterAll(async () => {
  await f.close();
});

const unique = (prefix = "S"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (): string => `synthetic-${randomUUID()}`;
/** A canary assembled at run time (never a literal in the repository). */
const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

async function operationCount(env: EnvName): Promise<number> {
  const result = await f.api.superuser.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM app.operation WHERE environment_id = $1",
    [f.env(env).environmentId],
  );
  return result.rows[0]?.count ?? 0;
}

/** Writes a version past the product, as an operator would (fixture state). */
async function operatorWrite(env: EnvName, name: string): Promise<number> {
  const { projectId, environmentId } = f.env(env);
  const written = await f
    .operatorBao()
    .kvWrite(
      secretPath(projectId, environmentId, name),
      { value: synthetic(), operation_id: randomUUID(), format: 1 },
      0,
      { operationId: randomUUID(), dispatchId: randomUUID() },
    );
  if (!written.ok) throw new Error(`operator write: ${written.kind}`);
  return written.data.version;
}

describe("secrets.create", () => {
  it("creates: 201 with the result, one version carrying the operation id, index, event, audit", async () => {
    const name = unique();
    const value = synthetic();
    const answer = await f.create("env1a", name, value);
    expect(answer.status).toBe(201);
    expect(answer.body.state).toBe("succeeded");
    const operationId = answer.body.operationId as string;
    const result = answer.body.result as Record<string, unknown>;
    expect(result.name).toBe(name);
    expect(result.version).toBe(1);
    expect(String(result.stateTag)).toHaveLength(22);
    expect(result.state).toBe("live");
    expect(String(result.generation)).toMatch(/^\d+$/);

    const backend = await f.backend("env1a", name);
    expect(backend?.versions.map((v) => v.version)).toEqual([1]);
    expect(backend?.versions[0]?.operationId).toBe(operationId);
    expect(backend?.versions[0]?.digest).toBe(sha256(value));

    const row = await f.indexRow("env1a", name);
    expect(row?.state).toBe("live");
    expect(row?.current_version).toBe(1);
    expect(row?.state_tag).toBe(result.stateTag);
    expect(row?.last_operation_id).toBe(operationId);

    const events = await f.api.superuser.query<{
      actor_kind: string;
      actor_id: string;
      version: number;
    }>(
      "SELECT actor_kind, actor_id, version FROM app.secret_version_event WHERE environment_id = $1 AND name = $2",
      [f.env("env1a").environmentId, name],
    );
    expect(events.rows).toEqual([
      { actor_kind: "user", actor_id: f.tenants.userId("ownerA"), version: 1 },
    ]);
    const audit = await f.api.superuser.query<{
      action: string;
      outcome: string;
      details: { name: string };
    }>(
      "SELECT action, outcome, details FROM audit.event WHERE operation_id = $1 ORDER BY occurred_at, outcome DESC",
      [operationId],
    );
    expect(audit.rows.map((r) => [r.action, r.outcome, r.details.name])).toEqual([
      ["secret.create", "intent", name],
      ["secret.create", "success", name],
    ]);
    expect(await f.auditedChanges(operationId)).toBe(1);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("accepts the name rules and refuses the rest with 422 before any effect", async () => {
    const longest = `A${"B".repeat(127)}`;
    // Each fixture has its own database and namespace: "A" is free.
    for (const name of ["A", longest]) {
      const answer = await f.create("env1a", name, synthetic());
      expect(answer.status, name.length.toString()).toBe(201);
    }
    const before = await operationCount("env1a");
    for (const name of [`A${"B".repeat(128)}`, "a", "1A", "A-B", "SECRETS_X", ""]) {
      const answer = await f.create("env1a", name, synthetic());
      expect(answer.status, `name of ${String(name.length)}`).toBe(422);
      expect(answer.code).toBe("validation_failed");
    }
    expect(await operationCount("env1a")).toBe(before);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("stores every allowed value exactly and refuses the others before any effect", async () => {
    const allowed = [
      "",
      `${"€".repeat(21_845)}x`, // 65,535 bytes of 3-byte characters and one more
      "line one\r\nline two\n\tindented\r",
      "four bytes: \u{1F600}\u{1D11E}\u{10FFFF}",
    ];
    for (const value of allowed) {
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(65_536);
      const name = unique("V");
      const answer = await f.create("env1a", name, value);
      expect(answer.status, `value of ${String(Buffer.byteLength(value))} bytes`).toBe(201);
      const backend = await f.backend("env1a", name);
      expect(backend?.versions[0]?.digest).toBe(sha256(value));
      expect(backend?.versions[0]?.bytes).toBe(Buffer.byteLength(value, "utf8"));
    }
    const before = await operationCount("env1a");
    for (const value of ["x".repeat(65_537), "a\0b", "a\uD800b"]) {
      const answer = await f.create("env1a", unique("R"), value);
      expect(answer.status).toBe(422);
      expect(answer.code).toBe("validation_failed");
    }
    expect(await operationCount("env1a")).toBe(before);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("does not echo a refused value anywhere (Review focus 3)", async () => {
    const mark = canary();
    const oversized = `${mark}${"x".repeat(65_537 - mark.length)}`;
    const withNul = `${mark}\0`;
    const answers = [
      await f.create("env1a", unique("C"), oversized),
      await f.create("env1a", unique("C"), withNul),
      await f.create("env1a", unique("C"), oversized, { to: "second" }),
      await f.create("env1a", unique("C"), withNul, { to: "second" }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(422);
      expect(answer.text.includes(mark)).toBe(false);
    }
    expect(JSON.stringify(f.api.logs).includes(mark)).toBe(false);
    expect(f.second?.output().includes(mark)).toBe(false);
    const audit = await f.api.superuser.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit.event WHERE strpos(details::text, $1) > 0",
      [mark],
    );
    expect(audit.rows[0]?.count).toBe(0);
  });

  it("refuses a name that exists, live or deleted, and a name with backend history but no index row", async () => {
    // Live.
    const live = unique();
    expect((await f.create("env1a", live, synthetic())).status).toBe(201);
    const again = await f.create("env1a", live, synthetic());
    expect(again.status).toBe(409);
    expect(again.code).toBe("already_exists");
    expect((await f.backend("env1a", live))?.versions).toHaveLength(1);

    // Only version deleted: set up through the backend and the index.
    const deleted = unique("D");
    const version = await operatorWrite("env1a", deleted);
    const { projectId, environmentId } = f.env("env1a");
    const removed = await f
      .operatorBao()
      .kvSoftDelete(secretPath(projectId, environmentId, deleted), version, {
        operationId: randomUUID(),
        dispatchId: randomUUID(),
      });
    expect(removed.ok).toBe(true);
    await f.api.superuser.query(
      `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version, state_tag,
         state, live_value_bytes, last_changed_at)
       VALUES ($1, $2, $3, $4, $5, 'deleted', 0, now())`,
      [
        environmentId,
        deleted,
        f.tenants.a.organizationId,
        version,
        randomBytes(16).toString("base64url"),
      ],
    );
    const overDeleted = await f.create("env1a", deleted, synthetic());
    expect(overDeleted.status).toBe(409);
    expect(overDeleted.code).toBe("already_exists");
    expect((await f.backend("env1a", deleted))?.versions).toHaveLength(1);
    await expectIndexMatchesBackend(f, "env1a");

    // Backend history without an index row (environment 2a: it is left in review).
    const orphan = unique("O");
    await operatorWrite("env2a", orphan);
    const inconsistent = await f.create("env2a", orphan, synthetic());
    expect(inconsistent.status).toBe(503);
    expect(inconsistent.code).toBe("backend_inconsistent");
    expect((await f.indexRow("env2a", orphan))?.state).toBe("needs_review");
    expect((await f.backend("env2a", orphan))?.versions).toHaveLength(1);
  });

  it("replays the same key and body: the same 201, one version, one audited change", async () => {
    const name = unique();
    const value = synthetic();
    const key = randomUUID();
    const first = await f.create("env1a", name, value, { key });
    const second = await f.create("env1a", name, value, { key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.operationId).toBe(first.body.operationId);
    expect((second.body.result as { version: number }).version).toBe(1);
    expect((await f.backend("env1a", name))?.versions).toHaveLength(1);
    expect(await f.auditedChanges(first.body.operationId as string)).toBe(1);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("two identical requests at once on two processes: one version, one operation", async () => {
    const name = unique();
    const value = synthetic();
    const key = randomUUID();
    const [a, b] = await Promise.all([
      f.create("env1a", name, value, { key, to: "first" }),
      f.create("env1a", name, value, { key, to: "second" }),
    ]);
    expect([201, 202]).toContain(a.status);
    expect([201, 202]).toContain(b.status);
    expect(a.body.operationId).toBe(b.body.operationId);
    expect((await f.backend("env1a", name))?.versions).toHaveLength(1);
    expect(await f.auditedChanges(a.body.operationId as string)).toBe(1);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a reader gets 403, an ungranted member and another organization's owner 404; an editor creates", async () => {
    const cases = [
      { user: "readerA", status: 403, code: "action_denied" },
      { user: "ungrantedA", status: 404, code: "not_found" },
      { user: "ownerB", status: 404, code: "not_found" },
    ] as const;
    for (const entry of cases) {
      const name = unique();
      const answer = await f.create("env1a", name, synthetic(), { user: entry.user });
      expect(answer.status, entry.user).toBe(entry.status);
      expect(answer.code).toBe(entry.code);
      expect(await f.backend("env1a", name)).toBeNull();
    }
    const control = await f.create("env1a", unique(), synthetic(), { user: "editorA" });
    expect(control.status).toBe(201);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("refuses by environment state: pending without KV 409, archived 409, in review 503; active creates", async () => {
    const id = f.env("env1b").environmentId;
    const db = f.api.superuser;
    const states = [
      { set: "state = 'pending', kv_ready = false", status: 409, code: "state_conflict" },
      { set: "state = 'archived', archive_origin = 'self'", status: 409, code: "state_conflict" },
      {
        set: "state = 'needs_review', review_reason = 'backend_inconsistent'",
        status: 503,
        code: "backend_inconsistent",
      },
    ];
    try {
      for (const entry of states) {
        await db.query(`UPDATE app.environment SET ${entry.set} WHERE id = $1`, [id]);
        const name = unique();
        const answer = await f.create("env1b", name, synthetic());
        expect(answer.status, entry.set).toBe(entry.status);
        expect(answer.code).toBe(entry.code);
        expect(await f.backend("env1b", name)).toBeNull();
        await db.query(
          `UPDATE app.environment SET state = 'active', kv_ready = true, review_reason = NULL,
             archive_origin = NULL WHERE id = $1`,
          [id],
        );
      }
    } finally {
      await db.query(
        `UPDATE app.environment SET state = 'active', kv_ready = true, review_reason = NULL,
           archive_origin = NULL WHERE id = $1`,
        [id],
      );
    }
    expect((await f.create("env1b", unique(), synthetic())).status).toBe(201);
    await expectIndexMatchesBackend(f, "env1b");
    expect(await idleAdvisoryLocks(f)).toBe(0);
  });
});
