// The complete environment read (Run 4.8, P-78, FR-1.84): under the
// environment's lock, every live value of one generation or nothing. Read
// through the test-only route `test.read`, which answers digests only.
import { randomBytes, randomUUID } from "node:crypto";
import type { OperationId, OrganizationId } from "@mykey/contracts";
import { secretPath } from "@mykey/openbao";
import { reconcileEnvironment, reconcileOperation } from "@mykey/operations/operator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  idleAdvisoryLocks,
  sha256,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setFaults(null);
  f.relay.clear();
  expect(await idleAdvisoryLocks(f)).toBe(0);
});

const unique = (prefix = "C"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const valueOf = (label: string): string => `${mark}-${label}-${randomUUID()}`;

const read = (env: EnvName): Promise<Answer> =>
  f.send("GET", `${f.env(env).path}/test-read`, { key: null });

interface Entry {
  name: string;
  version: number;
  digest: string;
}
const entriesOf = (answer: Answer) => answer.body.entries as Entry[];

async function created(env: EnvName, name: string, value: string) {
  const answer = await f.create(env, name, value);
  expect(answer.status).toBe(201);
  return answer.body.result as { version: number; stateTag: string };
}

async function auditRows(action: string, requestId: string | null): Promise<number> {
  const result = await f.api.superuser.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit.event WHERE action = $1 AND request_id = $2",
    [action, requestId],
  );
  return result.rows[0]?.count ?? 0;
}

const operatorDeps = () => ({
  database: f.api.database.pool("maintenance"),
  bao: f.operatorBao(),
  operatorId: null,
  requestId: randomUUID(),
});

/** Puts the environment back the way the backend says (the operator's rebuild). */
async function repair(env: EnvName): Promise<void> {
  const { projectId, environmentId } = f.env(env);
  const verdict = await reconcileEnvironment(operatorDeps(), {
    organizationId: f.tenants.a.organizationId as OrganizationId,
    projectId,
    environmentId,
  });
  expect(verdict.kind).toBe("rebuilt");
  const state = await f.api.superuser.query<{ state: string }>(
    "SELECT state FROM app.environment WHERE id = $1",
    [environmentId],
  );
  expect(state.rows[0]?.state).toBe("active");
}

const bytewise = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

