// The complete read at the environment's limits (Run 4.8, P-78): 1,000
// names of 8 KiB, the large-request gate, and a writer that meets the read's
// lock.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  idleAdvisoryLocks,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

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

const read = (env: EnvName) => f.send("GET", `${f.env(env).path}/test-read`, { key: null });
const synthetic = (bytes: number): string =>
  randomBytes(Math.ceil(bytes / 2))
    .toString("hex")
    .slice(0, bytes);

/** A fault hook that holds the first `count` reads after their backend reads until released. */
function holdReads(count: number) {
  const releases: (() => void)[] = [];
  let arrived = 0;
  let allHeld: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    allHeld = resolve;
  });
  f.setFaults(async (point) => {
    if (point !== "after_backend_read" || arrived >= count) return;
    arrived += 1;
    if (arrived === count) allHeld();
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
  });
  return {
    held,
    release() {
      for (const release of releases) release();
    },
  };
}

describe("the complete read at its limits", () => {
  it("1,000 names of 8 KiB (seedEnvironment) are read completely", async () => {
    await f.seedEnvironment("env2a", 1000, 8192);
    const started = performance.now();
    const answer = await read("env2a");
    const seconds = (performance.now() - started) / 1000;
    expect(answer.status).toBe(200);
    expect((answer.body.entries as unknown[]).length).toBe(1000);
    console.log(`complete read of 1,000 names of 8 KiB: ${seconds.toFixed(2)} s`);
    expect(seconds).toBeLessThan(60);
    await expectIndexMatchesBackend(f, "env2a");
  }, 300_000);

  it("a third large read at once → 503 busy", async () => {
    await f.create("env1a", `L_${randomBytes(4).toString("hex").toUpperCase()}`, synthetic(8));
    await f.create("env1b", `L_${randomBytes(4).toString("hex").toUpperCase()}`, synthetic(8));
    const hold = holdReads(2);
    const first = read("env1a");
    const second = read("env1b");
    await hold.held;
    const third = await read("env2a");
    expect(third.status).toBe(503);
    expect(third.code).toBe("busy");
    hold.release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it("a writer during the long read gets busy and succeeds on retry afterwards", async () => {
    const row = await f.indexRow("env2a", "SEED_0000");
    expect(row).not.toBeNull();
    const expected = { version: row?.current_version ?? 0, stateTag: row?.state_tag ?? "" };
    const hold = holdReads(1);
    const reading = read("env2a");
    await hold.held;
    const key = randomUUID();
    const value = synthetic(8192);
    const refused = await f.update("env2a", "SEED_0000", value, expected, { key });
    expect(refused.status).toBe(503);
    expect(refused.code).toBe("busy");
    hold.release();
    expect((await reading).status).toBe(200);
    const retried = await f.update("env2a", "SEED_0000", value, expected, { key });
    expect(retried.status).toBe(200);
    await expectIndexMatchesBackend(f, "env2a");
  }, 120_000);
});
