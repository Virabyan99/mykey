// The fault table of revocation (Run 5.2 Task B, AC-1.40, P-89): the response
// is lost at every boundary after the marker. In every row the credential
// never reads `active` again once it read `revoking`; a new revoke request
// finishes what the first left; the original request again creates nothing.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { issueFor } from "../../harness/credentials-fixture.ts";
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

/** Once `revoking` was seen, nothing after it is `active`. */
function neverActiveAgain(states: string[]): void {
  const from = states.indexOf("revoking");
  expect(from, `states seen: ${states.join(" → ")}`).toBeGreaterThanOrEqual(0);
  expect(states.slice(from).includes("active"), `states seen: ${states.join(" → ")}`).toBe(false);
}

/** A new revoke request finishes it; the first operation then reads succeeded; the original again changes nothing. */
async function finishedByANewRequest(
  credentialId: string,
  first: { key: string; operationId: string },
  token: string,
): Promise<void> {
  const second = await cf.f.revoke("env1b", credentialId);
  expect(second.status).toBe(200);
  expect(await cf.stateOf(credentialId)).toBe("revoked");
  expect(await cf.operation(first.operationId)).toMatchObject({ state: "succeeded" });
  expect(await cf.alive(token)).toBe(false);
  const replay = await cf.f.revoke("env1b", credentialId, { key: first.key });
  expect(replay.status).toBe(200);
  expect((await cf.tokens("env1b")).length).toBe(0);
}

describe("revocation: the response lost at every boundary", () => {
  it("killed at after_revoke_marker: the token still works, the row revoking; after the sweep uncertain; a new request finishes it", async () => {
    const issued = await issueFor(cf.f, "env1b", { ttlSeconds: 600 });
    await cf.child("after_revoke_marker");
    const watch = cf.watch(issued.credentialId);
    const key = randomUUID();
    const answer = await cf.toChild(() =>
      cf.f.revoke("env1b", issued.credentialId, { key, to: "second" }),
    );
    expect(answer).toBeNull();
    const operationId = (await cf.operationByKey(key))!;
    expect(await cf.stateOf(issued.credentialId)).toBe("revoking");
    expect(await cf.alive(issued.token)).toBe(true);
    await cf.sweepAfterStale(operationId);
    expect(await cf.operation(operationId)).toMatchObject({ state: "uncertain" });
    expect(await cf.stateOf(issued.credentialId)).toBe("revoking");
    await finishedByANewRequest(issued.credentialId, { key, operationId }, issued.token);
    neverActiveAgain(await watch.stop());
    await cf.finish("env1b");
  }, 120_000);

  it("the relay drops the answer of the revoke: the token is in fact dead; 503 outcome_unknown; the row revoking; a new request → revoked", async () => {
    const issued = await issueFor(cf.f, "env1b", { ttlSeconds: 600 });
    const watch = cf.watch(issued.credentialId);
    cf.f.setFaults((point) => {
      if (point === "after_revoke_marker") cf.f.relay.setMode("drop");
    });
    const key = randomUUID();
    const answer = await cf.f.revoke("env1b", issued.credentialId, { key });
    cf.f.setFaults(null);
    cf.f.relay.clear();
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    expect(await cf.alive(issued.token)).toBe(false);
    expect(await cf.stateOf(issued.credentialId)).toBe("revoking");
    expect(await cf.operation(answer.operationId!)).toMatchObject({ state: "uncertain" });
    await finishedByANewRequest(
      issued.credentialId,
      { key, operationId: answer.operationId! },
      issued.token,
    );
    neverActiveAgain(await watch.stop());
    await cf.finish("env1b");
  }, 120_000);

  it("killed at before_revoke_finalize_commit: the token is dead, the row revoking; after the sweep uncertain; a new request → revoked", async () => {
    const issued = await issueFor(cf.f, "env1b", { ttlSeconds: 600 });
    await cf.child("before_revoke_finalize_commit");
    const watch = cf.watch(issued.credentialId);
    const key = randomUUID();
    const answer = await cf.toChild(() =>
      cf.f.revoke("env1b", issued.credentialId, { key, to: "second" }),
    );
    expect(answer).toBeNull();
    const operationId = (await cf.operationByKey(key))!;
    expect(await cf.alive(issued.token)).toBe(false);
    expect(await cf.stateOf(issued.credentialId)).toBe("revoking");
    await cf.sweepAfterStale(operationId);
    expect(await cf.operation(operationId)).toMatchObject({ state: "uncertain" });
    await finishedByANewRequest(issued.credentialId, { key, operationId }, issued.token);
    neverActiveAgain(await watch.stop());
    await cf.finish("env1b");
  }, 120_000);
});
