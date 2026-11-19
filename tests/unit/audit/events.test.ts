// Run 3.1 Task B: the closed list of audit actions and their strict details.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUDIT_ACTIONS, AUDIT_DETAILS, appendAudit, type AuditEvent } from "@mykey/audit";
import { SECRET_NAME_PATTERN } from "@mykey/contracts";

type Json = Record<string, unknown>;

/** Every leaf a details schema allows must be an id, an enum, an integer, a boolean or a short string. */
function looseLeaves(schema: Json, path: string): string[] {
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as Json[]).flatMap((part, i) => looseLeaves(part, `${path}|${String(i)}`));
  }
  switch (schema.type) {
    case "object": {
      const properties = (schema.properties ?? {}) as Record<string, Json>;
      const problems = Object.entries(properties).flatMap(([key, child]) =>
        looseLeaves(child, `${path}.${key}`),
      );
      if (schema.additionalProperties !== false) problems.push(`${path}: not strict`);
      return problems;
    }
    case "string":
      if (schema.format === "uuid" || Array.isArray(schema.enum) || "const" in schema) return [];
      if (typeof schema.maxLength === "number" && schema.maxLength < 64) return [];
      // P-71: a secret name (up to 128) is the one longer string, and only under the name pattern.
      if (path.endsWith(".name") && schema.pattern === SECRET_NAME_PATTERN.source) return [];
      return [`${path}: a string that is neither an id, an enum nor shorter than 64`];
    case "integer":
    case "boolean":
    case "null":
      return [];
    default:
      return [`${path}: type ${String(schema.type)}`];
  }
}

const event = (action: string, details: Json): AuditEvent =>
  ({
    action,
    actor: { kind: "system", id: null },
    source: "system",
    organizationId: null,
    target: null,
    outcome: "success",
    requestId: null,
    operationId: null,
    details,
  }) as AuditEvent;

/** A Queryable that fails the test if any statement reaches it. */
const noSql = {
  query: () => {
    throw new Error("a statement was sent");
  },
} as never;

