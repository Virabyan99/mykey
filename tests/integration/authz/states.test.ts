// Run 3.7 Task D (Doc 04 §1.2, P-53): state precedence. One case per filled
// cell of the state table, the state set through the superuser and ownerA as
// the caller; a state answer comes only after visibility and action, and a
// parent's state wins over its child's.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { errorOf, startTestApi, type TestApi } from "../../harness/api.ts";
import { createTenants, type FixtureUser, type Tenants } from "../../harness/tenants.ts";
import { pathIn, requestOf, type PathIds } from "./requests.ts";

let api: TestApi;
let tenants: Tenants;

beforeAll(async () => {
  api = await startTestApi({ stubs: true });
  tenants = await createTenants(api);
}, 300_000);

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  await api.superuser.query(
    "UPDATE app.organization SET state = 'active', review_reason = NULL WHERE id = $1",
    [tenants.a.organizationId],
  );
  await api.superuser.query(
    "UPDATE app.project SET state = 'active', review_reason = NULL WHERE organization_id = $1",
    [tenants.a.organizationId],
  );
  await api.superuser.query(
    `UPDATE app.environment SET state = 'active', review_reason = NULL, kv_ready = true
      WHERE organization_id = $1`,
    [tenants.a.organizationId],
  );
});

const route = (id: string): RouteDef => ROUTES.find((candidate) => candidate.id === id)!;

type Column =
  "metadata_read" | "metadata_write" | "secret_read" | "secret_write" | "credential_issue";
const COLUMNS: readonly Column[] = [
  "metadata_read",
  "metadata_write",
  "secret_read",
  "secret_write",
  "credential_issue",
];

/** A route of each column, for a state set on the environment and on the project. */
const ROUTE_OF: Record<"environment" | "project", Record<Column, string>> = {
  environment: {
    metadata_read: "credentials.list",
    metadata_write: "environments.rename",
    secret_read: "secrets.list",
    secret_write: "secrets.create",
    credential_issue: "credentials.issue",
  },
  project: {
    metadata_read: "environments.list",
    metadata_write: "projects.rename",
    secret_read: "secrets.reveal",
    secret_write: "secrets.update",
    credential_issue: "credentials.issue",
  },
};

const OK = "ok";
type Answer = typeof OK | "state_conflict" | "backend_inconsistent";
const SC = "state_conflict";
const BI = "backend_inconsistent";

// The table of P-53, row by row (columns in COLUMNS order).
const ORGANIZATION_ROWS: [string, Answer[]][] = [
  ["provisioning", [SC, SC, SC, SC, SC]],
  ["failed", [SC, SC, SC, SC, SC]],
  ["needs_review", [BI, BI, BI, BI, BI]],
];
const RESOURCE_ROWS: [string, boolean, Answer[]][] = [
  ["pending", true, [OK, OK, OK, OK, SC]],
  ["pending", false, [OK, OK, SC, SC, SC]],
  ["active", true, [OK, OK, OK, OK, OK]],
  ["revoking", true, [OK, SC, OK, SC, SC]],
  ["archived", true, [OK, SC, OK, SC, SC]],
  ["needs_review", true, [OK, SC, BI, BI, BI]],
];

const p1e1a = (): PathIds => ({
  org: tenants.a.organizationId,
  project: tenants.a.project1,
  env: tenants.a.env1a,
});

async function call(user: FixtureUser, id: string, ids: PathIds = p1e1a()) {
  const def = route(id);
  const before = api.reached.length;
  const response = await api.request(def.method, pathIn(def, ids), {
    ...requestOf(def),
    cookie: await tenants.cookie(user),
  });
  const reached = api.reached.length > before;
  if (response.status === 204 || response.status === 200) return { answer: OK, reached, response };
  const code = (await errorOf(response)).code;
  return { answer: code, reached, response };
}

async function auditReason(response: Response): Promise<string | null> {
  const result = await api.superuser.query<{ reason: string }>(
    "SELECT details->>'reason' AS reason FROM audit.event WHERE action = 'access.denied' AND request_id = $1",
    [response.headers.get("x-request-id")],
  );
  return result.rows[0]?.reason ?? null;
}

const review = (state: string) => (state === "needs_review" ? "drift" : null);

