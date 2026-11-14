// The complete read under concurrent writers (Run 4.8, AC-1.41, PO-19): two
// API processes, thirty keys, four writers sending creates, updates, deletes,
// undeletes and restores, one import of ten entries in the middle, and four
// readers. Afterwards every read is compared with the set rebuilt from the
// succeeded operations as of the read's generation: the same names, versions
// and digests, exactly. Values are synthetic; only digests are compared.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  sha256,
  type Answer,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture({ processes: 2 });
}, 600_000);

afterAll(async () => {
  await f.close();
});

const ENV = "env1a" as const;
const KEYS = 30;
const WRITERS = 4;
const READERS = 4;
/** The plan's twenty seconds, longer only until the minimum counts are reached. */
const MIN_MS = 20_000;
const MAX_MS = 120_000;
const MIN_READS = 50;
const MIN_MUTATIONS = 200;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const synthetic = (): string => `race-${randomBytes(12).toString("hex")}`;
const bytewise = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

interface Key {
  name: string;
  version: number;
  stateTag: string;
  state: "live" | "deleted";
}

/** Digest of every value written, by `name@version`. */
const digests = new Map<string, string>();
const at = (name: string, version: number) => `${name}@${String(version)}`;

/** Sends with one idempotency key until the answer is not busy. */
async function untilNotBusy(send: (key: string) => Promise<Answer>): Promise<Answer> {
  const key = randomUUID();
  for (;;) {
    const answer = await send(key);
    if (answer.code !== "busy") return answer;
    await sleep(20 + Math.random() * 50);
  }
}

