// Run 4.6 (AC-1.38, Doc 06 §6.2, D-20): five actions × six points of the
// protocol, each a real API process killed (SIGKILL) at that point. Every case
// checks what the client is told at each stage, that the backend changed at
// most once, that after settlement the index equals the backend, and that the
// dead process wrote no value.
//
// | Crash at                                              | Row after       | After sweepNow | Settlement                                                    | Changes |
// | after_admission                                       | accepted, slot  | rejected       | none                                                          | 0       |
// | after_dispatch_marker                                 | executing, slot | uncertain      | undetermined without exclusion, rejected with it              | 0       |
// | after_send, after_read_back, before_finalize_commit   | executing, slot | uncertain      | write: succeeded without; delete/undelete: succeeded with     | 1       |
// | after_finalize                                        | succeeded       | unchanged      | none; the original key replays the result                     | 1       |
import { FAULT_POINTS, type FaultPoint } from "@mykey/operations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectIndexMatchesBackend, type EnvName } from "../../harness/secrets-fixture.ts";
import { KINDS, faultFixture, unique, type FaultFixture, type Kind } from "./fixture.ts";

let ff: FaultFixture;

beforeAll(async () => {
  ff = await faultFixture();
}, 600_000);

afterAll(async () => {
  await ff.close();
}, 300_000);

const ENV: Record<Kind, EnvName> = {
  create: "env1a",
  update: "env1a",
  delete: "env1b",
  undelete: "env1b",
  restore: "env2a",
};
const WRITES: ReadonlySet<Kind> = new Set(["create", "update", "restore"]);
const LANDED: ReadonlySet<FaultPoint> = new Set([
  "after_send",
  "after_read_back",
  "before_finalize_commit",
]);

describe("a real API process killed at each point of the protocol", () => {
  for (const point of FAULT_POINTS) {
    for (const kind of KINDS) {
      it(`${kind} killed at ${point}`, async () => {
        const { f } = ff;
        const env = ENV[kind];
        const prepared = await ff.prepare(env, kind);
        await ff.child({ point, action: "crash" });
        const answered = await prepared.send("second").then(
          (answer) => answer.status,
          () => null,
        );
        expect(answered, "the process died before answering").toBeNull();
        const id = await ff.operationOf(prepared.name);

        // The row after the crash.
        const finished = point === "after_finalize";
        const accepted = point === "after_admission";
        expect((await ff.operation(id))?.state).toBe(
          finished ? "succeeded" : accepted ? "accepted" : "executing",
        );
        expect(await ff.slotHolder(env)).toBe(finished ? null : id);
        if (!finished) {
          // A new request in that environment is refused naming the operation;
          // the original key answers 202 while the row is unfinished.
          const other = await f.create(env, unique(), "fault-other");
          expect(other.status).toBe(409);
          expect(other.code).toBe("key_under_review");
          expect(other.operationId).toBe(id);
          const again = await prepared.send();
          expect(again.status).toBe(202);
          expect(again.operationId).toBe(id);
        }

        // The sweep.
        const swept = await ff.sweepNow();
        if (accepted) expect(swept.rejected).toEqual([id]);
        else if (!finished) expect(swept.uncertain).toEqual([id]);
        const replay = await prepared.send();
        if (accepted) {
          expect(replay.status).toBe(503);
          expect(replay.code).toBe("dependency_unavailable");
          expect(await ff.slotHolder(env)).toBeNull();
        } else if (finished) {
          expect(replay.status).toBe(kind === "create" ? 201 : 200);
          expect(replay.body.operationId).toBe(id);
        } else {
          expect(replay.status).toBe(503);
          expect(replay.code).toBe("outcome_unknown");
        }

        // The settlement.
        if (!accepted && !finished) {
          const landed = LANDED.has(point);
          const without = await ff.settle(id, { excluded: false });
          if (landed && WRITES.has(kind)) {
            expect(without).toMatchObject({ kind: "succeeded" });
          } else {
            expect(without).toEqual({ kind: "undetermined", reason: "executors_not_excluded" });
            const withExclusion = await ff.settle(id, { excluded: true });
            expect(withExclusion.kind).toBe(landed ? "succeeded" : "rejected");
          }
          const settled = await prepared.send();
          expect(settled.status).toBe(LANDED.has(point) ? (kind === "create" ? 201 : 200) : 503);
        }

        const changes = await ff.changes(id);
        expect(changes).toBe(LANDED.has(point) || finished ? 1 : 0);
        await expectIndexMatchesBackend(f, env);
        const output = f.second?.output() ?? "";
        for (const value of prepared.values) expect(output.includes(value)).toBe(false);
      }, 120_000);
    }
  }
});
