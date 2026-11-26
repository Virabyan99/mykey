// Run 11.3 Task B Step 3 (spec §6 item 8; Review focus 3): a fleet that
// starts together. Ten servers of ONE environment (the hard case: instances of
// one application), each with its own runtime credential, all behind one
// address, each start an exchange and then the complete read, and all of them
// start again. The limiter runs with the product's limits, and both calls go
// through the CLI's own client (Run 11.4), so a `busy` is waited out exactly
// as a real start waits (BUSY_PAUSES_MS).
//
// What paces a fleet is not a rate limit: complete reads of one environment
// are admitted about two every 1.6 s (D-49's read cool-down, two large
// requests a process). Measured in this run (D-83): with the five requests of
// cli-v0.1.2, eight of the ten started; with ten requests all do, one round in
// 7.7 s and two in 16.8 s. The spec's 20 s is what was measured, not what this
// test can promise on a slower machine: its own bound is the worst case.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { windowSecondsLeft } from "@mykey/api";
import { createClient, type ApiClient } from "@mykey/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueRuntimeFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { ENV_NAMES } from "../../harness/machine.ts";
import { measure } from "../../harness/measure.ts";

const FLEET = 10;
const SEEDED = 25;
/** The spec's figure, recorded against the measurement (measurements.json). */
const SPEC_MS = 20_000;
/** The worst case this test allows: each round is five cool-downs and their reads. */
const WITHIN_MS = 30_000;

let f: CredentialsFixture;
let client: ApiClient;
const secrets: string[] = [];

const nextWindow = () => f.api.superuser.query("DELETE FROM app.rate_limit");

beforeAll(async () => {
  f = await createCredentialsFixture({ rateLimits: "product" });
  client = createClient(new URL(f.api.baseUrl), {
    extraCa: readFileSync(f.stack.api.certAuthorityPath, "utf8"),
  });
  await f.seedEnvironment("env1a", SEEDED, 64);
  // A person issues five credentials a minute (rl:issue): two windows for ten.
  for (let index = 0; index < FLEET; index += 1) {
    if (index === 5) await nextWindow();
    secrets.push(
      (await issueRuntimeFor(f, "env1a", { name: `server-${String(index)}` })).clientSecret,
    );
  }
}, 600_000);

afterAll(async () => {
  await f.close();
});

/** One start of one server: its exchange, then every value. Answers how long it took. */
async function start(secret: string): Promise<{ ms: number; values: number }> {
  const began = performance.now();
  const exchanged = await client.exchange(secret);
  const resolved = await client.resolve(
    { project: f.env("env1a").projectId, env: ENV_NAMES.env1a },
    exchanged.token,
  );
  return { ms: performance.now() - began, values: resolved.entries.length };
}

describe("a fleet that starts together", () => {
  it("ten runtime credentials of one environment from one source, each exchanging and resolving twice through the CLI's own client, all succeed under the product's limits", async () => {
    // A whole window ahead and no count from the setup: the fleet meets the limits as they are.
    const left = windowSecondsLeft(Date.now());
    if (left < 25) await sleep(left * 1000 + 500);
    await f.api.superuser.query("DELETE FROM app.rate_limit");

    const began = performance.now();
    const first = await Promise.all(secrets.map((secret) => start(secret)));
    const second = await Promise.all(secrets.map((secret) => start(secret)));
    const total = performance.now() - began;

    for (const [round, starts] of [first, second].entries()) {
      expect(starts.length, `round ${String(round + 1)}`).toBe(FLEET);
      for (const one of starts) expect(one.values).toBe(SEEDED);
    }
    expect(total).toBeLessThan(WITHIN_MS);
    const all = [...first, ...second].map((one) => one.ms);
    measure("fleet.servers", FLEET);
    measure("fleet.slowest_start_ms", Math.round(Math.max(...all)));
    measure("fleet.two_rounds_ms", Math.round(total));
    measure("fleet.within_spec_20s", total < SPEC_MS ? 1 : 0);
    // Nothing was refused for good: no start threw, and the limiter refused none of them.
    const limited = f.api.logs.filter((entry) => entry.event === "rate_limited");
    expect(limited).toEqual([]);
  }, 120_000);
});
