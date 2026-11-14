// Run 4.1 Task A (P-63, P-65, Doc 06 §3, §6.3): the operation record — scope
// columns, the dispatch claim, the conditional finish, the replay expiry on
// database time and the operator's expiry into tombstones.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EnvironmentId, OperationId, OrganizationId, ProjectId } from "@mykey/contracts";
import {
  claimDispatch,
  expireOperations,
  findOperation,
  findOperationByKey,
  finishOperation,
  hasTombstone,
  insertOperation,
  touchOperation,
  withTransaction,
  type NewOperation,
} from "@mykey/db";
import pg from "pg";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await prepareDatabase();
});

afterAll(async () => {
  await db.drop();
});

const BOOT = randomUUID();

function newOperation(overrides: Partial<NewOperation> = {}): NewOperation {
  return {
    id: randomUUID() as OperationId,
    organizationId: randomUUID() as OrganizationId,
    principalKind: "user",
    principalId: randomUUID(),
    action: "secrets.update",
    target: randomUUID(),
    idempotencyKey: randomUUID(),
    state: "accepted",
    fingerprint: Buffer.alloc(32, 7),
    fingerprintKeyId: "k1",
    result: null,
    executorBootId: BOOT,
    ...overrides,
  };
}

async function insert(row: NewOperation): Promise<void> {
  await withTransaction(db.pool("api_runtime"), async (tx) => {
    expect(await insertOperation(tx, row)).toBe("inserted");
  });
}

