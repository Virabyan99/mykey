// Run 4.6 (AC-1.38, D-20): the secret protocol under delays, cuts, restarts
// and a dead process, on product code with the real stores. Every case ends
// with at most one backend change and the index equal to the backend.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectIndexMatchesBackend, type Answer } from "../../harness/secrets-fixture.ts";
import { baoFetch, restartService, startService, stopService } from "../../harness/stack.ts";
import { KINDS, faultFixture, synthetic, unique, type FaultFixture } from "./fixture.ts";

let ff: FaultFixture;

beforeAll(async () => {
  ff = await faultFixture();
}, 600_000);

afterAll(async () => {
  await ff.close();
}, 300_000);

const WRITES = new Set(["create", "update", "restore"]);

/** Runs `send` with `at` done when the protocol reaches the dispatch marker. */
async function atMarker(send: () => Promise<Answer>, at: () => void): Promise<Answer> {
  ff.f.setFaults((point) => {
    if (point === "after_dispatch_marker") at();
  });
  try {
    return await send();
  } finally {
    ff.f.setFaults(null);
  }
}

const operationsNaming = async (name: string): Promise<number> =>
  (await ff.f.api.superuser.query("SELECT 1 FROM app.operation WHERE secret_name = $1", [name]))
    .rowCount ?? 0;

describe("delays and cuts", () => {
  for (const kind of KINDS) {
    it(`${kind}: the answer is held past the deadline → 503 outcome_unknown; settled as succeeded; one change`, async () => {
      const p = await ff.prepare("env1a", kind);
      const answer = await atMarker(
        () => p.send(),
        () => {
          ff.f.relay.delayResponses(8_000);
        },
      );
      ff.f.relay.clear();
      expect(answer.code).toBe("outcome_unknown");
      const id = answer.operationId ?? "";
      const verdict = await ff.settle(id, { excluded: !WRITES.has(kind) });
      expect(verdict.kind).toBe("succeeded");
      expect(await ff.changes(id)).toBe(1);
      await expectIndexMatchesBackend(ff.f, "env1a");
    }, 60_000);
  }

  it("the request is held, the executors are excluded, the relay lets go: nothing lands; settled rejected", async () => {
    const p = await ff.prepare("env1b", "update");
    const answer = await atMarker(
      () => p.send(),
      () => {
        ff.f.relay.holdRequests(true);
      },
    );
    expect(answer.code).toBe("outcome_unknown");
    const id = answer.operationId ?? "";
    await ff.excludeExecutors();
    ff.f.relay.holdRequests(false);
    await sleep(15_000);
    expect((await ff.f.backend("env1b", p.name))?.currentVersion).toBe(1);
    expect(await ff.settle(id, { excluded: true })).toEqual({ kind: "rejected" });
    expect(await ff.changes(id)).toBe(0);
    await expectIndexMatchesBackend(ff.f, "env1b");
    await ff.child();
  }, 120_000);

  it("the request is held, no exclusion: undetermined; the relay lets go and the write lands; settled as succeeded — the original key repeated eight times answers 503 outcome_unknown each time", async () => {
    const p = await ff.prepare("env1b", "update");
    const answer = await atMarker(
      () => p.send(),
      () => {
        ff.f.relay.holdRequests(true);
      },
    );
    expect(answer.code).toBe("outcome_unknown");
    const id = answer.operationId ?? "";
    const repeats: number[] = [];
    for (let i = 0; i < 4; i += 1) repeats.push((await p.send()).status);
    expect(await ff.settle(id, { excluded: false })).toEqual({
      kind: "undetermined",
      reason: "executors_not_excluded",
    });
    ff.f.relay.holdRequests(false);
    for (let i = 0; i < 4; i += 1) repeats.push((await p.send()).status);
    const deadline = Date.now() + 15_000;
    while ((await ff.f.backend("env1b", p.name))?.currentVersion !== 2) {
      if (Date.now() > deadline) throw new Error("the released write did not land");
      await sleep(250);
    }
    expect(repeats).toEqual([503, 503, 503, 503, 503, 503, 503, 503]);
    expect(await ff.settle(id, { excluded: false })).toEqual({ kind: "succeeded", version: 2 });
    expect((await p.send()).status).toBe(200);
    expect(await ff.changes(id)).toBe(1);
    await expectIndexMatchesBackend(ff.f, "env1b");
  }, 120_000);

  it("the connection is cut after the request went out → outcome_unknown → succeeded", async () => {
    const p = await ff.prepare("env2a", "update");
    const answer = await atMarker(
      () => p.send(),
      () => {
        ff.f.relay.setMode("drop");
      },
    );
    ff.f.relay.clear();
    expect(answer.code).toBe("outcome_unknown");
    const id = answer.operationId ?? "";
    expect(await ff.settle(id, { excluded: false })).toMatchObject({ kind: "succeeded" });
    expect(await ff.changes(id)).toBe(1);
    await expectIndexMatchesBackend(ff.f, "env2a");
  }, 60_000);
});

