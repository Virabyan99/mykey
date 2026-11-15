// Run 3.7 Task C (FR-1.09, FR-1.10, FR-1.11, AC-1.08): every human route ×
// the seven fixture users × four targets, each cell checked against a literal
// table written from Doc 04 §1.1 — the table does not call `decide`. Every
// contract route answers through the harness's stub (P-80, Run 4.1: real
// handlers are covered by matrix-live.test.ts), so a cell is "reached"
// exactly when every check of the pipeline passed. Run 4.1 adds the
// operation rows. The suite writes docs/evidence/session-4/authorization-matrix.md.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, type Action, type RouteDef } from "@mykey/contracts";
import { errorOf, startTestApi, type TestApi } from "../../harness/api.ts";
import {
  FIXTURE_USERS,
  createTenants,
  type FixtureUser,
  type Tenants,
} from "../../harness/tenants.ts";
import { pathIn, requestOf, type PathIds } from "./requests.ts";

type Outcome = "A" | "D" | "H";
type TargetName = "p1/e1a" | "p1/e1b" | "p2/e2a" | "B";
type Level = "organization" | "project" | "environment";

/** Column order of every row below. */
const ACTION_ORDER: readonly (Action | null)[] = [
  null,
  "resources.manage",
  "secrets.read",
  "secrets.history",
  "secrets.write",
  "credentials.manage",
  "audit.view",
];

// Doc 04 §1.1. A = allowed, D = 403 action_denied, H = 404 not_found (hidden).
// Columns: see / manage resources / read / history / write / credentials / audit.
// "Organization" (owner, admin) is A everywhere in their organization; "Granted
// scope" is A for reads and, for an editor, writes; "No" is D where the caller
// sees the target and H where it does not; another organization is H.
const ALL = "AAAAAAA";
const HIDDEN = "HHHHHHH";
const SEE_ONLY = "ADDDDDD";
const EDITOR = "ADAAADD";
const READER = "ADAADDD";
const MATRIX: Record<FixtureUser, Record<TargetName, Record<Level, string>>> = {
  ownerA: {
    "p1/e1a": { organization: ALL, project: ALL, environment: ALL },
    "p1/e1b": { organization: ALL, project: ALL, environment: ALL },
    "p2/e2a": { organization: ALL, project: ALL, environment: ALL },
    B: { organization: HIDDEN, project: HIDDEN, environment: HIDDEN },
  },
  adminA: {
    "p1/e1a": { organization: ALL, project: ALL, environment: ALL },
    "p1/e1b": { organization: ALL, project: ALL, environment: ALL },
    "p2/e2a": { organization: ALL, project: ALL, environment: ALL },
    B: { organization: HIDDEN, project: HIDDEN, environment: HIDDEN },
  },
  editorA: {
    "p1/e1a": { organization: SEE_ONLY, project: SEE_ONLY, environment: EDITOR },
    "p1/e1b": { organization: SEE_ONLY, project: SEE_ONLY, environment: EDITOR },
    "p2/e2a": { organization: SEE_ONLY, project: HIDDEN, environment: HIDDEN },
    B: { organization: HIDDEN, project: HIDDEN, environment: HIDDEN },
  },
  readerA: {
    "p1/e1a": { organization: SEE_ONLY, project: SEE_ONLY, environment: READER },
    "p1/e1b": { organization: SEE_ONLY, project: SEE_ONLY, environment: READER },
    "p2/e2a": { organization: SEE_ONLY, project: HIDDEN, environment: HIDDEN },
    B: { organization: HIDDEN, project: HIDDEN, environment: HIDDEN },
  },
  envEditorA: {
    "p1/e1a": { organization: SEE_ONLY, project: SEE_ONLY, environment: EDITOR },
    "p1/e1b": { organization: SEE_ONLY, project: SEE_ONLY, environment: HIDDEN },
    "p2/e2a": { organization: SEE_ONLY, project: HIDDEN, environment: HIDDEN },
    B: { organization: HIDDEN, project: HIDDEN, environment: HIDDEN },
  },
  ungrantedA: {
    "p1/e1a": { organization: SEE_ONLY, project: HIDDEN, environment: HIDDEN },
    "p1/e1b": { organization: SEE_ONLY, project: HIDDEN, environment: HIDDEN },
    "p2/e2a": { organization: SEE_ONLY, project: HIDDEN, environment: HIDDEN },
    B: { organization: HIDDEN, project: HIDDEN, environment: HIDDEN },
  },
  ownerB: {
    "p1/e1a": { organization: HIDDEN, project: HIDDEN, environment: HIDDEN },
    "p1/e1b": { organization: HIDDEN, project: HIDDEN, environment: HIDDEN },
    "p2/e2a": { organization: HIDDEN, project: HIDDEN, environment: HIDDEN },
    B: { organization: ALL, project: ALL, environment: ALL },
  },
};