describe("reads race writers", () => {
  it("every read equals the set of its generation exactly", async () => {
    const prefix = `RACE_${randomBytes(3).toString("hex").toUpperCase()}`;
    const keys: Key[] = [];
    for (let index = 0; index < KEYS; index += 1) {
      const name = `${prefix}_${String(index).padStart(2, "0")}`;
      const value = synthetic();
      const answer = await f.create(ENV, name, value);
      expect(answer.status).toBe(201);
      const result = answer.body.result as { version: number; stateTag: string };
      digests.set(at(name, result.version), sha256(value));
      keys.push({ name, version: result.version, stateTag: result.stateTag, state: "live" });
    }

    const started = Date.now();
    let mutations = 0;
    const unexpected: string[] = [];
    const reads: {
      generation: bigint;
      entries: { name: string; version: number; digest: string }[];
    }[] = [];
    const readRefusals: string[] = [];
    const done = () => {
      const elapsed = Date.now() - started;
      if (elapsed >= MAX_MS) return true;
      return elapsed >= MIN_MS && reads.length >= MIN_READS && mutations >= MIN_MUTATIONS;
    };

    const writer = async (index: number): Promise<void> => {
      const mine = keys.filter((_, position) => position % WRITERS === index);
      const to = index % 2 === 0 ? "first" : "second";
      while (!done()) {
        const key = mine[Math.floor(Math.random() * mine.length)];
        if (key === undefined) return;
        const expected = { version: key.version, stateTag: key.stateTag };
        let answer: Answer;
        let written: string | null = null;
        let source: number | null = null;
        if (key.state === "deleted") {
          answer = await untilNotBusy((k) =>
            f.act(ENV, key.name, "undelete", expected, { key: k, to }),
          );
        } else {
          const roll = Math.random();
          if (roll < 0.5) {
            written = synthetic();
            const value = written;
            answer = await untilNotBusy((k) =>
              f.update(ENV, key.name, value, expected, { key: k, to }),
            );
          } else if (roll < 0.75 || key.version < 2) {
            answer = await untilNotBusy((k) =>
              f.act(ENV, key.name, "delete", expected, { key: k, to }),
            );
          } else {
            source = key.version - 1;
            const sourceVersion = source;
            answer = await untilNotBusy((k) =>
              f.act(ENV, key.name, "restore", expected, { key: k, to, sourceVersion }),
            );
          }
        }
        if (answer.status !== 200) {
          unexpected.push(`${key.name} ${String(answer.status)} ${answer.code ?? ""}`);
          return;
        }
        const result = answer.body.result as {
          version: number;
          stateTag: string;
          state: "live" | "deleted";
        };
        if (written !== null) digests.set(at(key.name, result.version), sha256(written));
        if (source !== null) {
          digests.set(at(key.name, result.version), digests.get(at(key.name, source)) ?? "missing");
        }
        key.version = result.version;
        key.stateTag = result.stateTag;
        key.state = result.state;
        mutations += 1;
      }
    };

    const reader = async (): Promise<void> => {
      while (!done()) {
        const answer = await f.send("GET", `${f.env(ENV).path}/test-read`, { key: null });
        if (answer.status === 200) {
          reads.push({
            generation: BigInt(answer.body.generation as string),
            entries: answer.body.entries as { name: string; version: number; digest: string }[],
          });
        } else if (answer.code !== "busy") {
          readRefusals.push(`${String(answer.status)} ${answer.code ?? ""}`);
        }
        await sleep(50);
      }
    };

    const importer = async (): Promise<void> => {
      await sleep(MIN_MS / 2);
      const entries = Array.from({ length: 10 }, (_, index): [string, string] => [
        `${prefix}_IMP_${String(index)}`,
        synthetic(),
      ]);
      for (const [name, value] of entries) digests.set(at(name, 1), sha256(value));
      const text = entries.map(([name, value]) => `${name}=${value}\n`).join("");
      let preview: Answer;
      do {
        preview = await f.send("POST", `${f.env(ENV).path}/import/preview`, { text, key: null });
      } while (preview.code === "busy");
      expect(preview.status).toBe(200);
      let answer = await untilNotBusy((k) =>
        f.send("POST", `${f.env(ENV).path}/import/${preview.body.previewId as string}/apply`, {
          text,
          key: k,
        }),
      );
      const parentId = answer.body.operationId as string;
      while (answer.status === 202 || answer.code === "busy") {
        await sleep(100);
        answer = await f.send("POST", `${f.env(ENV).path}/import-operations/${parentId}/resume`, {
          text,
          key: null,
        });
      }
      expect(answer.status).toBe(200);
      expect(answer.body.state).toBe("succeeded");
      mutations += 10;
    };

    await Promise.all([
      ...Array.from({ length: WRITERS }, (_, index) => writer(index)),
      ...Array.from({ length: READERS }, () => reader()),
      importer(),
    ]);
    const seconds = (Date.now() - started) / 1000;
    expect(unexpected).toEqual([]);
    expect(readRefusals).toEqual([]);
    console.log(
      `race: ${String(reads.length)} reads, ${String(mutations)} mutations in ${seconds.toFixed(1)} s`,
    );
    expect(reads.length, "reads (fails as empty below the minimum)").toBeGreaterThanOrEqual(
      MIN_READS,
    );
    expect(mutations, "mutations (fails as empty below the minimum)").toBeGreaterThanOrEqual(
      MIN_MUTATIONS,
    );

    // Every succeeded secret operation of the environment, in generation order.
    const ops = await f.api.superuser.query<{
      result: { name: string; version: number; state: "live" | "deleted"; generation: string };
    }>(
      `SELECT result FROM app.operation
        WHERE environment_id = $1 AND state = 'succeeded' AND action LIKE 'secrets.%'`,
      [f.env(ENV).environmentId],
    );
    const history = ops.rows
      .map((row) => ({ ...row.result, generation: BigInt(row.result.generation) }))
      .sort((a, b) => (a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0));
    const generations = new Set(history.map((op) => op.generation));
    expect(generations.size, "one generation per change").toBe(history.length);

    let mismatches = 0;
    for (const observed of reads) {
      const state = new Map<string, { version: number; state: string }>();
      for (const op of history) {
        if (op.generation > observed.generation) break;
        state.set(op.name, { version: op.version, state: op.state });
      }
      const expected = [...state.entries()]
        .filter(([, value]) => value.state === "live")
        .map(([name, value]) => ({
          name,
          version: value.version,
          digest: digests.get(at(name, value.version)) ?? "missing",
        }))
        .sort((a, b) => bytewise(a.name, b.name));
      const mine = observed.entries.filter((entry) => entry.name.startsWith(prefix));
      try {
        expect(mine).toEqual(expected);
      } catch (error) {
        mismatches += 1;
        if (mismatches === 1) throw error;
      }
    }
    expect(mismatches).toBe(0);
    await expectIndexMatchesBackend(f, ENV);
  }, 300_000);
});
