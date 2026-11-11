// Run 2.4: one effect per environment at a time (Doc 06 §6.2).
import { randomUUID } from "node:crypto";
import { createPool } from "@mykey/db";
import { executeWrite, finalize, type SpikeOutcome } from "@mykey/operations/spike";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSharedStack } from "../../harness/stack.ts";
import {
  auditedWrites,
  backendVersions,
  effectsFixture,
  expectConsistent,
  operationFor,
  operationOf,
  type EffectsFixture,
} from "./fixture.ts";

let fixture: EffectsFixture;

beforeAll(async () => {
  fixture = await effectsFixture(await getSharedStack());
});

afterAll(async () => {
  await (fixture as EffectsFixture | undefined)?.close();
});

/** An executor with its own connections and its own boot id. */
async function independentExecute(
  input: Parameters<typeof executeWrite>[1],
): Promise<SpikeOutcome> {
  const runtimePool = createPool(fixture.db.targets.api_runtime, { max: 2 });
  try {
    return await executeWrite(
      {
        runtimePool,
        lockTarget: fixture.db.targets.api_runtime,
        bao: fixture.runtimeBao(),
        bootId: randomUUID(),
      },
      input,
    );
  } finally {
    await runtimePool.end();
  }
}

describe("exclusion", () => {
  it("twenty executors on one secret with the same expected version: one succeeds, one write", async () => {
    const base = fixture.write();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        independentExecute({ ...base, idempotencyKey: randomUUID() }),
      ),
    );
    const succeeded = outcomes.filter((outcome) => outcome.state === "succeeded");
    expect(succeeded).toHaveLength(1);
    const codes = outcomes.flatMap((outcome) =>
      outcome.state === "rejected" ? [outcome.code] : [],
    );
    expect(codes).toHaveLength(19);
    expect(
      codes.filter((code) => code !== "version_conflict" && code !== "state_conflict"),
    ).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.state === "uncertain")).toEqual([]);

    let writes = 0;
    for (const outcome of outcomes) writes += await auditedWrites(fixture, outcome.operationId);
    expect(writes).toBe(1);
    expect(await backendVersions(fixture, base)).toEqual([
      { version: 1, operationId: succeeded[0]?.operationId },
    ]);
    await expectConsistent(fixture, base, succeeded[0]?.operationId ?? "", 1);
  });

  it("two environments proceed independently", async () => {
    const outcomes = await Promise.all([
      independentExecute(fixture.write({ environment: 0 })),
      independentExecute(fixture.write({ environment: 1 })),
    ]);
    expect(outcomes.map((outcome) => outcome.state)).toEqual(["succeeded", "succeeded"]);
  });

  it("an effect slot cannot be held twice", async () => {
    const scope = `env:${randomUUID()}`;
    const pool = fixture.db.pool("api_runtime");
    const holders: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const operationId = randomUUID();
      holders.push(operationId);
      await pool.query(
        `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
                                    idempotency_key, state)
         VALUES ($1, $2, 'system', 'g-effect-spike', 'secret.write', $3, $4, 'accepted')`,
        [operationId, fixture.org.organizationId, `${scope}/S`, randomUUID()],
      );
    }
    const insert = (operationId: string) =>
      pool.query(
        "INSERT INTO app.effect_slot (scope_key, operation_id, generation, acquired_at) VALUES ($1, $2, 1, now())",
        [scope, operationId],
      );
    await insert(holders[0] ?? "");
    const second = await insert(holders[1] ?? "").catch((error: unknown) => error);
    expect(second).toBeInstanceOf(pg.DatabaseError);
    expect((second as pg.DatabaseError).code).toBe("23505");
    await pool.query("DELETE FROM app.effect_slot WHERE scope_key = $1", [scope]);
  });

  it("an executor with another boot id cannot finalize an operation", async () => {
    const input = fixture.write();
    const owner = randomUUID();
    const child = fixture.child(input, { crashAt: "after_backend_success", bootId: owner });
    expect(await child.outcome).toBeNull();
    const operationId = await operationFor(fixture, input);
    const sent = { ok: true, status: 200, data: { version: 1 } } as const;
    await expect(
      finalize(fixture.deps({ bootId: randomUUID() }), input, operationId, sent),
    ).rejects.toThrow(/no longer owns/);
    expect((await operationOf(fixture, operationId)).state).toBe("executing");
    // Control: its own boot id finalizes it.
    expect(await finalize(fixture.deps({ bootId: owner }), input, operationId, sent)).toEqual({
      operationId,
      state: "succeeded",
      version: 1,
    });
    await expectConsistent(fixture, input, operationId, 1);
  });
});