describe("restarts and a dead process", () => {
  it("PostgreSQL restarts between the send and the finalizing transaction → 503 outcome_unknown; after the sweep and settlement the index equals the backend", async () => {
    const p = await ff.prepare("env2a", "update");
    ff.f.setFaults(async (point) => {
      if (point === "after_send") await restartService(ff.f.stack, "postgres");
    });
    let answer: Answer;
    try {
      answer = await p.send();
    } finally {
      ff.f.setFaults(null);
    }
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    const id = await ff.operationOf(p.name);
    await ff.sweepNow();
    expect((await ff.operation(id))?.state).toBe("uncertain");
    expect(await ff.settle(id, { excluded: false })).toMatchObject({ kind: "succeeded" });
    expect(await ff.changes(id)).toBe(1);
    await expectIndexMatchesBackend(ff.f, "env2a");
  }, 180_000);

  it("OpenBao sealed before dispatch → 503 backend_sealed, no operation", async () => {
    const p = await ff.prepare("env1a", "update");
    const before = await operationsNaming(p.name);
    const sealed = await baoFetch(ff.f.stack, "/v1/sys/seal", { method: "PUT" });
    expect(sealed.status).toBe(204);
    try {
      const answer = await p.send();
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("backend_sealed");
      expect(await operationsNaming(p.name)).toBe(before);
    } finally {
      await restartService(ff.f.stack, "openbao");
    }
    await expectIndexMatchesBackend(ff.f, "env1a");
  }, 180_000);

  it("OpenBao stopped → 503 dependency_unavailable, no operation", async () => {
    const p = await ff.prepare("env1a", "update");
    const before = await operationsNaming(p.name);
    await stopService(ff.f.stack, "openbao");
    try {
      const answer = await p.send();
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("dependency_unavailable");
      expect(await operationsNaming(p.name)).toBe(before);
    } finally {
      await startService(ff.f.stack, "openbao");
    }
    await expectIndexMatchesBackend(ff.f, "env1a");
  }, 180_000);

  it("one API process dies in a write to environment X: the other still serves environment Y, and X answers key_under_review", async () => {
    const p = await ff.prepare("env1a", "update");
    await ff.child({ point: "after_send", action: "crash" });
    await p.send("second").catch(() => null);
    const id = await ff.operationOf(p.name);
    const inY = await ff.f.create("env2a", unique(), synthetic());
    expect(inY.status).toBe(201);
    const inX = await ff.f.create("env1a", unique(), synthetic());
    expect(inX.status).toBe(409);
    expect(inX.code).toBe("key_under_review");
    expect(inX.operationId).toBe(id);
    await ff.sweepNow();
    expect(await ff.settle(id, { excluded: false })).toMatchObject({ kind: "succeeded" });
    await expectIndexMatchesBackend(ff.f, "env1a");
    await expectIndexMatchesBackend(ff.f, "env2a");
    for (const value of p.values) expect(ff.f.second?.output().includes(value)).toBe(false);
    await ff.child();
  }, 120_000);

  it("a provisioner job running at the same time is not disturbed and disturbs nothing", async () => {
    const provisioner = await ff.f.fx.start();
    try {
      const { environmentId } = await ff.f.fx.newEnvironment();
      const name = unique();
      const created = await ff.f.create("env1b", name, synthetic());
      expect(created.status).toBe(201);
      let current = created.body.result as { version: number; stateTag: string };
      for (let i = 0; i < 20; i += 1) {
        const updated = await ff.f.update("env1b", name, synthetic(), current, {
          key: randomUUID(),
        });
        expect(updated.status, `update ${String(i)}`).toBe(200);
        current = updated.body.result as { version: number; stateTag: string };
      }
      await ff.f.fx.waitFor(environmentId, "active", 120_000);
    } finally {
      await provisioner.stop();
    }
    await expectIndexMatchesBackend(ff.f, "env1b");
  }, 240_000);
});
