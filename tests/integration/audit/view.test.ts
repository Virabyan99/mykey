// Run 6.1 Task B (P-106, P-107, FR-1.58, Review focus 4): an owner or admin
// reads the audit trail of their organization — its tenant rows and the
// account rows of its members — and nothing else: no row of another
// organization, no global row, no row that belongs to nobody. Pages are
// keyset pages under an anchor, so events that arrive between two pages
// neither appear nor shift anything.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_SCOPE, appendAudit } from "@mykey/audit";
import { signInComplete, startTestApi, type TestApi } from "../../harness/api.ts";
import { writeAuditRow } from "../../harness/audit-fixture.ts";
import { createTenants, type FixtureUser, type Tenants } from "../../harness/tenants.ts";

let api: TestApi;
let t: Tenants;
const rowsOfA = new Set<string>();
const rowsOfB = new Set<string>();
const globalRows = new Set<string>();
const nobodyRows = new Set<string>();
const OPERATION = randomUUID();
const REQUEST = randomUUID();

interface Item {
  id: string;
  occurredAt: string;
  actor: { kind: string; id: string | null };
  source: string | null;
  action: string;
  target: { kind: string; id: string | null } | null;
  outcome: string;
  requestId: string | null;
  operationId: string | null;
  details: Record<string, unknown>;
}

interface Page {
  items: Item[];
  nextCursor: string | null;
  anchor: string;
}

beforeAll(async () => {
  api = await startTestApi({ dispatcher: false });
  t = await createTenants(api);
  const db = api.superuser;
  const targetsOfA = [
    { kind: "project", id: t.a.project1 },
    { kind: "environment", id: t.a.env1a },
    { kind: "environment", id: t.a.env2a },
  ];
  let i = 0;
  for (const action of AUDIT_ACTIONS) {
    i += 1;
    const scope = AUDIT_SCOPE[action];
    if (scope === "global") {
      globalRows.add(await writeAuditRow(db, action, { organizationId: "", userId: "" }));
      continue;
    }
    const target = targetsOfA[i % 3];
    const operationId = action.startsWith("secret.") ? OPERATION : null;
    const outcome = action === "access.denied" ? "denied" : "success";
    rowsOfA.add(
      await writeAuditRow(db, action, {
        organizationId: t.a.organizationId,
        userId: t.userId(i % 2 === 0 ? "ownerA" : "editorA"),
        ...(target === undefined ? {} : { target }),
        operationId,
        outcome,
        ...(action === "secret.create" ? { requestId: REQUEST } : {}),
      }),
    );
    rowsOfB.add(
      await writeAuditRow(db, action, {
        organizationId: t.b.organizationId,
        userId: t.userId("ownerB"),
        target: { kind: "project", id: t.b.project1 },
        operationId,
        outcome,
      }),
    );
  }
  // A denial of a foreign organization names none: the caller's account row.
  rowsOfA.add(
    await writeAuditRow(db, "access.denied", {
      organizationId: "",
      userId: t.userId("adminA"),
      outcome: "denied",
    }),
  );
  rowsOfB.add(
    await writeAuditRow(db, "access.denied", {
      organizationId: "",
      userId: t.userId("ownerB"),
      outcome: "denied",
    }),
  );
  // A row that belongs to nobody: an anonymous failed sign-in without a user target.
  nobodyRows.add(
    await appendAudit(db, {
      action: "auth.sign_in",
      actor: { kind: "anonymous", id: null },
      source: "api",
      organizationId: null,
      target: null,
      outcome: "failure",
      requestId: randomUUID(),
      operationId: null,
      details: { reason: "credentials" },
    }),
  );
}, 300_000);

afterAll(async () => {
  await api.close();
});

const pathOf = (org: string, query: Record<string, string>): string => {
  const qs = new URLSearchParams(query).toString();
  return `/v1/organizations/${org}/audit${qs === "" ? "" : `?${qs}`}`;
};

