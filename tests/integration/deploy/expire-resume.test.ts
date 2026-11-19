// Run 6.9 Task C (P-129, M-7): an import left awaiting_input past the replay
// window is expired together with its entries, so a resume answers
// 409 replay_expired instead of parking on idempotency_conflict. A parked
// import whose entries are still inside the window is left alone. Values are
// synthetic with a run-time canary.
import { randomBytes, randomUUID } from "node:crypto";
import { createPool, expireOperations, withTransaction } from "@mykey/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  type Answer,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;
let maintenance: ReturnType<typeof createPool>;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

beforeAll(async () => {
  f = await createSecretsFixture();
  maintenance = createPool(f.api.database.targets.maintenance, { max: 1 });
}, 600_000);

afterAll(async () => {
  await maintenance.end();
  await f.close();
});

const unique = () => `M_${randomBytes(5).toString("hex").toUpperCase()}`;
const fileOf = (n: number) =>
  Array.from({ length: n }, () => `${unique()}=${mark}-${randomUUID()}\n`).join("");

async function waiting(text: string): Promise<string> {
  const previewed = await f.send("POST", `${f.env("env1a").path}/import/preview`, {
    text,
    user: "ownerA",
    key: null,
  });
  expect(previewed.status).toBe(200);
  f.setImportBudget(0);
  const answer = await f.send(
    "POST",
    `${f.env("env1a").path}/import/${previewed.body.previewId as string}/apply`,
    { text, user: "ownerA" },
  );
  f.setImportBudget(null);
  expect(answer.status).toBe(202);
  expect(answer.body.state).toBe("awaiting_input");
  return answer.body.operationId as string;
}

const resume = (operationId: string, text: string): Promise<Answer> =>
  f.send("POST", `${f.env("env1a").path}/import-operations/${operationId}/resume`, {
    text,
    user: "ownerA",
    key: null,
  });

/** 31 days pass for this import's entries: their replay window ends. */
async function age(parentId: string): Promise<void> {
  await f.api.superuser.query(
    `UPDATE app.operation SET replay_expires_at = now() - interval '1 day'
      WHERE parent_operation_id = $1 AND replay_expires_at IS NOT NULL`,
    [parentId],
  );
}

const expire = () => withTransaction(maintenance, (tx) => expireOperations(tx));

describe("operations-expire and a parked import (M-7)", () => {
  it("an import parent left awaiting_input past its entries' window is expired with them; a resume answers 409 replay_expired", async () => {
    const text = fileOf(3);
    const parent = await waiting(text);
    await age(parent);
    expect(await expire()).toBeGreaterThanOrEqual(2);

    const rows = await f.api.superuser.query<{
      parent: boolean;
      state: string;
      error_code: string | null;
      fingerprint: string | null;
    }>(
      `SELECT parent_operation_id IS NULL AS parent, state, error_code, fingerprint
         FROM app.operation WHERE id = $1 OR parent_operation_id = $1`,
      [parent],
    );
    const top = rows.rows.find((r) => r.parent);
    expect(top).toMatchObject({
      state: "rejected",
      error_code: "replay_expired",
      fingerprint: null,
    });
    for (const child of rows.rows.filter((r) => !r.parent)) {
      expect(["succeeded", "partial", "rejected"]).toContain(child.state);
      expect(child.fingerprint).toBeNull();
    }
    const tombstones = await f.api.superuser.query(
      `SELECT 1 FROM app.operation_tombstone t JOIN app.operation o
          ON o.idempotency_key = t.idempotency_key AND o.action = t.action
       WHERE o.id = $1`,
      [parent],
    );
    expect(tombstones.rowCount).toBe(1);

    const answer = await resume(parent, text);
    expect([answer.status, (answer.body.error as { code?: string } | undefined)?.code]).toEqual([
      409,
      "replay_expired",
    ]);
  });

  it("a parked import whose entries are inside their window is not touched, and resumes", async () => {
    const text = fileOf(2);
    const parent = await waiting(text);
    await expire();
    const state = await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.operation WHERE id = $1",
      [parent],
    );
    expect(state.rows[0]?.state).toBe("awaiting_input");
    expect((await resume(parent, text)).status).toBe(200);
  });
});
