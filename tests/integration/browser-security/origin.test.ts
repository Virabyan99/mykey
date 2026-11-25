// Run 7.9 (FR-1.76, AC-1.34, PO-12): what the browser's own rules leave to
// the server. The refusal of a foreign, null, missing or cross-site Origin on
// every route that changes something is proven since Run 3.7
// (tests/integration/authz/origin.test.ts), and the shell's headers since
// Run 7.1 (tests/integration/web/shell.test.ts). This file proves the other
// half: a GET is not subject to the Origin check, so no GET may change
// anything. Every GET of the route table is asked over the real stores, from
// this origin and as another site would ask it, and every table is compared
// before and after.
import { randomBytes } from "node:crypto";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";

let f: CredentialsFixture;
let secretName: string;
let operationId: string;

const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

beforeAll(async () => {
  f = await createCredentialsFixture();
  // Something for every list to return: a secret with two versions, a credential, operations.
  secretName = `GET_${randomBytes(4).toString("hex").toUpperCase()}`;
  const created = await f.create("env1a", secretName, `${mark}-1`);
  expect(created.status, created.code ?? "").toBe(201);
  operationId = created.operationId ?? "";
  expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
  await issueFor(f, "env1a", { name: "get-proof" });
}, 600_000);

afterAll(async () => {
  await f.close();
});

/**
 * Tables a request changes by design, whatever its method, and tables that
 * change with no request at all. Everything else is compared.
 */
const NOT_COMPARED: Readonly<Record<string, string>> = {
  "app.rate_limit": "every request is counted for its source and its session (P-113)",
};

async function comparedTables(): Promise<string[]> {
  const result = await f.api.superuser.query<{ name: string }>(
    `SELECT schemaname || '.' || tablename AS name FROM pg_tables
      WHERE schemaname IN ('app', 'audit', 'auth', 'jobs', 'meta') ORDER BY 1`,
  );
  return result.rows.map((row) => row.name).filter((name) => !(name in NOT_COMPARED));
}

/** Per table: its row count and a digest of every row. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of await comparedTables()) {
    const [schema, name] = table.split(".");
    const result = await f.api.superuser.query<{ digest: string }>(
      `SELECT count(*)::text || ':' ||
              coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '-') AS digest
         FROM "${schema ?? ""}"."${name ?? ""}" t`,
    );
    out[table] = result.rows[0]?.digest ?? "";
  }
  return out;
}

const changed = (before: Record<string, string>, after: Record<string, string>): string[] =>
  Object.keys({ ...before, ...after }).filter((table) => before[table] !== after[table]);

function pathOf(route: RouteDef): string {
  const env = f.env("env1a");
  const values: Record<string, string> = {
    org: f.tenants.a.organizationId,
    project: env.projectId,
    env: env.environmentId,
    name: secretName,
    operation: operationId,
  };
  return route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = values[name];
    // A parameter this test has no real value for must be added here, not guessed.
    if (value === undefined) throw new Error(`no value for :${name} of ${route.id}`);
    return value;
  });
}

/** The classes whose credential is a bearer: a browser session cannot send their requests. */
const BEARER: ReadonlySet<string> = new Set(["machine", "machine_exchange", "automation"]);
/** Session 11 (Run 11.2): a session GET with no handler in this build (404). Empty since Run 11.5. */
const NO_HANDLER: ReadonlySet<string> = new Set<string>();

const gets = (): RouteDef[] =>
  ROUTES.filter((route) => route.method === "GET" && !BEARER.has(route.auth));

const ASKED_AS: [string, Record<string, string>][] = [
  ["this origin", {}],
  ["another site", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
  ["no Origin", { origin: "" }],
];

describe("a GET changes nothing", () => {
  it("the pass covers every GET of ROUTES that a browser session can send", () => {
    const ids = gets().map((route) => route.id);
    expect(ids).toContain("secrets.history");
    expect(ids).toContain("metrics.get");
    expect(ids).toContain("operations.get");
    // Session 11: machine.metadata and the five GETs of automation are bearer routes too.
    const bearer = ROUTES.filter((route) => route.method === "GET" && BEARER.has(route.auth));
    expect(bearer.map((route) => route.id).sort()).toEqual([
      "automation.operations.get",
      "automation.projects.get",
      "automation.projects.list",
      "automation.runtime_credentials.list",
      "automation.secrets.list",
      "machine.keys",
      "machine.metadata",
    ]);
    expect(ids.length).toBe(
      ROUTES.filter((route) => route.method === "GET").length - bearer.length,
    );
  });

  it("no GET of ROUTES changes a row, asked from this origin, from another site or without an Origin", async () => {
    const cookie = await f.tenants.cookie("ownerA");
    const before = await snapshot();
    for (const [label, headers] of ASKED_AS) {
      for (const route of gets()) {
        const response = await f.api.request("GET", pathOf(route), { cookie, headers });
        await response.arrayBuffer();
        // The handler answered: the request was not stopped before it could do anything.
        // The reference page needs its asset, which this stack may not have (503).
        const answered =
          route.id === "reference.get" ? [200, 503] : NO_HANDLER.has(route.id) ? [404] : [200];
        expect(answered, `${route.id}, ${label}: ${String(response.status)}`).toContain(
          response.status,
        );
      }
    }
    expect(changed(before, await snapshot())).toEqual([]);
  });

  // Run 8.0 Task C (Session 7's Minor 11): the auth module's two GETs are not
  // in ROUTES (docs/auth-route-contract.md). A session near its end shows
  // whether asking it keeps it alive.
  it("the two GET paths of the auth module change no row either", async () => {
    const cookie = await f.tenants.cookie("ownerA");
    await f.api.superuser.query(
      "UPDATE auth.session SET expires_at = now() + interval '1 hour' WHERE expires_at > now()",
    );
    const before = await snapshot();
    for (const [label, headers] of ASKED_AS) {
      for (const path of ["/v1/auth/get-session", "/v1/auth/sessions"]) {
        const response = await f.api.request("GET", path, { cookie, headers });
        const body = await response.text();
        expect(response.status, `${path}, ${label}`).toBe(200);
        expect(body, `${path}, ${label}`).not.toBe("null");
      }
    }
    expect(changed(before, await snapshot())).toEqual([]);
  });

  it("a refused GET writes its denial to the audit log and changes nothing else", async () => {
    const cookie = await f.tenants.cookie("readerA");
    const before = await snapshot();
    const denials = async (): Promise<number> => {
      const result = await f.api.superuser.query<{ count: string }>(
        "SELECT count(*) AS count FROM audit.event WHERE action = 'access.denied'",
      );
      return Number(result.rows[0]?.count);
    };
    const deniedBefore = await denials();
    const response = await f.api.request(
      "GET",
      `/v1/organizations/${f.tenants.a.organizationId}/metrics`,
      { cookie, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } },
    );
    expect(response.status).toBe(403);
    expect(changed(before, await snapshot())).toEqual(["audit.event"]);
    expect(await denials()).toBe(deniedBefore + 1);
  });

  it("control: the comparison sees one new secret", async () => {
    const before = await snapshot();
    const name = `GET_${randomBytes(4).toString("hex").toUpperCase()}`;
    const created = await f.create("env1a", name, `${mark}-2`);
    expect(created.status, created.code ?? "").toBe(201);
    const tables = changed(before, await snapshot());
    expect(tables).toContain("app.secret_index");
    expect(tables).toContain("app.operation");
    expect(tables).toContain("audit.event");
  });
});
