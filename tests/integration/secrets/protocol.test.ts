// The mutation protocol's refusals and faults (Run 4.2 Task B, Doc 06 §6.2,
// Review focus 1 and 2). Before the dispatch marker a failure leaves no
// operation (or a rejected one, when the gate closes); after it, every failure
// answers 503 outcome_unknown with the operation id.
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  idleAdvisoryLocks,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setFaults(null);
  f.setBao("relay");
  f.relay.clear();
  f.api.setGate("open");
  expect(await idleAdvisoryLocks(f)).toBe(0);
});

const unique = (prefix = "P"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (): string => `synthetic-${randomUUID()}`;

async function operationCount(env: EnvName): Promise<number> {
  const result = await f.api.superuser.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM app.operation WHERE environment_id = $1",
    [f.env(env).environmentId],
  );
  return result.rows[0]?.count ?? 0;
}

async function operationState(id: string): Promise<{ state: string; error_code: string | null }> {
  const result = await f.api.superuser.query<{ state: string; error_code: string | null }>(
    "SELECT state, error_code FROM app.operation WHERE id = $1",
    [id],
  );
  return result.rows[0]!;
}

async function slotHolder(env: EnvName): Promise<string | null> {
  const result = await f.api.superuser.query<{ operation_id: string }>(
    "SELECT operation_id FROM app.effect_slot WHERE scope_key = $1",
    [`env:${f.env(env).environmentId}`],
  );
  return result.rows[0]?.operation_id ?? null;
}

/** Frees an environment an uncertain operation left behind (the sweep's work, Run 4.5). */
async function freeSlot(env: EnvName): Promise<void> {
  await f.api.superuser.query("DELETE FROM app.effect_slot WHERE scope_key = $1", [
    `env:${f.env(env).environmentId}`,
  ]);
}

async function lockKey(env: EnvName): Promise<string> {
  const result = await f.api.superuser.query<{ lock_key: string }>(
    "SELECT lock_key FROM app.environment WHERE id = $1",
    [f.env(env).environmentId],
  );
  return result.rows[0]!.lock_key;
}

