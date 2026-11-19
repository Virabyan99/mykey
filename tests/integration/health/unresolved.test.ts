// Run 6.4 Task B (M-3): status.sh's count of unresolved operations, run as the
// host runs it (infra/hosts/checks/sql/operations-unresolved.sql) against a
// fixture database. A provisioning operation waits in the job queue, which
// retries for 600 s: it is not counted before that, and is counted after.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareDatabase, type TestDatabase } from "../database/setup.ts";

const SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "infra",
    "hosts",
    "checks",
    "sql",
    "operations-unresolved.sql",
  ),
  "utf8",
);

let db: TestDatabase;

beforeAll(async () => {
  db = await prepareDatabase();
}, 300_000);

afterAll(async () => {
  await db.drop();
});

async function unresolved(): Promise<number> {
  const results = (await db.pool("superuser").query(SQL)) as unknown as {
    rows: { count: string }[];
  }[];
  const select = results.find(
    (result) => result.rows.length === 1 && "count" in (result.rows[0] ?? {}),
  );
  return Number(select?.rows[0]?.count);
}

async function operation(
  action: string,
  state: string,
  ageSeconds: number,
  heartbeatAgeSeconds: number | null,
): Promise<string> {
  const id = randomUUID();
  await db.pool("superuser").query(
    `INSERT INTO app.operation (id, principal_kind, principal_id, action, target, idempotency_key, state, created_at, heartbeat_at)
     VALUES ($1::uuid, 'system', 'provisioner', $2, $1::text, $1::text, $3, now() - make_interval(secs => $4),
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(secs => $5::int) END)`,
    [id, action, state, ageSeconds, heartbeatAgeSeconds],
  );
  return id;
}

const remove = (id: string) =>
  db.pool("superuser").query("DELETE FROM app.operation WHERE id = $1", [id]);

describe("operationsUnresolved (M-3)", () => {
  it("control: an executing secret operation with a heartbeat 200 s old is counted", async () => {
    const id = await operation("secret.create", "executing", 300, 200);
    expect(await unresolved()).toBe(1);
    await remove(id);
    expect(await unresolved()).toBe(0);
  });

  it("an accepted provisioning operation younger than 600 s is not counted; older, it is", async () => {
    const young = await operation("environment.provision", "accepted", 590, null);
    expect(await unresolved()).toBe(0);
    await db
      .pool("superuser")
      .query("UPDATE app.operation SET created_at = now() - interval '610 seconds' WHERE id = $1", [
        young,
      ]);
    expect(await unresolved()).toBe(1);
    await remove(young);
  });

  it("an executing provisioning operation with a fresh heartbeat is not counted at any age", async () => {
    const id = await operation("environment.provision", "executing", 3_600, 10);
    expect(await unresolved()).toBe(0);
    await remove(id);
  });
});
