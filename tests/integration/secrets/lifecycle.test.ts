// A key's whole life (Run 4.4, Review focus 4, P-70): create → update →
// delete → undelete → restore → delete. After every step the environment's
// live bytes, its name count and its generation are exact, and the index
// matches the backend.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  type Answer,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

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
const ofLength = (bytes: number): string =>
  randomBytes(Math.ceil(bytes / 2) + 1)
    .toString("hex")
    .slice(0, bytes);
const currentOf = (answer: Answer): Current => {
  expect(answer.status, answer.code ?? "").toBeLessThan(300);
  const result = answer.body.result as Current;
  return { version: result.version, stateTag: result.stateTag };
};

async function counters(): Promise<{ bytes: number; names: number; generation: bigint }> {
  const { environmentId } = f.env("env1b");
  const result = await f.api.superuser.query<{
    live_value_bytes: string;
    metadata_generation: string;
    names: number;
  }>(
    `SELECT e.live_value_bytes, e.metadata_generation,
            (SELECT count(*)::int FROM app.secret_index i WHERE i.environment_id = e.id) AS names
       FROM app.environment e WHERE e.id = $1`,
    [environmentId],
  );
  const row = result.rows[0]!;
  return {
    bytes: Number(row.live_value_bytes),
    names: row.names,
    generation: BigInt(row.metadata_generation),
  };
}

describe("a key's life", () => {
  it("create 100 → update 250 → delete → undelete → restore 1 → delete: bytes 100, 250, 0, 250, 100, 0", async () => {
    const name = `L_${randomBytes(5).toString("hex").toUpperCase()}`;
    const start = await counters();
    expect(start.names).toBe(0);
    const steps: { run: (current: Current | null) => Promise<Answer>; bytes: number }[] = [
      { run: () => f.create("env1b", name, ofLength(100)), bytes: 100 },
      { run: (c) => f.update("env1b", name, ofLength(250), c!), bytes: 250 },
      { run: (c) => f.act("env1b", name, "delete", c!), bytes: 0 },
      { run: (c) => f.act("env1b", name, "undelete", c!), bytes: 250 },
      { run: (c) => f.act("env1b", name, "restore", c!, { sourceVersion: 1 }), bytes: 100 },
      { run: (c) => f.act("env1b", name, "delete", c!), bytes: 0 },
    ];
    let current: Current | null = null;
    let generation = start.generation;
    for (const [index, step] of steps.entries()) {
      current = currentOf(await step.run(current));
      const now = await counters();
      expect(now.bytes, `step ${String(index + 1)} bytes`).toBe(step.bytes);
      expect(now.names, `step ${String(index + 1)} names`).toBe(1);
      expect(now.generation, `step ${String(index + 1)} generation`).toBe(generation + 1n);
      generation = now.generation;
      await expectIndexMatchesBackend(f, "env1b");
    }
    expect(current?.version).toBe(3);
  });
});