describe("refusals before the dispatch marker", () => {
  it("the lock is busy: 503 busy after about two seconds, no operation", async () => {
    const holder = await f.api.superuser.connect();
    const key = await lockKey("env1a");
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [key]);
      const before = await operationCount("env1a");
      const started = Date.now();
      const answer = await f.create("env1a", unique(), synthetic());
      const elapsed = Date.now() - started;
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("busy");
      expect(elapsed).toBeGreaterThanOrEqual(1_500);
      expect(elapsed).toBeLessThan(10_000);
      expect(await operationCount("env1a")).toBe(before);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [key]);
      holder.release();
    }
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("an occupied slot: 409 key_under_review with the holder's operationId", async () => {
    const holder = randomUUID();
    const { environmentId, projectId } = f.env("env1a");
    const db = f.api.superuser;
    await db.query(
      `INSERT INTO app.operation (id, organization_id, project_id, environment_id, principal_kind,
         principal_id, action, target, idempotency_key, state)
       VALUES ($1::uuid, $2, $3, $4::uuid, 'user', $5, 'secrets.update', $4::text, $1::text, 'uncertain')`,
      [holder, f.tenants.a.organizationId, projectId, environmentId, f.tenants.userId("ownerA")],
    );
    await db.query(
      `INSERT INTO app.effect_slot (scope_key, operation_id, generation, acquired_at)
       VALUES ($1, $2, 0, now())`,
      [`env:${environmentId}`, holder],
    );
    try {
      const name = unique();
      const answer = await f.create("env1a", name, synthetic());
      expect(answer.status).toBe(409);
      expect(answer.code).toBe("key_under_review");
      expect(answer.operationId).toBe(holder);
      expect(await f.backend("env1a", name)).toBeNull();
    } finally {
      await freeSlot("env1a");
    }
    expect((await f.create("env1a", unique(), synthetic())).status).toBe(201);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("capture mode draining: 503 busy", async () => {
    const db = f.api.superuser;
    await db.query("UPDATE app.service_control SET capture_mode = 'draining'");
    try {
      const name = unique();
      const answer = await f.create("env1a", name, synthetic());
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("busy");
      expect(await f.backend("env1a", name)).toBeNull();
    } finally {
      await db.query("UPDATE app.service_control SET capture_mode = 'idle'");
    }
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("audit cannot be written: 503 audit_unavailable, no operation, nothing sent", async () => {
    const db = f.api.superuser;
    const before = await operationCount("env1a");
    await db.query("REVOKE INSERT ON audit.event FROM api_runtime");
    try {
      const name = unique();
      const answer = await f.create("env1a", name, synthetic());
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("audit_unavailable");
      expect(await f.backend("env1a", name)).toBeNull();
      expect(await operationCount("env1a")).toBe(before);
    } finally {
      await db.query("GRANT INSERT ON audit.event TO api_runtime");
    }
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("the backend refuses the connection: 503 dependency_unavailable, no operation", async () => {
    const before = await operationCount("env1a");
    f.setBao("closed");
    const answer = await f.create("env1a", unique(), synthetic());
    f.setBao("relay");
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("dependency_unavailable");
    expect(await operationCount("env1a")).toBe(before);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("the gate closes between admission and dispatch: rejected with quarantined, slot released, nothing sent", async () => {
    const name = unique();
    f.setFaults((point) => {
      if (point === "after_admission") f.api.setGate("closed");
    });
    const answer = await f.create("env1a", name, synthetic());
    f.setFaults(null);
    f.api.setGate("open");
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("quarantined");
    expect(answer.operationId).toBeDefined();
    const stored = await operationState(answer.operationId!);
    expect(stored).toEqual({ state: "rejected", error_code: "quarantined" });
    expect(await slotHolder("env1a")).toBeNull();
    expect(await f.backend("env1a", name)).toBeNull();
    expect(await f.auditedChanges(answer.operationId!)).toBe(0);
    await expectIndexMatchesBackend(f, "env1a");
  });
});

describe("faults after the dispatch marker (Review focus 1)", () => {
  for (const point of [
    "after_dispatch_marker",
    "after_send",
    "after_read_back",
    "before_finalize_commit",
  ]) {
    it(`a throw at ${point} answers 503 outcome_unknown with operationId; never rejected or succeeded`, async () => {
      const name = unique();
      f.setFaults((at) => {
        if (at === point) throw new Error("fault");
      });
      const answer = await f.create("env2a", name, synthetic());
      f.setFaults(null);
      try {
        expect(answer.status).toBe(503);
        expect(answer.code).toBe("outcome_unknown");
        expect(answer.operationId).toBeDefined();
        const { state } = await operationState(answer.operationId!);
        expect(["executing", "uncertain"]).toContain(state);
        expect(await slotHolder("env2a")).toBe(answer.operationId);
      } finally {
        await freeSlot("env2a");
      }
    });
  }

  it("a throw after finalize: the operation succeeded, the answer is still 503, and a replay answers 201", async () => {
    const name = unique();
    const value = synthetic();
    const key = randomUUID();
    f.setFaults((at) => {
      if (at === "after_finalize") throw new Error("fault");
    });
    const answer = await f.create("env1a", name, value, { key });
    f.setFaults(null);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    expect((await operationState(answer.operationId!)).state).toBe("succeeded");
    const replay = await f.create("env1a", name, value, { key });
    expect(replay.status).toBe(201);
    expect(replay.body.operationId).toBe(answer.operationId);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("the lock session is terminated after the send: 503 outcome_unknown; the connection is not reused (Review focus 2)", async () => {
    const name = unique();
    f.setFaults(async (at) => {
      if (at !== "after_send") return;
      await f.api.superuser.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype = 'advisory' AND granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
    });
    const answer = await f.create("env2a", name, synthetic());
    f.setFaults(null);
    try {
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("outcome_unknown");
      expect(answer.operationId).toBeDefined();
      expect(["executing", "uncertain"]).toContain(
        (await operationState(answer.operationId!)).state,
      );
    } finally {
      await freeSlot("env2a");
    }
    // The lock pool hands out working connections; none holds an advisory lock.
    for (let round = 0; round < 3; round += 1) {
      expect((await f.create("env1a", unique(), synthetic())).status).toBe(201);
    }
    const held = await f.api.superuser.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_locks
        WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    expect(held.rows[0]?.count).toBe(0);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a delayed answer: 503 outcome_unknown, uncertain, key in review, slot held, one audited change, version written", async () => {
    const name = unique();
    f.setFaults((at) => {
      // After the pre-read: only the write's answer is held past the 5 s deadline.
      if (at === "after_dispatch_marker") f.relay.delayResponses(8_000);
    });
    const answer = await f.create("env2a", name, synthetic());
    f.setFaults(null);
    f.relay.clear();
    try {
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("outcome_unknown");
      const operationId = answer.operationId!;
      expect((await operationState(operationId)).state).toBe("uncertain");
      expect((await f.indexRow("env2a", name))?.state).toBe("needs_review");
      expect(await slotHolder("env2a")).toBe(operationId);
      // The write arrives in OpenBao once the relay lets it through.
      let backend = await f.backend("env2a", name);
      for (let wait = 0; backend === null && wait < 40; wait += 1) {
        await sleep(250);
        backend = await f.backend("env2a", name);
      }
      expect(backend?.versions[0]?.operationId).toBe(operationId);
      expect(await f.auditedChanges(operationId)).toBe(1);
    } finally {
      await freeSlot("env2a");
    }
  }, 30_000);
});