const TARGETS: readonly TargetName[] = ["p1/e1a", "p1/e1b", "p2/e2a", "B"];

function expected(user: FixtureUser, target: TargetName, route: RouteDef): Outcome {
  if (route.scope === "none") return "A";
  // The path holds a random operation id: absent, so hidden (the operation rows are below).
  if (route.scope === "operation") return "H";
  const row = MATRIX[user][target][route.scope];
  const column = ACTION_ORDER.indexOf(route.action);
  return row[column] as Outcome;
}

const HUMAN = ROUTES.filter((route) => route.auth === "human" || route.auth === "human_fresh_totp");

let api: TestApi;
let tenants: Tenants;
const cookies = new Map<FixtureUser, string>();

function idsOf(target: TargetName): PathIds {
  const { a, b } = tenants;
  switch (target) {
    case "p1/e1a":
      return { org: a.organizationId, project: a.project1, env: a.env1a };
    case "p1/e1b":
      return { org: a.organizationId, project: a.project1, env: a.env1b };
    case "p2/e2a":
      return { org: a.organizationId, project: a.project2, env: a.env2a };
    case "B":
      return { org: b.organizationId, project: b.project1, env: b.env1a };
  }
}

async function send(user: FixtureUser, route: RouteDef, path: string): Promise<Response> {
  const init = requestOf(route);
  return api.request(route.method, path, { ...init, cookie: cookies.get(user)! });
}

async function deniedReason(requestId: string): Promise<string | null> {
  const result = await api.superuser.query<{ reason: string }>(
    `SELECT details->>'reason' AS reason FROM audit.event
      WHERE action = 'access.denied' AND request_id = $1`,
    [requestId],
  );
  return result.rows[0]?.reason ?? null;
}

/** Checks one response against its expected outcome; answers what happened. */
async function verdict(route: RouteDef, response: Response, reachedBefore: number) {
  const requestId = response.headers.get("x-request-id") ?? "";
  const reached = api.reached.length > reachedBefore;
  if (response.status >= 200 && response.status < 300) {
    return { outcome: "A" as Outcome, reached, reason: null as string | null };
  }
  const code = (await errorOf(response)).code;
  const outcome: Outcome | "?" =
    response.status === 403 && code === "action_denied"
      ? "D"
      : response.status === 404 && code === "not_found"
        ? "H"
        : "?";
  expect(outcome, `${route.id}: ${String(response.status)} ${code}`).not.toBe("?");
  return { outcome: outcome as Outcome, reached, reason: await deniedReason(requestId) };
}

beforeAll(async () => {
  api = await startTestApi({ stubs: "all" });
  tenants = await createTenants(api);
  for (const user of FIXTURE_USERS) cookies.set(user, await tenants.cookie(user));
}, 300_000);

afterAll(async () => {
  await api.close();
});

