// Run 6.3 Task B (P-114, D-49): does one credential reading a large
// environment back to back starve a person's write? The environment holds
// 1,000 keys of 8 KiB; the credential calls `resolve` one after the other for
// 20 s; meanwhile a person updates one secret every second. The pass line:
// each write succeeds within three attempts 1 s apart. The measured worst case
// goes to docs/evidence/session-6/run-6.3-starvation.json for the run note.
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { machineCall } from "../../harness/machine.ts";

let f: CredentialsFixture;
let token: string;
let current: { version: number; stateTag: string };
const NAME = "STARVE_TARGET";
const EVIDENCE = "docs/evidence/session-6/run-6.3-starvation.json";
const currentOf = (body: Record<string, unknown>) => {
  const result = body.result as { version: number; stateTag: string };
  return { version: result.version, stateTag: result.stateTag };
};

beforeAll(async () => {
  f = await createCredentialsFixture();
  // 999 seeded and the target: the 1,000 names an environment may hold.
  await f.seedEnvironment("env1a", 999, 8192);
  const made = await f.create("env1a", NAME, "synthetic-0");
  expect(made.status, made.code ?? "").toBe(201);
  current = currentOf(made.body);
  ({ token } = await issueFor(f, "env1a"));
}, 900_000);

afterAll(async () => {
  await f.close();
});

describe("a back-to-back reader and a person's write (P-114)", () => {
  it("each write succeeds within three attempts 1 s apart while one credential resolves for 20 s", async () => {
    const end = Date.now() + 20_000;
    const reads: { status: number; ms: number }[] = [];
    const reader = (async () => {
      while (Date.now() < end) {
        const started = performance.now();
        const answer = await machineCall(f, "resolve", { token });
        reads.push({ status: answer.status, ms: Math.round(performance.now() - started) });
      }
    })();
    const writes: { attempts: number; ms: number; codes: string[] }[] = [];
    let n = 0;
    while (Date.now() < end) {
      const started = performance.now();
      const codes: string[] = [];
      let attempts = 0;
      for (; attempts < 3; attempts += 1) {
        if (attempts > 0) await sleep(1000);
        const answer = await f.update("env1a", NAME, `synthetic-${String((n += 1))}`, current);
        if (answer.status === 200) {
          current = currentOf(answer.body);
          codes.push("ok");
          break;
        }
        codes.push(answer.code ?? String(answer.status));
      }
      writes.push({ attempts: attempts + 1, ms: Math.round(performance.now() - started), codes });
      await sleep(1000);
    }
    await reader;
    const worst = writes.reduce((a, b) => (b.attempts > a.attempts || b.ms > a.ms ? b : a));
    const measured = {
      readerRequests: reads.length,
      readerStatuses: [...new Set(reads.map((read) => read.status))],
      readerMsMax: Math.max(...reads.map((read) => read.ms)),
      writes: writes.length,
      writesWithinThree: writes.filter((write) => write.codes.at(-1) === "ok").length,
      worst,
    };
    writeFileSync(EVIDENCE, `${JSON.stringify(measured, null, 2)}\n`);
    console.log(`starvation: ${JSON.stringify(measured)}`);
    expect(reads.length).toBeGreaterThan(1);
    expect(measured.writesWithinThree).toBe(writes.length);
  }, 300_000);
});
