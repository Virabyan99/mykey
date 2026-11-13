// secrets.reveal (Run 4.3 Task B, FR-1.22 server half, AC-1.12, P-73): one
// value, read under the environment's lock and released only after its
// audit row is committed. Values are synthetic and built around a run-time
// canary; assertions compare digests, never values.
import { randomBytes, randomUUID } from "node:crypto";
import { secretPath } from "@mykey/openbao";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  idleAdvisoryLocks,
  sha256,
  type Answer,
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
  f.setFaults(null);
  expect(await idleAdvisoryLocks(f)).toBe(0);
});

const unique = (prefix = "R"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const valueOf = (label: string): string => `${mark}-${label}-${randomUUID()}`;

function reveal(
  env: EnvName,
  name: string,
  body: Record<string, unknown> = {},
  user: FixtureUser = "ownerA",
): Promise<Answer> {
  return f.send("POST", `${f.env(env).path}/secrets/${name}/reveal`, { body, user, key: null });
}

async function created(env: EnvName, name: string, value: string) {
  const answer = await f.create(env, name, value);
  expect(answer.status).toBe(201);
  return answer.body.result as { version: number; stateTag: string };
}

async function revealRows(requestId: string | null): Promise<number> {
  const result = await f.api.superuser.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit.event WHERE action = 'secret.reveal' AND request_id = $1",
    [requestId],
  );
  return result.rows[0]?.count ?? 0;
}

const digestOf = (answer: Answer): string => sha256(String(answer.body.value));

