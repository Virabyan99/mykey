// Run 8.2 (P-151): no request chooses where it lands. Every route of ROUTES,
// asked by A's owner (or with A's machine token) on A's API, with selectors
// that name B's real namespace, paths, roles and ids — as query keys, as body
// keys and as headers — is refused or ignores them: B's rows stay as they
// were, no answer names B, and OpenBao's audit device records no request in
// B's namespace. A control shows the same search sees B's own request.
import { randomUUID } from "node:crypto";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestOf } from "../authz/requests.ts";
import { readAuditLog } from "../../harness/stack.ts";
import { fill, idsOf } from "./answers.ts";
import { createIsolationFixture, type IsolationFixture } from "./fixture.ts";

let fx: IsolationFixture;

beforeAll(async () => {
  fx = await createIsolationFixture();
}, 900_000);

afterAll(async () => {
  await (fx as IsolationFixture | undefined)?.close();
});

const namespaceB = () => `org-${fx.b.organizationId}/`;

/** Per table of schema app with an organization_id: count and digest of B's rows. */
async function rowsOfB(): Promise<Record<string, string>> {
  const db = fx.f.api.superuser;
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'app' AND column_name = 'organization_id' ORDER BY 1`,
  );
  const out: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    const result = await db.query<{ digest: string }>(
      `SELECT count(*)::text || ':' ||
              coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '-') AS digest
         FROM app."${table}" t WHERE organization_id = $1`,
      [fx.b.organizationId],
    );
    out[table] = result.rows[0]?.digest ?? "";
  }
  return out;
}

async function requestsInB(from: number): Promise<number> {
  const entries = await readAuditLog(fx.stack);
  return entries
    .slice(from)
    .filter((entry) => entry.type === "request" && entry.namespacePath === namespaceB()).length;
}

const selectors = () => {
  const b = fx.b;
  return {
    namespace: namespaceB(),
    path: `kv/data/p/${b.ids.projectId}/e/${b.ids.environmentId}/${b.ids.secretName}`,
    role: "runtime",
    policy: `machine-env-${b.ids.environmentId}`,
    organizationId: b.organizationId,
    environmentId: b.ids.environmentId,
  };
};

type Placement = "query" | "body" | "header";

function attack(route: RouteDef, placement: Placement): Promise<Response> {
  const a = fx.a;
  const chosen = selectors();
  const base = requestOf(route);
  let path = fill(route, idsOf(a));
  const headers: Record<string, string> = { ...base.headers };
  let body = base.body;
  if (placement === "query") {
    path += `${path.includes("?") ? "&" : "?"}${new URLSearchParams(chosen).toString()}`;
  } else if (placement === "body") {
    body = { ...(typeof body === "object" && body !== null ? body : {}), ...chosen };
  } else {
    headers["x-vault-namespace"] = chosen.namespace;
    // B's own OpenBao token (the machine token the product issued for B).
    headers["x-vault-token"] = fx.b.machineToken;
    headers["x-organization-id"] = chosen.organizationId;
  }
  const machine = route.auth === "machine";
  if (machine) headers.authorization = `Bearer ${a.machineToken}`;
  // A dotenv route keeps its text body, except where the selectors are the body:
  // then they go as JSON, which such a route must refuse.
  const rawBody = placement === "body" ? undefined : base.rawBody;
  const raw = rawBody !== undefined;
  if (raw) {
    // headers already hold content-type text/plain from requestOf
  } else if (base.rawBody !== undefined) {
    delete headers["content-type"];
  }
  return a.request(route.method, path, {
    ...(machine || route.auth === "public" ? {} : { cookie: a.owner }),
    headers,
    ...(rawBody !== undefined ? { rawBody } : body === undefined ? {} : { body }),
  });
}

describe("selectors that name B change nothing of B", () => {
  it("every route of ROUTES refuses or ignores namespace, path, role, policy, organizationId and environmentId that name B's real ids, as a query key, as a body key and as a header (x-vault-namespace, x-vault-token, x-organization-id)", async () => {
    const before = await rowsOfB();
    const mark = (await readAuditLog(fx.stack)).length;
    const named: string[] = [];
    const failures: string[] = [];
    const b = fx.b;
    const secretsOfB = [
      b.organizationId,
      b.ids.projectId,
      b.ids.environmentId,
      b.ids.secretName,
      b.ids.credentialId,
      b.ids.operationId,
    ];
    let asked = 0;
    for (const placement of ["query", "body", "header"] as const) {
      await fx.freshen();
      for (const route of ROUTES) {
        if (route.id === "auth.reset.complete") continue; // no session: the reset flow's own file
        const response = await attack(route, placement);
        const text = await response.text();
        asked += 1;
        if (response.status >= 500 && response.status !== 503) {
          failures.push(`${placement} ${route.id}: ${String(response.status)}`);
        }
        for (const id of secretsOfB) {
          if (text.includes(id)) named.push(`${placement} ${route.id} names a B id`);
        }
      }
    }
    expect(asked).toBe((ROUTES.length - 1) * 3);
    // Every refusal is one the route lists (the contract's error table).
    const unlisted = fx.f.api.logs.filter((entry) => entry.event === "unlisted_error");
    expect(unlisted.map((entry) => JSON.stringify(entry))).toEqual([]);
    expect(failures).toEqual([]);
    expect(named).toEqual([]);
    expect(await rowsOfB()).toEqual(before);
    expect(await requestsInB(mark)).toBe(0);
  }, 900_000);

  it("control: one request B's own API makes in B's namespace is seen by the same search", async () => {
    const mark = (await readAuditLog(fx.stack)).length;
    const b = fx.b;
    const path = `/v1/organizations/${b.organizationId}/projects/${b.ids.projectId}/environments/${b.ids.environmentId}/secrets/${b.ids.secretName}/reveal`;
    await fx.freshen();
    const revealed = await b.request("POST", path, { cookie: b.owner, body: {} });
    expect(revealed.status).toBe(200);
    await revealed.arrayBuffer();
    expect(await requestsInB(mark)).toBeGreaterThan(0);
    // And a request in A's namespace is not counted as B's.
    const markA = (await readAuditLog(fx.stack)).length;
    const a = fx.a;
    const pathA = `/v1/organizations/${a.organizationId}/projects/${a.ids.projectId}/environments/${a.ids.environmentId}/secrets/${a.ids.secretName}/reveal`;
    const own = await a.request("POST", pathA, {
      cookie: a.owner,
      headers: { "x-request-id": randomUUID() },
      body: {},
    });
    expect(own.status).toBe(200);
    await own.arrayBuffer();
    expect(await requestsInB(markA)).toBe(0);
  }, 300_000);
});
