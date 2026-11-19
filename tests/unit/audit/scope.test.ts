// Run 6.1 Task A (P-106, FR-1.58): every action is a tenant, account or
// global event, and `appendAudit` refuses an event whose organization does not
// fit its scope — before any SQL. No details schema has a key that could name
// a credential, a value or a path.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AUDIT_ACTIONS,
  AUDIT_DETAILS,
  AUDIT_SCOPE,
  AuditEventInvalid,
  appendAudit,
  type AuditEvent,
} from "@mykey/audit";
import type { Queryable } from "@mykey/db";

/** A database that must never be reached. */
const unreachable = {
  query: () => {
    throw new Error("appendAudit reached SQL");
  },
} as unknown as Queryable;

const ORG = "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01";
const USER = "0b8f3c7e-5a1d-4c2b-8e9f-1a2b3c4d5e6f";

const base = (over: Partial<AuditEvent>): AuditEvent => ({
  action: "operator.operations_expire",
  actor: { kind: "operator", id: null },
  source: "operator",
  organizationId: null,
  target: null,
  outcome: "success",
  requestId: null,
  operationId: null,
  details: { expired: 1 },
  ...over,
});

/** Every key of an object schema, nested ones included. */
function keysOf(schema: Record<string, unknown>): string[] {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(properties).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

describe("audit scopes (P-106)", () => {
  it("every action has a scope", () => {
    const scopes = new Set(["tenant", "account", "global"]);
    for (const action of AUDIT_ACTIONS) expect(scopes.has(AUDIT_SCOPE[action]), action).toBe(true);
    expect(Object.keys(AUDIT_SCOPE).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it("appendAudit refuses a global action with an organization id", async () => {
    expect(AUDIT_SCOPE["operator.operations_expire"]).toBe("global");
    await expect(appendAudit(unreachable, base({ organizationId: ORG }))).rejects.toEqual(
      new AuditEventInvalid("event"),
    );
  });

  it("appendAudit refuses a tenant action without an organization id", async () => {
    expect(AUDIT_SCOPE["project.create"]).toBe("tenant");
    const event = base({
      action: "project.create",
      actor: { kind: "user", id: USER },
      source: "api",
      target: { kind: "project", id: USER },
      details: { nameLength: 4 },
    });
    await expect(appendAudit(unreachable, event)).rejects.toEqual(new AuditEventInvalid("event"));
  });

  it("a denial names its organization only when the caller is a member: tenant or account, never global", async () => {
    expect(AUDIT_SCOPE["access.denied"]).toBe("tenant");
    const event = base({
      action: "access.denied",
      actor: { kind: "user", id: USER },
      source: "api",
      target: null,
      outcome: "denied",
      details: { routeId: "projects.list", reason: "hidden" },
    });
    const sql: unknown[] = [];
    const recording = {
      query: (text: string) => {
        sql.push(text);
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as unknown as Queryable;
    await appendAudit(recording, event);
    await appendAudit(recording, { ...event, organizationId: ORG });
    expect(sql).toHaveLength(2);
  });

  it("appendAudit refuses an account action with an organization id", async () => {
    expect(AUDIT_SCOPE["auth.sign_out"]).toBe("account");
    const event = base({
      action: "auth.sign_out",
      actor: { kind: "user", id: USER },
      source: "api",
      organizationId: ORG,
    });
    await expect(appendAudit(unreachable, event)).rejects.toEqual(new AuditEventInvalid("event"));
  });

  it("the infrastructure's actions are global and the auth actions are account", () => {
    for (const action of AUDIT_ACTIONS) {
      if (action.startsWith("auth.") && action !== "auth.throttled") {
        expect(AUDIT_SCOPE[action], action).toBe("account");
      }
      if (
        /^system\.(audit|backup)_/.test(action) ||
        /^operator\.(gate|restore|deploy)/.test(action)
      ) {
        expect(AUDIT_SCOPE[action], action).toBe("global");
      }
    }
    expect(AUDIT_SCOPE["auth.throttled"]).toBe("global");
    expect(AUDIT_SCOPE["operator.auth_cleanup"]).toBe("global");
    expect(AUDIT_SCOPE["operator.operations_expire"]).toBe("global");
    expect(AUDIT_SCOPE["operator.reset_initiate"]).toBe("account");
  });

  it("no details schema has a key matching /token|secret|password|accessor|code|link|value|path/i", () => {
    const pattern = /token|secret|password|accessor|code|link|value|path/i;
    const bad = AUDIT_ACTIONS.flatMap((action) =>
      keysOf(z.toJSONSchema(AUDIT_DETAILS[action]) as Record<string, unknown>)
        .filter((key) => pattern.test(key))
        .map((key) => `${action}.${key}`),
    );
    expect(bad).toEqual([]);
  });

  it("the actions of the whole session are declared now (Runs 6.2–6.9 only write them)", () => {
    for (const action of [
      "auth.sign_out",
      "auth.session_revoke",
      "operator.auth_cleanup",
      "system.audit_archive",
      "system.audit_purge",
      "system.backup_capture",
      "system.backup_eligible",
      "system.backup_invalidated",
      "system.backup_cleanup",
      "operator.gate_open",
      "operator.gate_close",
      "operator.restore_begin",
      "operator.restore_invalidate",
      "operator.restore_verify",
      "operator.deploy",
    ]) {
      expect(AUDIT_ACTIONS, action).toContain(action);
    }
  });
});