describe("secrets.reveal", () => {
  it("the current value: 200, equal digest, no-store, and its audit row committed when the answer arrives", async () => {
    const name = unique();
    const value = valueOf("current");
    const current = await created("env1a", name, value);
    const answer = await reveal("env1a", name);
    expect(answer.status).toBe(200);
    expect(digestOf(answer)).toBe(sha256(value));
    expect(answer.body.version).toBe(1);
    expect(answer.body.stateTag).toBe(current.stateTag);
    expect(answer.body.name).toBe(name);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const audit = await f.api.superuser.query<{
      details: { name: string; version: number };
      outcome: string;
    }>(
      "SELECT details, outcome FROM audit.event WHERE action = 'secret.reveal' AND request_id = $1",
      [answer.headers.get("x-request-id")],
    );
    expect(audit.rows).toEqual([{ details: { name, version: 1 }, outcome: "success" }]);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("version 1 after an update; above the current is 404; a deleted older version is 409; bad versions are refused", async () => {
    const name = unique();
    const first = valueOf("v1");
    const current = await created("env1a", name, first);
    expect((await f.update("env1a", name, valueOf("v2"), current)).status).toBe(200);
    const old = await reveal("env1a", name, { version: 1 });
    expect(old.status).toBe(200);
    expect(digestOf(old)).toBe(sha256(first));
    expect(old.body.version).toBe(1);
    const above = await reveal("env1a", name, { version: 3 });
    expect(above.status).toBe(404);
    expect(above.code).toBe("not_found");

    const { projectId, environmentId } = f.env("env1a");
    const removed = await f
      .operatorBao()
      .kvSoftDelete(secretPath(projectId, environmentId, name), 1, {
        operationId: randomUUID(),
        dispatchId: randomUUID(),
      });
    expect(removed.ok).toBe(true);
    const deleted = await reveal("env1a", name, { version: 1 });
    expect(deleted.status).toBe(409);
    expect(deleted.code).toBe("state_conflict");

    // Doc 06 §9: a value of the wrong type is 400, a number breaking its rule 422.
    expect((await reveal("env1a", name, { version: 0 })).status).toBe(422);
    expect((await reveal("env1a", name, { version: "1" })).status).toBe(400);
    expect([400, 422]).toContain((await reveal("env1a", name, { version: 1.5 })).status);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a deleted current version without a version is 409 state_conflict; a key in review is 409 key_under_review", async () => {
    const name = unique();
    await created("env2a", name, valueOf("d"));
    const db = f.api.superuser;
    const { environmentId } = f.env("env2a");
    await db.query(
      "UPDATE app.secret_index SET state = 'deleted' WHERE environment_id = $1 AND name = $2",
      [environmentId, name],
    );
    const deleted = await reveal("env2a", name);
    expect(deleted.status).toBe(409);
    expect(deleted.code).toBe("state_conflict");
    await db.query(
      "UPDATE app.secret_index SET state = 'needs_review' WHERE environment_id = $1 AND name = $2",
      [environmentId, name],
    );
    const review = await reveal("env2a", name);
    expect(review.status).toBe(409);
    expect(review.code).toBe("key_under_review");
    expect(review.text.includes(mark)).toBe(false);
  });

  it("a slot held for this key is 409 with its operationId; a slot held for another key is 200 (P-67)", async () => {
    const name = unique();
    const value = valueOf("slot");
    await created("env1a", name, value);
    const db = f.api.superuser;
    const { environmentId, projectId } = f.env("env1a");
    const holder = randomUUID();
    const hold = async (secretName: string) => {
      await db.query(
        `INSERT INTO app.operation (id, organization_id, project_id, environment_id, secret_name,
           principal_kind, principal_id, action, target, idempotency_key, state)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'user', $6, 'secrets.update', $4::text, $7, 'uncertain')`,
        [
          holder,
          f.tenants.a.organizationId,
          projectId,
          environmentId,
          secretName,
          f.tenants.userId("ownerA"),
          randomUUID(),
        ],
      );
      await db.query(
        "INSERT INTO app.effect_slot (scope_key, operation_id, generation, acquired_at) VALUES ($1, $2, 0, now())",
        [`env:${environmentId}`, holder],
      );
    };
    await hold(name);
    try {
      const blocked = await reveal("env1a", name);
      expect(blocked.status).toBe(409);
      expect(blocked.code).toBe("key_under_review");
      expect(blocked.operationId).toBe(holder);
      await db.query("UPDATE app.operation SET secret_name = $2 WHERE id = $1", [
        holder,
        unique("OTHER"),
      ]);
      const other = await reveal("env1a", name);
      expect(other.status).toBe(200);
      expect(digestOf(other)).toBe(sha256(value));
    } finally {
      await db.query("DELETE FROM app.effect_slot WHERE operation_id = $1", [holder]);
    }
  });

  it("audit cannot be written: 503 audit_unavailable, no value in the body", async () => {
    const name = unique();
    await created("env1a", name, valueOf("audit"));
    const db = f.api.superuser;
    await db.query("REVOKE INSERT ON audit.event FROM api_runtime");
    try {
      const answer = await reveal("env1a", name);
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("audit_unavailable");
      expect(answer.text.includes(mark)).toBe(false);
    } finally {
      await db.query("GRANT INSERT ON audit.event TO api_runtime");
    }
  });

  it("the lock session terminated after the backend read: 503 dependency_unavailable, no value, no reveal row (Review focus 2)", async () => {
    const name = unique();
    await created("env1a", name, valueOf("terminate"));
    f.setFaults(async (point) => {
      if (point !== "after_backend_read") return;
      await f.api.superuser.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype = 'advisory' AND granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
    });
    const answer = await reveal("env1a", name);
    f.setFaults(null);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("dependency_unavailable");
    expect(answer.text.includes(mark)).toBe(false);
    expect(await revealRows(answer.headers.get("x-request-id"))).toBe(0);
    // The lock pool still works.
    expect((await reveal("env1a", name)).status).toBe(200);
  });

  it("the lock held elsewhere: 503 busy", async () => {
    const name = unique();
    await created("env1a", name, valueOf("busy"));
    const key = (
      await f.api.superuser.query<{ lock_key: string }>(
        "SELECT lock_key FROM app.environment WHERE id = $1",
        [f.env("env1a").environmentId],
      )
    ).rows[0]!.lock_key;
    const holder = await f.api.superuser.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [key]);
      const answer = await reveal("env1a", name);
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("busy");
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [key]);
      holder.release();
    }
  });

  it("the backend holds a newer version than the index: 503 backend_inconsistent, key in review, no value", async () => {
    const name = unique();
    const current = await created("env2a", name, valueOf("old"));
    const { projectId, environmentId } = f.env("env2a");
    const moved = await f
      .operatorBao()
      .kvWrite(
        secretPath(projectId, environmentId, name),
        { value: valueOf("outside"), operation_id: randomUUID(), format: 1 },
        current.version,
        { operationId: randomUUID(), dispatchId: randomUUID() },
      );
    expect(moved.ok).toBe(true);
    const answer = await reveal("env2a", name);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("backend_inconsistent");
    expect(answer.text.includes(mark)).toBe(false);
    expect((await f.indexRow("env2a", name))?.state).toBe("needs_review");
  });

  it("roles: a reader and an editor reveal; an ungranted member is 404 with access.denied and no reveal row", async () => {
    const name = unique();
    const value = valueOf("roles");
    await created("env1a", name, value);
    for (const user of ["readerA", "editorA"] as const) {
      const answer = await reveal("env1a", name, {}, user);
      expect(answer.status, user).toBe(200);
      expect(digestOf(answer)).toBe(sha256(value));
    }
    for (const user of ["ungrantedA", "ownerB"] as const) {
      const answer = await reveal("env1a", name, {}, user);
      expect(answer.status, user).toBe(404);
      const requestId = answer.headers.get("x-request-id");
      expect(await revealRows(requestId)).toBe(0);
      const denied = await f.api.superuser.query(
        "SELECT 1 FROM audit.event WHERE action = 'access.denied' AND request_id = $1",
        [requestId],
      );
      expect(denied.rowCount, user).toBe(1);
    }
  });

  it("boundary values come back exactly through reveal (AC-1.12)", async () => {
    const values = [
      "",
      `${"€".repeat(21_845)}x`,
      "line one\r\nline two\n\tindented\r",
      "four bytes: \u{1F600}\u{1D11E}\u{10FFFF}",
    ];
    for (const [index, value] of values.entries()) {
      const name = index === 0 ? `A${randomBytes(3).toString("hex").toUpperCase()}` : unique("B");
      await created("env1a", name, value);
      const answer = await reveal("env1a", name);
      expect(answer.status, `value ${String(index)}`).toBe(200);
      expect(digestOf(answer)).toBe(sha256(value));
    }
    const longest = `Z${"Y".repeat(127)}`;
    await created("env1a", longest, valueOf("long-name"));
    expect((await reveal("env1a", longest)).status).toBe(200);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("after ten reveals no log entry of the API contains the canary", async () => {
    const name = unique();
    await created("env1a", name, valueOf("logs"));
    for (let i = 0; i < 10; i += 1) expect((await reveal("env1a", name)).status).toBe(200);
    expect(JSON.stringify(f.api.logs).includes(mark)).toBe(false);
    const audit = await f.api.superuser.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit.event WHERE strpos(details::text, $1) > 0",
      [mark],
    );
    expect(audit.rows[0]?.count).toBe(0);
  });
});