async function get(
  user: FixtureUser,
  org: string,
  query: Record<string, string> = {},
): Promise<Response> {
  return api.request("GET", pathOf(org, query), { cookie: await t.cookie(user) });
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

/** Every item of the listing, page by page (`limit` 7); fails on a repeated id. */
async function walk(
  user: FixtureUser,
  org: string,
  query: Record<string, string> = {},
): Promise<Item[]> {
  const items: Item[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 0; pages < 500; pages += 1) {
    const response = await get(user, org, {
      ...query,
      limit: "7",
      ...(cursor === null ? {} : { cursor }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const page = (await response.json()) as Page;
    for (const item of page.items) {
      expect(seen.has(item.id), `repeated ${item.id}`).toBe(false);
      seen.add(item.id);
      items.push(item);
    }
    cursor = page.nextCursor;
    if (cursor === null) return items;
  }
  throw new Error("the listing did not end");
}

const ids = (items: Item[]): Set<string> => new Set(items.map((item) => item.id));

describe("who reads the audit trail", () => {
  it("owner and admin of A read A's events; editorA gets 403 action_denied and an access.denied row; ownerB gets the hidden 404", async () => {
    for (const user of ["ownerA", "adminA"] as const) {
      const response = await get(user, t.a.organizationId);
      expect(response.status, user).toBe(200);
      const page = (await response.json()) as Page;
      expect(page.items.length, user).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(page.anchor))).toBe(false);
    }
    const editor = await get("editorA", t.a.organizationId);
    expect(editor.status).toBe(403);
    expect(await codeOf(editor)).toBe("action_denied");
    const denied = await api.superuser.query(
      `SELECT 1 FROM audit.event WHERE action = 'access.denied' AND actor_id = $1
          AND request_id = $2 AND details->>'routeId' = 'audit.list'`,
      [t.userId("editorA"), editor.headers.get("x-request-id")],
    );
    expect(denied.rowCount).toBe(1);
    const foreign = await get("ownerB", t.a.organizationId);
    const random = await get("ownerB", randomUUID());
    expect(foreign.status).toBe(404);
    expect(random.status).toBe(404);
    expect(await codeOf(foreign)).toBe(await codeOf(random));
  });

  it("no row of B, no global row and no anonymous row is in any page", async () => {
    const ofA = ids(await walk("ownerA", t.a.organizationId));
    for (const id of rowsOfA) expect(ofA.has(id), `A's row ${id}`).toBe(true);
    for (const id of [...rowsOfB, ...globalRows, ...nobodyRows]) {
      expect(ofA.has(id), `foreign row ${id}`).toBe(false);
    }
    const ofB = ids(await walk("ownerB", t.b.organizationId));
    for (const id of rowsOfB) expect(ofB.has(id), `B's row ${id}`).toBe(true);
    for (const id of [...rowsOfA, ...globalRows, ...nobodyRows]) {
      expect(ofB.has(id), `foreign row ${id}`).toBe(false);
    }
  });

  it("a sign-in of ownerA is served to A; a failed sign-in for an unknown address is not", async () => {
    // Database time: the workstation's clock and the container's may differ.
    const before = (await api.superuser.query<{ now: Date }>("SELECT now()")).rows[0]?.now;
    await signInComplete(api, t.credentials("ownerA"), { source: "198.51.100.40" });
    const unknown = await api.request("POST", "/v1/auth/sign-in/email", {
      body: { email: `nobody-${randomUUID()}@mykey.invalid`, password: "not-a-password-1" },
      headers: { "x-forwarded-for": "198.51.100.41" },
    });
    expect(unknown.status).toBe(401);
    const written = await api.superuser.query<{
      id: string;
      actor_kind: string;
      actor_id: string | null;
      request_id: string;
    }>(
      `SELECT id, actor_kind, actor_id, request_id FROM audit.event
        WHERE action = 'auth.sign_in' AND occurred_at >= $1 ORDER BY occurred_at`,
      [before],
    );
    const mine = written.rows
      .filter((row) => row.actor_kind === "user" && row.actor_id === t.userId("ownerA"))
      .map((row) => row.id);
    const nobody = written.rows
      .filter((row) => row.request_id === unknown.headers.get("x-request-id"))
      .map((row) => row.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(nobody).toHaveLength(1);
    const served = ids(await walk("ownerA", t.a.organizationId, { action: "auth.sign_in" }));
    for (const id of mine) expect(served.has(id)).toBe(true);
    expect(served.has(nobody[0] ?? "")).toBe(false);
  });
});

describe("filters", () => {
  const match = (all: Item[], keep: (item: Item) => boolean): string[] =>
    all
      .filter(keep)
      .map((item) => item.id)
      .sort();
  const listed = async (query: Record<string, string>): Promise<string[]> =>
    (await walk("ownerA", t.a.organizationId, query)).map((item) => item.id).sort();

  it("each filter alone and two together return exactly the rows the full listing holds for them", async () => {
    const all = await walk("ownerA", t.a.organizationId);
    const envsOfProject1 = new Set([t.a.project1, t.a.env1a, t.a.env1b]);
    const inProject1 =
      all.find(
        (item) => item.action.startsWith("secret.") && envsOfProject1.has(item.target?.id ?? ""),
      )?.action ?? "";
    const cases: [Record<string, string>, (item: Item) => boolean][] = [
      [{ action: "secret.create" }, (item) => item.action === "secret.create"],
      [{ outcome: "denied" }, (item) => item.outcome === "denied"],
      [{ actorKind: "user" }, (item) => item.actor.kind === "user"],
      [{ actorId: t.userId("editorA") }, (item) => item.actor.id === t.userId("editorA")],
      [{ projectId: t.a.project1 }, (item) => envsOfProject1.has(item.target?.id ?? "")],
      [{ environmentId: t.a.env1a }, (item) => item.target?.id === t.a.env1a],
      [{ operationId: OPERATION }, (item) => item.operationId === OPERATION],
      [{ requestId: REQUEST }, (item) => item.requestId === REQUEST],
      [
        { projectId: t.a.project1, action: inProject1 },
        (item) => envsOfProject1.has(item.target?.id ?? "") && item.action === inProject1,
      ],
      [
        { actorKind: "user", outcome: "denied" },
        (item) => item.actor.kind === "user" && item.outcome === "denied",
      ],
    ];
    for (const [query, keep] of cases) {
      const expected = match(all, keep);
      expect(expected.length, JSON.stringify(query)).toBeGreaterThan(0);
      expect(await listed(query), JSON.stringify(query)).toEqual(expected);
    }
    // A time window: the rows between two served times, both ends included.
    // Served times are cut to milliseconds; `to` is one past the newest so that
    // the newest row's microseconds stay inside the window.
    const newest = all[3]?.occurredAt ?? "";
    const oldest = all[12]?.occurredAt ?? "";
    const toAfter = new Date(Date.parse(newest) + 1).toISOString();
    expect(await listed({ from: oldest, to: toAfter }), "from/to").toEqual(
      match(
        all,
        (item) =>
          Date.parse(item.occurredAt) >= Date.parse(oldest) &&
          Date.parse(item.occurredAt) <= Date.parse(newest),
      ),
    );
  });

  it("a window of 93 days, from after to and an action that is not served → 422; an unknown key → 400 as on every route", async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 93 * 86_400_000);
    const cases: Record<string, string>[] = [
      { from: from.toISOString(), to: to.toISOString() },
      { from: to.toISOString(), to: from.toISOString() },
      { action: "operator.gate_open" },
      { action: "no.such_action" },
    ];
    for (const query of cases) {
      const response = await get("ownerA", t.a.organizationId, query);
      expect(response.status, JSON.stringify(query)).toBe(422);
      expect(await codeOf(response)).toBe("validation_failed");
    }
    const unknownKey = await get("ownerA", t.a.organizationId, { colour: "blue" });
    expect(unknownKey.status).toBe(400);
    expect(await codeOf(unknownKey)).toBe("malformed_request");
    // Control: 92 days is accepted.
    const within = new Date(to.getTime() - 92 * 86_400_000);
    const ok = await get("ownerA", t.a.organizationId, {
      from: within.toISOString(),
      to: to.toISOString(),
    });
    expect(ok.status).toBe(200);
  });
});

describe("pages", () => {
  it("pages are stable: 30 events written between page one and page two do not appear and nothing is skipped or repeated", async () => {
    const before = ids(await walk("ownerA", t.a.organizationId));
    const first = (await (await get("ownerA", t.a.organizationId, { limit: "7" })).json()) as Page;
    const late = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      late.add(
        await writeAuditRow(api.superuser, "project.rename", {
          organizationId: t.a.organizationId,
          userId: t.userId("ownerA"),
        }),
      );
    }
    const collected = first.items.map((item) => item.id);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = (await (
        await get("ownerA", t.a.organizationId, { limit: "7", cursor })
      ).json()) as Page;
      expect(page.anchor).toBe(first.anchor);
      collected.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }
    expect(new Set(collected).size).toBe(collected.length);
    for (const id of late) expect(collected.includes(id)).toBe(false);
    expect([...collected].sort()).toEqual([...before].sort());
  });

  it("a cursor used with another filter → 409 listing_changed; a cursor with a changed byte → 400 malformed_request", async () => {
    const first = (await (
      await get("ownerA", t.a.organizationId, { limit: "3", actorKind: "user" })
    ).json()) as Page;
    const cursor = first.nextCursor ?? "";
    expect(cursor).not.toBe("");
    const other = await get("ownerA", t.a.organizationId, {
      limit: "3",
      actorKind: "operator",
      cursor,
    });
    expect(other.status).toBe(409);
    expect(await codeOf(other)).toBe("listing_changed");
    const changed = `${cursor.slice(0, 5)}${cursor[5] === "A" ? "B" : "A"}${cursor.slice(6)}`;
    const tampered = await get("ownerA", t.a.organizationId, {
      limit: "3",
      actorKind: "user",
      cursor: changed,
    });
    expect(tampered.status).toBe(400);
    expect(await codeOf(tampered)).toBe("malformed_request");
    // A cursor of organization A is not one of organization B.
    const foreign = await get("ownerB", t.b.organizationId, {
      limit: "3",
      actorKind: "user",
      cursor,
    });
    expect(foreign.status).toBe(400);
  });

  it("a row whose details fail its schema is served with details {} and logged output_invalid", async () => {
    const id = randomUUID();
    // The superuser writes past appendAudit: a field no schema allows.
    await api.superuser.query(
      `INSERT INTO audit.event (id, actor_kind, actor_id, source_category, organization_id, action,
                                target_kind, target_id, outcome, request_id, operation_id, details)
       VALUES ($1, 'user', $2, 'api', $3, 'secret.create', 'environment', $4, 'success', NULL, NULL,
               '{"name": "BAD_ROW", "extra": "not allowed"}')`,
      [id, t.userId("ownerA"), t.a.organizationId, t.a.env1a],
    );
    const items = await walk("ownerA", t.a.organizationId, { action: "secret.create" });
    const served = items.find((item) => item.id === id);
    expect(served?.details).toEqual({});
    const logged = api.logs.filter(
      (entry) => (entry as { event: string }).event === "output_invalid",
    );
    expect(JSON.stringify(logged)).toContain(id);
    expect(JSON.stringify(logged)).not.toContain("not allowed");
  });
});
