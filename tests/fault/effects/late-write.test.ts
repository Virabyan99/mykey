// Run 2.4: writes that land after everyone stopped waiting (G-EFFECT).
//
// Observed on OpenBao 2.7.2 (ruling R47): a connection whose request has not
// arrived about 10 s after the TLS handshake is closed by the server (its
// listener's header read timeout). A request held on the wire for up to ~10 s
// still lands; one held longer never does. The scenarios use an 8 s hold.
import { randomUUID } from "node:crypto";
import { spikeSecretPath } from "@mykey/operations/spike";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSharedStack, type Stack } from "../../harness/stack.ts";
import { startTlsRelay, type TlsRelay } from "../../harness/tls-relay.ts";
import {
  auditedWrites,
  backendVersions,
  effectsFixture,
  expectConsistent,
  operationFor,
  operationOf,
  type EffectsFixture,
} from "./fixture.ts";

const HOLD_MS = 8_000;

let stack: Stack;
let fixture: EffectsFixture;

beforeAll(async () => {
  stack = await getSharedStack();
  fixture = await effectsFixture(stack);
});

afterAll(async () => {
  await (fixture as EffectsFixture | undefined)?.close();
});

async function relay(): Promise<{ relay: TlsRelay; url: string }> {
  const bao = new URL(stack.bao.url);
  const started = await startTlsRelay({ host: bao.hostname, port: Number(bao.port) });
  return { relay: started, url: `https://127.0.0.1:${started.port}` };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Waits until the child has marked its operation dispatched; returns the operation id and the time. */
async function dispatched(
  input: Parameters<EffectsFixture["write"]>[0] & object,
): Promise<{ id: string; at: number }> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const id = await operationFor(fixture, input as never);
      if ((await operationOf(fixture, id)).dispatched_at !== null) return { id, at: Date.now() };
    } catch {
      // not inserted yet
    }
    if (Date.now() > deadline) throw new Error("the executor never dispatched");
    await sleep(100);
  }
}

describe("late writes", () => {
  it("a delayed answer is uncertain, not failed", async () => {
    const { relay: proxy, url } = await relay();
    try {
      proxy.delayResponses(HOLD_MS);
      const input = fixture.write();
      const outcome = await fixture.execute(input, { url, deadlineMs: 5_000 });
      expect(outcome.state).toBe("uncertain");
      // The request reached the server at once; only the answer was late.
      expect(await backendVersions(fixture, input)).toEqual([
        { version: 1, operationId: outcome.operationId },
      ]);

      const second = await fixture.execute(fixture.write());
      expect(second).toMatchObject({ state: "rejected", code: "state_conflict" });
      expect(await auditedWrites(fixture, second.operationId)).toBe(0);

      expect((await fixture.reconcile(outcome.operationId, false)).state).toBe("succeeded");
      await expectConsistent(fixture, input, outcome.operationId, 1);
    } finally {
      await proxy.close();
    }
  });

  it("a write can land after everyone has stopped waiting", async () => {
    const { relay: proxy, url } = await relay();
    const input = fixture.write();
    const child = fixture.child(input, { url, hangAfterSend: true });
    try {
      proxy.delayRequests(HOLD_MS);
      const { id, at } = await dispatched(input);
      await sleep(6_000 - (Date.now() - at));
      expect((await operationOf(fixture, id)).state).toBe("executing");
      expect(await backendVersions(fixture, input)).toEqual([]);
      const refused = await fixture.execute(fixture.write());
      expect(refused).toMatchObject({ state: "rejected", code: "state_conflict" });

      let landedAfter = -1;
      while (Date.now() - at < 15_000) {
        if ((await backendVersions(fixture, input)).length > 0) {
          landedAfter = Date.now() - at;
          break;
        }
        await sleep(200);
      }
      console.info(`late write landed ${landedAfter} ms after the dispatch marker`);
      expect(landedAfter).toBeGreaterThanOrEqual(HOLD_MS - 1_000);
      expect(landedAfter).toBeLessThan(HOLD_MS + 3_000);
      await child.kill();
      expect((await fixture.reconcile(id, true)).state).toBe("succeeded");
      await expectConsistent(fixture, input, id, 1);
    } finally {
      await child.kill();
      await proxy.close();
    }
  });

  it("no state is trusted while the old request may still arrive", async () => {
    const { relay: proxy, url } = await relay();
    const input = fixture.write();
    const child = fixture.child(input, { url, hangAfterSend: true });
    try {
      proxy.delayRequests(HOLD_MS);
      const { id, at } = await dispatched(input);
      await sleep(6_000 - (Date.now() - at));
      const early = await fixture.reconcile(id, false);
      expect(early.state).toBe("uncertain");
      expect(early.evidence).toContain("executors are not excluded: the request may still arrive");
      expect(await backendVersions(fixture, input)).toEqual([]);
      // It does arrive.
      await sleep(HOLD_MS + 2_000 - (Date.now() - at));
      expect((await fixture.reconcile(id, false)).state).toBe("succeeded");
      await expectConsistent(fixture, input, id, 1);
    } finally {
      await child.kill();
      await proxy.close();
    }
  });

  it("a request held longer than the server waits for it never lands (observed bound)", async () => {
    const { relay: proxy, url } = await relay();
    const input = fixture.write();
    const child = fixture.child(input, { url, hangAfterSend: true });
    try {
      proxy.delayRequests(15_000);
      const { id, at } = await dispatched(input);
      while (Date.now() - at < 25_000) {
        expect(await backendVersions(fixture, input)).toEqual([]);
        await sleep(1_000);
      }
      expect(proxy.forwardedAt).toEqual([]);
      await child.kill();
      expect((await fixture.reconcile(id, true)).state).toBe("rejected");
      await expectConsistent(fixture, input, id, 0);
    } finally {
      await child.kill();
      await proxy.close();
    }
  }, 60_000);

  it("a large write whose body is held past the bound never lands either (observed bound)", async () => {
    const { relay: proxy, url } = await relay();
    try {
      // The headers arrive at once; the rest of a 60 kB value is held.
      proxy.delayRequestTail(15_000);
      const input = fixture.write();
      const c = { operationId: randomUUID(), dispatchId: randomUUID() };
      const client = fixture.runtimeBao({ url, deadlineMs: 60_000 });
      const started = Date.now();
      const result = await client.kvWrite(
        spikeSecretPath(input.projectId, input.environmentId, input.name),
        { value: "v".repeat(60_000), operation_id: c.operationId, format: 1 },
        0,
        c,
      );
      const closedAfter = Date.now() - started;
      expect(result).toEqual({ ok: false, kind: "unknown", cause: "connection_lost" });
      expect(closedAfter).toBeGreaterThan(9_000);
      expect(closedAfter).toBeLessThan(12_000);
      expect(proxy.forwardedAt).toHaveLength(1);
      await sleep(10_000);
      expect(await backendVersions(fixture, input)).toEqual([]);
    } finally {
      await proxy.close();
    }
  }, 60_000);
});
