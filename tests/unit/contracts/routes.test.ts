import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DENIED_ALIASES,
  ERROR_CODES,
  LIMITS,
  OPERATION_STATES,
  ROUTES,
  operationResponseSchema,
  type RouteDef,
} from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

const O = "/v1/organizations/:org";
const P = `${O}/projects/:project`;
const E = `${P}/environments/:env`;
const M = "/v1/machine/projects/:project/environments/:envName";

/** The frozen table of docs/plans/session-1-plan.md Run 1.6 Task C: id, method, path, auth, idempotent, owner run. */
const TABLE: readonly (readonly [string, string, string, string, boolean, string])[] = [
  ["health.get", "GET", "/health", "public", false, "2.5"],
  ["version.get", "GET", "/v1/version", "public", false, "3.1"],
  ["organizations.list", "GET", "/v1/organizations", "human", false, "3.7"],
  ["projects.list", "GET", `${O}/projects`, "human", false, "3.9"],
  ["projects.create", "POST", `${O}/projects`, "human", true, "3.9"],
  ["projects.rename", "PATCH", P, "human", true, "3.9"],
  ["projects.archive", "POST", `${P}/archive`, "human", true, "5.3"],
  ["projects.reactivate", "POST", `${P}/reactivate`, "human", true, "5.3"],
  ["environments.list", "GET", `${P}/environments`, "human", false, "3.9"],
  ["environments.create", "POST", `${P}/environments`, "human", true, "3.9"],
  ["environments.rename", "PATCH", E, "human", true, "3.9"],
  ["environments.archive", "POST", `${E}/archive`, "human", true, "5.3"],
  ["environments.reactivate", "POST", `${E}/reactivate`, "human", true, "5.3"],
  ["secrets.list", "GET", `${E}/secrets`, "human", false, "4.3"],
  ["secrets.history", "GET", `${E}/secrets/:name/history`, "human", false, "4.3"],
  ["secrets.reveal", "POST", `${E}/secrets/:name/reveal`, "human", false, "4.3"],
  ["secrets.create", "POST", `${E}/secrets`, "human", true, "4.2"],
  ["secrets.update", "PATCH", `${E}/secrets/:name`, "human", true, "4.2"],
  ["secrets.delete", "POST", `${E}/secrets/:name/delete`, "human", true, "4.4"],
  ["secrets.undelete", "POST", `${E}/secrets/:name/undelete`, "human", true, "4.4"],
  ["secrets.restore", "POST", `${E}/secrets/:name/restore`, "human", true, "4.4"],
  ["import.preview", "POST", `${E}/import/preview`, "human", false, "4.7"],
  ["import.apply", "POST", `${E}/import/:preview/apply`, "human", true, "4.7"],
  ["import.resume", "POST", `${E}/import-operations/:operation/resume`, "human", false, "4.7"],
  ["export.create", "POST", `${E}/export`, "human_fresh_totp", false, "4.9"],
  ["credentials.list", "GET", `${E}/credentials`, "human", false, "5.1"],
  ["credentials.issue", "POST", `${E}/credentials`, "human_fresh_totp", true, "5.1"],
  ["credentials.revoke", "POST", `${E}/credentials/:credential/revoke`, "human", true, "5.2"],
  ["operations.get", "GET", "/v1/operations/:operation", "human", false, "4.1"],
  ["operations.list", "GET", `${E}/operations`, "human", false, "4.1"],
  ["audit.list", "GET", `${O}/audit`, "human", false, "6.1"],
  ["activity.list", "GET", `${O}/activity`, "human", false, "6.1"],
  ["overview.get", "GET", `${O}/overview`, "human", false, "7.3"],
  ["credentials.summary", "GET", `${O}/credentials/summary`, "human", false, "7.7"],
  ["metrics.get", "GET", `${O}/metrics`, "human", false, "7.8"],
  ["session.activity", "POST", "/v1/session/activity", "human", false, "3.5"],
  ["auth.reset.complete", "POST", "/v1/auth/reset/complete", "reset_flow", false, "3.6"],
  ["reference.get", "GET", "/v1/reference", "human", false, "5.9"],
  ["openapi.get", "GET", "/v1/openapi.json", "human", false, "5.9"],
  ["machine.keys", "GET", `${M}/keys`, "machine", false, "5.4"],
  ["machine.resolve", "POST", `${M}/resolve`, "machine", false, "5.4"],
];

