// Run 2.4: an executor that dies at each boundary of a write (Doc 06 §6.2).
// The executor is a child process that kills itself with SIGKILL there.
import { spikeSecretPath } from "@mykey/operations/spike";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSharedStack, type Stack } from "../../harness/stack.ts";
import { startTlsRelay } from "../../harness/tls-relay.ts";
import { run } from "../../integration/database/setup.ts";
import {
  auditedWrites,
  backendVersions,
  effectsFixture,
  expectConsistent,
  operationFor,
  operationOf,
  slotHeld,
  type EffectsFixture,
} from "./fixture.ts";

let stack: Stack;
let fixture: EffectsFixture;

beforeAll(async () => {
  stack = await getSharedStack();
  fixture = await effectsFixture(stack);
});

afterAll(async () => {
  await (fixture as EffectsFixture | undefined)?.close();
});

const stateTag = async (environmentId: string, name: string): Promise<string | undefined> =>
  (
    await run<{ state_tag: string }>(
      fixture.db.pool("maintenance"),
      "SELECT state_tag FROM app.secret_index WHERE environment_id = $1 AND name = $2",
      [environmentId, name],
    )
  )[0]?.state_tag;

describe("the relay", () => {
  it("delays an answer and still lets the client verify the certificate", async () => {
    const bao = new URL(stack.bao.url);
    const relay = await startTlsRelay({ host: bao.hostname, port: Number(bao.port) });
    try {
      relay.delayResponses(300);
      const input = fixture.write();
      const client = fixture.runtimeBao({ url: `https://127.0.0.1:${relay.port}` });
      const started = Date.now();
      const read = await client.kvRead(
        spikeSecretPath(input.projectId, input.environmentId, input.name),
      );
      expect(read).toEqual({ ok: false, kind: "not_found", status: 404 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    } finally {
      await relay.close();
    }
  });
});

describe("an executor killed", () => {
  it("after the intent: nothing was sent; rejected only once executors are excluded", async () => {
    const input = fixture.write();
    const child = fixture.child(input, { crashAt: "after_intent" });
    expect(await child.outcome).toBeNull();
    await child.exited;
    const operationId = await operationFor(fixture, input);
    expect((await operationOf(fixture, operationId)).state).toBe("accepted");
    expect(await slotHeld(fixture, input.environmentId)).toBe(true);
    expect(await auditedWrites(fixture, operationId)).toBe(0);

    expect((await fixture.reconcile(operationId, false)).state).toBe("uncertain");
    expect(await slotHeld(fixture, input.environmentId)).toBe(true);
    expect((await fixture.reconcile(operationId, true)).state).toBe("rejected");
    expect(await slotHeld(fixture, input.environmentId)).toBe(false);
    await expectConsistent(fixture, input, operationId, 0);

    // The environment is free again: a new write with a new key succeeds.
    const next = await fixture.execute(fixture.write({ name: input.name }));
    expect(next).toMatchObject({ state: "succeeded", version: 1 });
  });

  it("after the dispatch marker: nothing was sent, yet it counts as possibly sent", async () => {
    const input = fixture.write();
    const child = fixture.child(input, { crashAt: "after_dispatch_marker" });
    expect(await child.outcome).toBeNull();
    await child.exited;
    const operationId = await operationFor(fixture, input);
    const operation = await operationOf(fixture, operationId);
    expect(operation.state).toBe("executing");
    expect(operation.dispatched_at).not.toBeNull();
    expect(await auditedWrites(fixture, operationId)).toBe(0);

    expect((await fixture.reconcile(operationId, false)).state).toBe("uncertain");
    // The executor is dead (excluded): no version can still carry this operation.
    expect((await fixture.reconcile(operationId, true)).state).toBe("rejected");
    expect(await slotHeld(fixture, input.environmentId)).toBe(false);
    await expectConsistent(fixture, input, operationId, 0);
  });

  it("after the backend succeeded: reconciliation finds the version and finishes the operation", async () => {
    const input = fixture.write();
    const child = fixture.child(input, { crashAt: "after_backend_success" });
    expect(await child.outcome).toBeNull();
    await child.exited;
    const operationId = await operationFor(fixture, input);
    expect((await operationOf(fixture, operationId)).state).toBe("executing");
    expect(await backendVersions(fixture, input)).toEqual([{ version: 1, operationId }]);

    const before = await stateTag(input.environmentId, input.name);
    const settled = await fixture.reconcile(operationId, false);
    expect(settled.state).toBe("succeeded");
    expect(settled.evidence).toContain("version 1 carries this operation");
    expect((await operationOf(fixture, operationId)).state).toBe("succeeded");
    expect(await stateTag(input.environmentId, input.name)).not.toBe(before);
    expect(await slotHeld(fixture, input.environmentId)).toBe(false);
    await expectConsistent(fixture, input, operationId, 1);
  });

  it("after finalizing: a replay answers from the row and sends nothing; reconciliation changes nothing", async () => {
    const input = fixture.write();
    const child = fixture.child(input, { crashAt: "after_finalize" });
    expect(await child.outcome).toBeNull();
    await child.exited;
    const operationId = await operationFor(fixture, input);
    expect((await operationOf(fixture, operationId)).state).toBe("succeeded");
    const tag = await stateTag(input.environmentId, input.name);

    expect(await fixture.execute(input)).toEqual({ operationId, state: "succeeded", version: 1 });
    expect(await auditedWrites(fixture, operationId)).toBe(1);
    expect(await fixture.reconcile(operationId, true)).toEqual({
      state: "succeeded",
      evidence: ["terminal: succeeded"],
    });
    expect(await stateTag(input.environmentId, input.name)).toBe(tag);
    await expectConsistent(fixture, input, operationId, 1);
  });
});