describe("the authorization matrix", () => {
  it("every human route × seven users × four targets, as Doc 04 §1.1 says", async () => {
    const lines: string[] = [];
    const totals = { A: 0, D: 0, H: 0 };
    const allowedRoutes = new Set<string>();
    const failures: string[] = [];
    for (const route of HUMAN) {
      for (const user of FIXTURE_USERS) {
        for (const target of TARGETS) {
          if (route.scope === "none" && target !== "p1/e1a") continue;
          const want = expected(user, target, route);
          const before = api.reached.length;
          const response = await send(user, route, pathIn(route, idsOf(target)));
          const got = await verdict(route, response, before);
          const cell = `${route.id} | ${user} | ${route.scope === "none" ? "-" : target}`;
          if (got.outcome !== want) failures.push(`${cell}: expected ${want}, got ${got.outcome}`);
          if (want === "A" && response.status === 204 && !got.reached) {
            failures.push(`${cell}: 204 without the stub`);
          }
          if (want !== "A") {
            if (got.reached) failures.push(`${cell}: the stub was reached`);
            const reason = want === "H" ? "hidden" : "action";
            if (got.reason !== reason) failures.push(`${cell}: audit reason ${String(got.reason)}`);
          } else {
            allowedRoutes.add(route.id);
          }
          totals[got.outcome] += 1;
          lines.push(`| ${cell.split(" | ").join(" | ")} | ${got.outcome} |`);
        }
      }
    }
    // Every route has a cell that reaches it — operations.get through its own rows below.
    const unreachable = HUMAN.filter(
      (route) => route.scope !== "operation" && !allowedRoutes.has(route.id),
    ).map((route) => route.id);
    expect(unreachable).toEqual([]);
    // Formatted as the repository formats it, so `format:check` passes after a run.
    const file = join(
      import.meta.dirname,
      "../../../docs/evidence/session-4/authorization-matrix.md",
    );
    const markdown = [
      "# Authorization matrix (Run 3.7, Run 4.1)",
      "",
      "Written by `tests/integration/authz/matrix.test.ts`. A = the request passed every check",
      "(the harness stub was reached), D = `403 action_denied`, H = `404 not_found`. Every D and H",
      "cell also has its `access.denied` audit row with the reason checked. `operations.get` here",
      "names a random id (H for everyone); its own rows are in the test's operation table.",
      "",
      `Cells: ${String(lines.length)} — A ${String(totals.A)}, D ${String(totals.D)}, H ${String(totals.H)}. Mismatches: ${String(failures.length)}.`,
      "",
      "| Route | User | Target | Result |",
      "| --- | --- | --- | --- |",
      ...lines,
      "",
    ].join("\n");
    writeFileSync(file, await format(markdown, { ...(await resolveConfig(file)), filepath: file }));
    expect(failures).toEqual([]);
  }, 600_000);
});

// Run 4.1 (P-63): operations.get by the operation's own scope and author. The
// operations are of action secrets.create in environment 1a (B: its env 1a).
// own: made by the caller; member: made by editorA (adminA for editorA);
// foreign: made in the other organization; absent: a random id.
const OPERATION_ROWS: Record<
  FixtureUser,
  Record<"own" | "member" | "foreign" | "absent", Outcome>
> = {
  ownerA: { own: "A", member: "A", foreign: "H", absent: "H" },
  adminA: { own: "A", member: "A", foreign: "H", absent: "H" },
  editorA: { own: "A", member: "H", foreign: "H", absent: "H" },
  // A reader may not write: its own write operation is hidden from it.
  readerA: { own: "H", member: "H", foreign: "H", absent: "H" },
  envEditorA: { own: "A", member: "H", foreign: "H", absent: "H" },
  ungrantedA: { own: "H", member: "H", foreign: "H", absent: "H" },
  ownerB: { own: "A", member: "H", foreign: "H", absent: "H" },
};

describe("machine routes (Run 5.4, P-93)", () => {
  it("both machine routes with each of the seven users' sessions → 401: a session is never a machine credential", async () => {
    const machine = ROUTES.filter((route) => route.auth === "machine");
    expect(machine.map((route) => route.id).sort()).toEqual(["machine.keys", "machine.resolve"]);
    for (const route of machine) {
      const path = route.path.replace(":project", tenants.a.project1).replace(":envName", "dev");
      for (const user of FIXTURE_USERS) {
        const response = await api.request(route.method, path, { cookie: cookies.get(user)! });
        expect([response.status, (await errorOf(response)).code], `${route.id} ${user}`).toEqual([
          401,
          "unauthenticated",
        ]);
      }
    }
  });
});