describe("audit actions", () => {
  it("starts with the three actions of Run 3.1 and gives every action a details schema", () => {
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining(["operator.bootstrap", "auth.sign_in", "access.denied"]),
    );
    expect(Object.keys(AUDIT_DETAILS).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it("every details schema is strict and holds only ids, enums, integers, booleans or short strings", () => {
    const problems = AUDIT_ACTIONS.flatMap((action) =>
      looseLeaves(z.toJSONSchema(AUDIT_DETAILS[action], { io: "input" }) as Json, action),
    );
    expect(problems).toEqual([]);
  });

  it("the walking test catches a loose string (control)", () => {
    const loose = z.strictObject({ note: z.string() });
    expect(looseLeaves(z.toJSONSchema(loose, { io: "input" }) as Json, "x")).toHaveLength(1);
  });

  it("an action outside the list is refused before any SQL", async () => {
    // @ts-expect-error -- not an action of the list
    const unknown: AuditEvent = { ...event("auth.sign_in", {}), action: "secret.dump" };
    await expect(appendAudit(noSql, unknown)).rejects.toThrow(/action/);
  });

  it("details with an extra key are refused before any SQL", async () => {
    await expect(
      appendAudit(
        noSql,
        event("access.denied", { routeId: "projects.create", reason: "hidden", extra: 1 }),
      ),
    ).rejects.toThrow(/details/);
  });

  it("a target id that is not a uuid is refused before any SQL", async () => {
    await expect(
      appendAudit(noSql, {
        ...event("operator.bootstrap", {}),
        target: { kind: "organization", id: "not-an-id" },
      }),
    ).rejects.toThrow(/event/);
  });
});

// Run 4.2 Task B Step 1 (P-71): the secret actions name their secret; outcomes intent and unknown.
describe("secret actions", () => {
  const secretActions = [
    "secret.create",
    "secret.update",
    "secret.delete",
    "secret.undelete",
    "secret.restore",
    "secret.reveal",
  ] as const;

  it("the actions of P-71 exist", () => {
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        ...secretActions,
        "secret.export",
        "import.preview",
        "import.apply",
        "import.resume",
        "system.operation_stuck",
        "operator.reconcile_operation",
        "operator.reconcile_environment",
        "operator.operations_expire",
      ]),
    );
  });

  it("details.name accepts a 128-character name and refuses lower case and a 129th character", () => {
    for (const action of secretActions) {
      const schema = AUDIT_DETAILS[action];
      expect(schema.safeParse({ name: `A${"B".repeat(127)}`, version: 1 }).success, action).toBe(
        true,
      );
      expect(schema.safeParse({ name: "db_host", version: 1 }).success, action).toBe(false);
      expect(schema.safeParse({ name: `A${"B".repeat(128)}`, version: 1 }).success, action).toBe(
        false,
      );
    }
  });

  it("no other string key of any action allows more than 63 characters (the walk above), and a long name elsewhere is refused (control)", () => {
    const loose = z.strictObject({ label: z.string().regex(SECRET_NAME_PATTERN) });
    expect(looseLeaves(z.toJSONSchema(loose, { io: "input" }) as Json, "x")).toHaveLength(1);
  });

  it("outcomes intent and unknown are accepted", async () => {
    const written: unknown[][] = [];
    const recorder = {
      query: (_sql: string, params: unknown[]) => {
        written.push(params);
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as never;
    for (const outcome of ["intent", "unknown"] as const) {
      await appendAudit(recorder, {
        ...event("secret.create", { name: "DB_HOST" }),
        // Run 6.1 (P-106): a tenant action carries its organization.
        organizationId: "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01",
        outcome,
      });
    }
    expect(written.map((params) => params[8])).toEqual(["intent", "unknown"]);
  });

  it("drift may name the object kv_data", () => {
    expect(
      AUDIT_DETAILS["system.drift_detected"].safeParse({ scope: "environment", object: "kv_data" })
        .success,
    ).toBe(true);
  });
});

// Run 5.1 (P-95): credential actions carry the credential id, never an accessor or a token.
describe("credential actions", () => {
  const id = "44444444-4444-4444-8444-444444444444";

  it("the issuance and revocation actions exist with their details", () => {
    expect(
      AUDIT_DETAILS["credential.issue"].safeParse({
        credentialId: id,
        nameLength: 7,
        ttlSeconds: 60,
      }).success,
    ).toBe(true);
    expect(AUDIT_DETAILS["credential.revoke"].safeParse({ credentialId: id }).success).toBe(true);
  });

  it("an accessor, a token or the name itself is refused", () => {
    const base = { credentialId: id, nameLength: 7, ttlSeconds: 60 };
    for (const extra of [{ accessor: "a" }, { token: "t" }, { name: "deploy" }]) {
      expect(AUDIT_DETAILS["credential.issue"].safeParse({ ...base, ...extra }).success).toBe(
        false,
      );
    }
    expect(
      AUDIT_DETAILS["credential.revoke"].safeParse({ credentialId: "not-an-id" }).success,
    ).toBe(false);
  });

  // Run 5.2 (P-90): the operator's reconciliation records counts only.
  it("operator.reconcile_credentials takes the four counts and the flag, and nothing else", () => {
    const counts = {
      unrecordedRevoked: 1,
      revocationsCompleted: 0,
      issuancesSettled: 2,
      left: 0,
      executorsExcluded: false,
    };
    const details = AUDIT_DETAILS["operator.reconcile_credentials"];
    expect(details.safeParse(counts).success).toBe(true);
    expect(details.safeParse({ ...counts, accessor: "a" }).success).toBe(false);
    expect(details.safeParse({ ...counts, left: -1 }).success).toBe(false);
  });
});
