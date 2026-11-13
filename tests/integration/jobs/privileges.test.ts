// Run 3.1 Task A: the job queue (pg-boss in schema `jobs`, migration 0004) and
// the least rights each runtime role needs to use it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@mykey/db";
import { JOB_KINDS, createSender, createWorker, ensureQueues } from "@mykey/operations";
import type { OperationId } from "@mykey/contracts";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await prepareDatabase();
});

afterAll(async () => {
  await db.drop();
});

describe("job queue", () => {
  it("ensureQueues run twice leaves one queue per job kind", async () => {
    await ensureQueues(db.pool("migration_owner"));
    await ensureQueues(db.pool("migration_owner"));
    const queues = await run<{ name: string }>(
      db.pool("superuser"),
      "SELECT name FROM jobs.queue ORDER BY name",
    );
    expect(queues.map((row) => row.name)).toEqual([...JOB_KINDS].sort());
  });

  it("api_runtime sends a job and provisioner_runtime receives it", async () => {
    await ensureQueues(db.pool("migration_owner"));
    const operationId = randomUUID() as OperationId;
    const received: string[] = [];
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = await createWorker(db.pool("provisioner_runtime"), {
      "environment.provision": (id) => {
        received.push(id);
        release();
        return Promise.resolve();
      },
    });
    const sender = await createSender(db.pool("api_runtime"));
    try {
      await sender.send("environment.provision", operationId);
      await Promise.race([
        done,
        new Promise((_, reject) =>
          setTimeout(() => {
            reject(new Error("no job received"));
          }, 15_000),
        ),
      ]);
      expect(received).toEqual([operationId]);
    } finally {
      await sender.stop();
      await worker.stop();
    }
  });

  it("api_runtime cannot send where ensureQueues never ran (it cannot create the queue)", async () => {
    const bare = await prepareDatabase();
    const pool = createPool(bare.targets.api_runtime, { max: 2 });
    try {
      const sender = await createSender(pool);
      try {
        // The send fails because no queue exists (pg-boss's own refusal)…
        const error = await sender
          .send("environment.provision", randomUUID() as OperationId)
          .catch((caught: unknown) => caught);
        expect((error as { code?: string }).code).toBe("PGBOSS_QUEUE_NOT_FOUND");
      } finally {
        await sender.stop();
      }
      // …and api_runtime cannot make one (Run 4.1 Task D): a denial with its SQLSTATE and
      // object, not any error — pg-boss's createQueue is this function call.
      const client = await pool.connect();
      try {
        const denied = await client
          .query("SELECT jobs.create_queue('environment.provision', '{}'::jsonb)")
          .catch((caught: unknown) => caught);
        expect((denied as { code?: string }).code).toBe("42501");
        expect((denied as Error).message).toBe("permission denied for function create_queue");
        const insert = await client
          .query("INSERT INTO jobs.queue (name) VALUES ('environment.provision')")
          .catch((caught: unknown) => caught);
        expect((insert as { code?: string }).code).toBe("42501");
        expect((insert as Error).message).toBe("permission denied for table queue");
      } finally {
        client.release();
      }
      const queues = await run(bare.pool("superuser"), "SELECT name FROM jobs.queue");
      expect(queues).toEqual([]);
    } finally {
      await pool.end();
      await bare.drop();
    }
  });
});
