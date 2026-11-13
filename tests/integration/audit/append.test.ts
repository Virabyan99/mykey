// Run 3.1 Task B: the audit append path against a real database.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditUnavailable, appendAudit, type AuditEvent } from "@mykey/audit";
import { createPool, withTransaction } from "@mykey/db";
import pg from "pg";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

let db: TestDatabase;

beforeAll(async () => {
  db = await prepareDatabase();
});

afterAll(async () => {
  await db.drop();
});

const COLUMNS = [
  "action",
  "actor_id",
  "actor_kind",
  "details",
  "id",
  "occurred_at",
  "operation_id",
  "organization_id",
  "outcome",
  "request_id",
  "source_category",
  "target_id",
  "target_kind",
];

function denied(requestId: string): AuditEvent {
  return {
    action: "access.denied",
    actor: { kind: "user", id: randomUUID() },
    source: "api",
    organizationId: null,
    target: { kind: "project", id: randomUUID() },
    outcome: "denied",
    requestId,
    operationId: null,
    details: { routeId: "projects.rename", reason: "action" },
  };
}

async function eventCount(): Promise<number> {
  const [row] = await run<{ n: number }>(
    db.pool("superuser"),
    "SELECT count(*)::int AS n FROM audit.event",
  );
  return row?.n ?? -1;
}

describe("appendAudit", () => {
  it("the row holds exactly the allowlisted columns", async () => {
    const requestId = randomUUID();
    const event = denied(requestId);
    const id = await appendAudit(db.pool("api_runtime"), event);
    const [row] = await run<Record<string, unknown>>(
      db.pool("superuser"),
      "SELECT * FROM audit.event WHERE id = $1",
      [id],
    );
    expect(Object.keys(row ?? {}).sort()).toEqual(COLUMNS);
    expect(row).toMatchObject({
      action: "access.denied",
      actor_kind: "user",
      actor_id: event.actor.id,
      source_category: "api",
      organization_id: null,
      target_kind: "project",
      target_id: event.target?.id,
      outcome: "denied",
      request_id: requestId,
      operation_id: null,
      details: { routeId: "projects.rename", reason: "action" },
    });
  });

  it("inside a transaction that rolls back, no row remains", async () => {
    const requestId = randomUUID();
    await expect(
      withTransaction(db.pool("api_runtime"), async (tx) => {
        await appendAudit(tx, denied(requestId));
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    const rows = await run(
      db.pool("superuser"),
      "SELECT 1 FROM audit.event WHERE request_id = $1",
      [requestId],
    );
    expect(rows).toEqual([]);
  });

  it("when the insert fails the caller gets AuditUnavailable", async () => {
    // A throw-away role that may use schema audit but not insert into it.
    const role = `t_noaudit_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(18).toString("hex");
    const superuser = db.pool("superuser");
    const database = pg.escapeIdentifier(db.database);
    // Name and password are hex generated above, safe to inline.
    await run(superuser, `CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await run(superuser, `GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    await run(superuser, `GRANT USAGE ON SCHEMA audit TO ${role}`);
    const pool = createPool({ ...db.targets.api_runtime, user: role, password }, { max: 1 });
    try {
      const before = await eventCount();
      const error = await appendAudit(pool, denied(randomUUID())).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuditUnavailable);
      expect(await eventCount()).toBe(before);
    } finally {
      await pool.end();
      await run(superuser, `REVOKE ALL ON SCHEMA audit FROM ${role}`);
      await run(superuser, `REVOKE ALL ON DATABASE ${database} FROM ${role}`);
      await run(superuser, `DROP ROLE ${role}`);
    }
  });

  it("a details value that looks like a secret is rejected by its schema", async () => {
    const before = await eventCount();
    const secretLike = randomBytes(30).toString("base64url");
    expect(secretLike).toHaveLength(40);
    const asRoute = await appendAudit(db.pool("api_runtime"), {
      ...denied(randomUUID()),
      details: { routeId: secretLike, reason: "action" },
    }).catch((e: unknown) => e);
    expect(asRoute).toBeInstanceOf(Error);
    expect(asRoute).not.toBeInstanceOf(AuditUnavailable);
    expect(String(asRoute).includes(secretLike)).toBe(false);
    const asTarget = await appendAudit(db.pool("api_runtime"), {
      ...denied(randomUUID()),
      target: { kind: "project", id: secretLike },
    }).catch((e: unknown) => e);
    expect(asTarget).toBeInstanceOf(Error);
    expect(String(asTarget).includes(secretLike)).toBe(false);
    expect(await eventCount()).toBe(before);
  });
});
