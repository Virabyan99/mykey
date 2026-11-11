// Run 2.4: the maintenance procedure of Doc 06 §6.4, once, end to end. A
// restart of OpenBao is what makes a possibly-pending write final. This suite
// owns its stack: it stops, pauses and kills OpenBao.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  killService,
  pauseService,
  serviceRunning,
  startService,
  startStack,
  stopService,
  type Stack,
} from "../../harness/stack.ts";
import { startTlsRelay, type TlsRelay } from "../../harness/tls-relay.ts";
import {
  backendVersions,
  effectsFixture,
  expectConsistent,
  operationFor,
  operationOf,
  type EffectsFixture,
} from "./fixture.ts";

let stack: Stack;
let fixture: EffectsFixture;

beforeAll(async () => {
  stack = await startStack();
  fixture = await effectsFixture(stack);
}, 600_000);

afterAll(async () => {
  await (fixture as EffectsFixture | undefined)?.close().catch(() => undefined);
  await (stack as Stack | undefined)?.stop();
}, 300_000);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function relay(): Promise<{ relay: TlsRelay; url: string }> {
  const bao = new URL(stack.bao.url);
  const started = await startTlsRelay({ host: bao.hostname, port: Number(bao.port) });
  return { relay: started, url: `https://127.0.0.1:${started.port}` };
}

async function dispatchedOperation(input: Parameters<typeof operationFor>[1]): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const id = await operationFor(fixture, input);
      if ((await operationOf(fixture, id)).dispatched_at !== null) return id;
    } catch {
      // not inserted yet
    }
    if (Date.now() > deadline) throw new Error("the executor never dispatched");
    await sleep(100);
  }
}

/** Polls the key for `ms`; returns the most versions ever seen. */
async function versionsDuring(
  input: Parameters<typeof backendVersions>[1],
  ms: number,
): Promise<number> {
  const until = Date.now() + ms;
  let most = 0;
  while (Date.now() < until) {
    most = Math.max(most, (await backendVersions(fixture, input)).length);
    await sleep(1_000);
  }
  return most;
}

describe("maintenance (Doc 06 §6.4)", () => {
  it("a restart ends a request held on the wire", async () => {
    const { relay: proxy, url } = await relay();
    const input = fixture.write();
    const child = fixture.child(input, { url, hangAfterSend: true });
    try {
      // 8 s: without the restart this request would land (late-write.test.ts).
      proxy.delayRequests(8_000);
      const operationId = await dispatchedOperation(input);
      await sleep(2_000);
      await child.kill();
      expect(child.process.exitCode !== null || child.process.signalCode !== null).toBe(true);
      await stopService(stack, "openbao");
      expect(await serviceRunning(stack, "openbao")).toBe(false);
      await startService(stack, "openbao");
      proxy.clear();
      expect(await versionsDuring(input, 30_000)).toBe(0);

      expect((await fixture.reconcile(operationId, true)).state).toBe("rejected");
      await expectConsistent(fixture, input, operationId, 0);
      // The next write succeeds (the stack's address after the restart).
      expect(await fixture.execute(fixture.write({ name: input.name }))).toMatchObject({
        state: "succeeded",
        version: 1,
      });
    } finally {
      await child.kill();
      await proxy.close();
    }
  }, 180_000);

  it("a restart ends a request the server had accepted but not processed", async () => {
    const input = fixture.write();
    await pauseService(stack, "openbao");
    // The kernel of the paused container accepts the connection; nothing answers it.
    const child = fixture.child(input, { hangAfterSend: true });
    try {
      const operationId = await dispatchedOperation(input);
      await sleep(2_000);
      await killService(stack, "openbao");
      await startService(stack, "openbao");
      await child.kill();
      expect(await versionsDuring(input, 30_000)).toBe(0);
      expect((await fixture.reconcile(operationId, true)).state).toBe("rejected");
      await expectConsistent(fixture, input, operationId, 0);
    } finally {
      await child.kill();
    }
  }, 180_000);

  it("a request already inside OpenBao is complete after a graceful stop — and that is visible", async () => {
    const { relay: proxy, url } = await relay();
    const input = fixture.write();
    const child = fixture.child(input, { url, hangAfterSend: true });
    try {
      proxy.delayResponses(15_000);
      const operationId = await dispatchedOperation(input);
      await sleep(2_000);
      await stopService(stack, "openbao");
      await startService(stack, "openbao");
      await child.kill();
      const versions = await backendVersions(fixture, input);
      expect(versions).toEqual([{ version: 1, operationId }]);
      expect((await fixture.reconcile(operationId, true)).state).toBe("succeeded");
      // After the restart the backend state is final: nothing lands later.
      expect(await versionsDuring(input, 30_000)).toBe(1);
      await expectConsistent(fixture, input, operationId, 1);
    } finally {
      await child.kill();
      await proxy.close();
    }
  }, 180_000);
});