describe("the complete environment read", () => {
  it("an empty environment → no entries", async () => {
    const answer = await read("env2a");
    expect(answer.status).toBe(200);
    expect(entriesOf(answer)).toEqual([]);
  });

  it("three live and one deleted → three entries in bytewise order", async () => {
    const prefix = unique("O");
    const names = [`${prefix}_Z`, `${prefix}1`, `${prefix}_A`];
    const values = new Map(names.map((name) => [name, valueOf(name)]));
    for (const name of names) await created("env1b", name, values.get(name) ?? "");
    const gone = `${prefix}_D`;
    const current = await created("env1b", gone, valueOf("gone"));
    expect((await f.act("env1b", gone, "delete", current)).status).toBe(200);
    const answer = await read("env1b");
    expect(answer.status).toBe(200);
    expect(answer.text.includes(mark)).toBe(false);
    const mine = entriesOf(answer).filter((entry) => entry.name.startsWith(prefix));
    expect(mine.map((entry) => entry.name)).toEqual([...names].sort(bytewise));
    for (const entry of mine) {
      expect(entry.digest).toBe(sha256(values.get(entry.name) ?? ""));
      expect(entry.version).toBe(1);
    }
    const all = entriesOf(answer).map((entry) => entry.name);
    expect(all).toEqual([...all].sort(bytewise));
  });

  it("a deleted name still listed by the backend is no drift", async () => {
    const name = unique();
    const current = await created("env1b", name, valueOf("deleted"));
    expect((await f.act("env1b", name, "delete", current)).status).toBe(200);
    const answer = await read("env1b");
    expect(answer.status).toBe(200);
    expect(entriesOf(answer).some((entry) => entry.name === name)).toBe(false);
  });

  it("the audit row is committed when the answer arrives", async () => {
    await created("env1b", unique(), valueOf("audited"));
    const answer = await read("env1b");
    expect(answer.status).toBe(200);
    expect(await auditRows("secret.export", answer.headers.get("x-request-id"))).toBe(1);
  });

  it("a key in review → 409 key_under_review", async () => {
    const name = unique("R");
    await f.seedIndex("env1b", [name], "needs_review");
    try {
      const answer = await read("env1b");
      expect(answer.status).toBe(409);
      expect(answer.code).toBe("key_under_review");
    } finally {
      await f.unseedIndex("env1b", [name]);
    }
  });

  it("a slot → 409 key_under_review with operationId", async () => {
    const name = unique("S");
    f.setFaults((point) => {
      if (point === "after_send") throw new Error("fault: the answer is lost");
    });
    const write = await f.create("env1b", name, valueOf("slot"));
    f.setFaults(null);
    expect(write.code).toBe("outcome_unknown");
    const holder = write.operationId as OperationId;
    const answer = await read("env1b");
    expect(answer.status).toBe(409);
    expect(answer.code).toBe("key_under_review");
    expect(answer.operationId).toBe(holder);
    const verdict = await reconcileOperation(operatorDeps(), holder, { executorsExcluded: false });
    expect(verdict.kind).toBe("succeeded");
    expect((await read("env1b")).status).toBe(200);
  });

  it("the Nth backend read fails (relay) → 503 dependency_unavailable, no entries, no audit row", async () => {
    for (let index = 0; index < 12; index += 1) await created("env1a", unique("N"), valueOf("n"));
    // The list and four reads pass; the fifth read and the rest are dropped.
    f.relay.dropAfter(5);
    const answer = await read("env1a");
    f.relay.clear();
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("dependency_unavailable");
    expect(answer.body.entries).toBeUndefined();
    expect(await auditRows("secret.export", answer.headers.get("x-request-id"))).toBe(0);
    expect((await read("env1a")).status).toBe(200);
  });

  it("audit cannot be written → 503 audit_unavailable, no entries", async () => {
    await created("env1a", unique(), valueOf("audit"));
    const db = f.api.superuser;
    await db.query("REVOKE INSERT ON audit.event FROM api_runtime");
    try {
      const answer = await read("env1a");
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("audit_unavailable");
      expect(answer.body.entries).toBeUndefined();
    } finally {
      await db.query("GRANT INSERT ON audit.event TO api_runtime");
    }
  });

  it("the lock session is terminated before the audit commit → 503 dependency_unavailable", async () => {
    await created("env1a", unique(), valueOf("terminate"));
    f.setFaults(async (point) => {
      if (point !== "before_audit_commit") return;
      await f.api.superuser.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype = 'advisory' AND granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
    });
    const answer = await read("env1a");
    f.setFaults(null);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("dependency_unavailable");
    expect(await auditRows("secret.export", answer.headers.get("x-request-id"))).toBe(0);
    expect((await read("env1a")).status).toBe(200);
  });

  it("the generation moves under the read (superuser, in the hook) → 409 environment_changed", async () => {
    await created("env1a", unique(), valueOf("moved"));
    f.setFaults(async (point) => {
      if (point !== "after_backend_read") return;
      await f.api.superuser.query(
        "UPDATE app.environment SET metadata_generation = metadata_generation + 1 WHERE id = $1",
        [f.env("env1a").environmentId],
      );
    });
    const answer = await read("env1a");
    f.setFaults(null);
    expect(answer.status).toBe(409);
    expect(answer.code).toBe("environment_changed");
    expect(await auditRows("secret.export", answer.headers.get("x-request-id"))).toBe(0);
  });

  it("a name in the backend that the index lacks → 503 backend_inconsistent, environment needs_review, one drift event", async () => {
    const { projectId, environmentId } = f.env("env2a");
    const name = unique("X");
    const written = await f
      .operatorBao()
      .kvWrite(
        secretPath(projectId, environmentId, name),
        { value: valueOf("outside"), operation_id: randomUUID(), format: 1 },
        0,
        { operationId: randomUUID(), dispatchId: randomUUID() },
      );
    expect(written.ok).toBe(true);
    try {
      const answer = await read("env2a");
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("backend_inconsistent");
      expect(await auditRows("system.drift_detected", answer.headers.get("x-request-id"))).toBe(1);
      const state = await f.api.superuser.query<{ state: string }>(
        "SELECT state FROM app.environment WHERE id = $1",
        [environmentId],
      );
      expect(state.rows[0]?.state).toBe("needs_review");
    } finally {
      await repair("env2a");
    }
    await expectIndexMatchesBackend(f, "env2a");
  });

  it("a name in the index that the backend lacks → the same", async () => {
    const name = unique("Y");
    await f.seedIndex("env2a", [name], "live");
    try {
      const answer = await read("env2a");
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("backend_inconsistent");
      expect(await auditRows("system.drift_detected", answer.headers.get("x-request-id"))).toBe(1);
    } finally {
      await repair("env2a");
    }
    expect(await f.indexRow("env2a", name)).toBeNull();
    await expectIndexMatchesBackend(f, "env2a");
  });

  it("a version written past the product → 503 backend_inconsistent and that key in review", async () => {
    const name = unique("V");
    const current = await created("env2a", name, valueOf("old"));
    const { projectId, environmentId } = f.env("env2a");
    const moved = await f
      .operatorBao()
      .kvWrite(
        secretPath(projectId, environmentId, name),
        { value: valueOf("outside"), operation_id: randomUUID(), format: 1 },
        current.version,
        { operationId: randomUUID(), dispatchId: randomUUID() },
      );
    expect(moved.ok).toBe(true);
    try {
      const answer = await read("env2a");
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("backend_inconsistent");
      expect((await f.indexRow("env2a", name))?.state).toBe("needs_review");
    } finally {
      await repair("env2a");
    }
    await expectIndexMatchesBackend(f, "env2a");
  });
});