describe("the state table, cell by cell (ownerA)", () => {
  for (const [state, row] of ORGANIZATION_ROWS) {
    it(`organization ${state}`, async () => {
      await api.superuser.query(
        "UPDATE app.organization SET state = $2, review_reason = $3 WHERE id = $1",
        [tenants.a.organizationId, state, review(state)],
      );
      for (const [index, column] of COLUMNS.entries()) {
        const id = ROUTE_OF.environment[column];
        const got = await call("ownerA", id);
        expect(got.answer, `${state} ${column} (${id})`).toBe(row[index]);
        expect(got.reached).toBe(false);
        expect(await auditReason(got.response)).toBe("state");
      }
    });
  }

  for (const level of ["environment", "project"] as const) {
    for (const [state, kvReady, row] of RESOURCE_ROWS) {
      it(`${level} ${state}${kvReady ? "" : " (kv not ready)"}`, async () => {
        const table = level === "environment" ? "app.environment" : "app.project";
        await api.superuser.query(
          `UPDATE ${table} SET state = $2, review_reason = $3 WHERE id = $1`,
          [level === "environment" ? tenants.a.env1a : tenants.a.project1, state, review(state)],
        );
        await api.superuser.query("UPDATE app.environment SET kv_ready = $2 WHERE id = $1", [
          tenants.a.env1a,
          kvReady,
        ]);
        for (const [index, column] of COLUMNS.entries()) {
          const id = ROUTE_OF[level][column];
          const got = await call("ownerA", id);
          expect(got.answer, `${level} ${state} ${column} (${id})`).toBe(row[index]);
          expect(got.reached, `${level} ${state} ${column}`).toBe(row[index] === OK);
          if (row[index] !== OK) expect(await auditReason(got.response)).toBe("state");
        }
      });
    }
  }
});

describe("precedence", () => {
  it("a caller who cannot see the scope gets 404, not the state", async () => {
    await api.superuser.query(
      "UPDATE app.environment SET state = 'needs_review', review_reason = 'drift' WHERE id = $1",
      [tenants.a.env1a],
    );
    const hidden = await call("ownerB", "secrets.list");
    expect(hidden.answer).toBe("not_found");
    expect(hidden.response.status).toBe(404);
  });

  it("a caller who may not do the thing gets 403, not state_conflict", async () => {
    await api.superuser.query("UPDATE app.environment SET state = 'archived' WHERE id = $1", [
      tenants.a.env1a,
    ]);
    const denied = await call("readerA", "secrets.create");
    expect(denied.answer).toBe("action_denied");
    expect(denied.response.status).toBe(403);
  });

  it("a parent's state wins: organization needs_review over an active or archived environment", async () => {
    await api.superuser.query(
      "UPDATE app.organization SET state = 'needs_review', review_reason = 'drift' WHERE id = $1",
      [tenants.a.organizationId],
    );
    expect((await call("ownerA", "secrets.list")).answer).toBe(BI);
    await api.superuser.query("UPDATE app.environment SET state = 'archived' WHERE id = $1", [
      tenants.a.env1a,
    ]);
    expect((await call("ownerA", "secrets.create")).answer).toBe(BI);
  });

  it("a project's state wins over its environment's", async () => {
    await api.superuser.query("UPDATE app.project SET state = 'archived' WHERE id = $1", [
      tenants.a.project1,
    ]);
    await api.superuser.query(
      "UPDATE app.environment SET state = 'needs_review', review_reason = 'drift' WHERE id = $1",
      [tenants.a.env1a],
    );
    // Archived project: a write is state_conflict before the environment's review is looked at.
    expect((await call("ownerA", "secrets.create")).answer).toBe(SC);
  });

  it("organizations.list still answers and shows needs_review with its reason", async () => {
    await api.superuser.query(
      "UPDATE app.organization SET state = 'needs_review', review_reason = 'policy_drift' WHERE id = $1",
      [tenants.a.organizationId],
    );
    const response = await api.request("GET", "/v1/organizations", {
      cookie: await tenants.cookie("ownerA"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organizations: [
        {
          id: tenants.a.organizationId,
          role: "owner",
          state: "needs_review",
          reviewReason: "policy_drift",
        },
      ],
    });
  });

  it("the database refuses a reason outside needs_review", async () => {
    await expect(
      api.superuser.query("UPDATE app.environment SET review_reason = 'drift' WHERE id = $1", [
        tenants.a.env1a,
      ]),
    ).rejects.toThrow(/review_reason_state_check/);
  });
});