const NOT_IDEMPOTENT_MUTATIONS = [
  "auth.reset.complete",
  "export.create",
  "import.preview",
  "import.resume",
  "machine.resolve",
  "secrets.reveal",
  "session.activity",
];

function route(id: string): RouteDef {
  const found = ROUTES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no route ${id}`);
  return found;
}

function body(id: string): z.ZodType {
  const schema = route(id).request.body;
  if (schema === undefined || typeof schema === "string") throw new Error(`${id} has no JSON body`);
  return schema;
}

const stateTag = "tag-1";

describe("frozen route list", () => {
  it("has 41 routes with unique ids and unique method + path", () => {
    expect(ROUTES).toHaveLength(41);
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(41);
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(41);
  });

  it("matches the frozen table row by row", () => {
    expect(TABLE).toHaveLength(41);
    expect(ROUTES.map((r) => [r.id, r.method, r.path, r.auth, r.idempotent, r.ownerRun])).toEqual(
      TABLE.map((row) => [...row]),
    );
  });

  it("requires Idempotency-Key on every POST and PATCH except the seven read-like or flow routes", () => {
    const mutations = ROUTES.filter((r) => r.method !== "GET");
    expect(
      mutations
        .filter((r) => !r.idempotent)
        .map((r) => r.id)
        .sort(),
    ).toEqual(NOT_IDEMPOTENT_MUTATIONS);
    expect(ROUTES.filter((r) => r.method === "GET" && r.idempotent)).toEqual([]);
  });

  it("has one operation-status route and denies its alias", () => {
    expect(DENIED_ALIASES).toEqual([{ method: "GET", path: "/v1/operations/:id/status" }]);
    const shape = (path: string) => path.replace(/:[A-Za-z]+/g, ":x");
    for (const alias of DENIED_ALIASES) {
      expect(
        ROUTES.some((r) => r.method === alias.method && shape(r.path) === shape(alias.path)),
      ).toBe(false);
    }
    expect(ROUTES.filter((r) => r.path.startsWith("/v1/operations/"))).toHaveLength(1);
  });

  it("gives every route only known error codes, and an envelope for each", () => {
    for (const r of ROUTES) {
      for (const code of r.errors) expect(ERROR_CODES[code], `${r.id} ${code}`).toBeDefined();
      expect(new Set(r.errors).size, r.id).toBe(r.errors.length);
    }
    expect(route("health.get").errors).toEqual([]);
    expect(route("machine.resolve").errors).toContain("forbidden_selector");
    expect(route("export.create").errors).toContain("fresh_verification_required");
    expect(route("credentials.issue").errors).toContain("credential_not_replayable");
    expect(route("secrets.update").errors).toContain("version_conflict");
    expect(route("secrets.list").errors).toContain("listing_changed");
    for (const r of ROUTES.filter((candidate) => candidate.idempotent)) {
      expect(r.errors, r.id).toEqual(
        expect.arrayContaining(["idempotency_conflict", "replay_expired", "outcome_unknown"]),
      );
    }
    for (const r of ROUTES) {
      expect(r.errors.includes("not_found"), r.id).toBe(r.path.includes("/:"));
    }
  });

  it("keeps the pending list equal to the committed snapshot (it may only shrink)", () => {
    const snapshot = JSON.parse(
      readFileSync(join(import.meta.dirname, "pending-routes.snapshot.json"), "utf8"),
    ) as string[];
    const pending = ROUTES.filter((r) => r.pending).map((r) => r.id);
    expect(pending).toEqual(snapshot);
  });
});

describe("request schemas the specification already fixes", () => {
  it("secrets.update needs value, expectedVersion and expectedStateTag, and nothing else", () => {
    const schema = body("secrets.update");
    const good = { value: "v", expectedVersion: 3, expectedStateTag: stateTag };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ value: "v", expectedVersion: 3 }).success).toBe(false);
    expect(schema.safeParse({ value: "v", expectedStateTag: stateTag }).success).toBe(false);
    expect(schema.safeParse({ ...good, force: true }).success).toBe(false);
    expect(schema.safeParse({ ...good, expectedVersion: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...good, expectedVersion: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...good, value: "a\0b" }).success).toBe(false);
  });

  it("secrets.create applies the name and value rules", () => {
    const schema = body("secrets.create");
    expect(schema.safeParse({ name: "DATABASE_URL", value: "" }).success).toBe(true);
    expect(schema.safeParse({ name: "database_url", value: "x" }).success).toBe(false);
    expect(schema.safeParse({ name: "SECRETS_X", value: "x" }).success).toBe(false);
    expect(schema.safeParse({ name: "A", value: "a".repeat(65537) }).success).toBe(false);
    expect(schema.safeParse({ name: "A" }).success).toBe(false);
  });

  it("destructive and lifecycle bodies need confirmed: true", () => {
    for (const id of ["projects.archive", "environments.reactivate", "export.create"]) {
      expect(body(id).safeParse({ confirmed: true }).success, id).toBe(true);
      expect(body(id).safeParse({ confirmed: false }).success, id).toBe(false);
      expect(body(id).safeParse({}).success, id).toBe(false);
    }
    const remove = body("secrets.delete");
    const base = { expectedVersion: 1, expectedStateTag: stateTag };
    expect(remove.safeParse({ ...base, confirmed: true }).success).toBe(true);
    expect(remove.safeParse(base).success).toBe(false);
    const restore = body("secrets.restore");
    expect(restore.safeParse({ ...base, sourceVersion: 1, confirmed: true }).success).toBe(true);
    expect(restore.safeParse({ ...base, confirmed: true }).success).toBe(false);
  });

  it("credentials.issue bounds ttlSeconds and defaults it to the maximum", () => {
    const schema = body("credentials.issue");
    const max = LIMITS.machineToken.maxTtlSeconds;
    expect(max).toBe(2592000);
    for (const ttlSeconds of [0, -1, max + 1, 1.5]) {
      expect(schema.safeParse({ name: "ci", ttlSeconds }).success, String(ttlSeconds)).toBe(false);
    }
    expect(schema.parse({ name: "ci", ttlSeconds: max })).toEqual({ name: "ci", ttlSeconds: max });
    expect(schema.parse({ name: "ci" })).toEqual({ name: "ci", ttlSeconds: max });
  });

  it("names use the shared validators", () => {
    expect(body("environments.create").safeParse({ name: "staging-2" }).success).toBe(true);
    expect(body("environments.create").safeParse({ name: "Staging" }).success).toBe(false);
    expect(body("projects.create").safeParse({ name: "My project" }).success).toBe(true);
    expect(body("projects.create").safeParse({ name: "   " }).success).toBe(false);
    expect(body("projects.create").safeParse({ name: "x", extra: 1 }).success).toBe(false);
  });

  it("raw dotenv routes carry no JSON body", () => {
    for (const id of ["import.preview", "import.apply", "import.resume"]) {
      expect(route(id).request.body, id).toBe("raw-dotenv");
    }
    expect(route("export.create").responses[200]).toBe("dotenv-attachment");
  });
});

describe("response schemas the specification already fixes", () => {
  it("operation responses have the seven states and a nullable replay expiry", () => {
    expect(OPERATION_STATES).toEqual([
      "accepted",
      "executing",
      "awaiting_input",
      "uncertain",
      "succeeded",
      "partial",
      "rejected",
    ]);
    const base = {
      operationId: "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f",
      state: "uncertain",
      statusUrl: "/v1/operations/0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f",
      replayExpiresAt: null,
    };
    expect(operationResponseSchema.safeParse(base).success).toBe(true);
    expect(
      operationResponseSchema.safeParse({ ...base, replayExpiresAt: "2026-11-12T10:00:00Z" })
        .success,
    ).toBe(true);
    expect(operationResponseSchema.safeParse({ ...base, state: "failed" }).success).toBe(false);
    expect(operationResponseSchema.safeParse({ ...base, fingerprint: "x" }).success).toBe(false);
    const withoutExpiry = {
      operationId: base.operationId,
      state: base.state,
      statusUrl: base.statusUrl,
    };
    expect(operationResponseSchema.safeParse(withoutExpiry).success).toBe(false);
  });

  it("mutations answer with the operation schema; health is up or down only", () => {
    for (const r of ROUTES.filter((candidate) => candidate.idempotent)) {
      expect(r.responses[202], r.id).toBe(operationResponseSchema);
    }
    expect(route("operations.get").responses[200]).toBe(operationResponseSchema);
    const health = route("health.get");
    expect(Object.keys(health.responses)).toEqual(["200", "503"]);
    const up = health.responses[200] as z.ZodType;
    expect(up.safeParse({ status: "up" }).success).toBe(true);
    expect(up.safeParse({ status: "down" }).success).toBe(true);
    expect(up.safeParse({ status: "up", database: "ok" }).success).toBe(false);
    expect(up.safeParse({ status: "degraded" }).success).toBe(false);
  });

  it("machine.resolve is a strict, complete set", () => {
    const schema = route("machine.resolve").responses[200] as z.ZodType;
    const good = {
      apiMajor: 1,
      environmentId: "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f",
      generation: "7",
      count: 1,
      entries: [{ name: "A", value: "synthetic" }],
      complete: true,
    };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, complete: false }).success).toBe(false);
    expect(schema.safeParse({ ...good, partial: true }).success).toBe(false);
    expect(schema.safeParse({ ...good, entries: [{ name: "A" }] }).success).toBe(false);
    expect(
      schema.safeParse({ ...good, entries: [{ name: "A", value: "v", version: 2 }] }).success,
    ).toBe(false);
    expect(route("machine.resolve").request.body).toBeUndefined();
    expect(schema.safeParse({ ...good, generation: 7 }).success).toBe(false);
    expect(schema.safeParse({ ...good, generation: "07" }).success).toBe(false);
  });

  it("machine.keys is the live names of one generation and never a value (Run 5.4, P-94)", () => {
    const schema = route("machine.keys").responses[200] as z.ZodType;
    const good = {
      apiMajor: 1,
      environmentId: "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f",
      generation: "12",
      count: 2,
      names: ["A", "B"],
      complete: true,
    };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, entries: [] }).success).toBe(false);
    expect(schema.safeParse({ ...good, complete: false }).success).toBe(false);
    expect(route("machine.keys").request.query).toBeUndefined();
    for (const id of ["machine.keys", "machine.resolve"]) {
      const errors = route(id).errors;
      for (const code of [
        "mixed_authentication",
        "unauthenticated",
        "action_denied",
        "forbidden_selector",
        "not_found",
        "quarantined",
        "environment_changed",
        "key_under_review",
        "busy",
        "audit_unavailable",
        "backend_sealed",
        "backend_inconsistent",
        "dependency_unavailable",
      ] as const) {
        expect(errors, `${id} ${code}`).toContain(code);
      }
    }
    expect(route("machine.resolve").errors).toContain("capacity_exceeded");
  });
});

describe("review fixes", () => {
  it("every route but health can answer quarantined: the gate comes before everything", () => {
    // Doc 06 §9: "GET /v1/version — gate still applies"; /health answers down instead.
    for (const candidate of ROUTES) {
      expect(candidate.errors.includes("quarantined"), candidate.id).toBe(
        candidate.id !== "health.get",
      );
    }
  });

  it("project and credential names are returned in NFC, whatever form was sent", () => {
    const nfd = "cafe" + String.fromCodePoint(0x301);
    const nfc = "caf" + String.fromCodePoint(0xe9);
    expect(nfd).not.toBe(nfc);
    for (const id of ["projects.create", "projects.rename", "credentials.issue"]) {
      const parsed = body(id).safeParse({ name: nfd });
      expect(parsed.success, id).toBe(true);
      expect((parsed.data as { name: string }).name, id).toBe(nfc);
    }
    // 64 code points in NFC, 128 as sent: the limit is counted after normalising.
    const long = ("e" + String.fromCodePoint(0x301)).repeat(64);
    const created = body("projects.create").safeParse({ name: long });
    expect(created.success).toBe(true);
    expect(Array.from((created.data as { name: string }).name)).toHaveLength(64);
  });
});
