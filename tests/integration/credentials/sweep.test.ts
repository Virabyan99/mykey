// Run 5.2 Task C (P-90, FR-1.43, D-40): the stale-work sweep settles credential
// work whose executor stopped. An issuance executing with a heartbeat older
// than 120 s → uncertain, its credential needs_review; a revocation likewise,
// its credential left revoking; an active row past its expiry → expired. The
// executor that comes back late cannot finalize. PostgreSQL only.
import { sweepCredentials } from "@mykey/operations";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearCredentials,
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import type { Answer, EnvName } from "../../harness/secrets-fixture.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setFaults(null);
  for (const env of ["env1a", "env1b", "env2a"] as const) {
    await clearCredentials(f, f.env(env).environmentId);
  }
});

type Point = Parameters<NonNullable<Parameters<CredentialsFixture["setFaults"]>[0]>>[0];

/** Starts `start` and holds it at `point` until released; answers the operation id once reached. */
async function hold(
  point: Point,
  start: () => Promise<Answer>,
): Promise<{ operationId: string; answer: Promise<Answer>; release(): void }> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: (operationId: string) => void;
  const arrived = new Promise<string>((resolve) => {
    reached = resolve;
  });
  f.setFaults(async (at, operationId) => {
    if (at !== point) return;
    reached(operationId);
    await held;
  });
  const answer = start();
  const operationId = await arrived;
  return { operationId, answer, release };
}

const age = async (operationId: string, seconds: number): Promise<void> => {
  await f.api.superuser.query(
    "UPDATE app.operation SET heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1",
    [operationId, seconds],
  );
};

const operation = async (operationId: string) =>
  (
    await f.api.superuser.query<{
      state: string;
      executor_boot_id: string | null;
      completed_at: Date | null;
    }>("SELECT state, executor_boot_id, completed_at FROM app.operation WHERE id = $1", [
      operationId,
    ])
  ).rows[0];

const credentialOf = async (operationId: string) =>
  (
    await f.api.superuser.query<{ id: string; state: string }>(
      "SELECT id, state FROM app.machine_credential WHERE issuance_operation_id = $1",
      [operationId],
    )
  ).rows[0];

const stateOf = async (credentialId: string): Promise<string | undefined> =>
  (
    await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE id = $1",
      [credentialId],
    )
  ).rows[0]?.state;

const stuckRows = async (operationId: string): Promise<number | null> =>
  (
    await f.api.superuser.query(
      `SELECT 1 FROM audit.event WHERE operation_id = $1 AND action = 'system.operation_stuck'
          AND outcome = 'unknown'`,
      [operationId],
    )
  ).rowCount;

const envId = (env: EnvName) => f.env(env).environmentId;

describe("sweepCredentials", () => {
  it("an issuance executing for more than the stale time → uncertain, its credential needs_review, one system.operation_stuck; a fresh one is untouched", async () => {
    const held = await hold("after_marker", () => f.issue("env1a"));
    try {
      await age(held.operationId, 119);
      expect((await sweepCredentials(f.api.pool)).uncertain).toEqual([]);
      expect((await operation(held.operationId))?.state).toBe("executing");
      expect((await credentialOf(held.operationId))?.state).toBe("issuing");

      await age(held.operationId, 121);
      const swept = await sweepCredentials(f.api.pool);
      expect(swept.uncertain).toEqual([held.operationId]);
      const row = await operation(held.operationId);
      expect(row?.state).toBe("uncertain");
      expect(row?.executor_boot_id).toBeNull();
      expect(row?.completed_at).toBeNull();
      expect((await credentialOf(held.operationId))?.state).toBe("needs_review");
      expect(await stuckRows(held.operationId)).toBe(1);
      expect((await sweepCredentials(f.api.pool)).uncertain).toEqual([]);
      expect(await stuckRows(held.operationId)).toBe(1);
    } finally {
      held.release();
      await held.answer;
    }
  });

  it("a revocation executing for more than the stale time → uncertain, its credential left revoking", async () => {
    const issued = await issueFor(f, "env1b", { ttlSeconds: 600 });
    const held = await hold("after_revoke_marker", () => f.revoke("env1b", issued.credentialId));
    try {
      await age(held.operationId, 121);
      const swept = await sweepCredentials(f.api.pool);
      expect(swept.uncertain).toEqual([held.operationId]);
      expect((await operation(held.operationId))?.state).toBe("uncertain");
      expect(await stateOf(issued.credentialId)).toBe("revoking");
      expect(await stuckRows(held.operationId)).toBe(1);
    } finally {
      held.release();
    }
    // The late executor proves the token gone but cannot finalize: the row stays revoking.
    const answer = await held.answer;
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    expect(await stateOf(issued.credentialId)).toBe("revoking");
    expect((await operation(held.operationId))?.state).toBe("uncertain");
  });

  it("two sweepers at once: one audit row", async () => {
    const held = await hold("after_marker", () => f.issue("env2a"));
    try {
      await age(held.operationId, 121);
      const [one, two] = await Promise.all([
        sweepCredentials(f.api.pool),
        sweepCredentials(f.api.pool),
      ]);
      expect([...one.uncertain, ...two.uncertain]).toEqual([held.operationId]);
      expect(await stuckRows(held.operationId)).toBe(1);
    } finally {
      held.release();
      await held.answer;
    }
  });

  it("an active row past its expiry → expired; an unexpired one stays active", async () => {
    const past = await issueFor(f, "env1a", { ttlSeconds: 600 });
    const live = await issueFor(f, "env1b", { ttlSeconds: 600 });
    await f.api.superuser.query(
      "UPDATE app.machine_credential SET effective_expires_at = now() - interval '1 second' WHERE id = $1",
      [past.credentialId],
    );
    const swept = await sweepCredentials(f.api.pool);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(await stateOf(past.credentialId)).toBe("expired");
    expect(await stateOf(live.credentialId)).toBe("active");
    expect((await sweepCredentials(f.api.pool)).expired).toBe(0);
  });

  it("the executor that comes back late cannot finalize: no row becomes active after the sweep", async () => {
    const held = await hold("after_marker", () => f.issue("env1a"));
    let answer: Answer;
    try {
      const swept = await sweepCredentials(f.api.pool, { staleSeconds: 0 });
      expect(swept.uncertain).toEqual([held.operationId]);
    } finally {
      held.release();
      answer = await held.answer;
    }
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    expect("token" in answer.body).toBe(false);
    expect((await operation(held.operationId))?.state).toBe("uncertain");
    expect((await credentialOf(held.operationId))?.state).toBe("needs_review");
    const active = await f.api.superuser.query(
      "SELECT 1 FROM app.machine_credential WHERE environment_id = $1 AND state = 'active'",
      [envId("env1a")],
    );
    expect(active.rowCount).toBe(0);
  });

  it("environmentId limits the sweep to one environment", async () => {
    const one = await hold("after_marker", () => f.issue("env1a"));
    try {
      await age(one.operationId, 121);
      expect(
        (await sweepCredentials(f.api.pool, { environmentId: envId("env1b") })).uncertain,
      ).toEqual([]);
      expect((await operation(one.operationId))?.state).toBe("executing");
      expect(
        (await sweepCredentials(f.api.pool, { environmentId: envId("env1a") })).uncertain,
      ).toEqual([one.operationId]);
    } finally {
      one.release();
      await one.answer;
    }
  });
});