describe("operations.get rows", () => {
  async function operationBy(user: FixtureUser, inB = false): Promise<string> {
    const id = randomUUID();
    const scope = inB
      ? [tenants.b.organizationId, tenants.b.project1, tenants.b.env1a]
      : [tenants.a.organizationId, tenants.a.project1, tenants.a.env1a];
    await api.superuser.query(
      `INSERT INTO app.operation (id, organization_id, project_id, environment_id, principal_kind,
         principal_id, action, target, idempotency_key, state)
       VALUES ($1::uuid, $2, $3, $4::uuid, 'user', $5, 'secrets.create', $4::text, $1::text, 'succeeded')`,
      [id, ...scope, tenants.userId(user)],
    );
    return id;
  }

  it("own, another member's, another organization's and an absent operation, for the seven users", async () => {
    const def = ROUTES.find((candidate) => candidate.id === "operations.get")!;
    const failures: string[] = [];
    for (const user of FIXTURE_USERS) {
      const inB = user === "ownerB";
      const ids = {
        own: await operationBy(user, inB),
        member: inB
          ? await operationBy("ownerA")
          : await operationBy(user === "editorA" ? "adminA" : "editorA"),
        foreign: inB ? await operationBy("ownerA") : await operationBy("ownerB", true),
        absent: randomUUID(),
      };
      for (const [column, id] of Object.entries(ids) as [keyof typeof ids, string][]) {
        const before = api.reached.length;
        const response = await send(user, def, `/v1/operations/${id}`);
        const got = await verdict(def, response, before);
        const want = OPERATION_ROWS[user][column];
        if (got.outcome !== want)
          failures.push(`${user} ${column}: expected ${want}, got ${got.outcome}`);
        if (want === "A" && !got.reached) failures.push(`${user} ${column}: stub not reached`);
        if (want === "H" && got.reason !== "hidden")
          failures.push(`${user} ${column}: reason ${String(got.reason)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("named cases", () => {
  const route = (id: string): RouteDef => ROUTES.find((candidate) => candidate.id === id)!;

  // What the lists contain is the handlers' business: tests/integration/resources/listing.test.ts.
  it("envEditorA writes in environment 1a, gets 404 for 1b, lists in project 1 and not project 2", async () => {
    const create = route("secrets.create");
    expect((await send("envEditorA", create, pathIn(create, idsOf("p1/e1a")))).status).toBe(204);
    expect((await send("envEditorA", create, pathIn(create, idsOf("p1/e1b")))).status).toBe(404);
    const list = route("environments.list");
    expect((await send("envEditorA", list, pathIn(list, idsOf("p1/e1a")))).status).toBe(204);
    expect((await send("envEditorA", list, pathIn(list, idsOf("p2/e2a")))).status).toBe(404);
    const projects = route("projects.list");
    expect((await send("envEditorA", projects, pathIn(projects, idsOf("p1/e1a")))).status).toBe(
      204,
    );
  });

  it("readerA reads values and history in project 1 and gets 403 on every write", async () => {
    for (const target of ["p1/e1a", "p1/e1b"] as const) {
      for (const id of ["secrets.list", "secrets.reveal", "secrets.history", "export.create"]) {
        const def = route(id);
        expect((await send("readerA", def, pathIn(def, idsOf(target)))).status, id).toBe(204);
      }
      for (const def of HUMAN.filter((r) => r.action === "secrets.write")) {
        const response = await send("readerA", def, pathIn(def, idsOf(target)));
        expect(response.status, def.id).toBe(403);
      }
    }
  });

  it("editorA cannot manage resources, credentials or audit: 403", async () => {
    const managed = HUMAN.filter(
      (r) =>
        (r.action === "resources.manage" ||
          r.action === "credentials.manage" ||
          r.action === "audit.view") &&
        r.scope !== "organization",
    );
    for (const def of managed) {
      const response = await send("editorA", def, pathIn(def, idsOf("p1/e1a")));
      expect(response.status, def.id).toBe(403);
    }
    for (const def of HUMAN.filter((r) => r.scope === "organization" && r.action !== null)) {
      expect((await send("editorA", def, pathIn(def, idsOf("p1/e1a")))).status, def.id).toBe(403);
    }
  });

  it("ungrantedA sees an empty project list and 404 on every project", async () => {
    for (const def of HUMAN.filter((r) => r.scope === "project" || r.scope === "environment")) {
      for (const target of ["p1/e1a", "p2/e2a"] as const) {
        const response = await send("ungrantedA", def, pathIn(def, idsOf(target)));
        expect(response.status, def.id).toBe(404);
      }
    }
  });

  it("ownerB gets 404 for every id of organization A, and ownerA for B", async () => {
    for (const def of HUMAN.filter((r) => r.scope !== "none")) {
      for (const target of ["p1/e1a", "p1/e1b", "p2/e2a"] as const) {
        expect((await send("ownerB", def, pathIn(def, idsOf(target)))).status, def.id).toBe(404);
      }
      expect((await send("ownerA", def, pathIn(def, idsOf("B")))).status, def.id).toBe(404);
    }
  });

  it("hidden equals absent: same status, header names, body but for requestId, length", async () => {
    const shape = async (response: Response) => {
      const text = await response.text();
      const requestId = response.headers.get("x-request-id") ?? "";
      return {
        status: response.status,
        headers: [...response.headers.keys()].filter((name) => name !== "date").sort(),
        body: text.replace(requestId, "<id>"),
        length: response.headers.get("content-length"),
      };
    };
    const cases: [string, PathIds][] = [
      ["projects.list", { ...idsOf("B"), org: tenants.b.organizationId }],
      ["environments.list", idsOf("p2/e2a")],
      ["secrets.list", idsOf("p1/e1b")],
    ];
    for (const [id, hiddenIds] of cases) {
      const def = route(id);
      const random = { org: randomUUID(), project: randomUUID(), env: randomUUID() };
      const absentIds: PathIds =
        def.scope === "organization"
          ? { ...hiddenIds, org: random.org }
          : def.scope === "project"
            ? { ...hiddenIds, project: random.project }
            : { ...hiddenIds, env: random.env };
      // envEditorA cannot see project 2 nor environment 1b; nobody of A sees B.
      const user: FixtureUser = id === "projects.list" ? "ownerA" : "envEditorA";
      const hidden = await shape(await send(user, def, pathIn(def, hiddenIds)));
      const absent = await shape(await send(user, def, pathIn(def, absentIds)));
      expect(hidden.status, id).toBe(404);
      expect(absent, id).toEqual(hidden);
    }
  });

  it("an id of the right kind under the wrong parent is 404", async () => {
    const list = route("secrets.list");
    const wrong = {
      org: tenants.a.organizationId,
      project: tenants.a.project1,
      env: tenants.a.env2a,
    };
    expect((await send("ownerA", list, pathIn(list, wrong))).status).toBe(404);
    const envs = route("environments.list");
    const crossed = {
      org: tenants.b.organizationId,
      project: tenants.a.project1,
      env: tenants.a.env1a,
    };
    expect((await send("ownerB", envs, pathIn(envs, crossed))).status).toBe(404);
    expect((await send("ownerA", envs, pathIn(envs, crossed))).status).toBe(404);
  });

  it("non-UUID ids are 404", async () => {
    const list = route("secrets.list");
    for (const ids of [
      { ...idsOf("p1/e1a"), org: "not-a-uuid" },
      { ...idsOf("p1/e1a"), project: "1" },
      { ...idsOf("p1/e1a"), env: "dev" },
      { ...idsOf("p1/e1a"), env: tenants.a.env1a.toUpperCase() },
    ]) {
      const response = await send("ownerA", list, pathIn(list, ids));
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("not_found");
    }
  });
});
