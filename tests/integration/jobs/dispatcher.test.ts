// Run 3.1 Task E: the outbox dispatcher runs inside the API process. A
// committed row becomes a job within seconds, and the dispatcher survives a
// PostgreSQL restart without a process restart.
//
// The suite owns its stack, because it restarts PostgreSQL; the API reaches
// the database through a relay on a fixed local port (as in health.test.ts).
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperationId } from "@mykey/contracts";
import { enqueueOutbox, insertOperation, withTransaction } from "@mykey/db";
import { startTestApi, type TestApi } from "../../harness/api.ts";
import { restartService, startStack, type Stack } from "../../harness/stack.ts";

let stack: Stack;
let api: TestApi;

beforeAll(async () => {
  stack = await startStack();
  api = await startTestApi({ stack, relayDatabase: true });
}, 300_000);

afterAll(async () => {
  await api.close();
  await stack.stop();
});

async function commitRow(): Promise<OperationId> {
  const id = randomUUID() as OperationId;
  await withTransaction(api.pool, async (tx) => {
    await insertOperation(tx, {
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
    await enqueueOutbox(tx, id, "environment.provision");
  });
  return id;
}

async function deliveredWithin(id: OperationId, ms: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const jobs = await api.superuser
      .query("SELECT 1 FROM jobs.job WHERE data = $1::jsonb", [JSON.stringify({ operationId: id })])
      .catch(() => ({ rowCount: 0 }));
    if (jobs.rowCount === 1) return true;
    await sleep(100);
  }
  return false;
}

async function healthWithin(status: number, ms: number): Promise<number> {
  const started = Date.now();
  let last = 0;
  while (Date.now() - started < ms) {
    last = (await api.request("GET", "/health")).status;
    if (last === status) return last;
    await sleep(250);
  }
  return last;
}

describe("outbox dispatcher in the API", () => {
  it("delivers a committed row within three seconds", async () => {
    const id = await commitRow();
    expect(await deliveredWithin(id, 3_000)).toBe(true);
    const row = await api.superuser.query<{ state: string }>(
      "SELECT state FROM app.outbox WHERE operation_id = $1",
      [id],
    );
    expect(row.rows).toEqual([{ state: "delivered" }]);
  });

  it("resumes after a PostgreSQL restart without a process restart", async () => {
    await restartService(stack, "postgres");
    expect(await healthWithin(200, 30_000)).toBe(200);
    const id = await commitRow();
    expect(await deliveredWithin(id, 10_000)).toBe(true);
  });
});