describe("operation records", () => {
  it("two inserts of one key at once: one inserted, the other waits and then finds it", async () => {
    const pool = db.pool("api_runtime");
    const first = newOperation();
    const second = { ...first, id: randomUUID() as OperationId };
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      expect(await insertOperation(a, first)).toBe("inserted");
      let settled = false;
      const waiting = insertOperation(b, second).then((outcome) => {
        settled = true;
        return outcome;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await a.query("COMMIT");
      expect(await waiting).toBe("exists");
      const found = await findOperationByKey(b, first);
      expect(found?.id).toBe(first.id);
      await b.query("COMMIT");
    } finally {
      a.release();
      b.release();
    }
  });

  it("claimDispatch moves accepted to executing once", async () => {
    const row = newOperation();
    await insert(row);
    const pool = db.pool("api_runtime");
    const other = randomUUID();
    expect(await withTransaction(pool, (tx) => claimDispatch(tx, row.id, other))).toBe(false);
    expect((await findOperation(pool, row.id))?.state).toBe("accepted");
    expect(await withTransaction(pool, (tx) => claimDispatch(tx, row.id, BOOT))).toBe(true);
    const claimed = await findOperation(pool, row.id);
    expect(claimed?.state).toBe("executing");
    expect(claimed?.dispatchedAt).toBeInstanceOf(Date);
    expect(claimed?.heartbeatAt).toBeInstanceOf(Date);
    expect(await withTransaction(pool, (tx) => claimDispatch(tx, row.id, BOOT))).toBe(false);
    const again = await findOperation(pool, row.id);
    expect(again?.dispatchedAt?.getTime()).toBe(claimed?.dispatchedAt?.getTime());
  });

  it("finishOperation by another boot id changes nothing and answers null", async () => {
    const row = newOperation({ state: "executing" });
    await insert(row);
    const pool = db.pool("api_runtime");
    const finished = await withTransaction(pool, (tx) =>
      finishOperation(tx, row.id, randomUUID(), { state: "succeeded", result: { a: 1 } }, 30),
    );
    expect(finished).toBeNull();
    const stored = await findOperation(pool, row.id);
    expect(stored?.state).toBe("executing");
    expect(stored?.result).toBeNull();
  });

  it("a terminal row is never overwritten", async () => {
    const row = newOperation({ state: "executing" });
    await insert(row);
    const pool = db.pool("api_runtime");
    const done = await withTransaction(pool, (tx) =>
      finishOperation(tx, row.id, BOOT, { state: "succeeded", result: { version: 2 } }, 30),
    );
    expect(done?.state).toBe("succeeded");
    for (const finish of [
      { state: "rejected", errorCode: "busy" },
      { state: "uncertain" },
      { state: "succeeded", result: { version: 3 } },
    ] as const) {
      expect(
        await withTransaction(pool, (tx) => finishOperation(tx, row.id, BOOT, finish, 30)),
      ).toBeNull();
    }
    const stored = await findOperation(pool, row.id);
    expect(stored?.state).toBe("succeeded");
    expect(stored?.result).toEqual({ version: 2 });
    expect(stored?.completedAt?.getTime()).toBe(done?.completedAt?.getTime());
  });

  it("succeeded sets a replay expiry 30 days ahead on database time; uncertain and awaiting_input set none", async () => {
    const pool = db.pool("api_runtime");
    const succeeded = newOperation({ state: "executing" });
    await insert(succeeded);
    const row = await withTransaction(pool, (tx) =>
      finishOperation(tx, succeeded.id, BOOT, { state: "succeeded", result: {} }, 30),
    );
    const [clock] = await run<{ now: Date }>(pool, "SELECT now() AS now");
    const days = (row!.replayExpiresAt!.getTime() - row!.completedAt!.getTime()) / 86_400_000;
    expect(days).toBe(30);
    expect(Math.abs(row!.completedAt!.getTime() - clock!.now.getTime())).toBeLessThan(5_000);
    expect(row!.expired).toBe(false);

    for (const state of ["uncertain", "awaiting_input"] as const) {
      const pending = newOperation({ state: "executing" });
      await insert(pending);
      const stored = await withTransaction(pool, (tx) =>
        finishOperation(tx, pending.id, BOOT, { state }, 30),
      );
      expect(stored?.state).toBe(state);
      expect(stored?.completedAt).toBeNull();
      expect(stored?.replayExpiresAt).toBeNull();
    }
  });

  it("expireOperations as maintenance: tombstones aged terminal rows, clears their replay data, leaves unfinished rows", async () => {
    const api = db.pool("api_runtime");
    const superuser = db.pool("superuser");
    const aged = newOperation({ state: "executing", expected: { version: 1, stateTag: "t" } });
    await insert(aged);
    await withTransaction(api, (tx) =>
      finishOperation(tx, aged.id, BOOT, { state: "succeeded", result: { version: 2 } }, 30),
    );
    const uncertain = newOperation({ state: "executing" });
    await insert(uncertain);
    await withTransaction(api, (tx) =>
      finishOperation(tx, uncertain.id, BOOT, { state: "uncertain" }, 30),
    );
    await superuser.query(
      `UPDATE app.operation SET created_at = now() - interval '60 days',
              completed_at = now() - interval '59 days', replay_expires_at = now() - interval '29 days'
        WHERE id = $1`,
      [aged.id],
    );
    await superuser.query(
      "UPDATE app.operation SET created_at = now() - interval '60 days' WHERE id = $1",
      [uncertain.id],
    );
    expect((await findOperation(api, aged.id))?.expired).toBe(true);

    // api_runtime may not do this: the tombstone is the operator's.
    const client = await api.connect();
    try {
      await client.query("BEGIN");
      const error = await expireOperations(client).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(pg.DatabaseError);
      expect((error as pg.DatabaseError).code).toBe("42501");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const count = await withTransaction(db.pool("maintenance"), (tx) => expireOperations(tx));
    expect(count).toBeGreaterThanOrEqual(1);
    const stored = await findOperation(api, aged.id);
    expect(stored).toMatchObject({
      id: aged.id,
      principalId: aged.principalId,
      action: aged.action,
      target: aged.target,
      state: "succeeded",
      fingerprint: null,
      fingerprintKeyId: null,
      expected: null,
      result: null,
    });
    expect(stored?.completedAt).toBeInstanceOf(Date);
    expect(await hasTombstone(api, aged)).toBe(true);
    const untouched = await findOperation(api, uncertain.id);
    expect(untouched?.state).toBe("uncertain");
    expect(untouched?.fingerprint).not.toBeNull();
    expect(await hasTombstone(api, uncertain)).toBe(false);
  });

  it("touchOperation moves the heartbeat only for the owner", async () => {
    const row = newOperation({ state: "executing" });
    await insert(row);
    const pool = db.pool("api_runtime");
    expect(await touchOperation(pool, row.id, randomUUID())).toBe(false);
    expect(await touchOperation(pool, row.id, BOOT)).toBe(true);
    expect((await findOperation(pool, row.id))?.heartbeatAt).toBeInstanceOf(Date);
  });

  it("the new columns hold what was inserted; a secret_name outside the pattern is refused by the database", async () => {
    const parent = newOperation({ state: "executing" });
    await insert(parent);
    const child = newOperation({
      projectId: randomUUID() as ProjectId,
      environmentId: randomUUID() as EnvironmentId,
      secretName: "DB_HOST",
      parentOperationId: parent.id,
      expected: { version: 3, stateTag: "abc" },
    });
    await insert(child);
    const stored = await findOperation(db.pool("api_runtime"), child.id);
    expect(stored).toMatchObject({
      projectId: child.projectId,
      environmentId: child.environmentId,
      secretName: "DB_HOST",
      parentOperationId: parent.id,
      expected: { version: 3, stateTag: "abc" },
      executorBootId: BOOT,
    });
    const bad = newOperation({ secretName: "db-host" });
    const error = await withTransaction(db.pool("api_runtime"), (tx) =>
      insertOperation(tx, bad),
    ).catch((caught: unknown) => caught);
    expect((error as pg.DatabaseError).code).toBe("23514");
  });
});
