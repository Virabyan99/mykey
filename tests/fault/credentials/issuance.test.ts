// The fault table of issuance (Run 5.2 Task B, AC-1.40, P-87, P-90): the
// response is lost at every boundary. True afterwards in every row: no token
// exists that nobody knows about and that still works once the operator has
// run; no replay creates a second token; the catalog matches the backend.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { expectCatalogMatchesBackend } from "../../harness/credentials-fixture.ts";
import { credentialFaults, type CredentialFaults } from "./fixture.ts";

let cf: CredentialFaults;

beforeAll(async () => {
  cf = await credentialFaults();
}, 600_000);

afterAll(async () => {
  await cf.close();
});

afterEach(async () => {
  await cf.reset();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** An issuance sent to the child, which dies at `point`. */
async function killedAt(point: string): Promise<{ key: string; operationId: string | null }> {
  await cf.child(point);
  const key = randomUUID();
  const answer = await cf.toChild(() => cf.f.issue("env1a", {}, { key, to: "second" }));
  expect(answer, "the child answered").toBeNull();
  return { key, operationId: await cf.operationByKey(key) };
}

/**
 * The end of the rows where a token was created and never recorded: after the
 * sweep the issuance is unresolved; `reconcile-credentials` without the flag
 * finds the token by its operation id, revokes it, settles, exits 0.
 */
async function settledFromTheBackend(key: string, operationId: string): Promise<void> {
  expect(await cf.operation(operationId)).toMatchObject({ state: "uncertain" });
  const credential = await cf.credentialOf(operationId);
  expect(credential?.state).toBe("needs_review");
  const tokens = await cf.tokens("env1a");
  expect(tokens.map((t) => t.meta?.operation_id)).toEqual([operationId]);
  // No row names the token.
  const named = await cf.f.api.superuser.query(
    "SELECT 1 FROM app.machine_credential WHERE accessor = $1",
    [tokens[0]!.accessor],
  );
  expect(named.rowCount).toBe(0);
  const run = await cf.reconcile("env1a");
  expect(run.code).toBe(0);
  expect(run.out).toContain("unrecorded-revoked 1");
  expect(run.out).toContain("issuances-settled 1");
  expect((await cf.tokens("env1a")).length).toBe(0);
  expect(await cf.stateOf(credential!.id)).toBe("revoked");
  expect(await cf.operation(operationId)).toMatchObject({
    state: "rejected",
    error_code: "dependency_unavailable",
  });
  // The original request again: its stored rejection, no token.
  const replay = await cf.f.issue("env1a", {}, { key });
  expect(replay.code).toBe("dependency_unavailable");
  expect("token" in replay.body).toBe(false);
  expect((await cf.tokens("env1a")).length).toBe(0);
}

describe("issuance: the response lost at every boundary", () => {
  it("before the marker commits (after_issuer_login), process killed: nothing exists; the same key issues normally", async () => {
    const { key, operationId } = await killedAt("after_issuer_login");
    expect(operationId).toBeNull();
    const rows = await cf.f.api.superuser.query(
      "SELECT 1 FROM app.machine_credential WHERE environment_id = $1 AND state <> 'revoked'",
      [cf.f.env("env1a").environmentId],
    );
    expect(rows.rowCount).toBe(0);
    expect((await cf.tokens("env1a")).length).toBe(0);
    const again = await cf.f.issue("env1a", {}, { key });
    expect(again.status).toBe(201);
    const replay = await cf.f.issue("env1a", {}, { key });
    expect(replay.code).toBe("credential_not_replayable");
    expect((await cf.tokens("env1a")).length).toBe(1);
    await cf.finish("env1a");
  }, 120_000);

  it("after_marker, process killed: executing / issuing, no token; the sweep; 409 for a new issuance; reconcile exits 3 without the flag, settles with it; then 201", async () => {
    const { key, operationId } = await killedAt("after_marker");
    expect(operationId).not.toBeNull();
    const id = operationId!;
    expect(await cf.operation(id)).toMatchObject({ state: "executing" });
    expect((await cf.credentialOf(id))?.state).toBe("issuing");
    expect((await cf.tokens("env1a")).length).toBe(0);
    await cf.sweepAfterStale(id);
    expect(await cf.operation(id)).toMatchObject({ state: "uncertain" });
    const credential = await cf.credentialOf(id);
    expect(credential?.state).toBe("needs_review");
    const blocked = await cf.f.issue("env1a");
    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe("state_conflict");
    expect(blocked.operationId).toBe(id);

    const refused = await cf.reconcile("env1a");
    expect(refused.code).toBe(3);
    expect(await cf.stateOf(credential!.id)).toBe("needs_review");
    expect(await cf.operation(id)).toMatchObject({ state: "uncertain" });
    // The child is dead: the executors are excluded.
    const settled = await cf.reconcile("env1a", true);
    expect(settled.code).toBe(0);
    expect(await cf.stateOf(credential!.id)).toBe("revoked");
    expect(await cf.operation(id)).toMatchObject({
      state: "rejected",
      error_code: "dependency_unavailable",
    });
    const replay = await cf.f.issue("env1a", {}, { key });
    expect(replay.code).toBe("dependency_unavailable");
    expect((await cf.tokens("env1a")).length).toBe(0);
    expect((await cf.f.issue("env1a")).status).toBe(201);
    await cf.finish("env1a");
  }, 120_000);

  it("create sent, the relay drops the answer: 503 outcome_unknown; one token no row names; reconcile without the flag revokes it and settles", async () => {
    cf.f.setFaults((point) => {
      if (point === "after_marker") cf.f.relay.setMode("drop");
    });
    const key = randomUUID();
    const answer = await cf.f.issue("env1a", {}, { key });
    cf.f.setFaults(null);
    cf.f.relay.clear();
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    expect("token" in answer.body).toBe(false);
    await settledFromTheBackend(key, answer.operationId!);
    await cf.finish("env1a");
  }, 120_000);

  // OpenBao drops a request that reaches it more than about 10 s after its
  // connection opened (observed with 15 s: no token ever appeared), so the
  // create is delayed 8 s: 3 s past the API's 5 s deadline. Every later request
  // waits as long, so the issuer session's revoke-self (sent when the API gives
  // up) reaches OpenBao after the create.
  it("create sent, the relay holds the request past the deadline, then lets it through: the token appears late; the same end", async () => {
    let whenGivenUp: number | null = null;
    cf.f.setFaults(async (point) => {
      if (point === "after_marker") cf.f.relay.delayRequests(8_000);
      // The API has given up on the create: no token exists yet.
      if (point === "after_create_sent") whenGivenUp = (await cf.tokens("env1a")).length;
    });
    const key = randomUUID();
    const answer = await cf.f.issue("env1a", {}, { key });
    cf.f.setFaults(null);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    expect(whenGivenUp).toBe(0);
    const deadline = Date.now() + 15_000;
    while ((await cf.tokens("env1a")).length === 0) {
      if (Date.now() > deadline) throw new Error("the held create did not arrive");
      await sleep(250);
    }
    cf.f.relay.clear();
    await settledFromTheBackend(key, answer.operationId!);
    await cf.finish("env1a");
  }, 120_000);

  for (const point of ["after_create_sent", "after_verify", "before_finalize_commit"]) {
    it(`${point}, process killed: after the sweep, as "create sent / dropped"`, async () => {
      const { key, operationId } = await killedAt(point);
      expect(operationId).not.toBeNull();
      expect(await cf.operation(operationId!)).toMatchObject({ state: "executing" });
      expect((await cf.credentialOf(operationId!))?.state).toBe("issuing");
      await cf.sweepAfterStale(operationId!);
      await settledFromTheBackend(key, operationId!);
      await cf.finish("env1a");
    }, 120_000);
  }

  it("after_finalize, process killed (the answer is never sent): active, the catalog matches with no operator; the replay → 409 with the id; revoke it; a new key issues", async () => {
    const { key, operationId } = await killedAt("after_finalize");
    expect(await cf.operation(operationId!)).toMatchObject({ state: "succeeded" });
    const credential = await cf.credentialOf(operationId!);
    expect(credential?.state).toBe("active");
    expect((await cf.tokens("env1a")).length).toBe(1);
    // No operator: the catalog already matches the backend.
    await expectCatalogMatchesBackend(cf.f, cf.f.env("env1a").environmentId);
    const replay = await cf.f.issue("env1a", {}, { key });
    expect(replay.status).toBe(409);
    expect(replay.code).toBe("credential_not_replayable");
    expect(replay.details).toMatchObject({ credentialId: credential!.id });
    expect("token" in replay.body).toBe(false);
    expect((await cf.tokens("env1a")).length).toBe(1);
    const revoked = await cf.f.revoke("env1a", credential!.id);
    expect(revoked.status).toBe(200);
    expect(await cf.stateOf(credential!.id)).toBe("revoked");
    expect((await cf.f.issue("env1a")).status).toBe(201);
    await cf.finish("env1a");
  }, 120_000);
});
