// Run 3.1 Task A: the transactional outbox. A row is written in the same
// transaction as the change it announces; a dispatcher turns each committed
// row into exactly one value-free job.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OperationId } from "@mykey/contracts";
import { createPool, enqueueOutbox, insertOperation, withTransaction } from "@mykey/db";
import {
  createSender,
  dispatchOutbox,
  ensureQueues,
  jobPayloadSchema,
  type JobSender,
} from "@mykey/operations";
import type pg from "pg";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

let db: TestDatabase;
let api: pg.Pool;
let sender: JobSender;

beforeAll(async () => {
  db = await prepareDatabase();
  await ensureQueues(db.pool("migration_owner"));
  api = createPool(db.targets.api_runtime, { max: 6 });
  sender = await createSender(api);
});

afterAll(async () => {
  await sender.stop();
  await api.end();
  await db.drop();
});

beforeEach(async () => {
  // Each case counts its own rows and jobs.
  await run(db.pool("superuser"), "DELETE FROM jobs.job");
  await run(db.pool("superuser"), "DELETE FROM app.outbox");
});

async function addOperation(client: pg.PoolClient): Promise<OperationId> {
  const id = randomUUID() as OperationId;
  const outcome = await insertOperation(client, {
    id,
    organizationId: null,
    principalKind: "system",
    principalId: "system",
    action: "environment.provision",
    target: randomUUID(),
    idempotencyKey: randomUUID(),
    state: "accepted",
    fingerprint: null,
    fingerprintKeyId: null,
    result: null,
  });
  expect(outcome).toBe("inserted");
  return id;
}

async function committedRows(count: number): Promise<OperationId[]> {
  return withTransaction(api, async (tx) => {
    const ids: OperationId[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = await addOperation(tx);
      await enqueueOutbox(tx, id, "environment.provision");
      ids.push(id);
    }
    return ids;
  });
}

async function jobData(): Promise<unknown[]> {
  const rows = await run<{ data: unknown }>(
    db.pool("superuser"),
    "SELECT data FROM jobs.job WHERE name = 'environment.provision' ORDER BY created_on",
  );
  return rows.map((row) => row.data);
}

async function outboxStates(): Promise<string[]> {
  const rows = await run<{ state: string }>(
    db.pool("superuser"),
    "SELECT state FROM app.outbox ORDER BY created_at",
  );
  return rows.map((row) => row.state);
}

describe("outbox", () => {
  it("a job carries an operation id and nothing else", async () => {
    const [id] = await committedRows(1);
    expect(await dispatchOutbox(api, sender)).toBe(1);
    expect(await jobData()).toEqual([{ operationId: id }]);
    expect(jobPayloadSchema.safeParse({ operationId: id }).success).toBe(true);
    expect(jobPayloadSchema.safeParse({ operationId: id, name: "x" }).success).toBe(false);
  });

  it("an outbox row written in a rolled-back transaction is never delivered", async () => {
    await expect(
      withTransaction(api, async (tx) => {
        const id = await addOperation(tx);
        await enqueueOutbox(tx, id, "environment.provision");
        throw new Error("abandon");
      }),
    ).rejects.toThrow("abandon");
    expect(await dispatchOutbox(api, sender)).toBe(0);
    expect(await jobData()).toEqual([]);
    expect(await outboxStates()).toEqual([]);
  });

  it("a committed row is delivered once and marked", async () => {
    await committedRows(1);
    expect(await dispatchOutbox(api, sender)).toBe(1);
    expect(await dispatchOutbox(api, sender)).toBe(0);
    expect(await jobData()).toHaveLength(1);
    expect(await outboxStates()).toEqual(["delivered"]);
  });

  it("two dispatchers running together deliver each row once", async () => {
    const ids = await committedRows(50);
    const second = createPool(db.targets.api_runtime, { max: 4 });
    const secondSender = await createSender(second);
    try {
      const [a, b] = await Promise.all([
        dispatchOutbox(api, sender),
        dispatchOutbox(second, secondSender),
      ]);
      expect(a + b).toBe(50);
    } finally {
      await secondSender.stop();
      await second.end();
    }
    const data = (await jobData()) as { operationId: string }[];
    expect(data).toHaveLength(50);
    expect(new Set(data.map((entry) => entry.operationId))).toEqual(new Set(ids));
    expect(new Set(await outboxStates())).toEqual(new Set(["delivered"]));
  });

  it("a dispatcher killed after send and before commit delivers again and the row ends delivered", async () => {
    const [id] = await committedRows(1);
    await expect(
      dispatchOutbox(api, sender, {
        beforeCommit: () => Promise.reject(new Error("killed before commit")),
      }),
    ).rejects.toThrow("killed before commit");
    expect(await outboxStates()).toEqual(["pending"]);
    expect(await dispatchOutbox(api, sender)).toBe(1);
    expect(await outboxStates()).toEqual(["delivered"]);
    // The send is part of the dispatcher's transaction, so the killed attempt left no job.
    expect(await jobData()).toEqual([{ operationId: id }]);
  });
});

describe("withTransaction", () => {
  it("a throw rolls back and releases the client", async () => {
    const pool = createPool(db.targets.api_runtime, { max: 1 });
    try {
      const id = randomUUID();
      await expect(
        withTransaction(pool, async (tx) => {
          // A row the API may write (since migration 0010 it creates no organization).
          await tx.query(
            "INSERT INTO app.rate_limit (scope, key_digest, window_start, count) VALUES ('test:rollback', sha256(convert_to($1, 'UTF8')), now(), 1)",
            [id],
          );
          throw new Error("roll back");
        }),
      ).rejects.toThrow("roll back");
      expect(pool.totalCount - pool.idleCount).toBe(0);
      const rows = await run(
        db.pool("superuser"),
        "SELECT 1 FROM app.rate_limit WHERE scope = 'test:rollback' AND key_digest = sha256(convert_to($1, 'UTF8'))",
        [id],
      );
      expect(rows).toEqual([]);
      // The only client of the pool was released: another transaction can start.
      const level = await withTransaction(pool, async (tx) => {
        const result = await tx.query<{ level: string }>(
          "SELECT current_setting('transaction_isolation') AS level",
        );
        return result.rows[0]?.level;
      });
      expect(level).toBe("read committed");
    } finally {
      await pool.end();
    }
  });
});
