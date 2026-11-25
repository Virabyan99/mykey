// Run 8.2 (P-151): a cursor opens only the listing it was made for. Every list
// route of ROUTES with a cursor refuses the cursor of every other list route,
// the cursor of the same route in the other organization, and (where the route
// has filters) its own cursor under another filter.
import { randomUUID } from "node:crypto";
import { AUTOMATION_RIGHTS, ROUTES, type RouteDef } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fill, idsOf } from "./answers.ts";
import { createIsolationFixture, type IsolationFixture, type Side } from "./fixture.ts";

let fx: IsolationFixture;

/**
 * The list routes that page by cursor; for each a filter that changes the
 * listing, and what its own cursor under that filter answers. secrets.list and
 * operations.list sign the filter into the cursor, so another filter does not
 * verify (400); their 409 means a write between two pages. audit.list and
 * activity.list bind the filters by digest and answer 409 (audit.md).
 */
const LISTS: Record<string, { filter: string | null; otherFilter?: string }> = {
  "projects.list": { filter: null },
  "environments.list": { filter: null },
  "secrets.list": { filter: "prefix=ISO", otherFilter: "400 malformed_request" },
  "credentials.list": { filter: null },
  "operations.list": { filter: "state=unfinished", otherFilter: "400 malformed_request" },
  "audit.list": { filter: "outcome=success", otherFilter: "409 listing_changed" },
  "activity.list": { filter: "projectId=PROJECT", otherFilter: "409 listing_changed" },
  // Session 11 (Run 11.5 Task A).
  "automation_credentials.list": { filter: null },
  // Session 11 (Run 11.5 Task C): sent with the side's automation credential.
  "automation.projects.list": { filter: null },
  "automation.secrets.list": { filter: "prefix=ISO", otherFilter: "400 malformed_request" },
  "automation.runtime_credentials.list": { filter: null },
};

/** Session 11 (Run 11.2 to 11.5): list routes without a handler. Empty since Run 11.5. */
const OWED: readonly string[] = [];

/** Each side's automation credential: the bearer of its automation lists. Never printed. */
const automationSecrets: Partial<Record<Side["name"], string>> = {};

/** A list request as its caller sends it: a session, or an automation credential. */
function send(side: Side, id: string, query: string): Promise<Response> {
  return side.request(
    "GET",
    pathOf(side, id, query),
    id.startsWith("automation.")
      ? { headers: { authorization: `Bearer ${automationSecrets[side.name] ?? ""}` } }
      : { cookie: side.owner },
  );
}

const route = (id: string): RouteDef => {
  const found = ROUTES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no route ${id}`);
  return found;
};

async function more(side: Side, label: string): Promise<void> {
  const env = `/v1/organizations/${side.organizationId}/projects/${side.ids.projectId}/environments/${side.ids.environmentId}`;
  const answers = [
    await side.request("POST", `/v1/organizations/${side.organizationId}/projects`, {
      cookie: side.owner,
      headers: { "idempotency-key": randomUUID() },
      body: { name: `Cursor ${label} ${randomUUID().slice(0, 6)}` },
    }),
    await side.request(
      "POST",
      `/v1/organizations/${side.organizationId}/projects/${side.ids.projectId}/environments`,
      {
        cookie: side.owner,
        headers: { "idempotency-key": randomUUID() },
        body: { name: `c${randomUUID().slice(0, 8)}` },
      },
    ),
    await side.request("POST", `${env}/secrets`, {
      cookie: side.owner,
      headers: { "idempotency-key": randomUUID() },
      body: { name: `ISO_${label}_SECOND`, value: "synthetic" },
    }),
  ];
  await fx.freshen();
  answers.push(
    await side.request("POST", `${env}/credentials`, {
      cookie: side.owner,
      headers: { "idempotency-key": randomUUID() },
      body: { name: `second-${label}` },
    }),
  );
  // Two runtime credentials: automation's list of them has a second page.
  for (const name of ["one", "two"]) {
    answers.push(
      await side.request("POST", `${env}/runtime-credentials`, {
        cookie: side.owner,
        headers: { "idempotency-key": randomUUID() },
        body: { name: `runtime-${name}-${label}` },
      }),
    );
  }
  // Two automation credentials: their list has a second page at limit=1.
  for (const name of ["first", "second"]) {
    const issued = await side.request(
      "POST",
      `/v1/organizations/${side.organizationId}/automation-credentials`,
      {
        cookie: side.owner,
        headers: { "idempotency-key": randomUUID() },
        body: { name: `${name}-${label}`, rights: AUTOMATION_RIGHTS, cidrs: ["127.0.0.0/8"] },
      },
    );
    expect(issued.status, `seeding ${label}`).toBe(201);
    const body = (await issued.json()) as { secret: string; credential: { ownerId: string } };
    if (name === "first") {
      // Its chain manages the side's projects (two: its list has a second page).
      automationSecrets[side.name] = body.secret;
      await fx.f.api.superuser.query(
        "UPDATE app.project SET managed_by = $2 WHERE organization_id = $1",
        [side.organizationId, body.credential.ownerId],
      );
    }
  }
  for (const answer of answers) {
    expect(answer.status, `seeding ${label}`).toBeLessThan(300);
    await answer.arrayBuffer();
  }
}

function pathOf(side: Side, id: string, query: string): string {
  const base = fill(route(id), idsOf(side));
  return `${base}?${query.replace("PROJECT", side.ids.projectId)}`;
}

async function cursorOf(side: Side, id: string, filter: string | null): Promise<string> {
  const query = filter === null ? "limit=1" : `limit=1&${filter}`;
  const answer = await send(side, id, query);
  const body = (await answer.json()) as { nextCursor?: string | null };
  expect(answer.status, `${side.name} ${id}`).toBe(200);
  if (typeof body.nextCursor !== "string") throw new Error(`${side.name} ${id}: no second page`);
  return body.nextCursor;
}

async function codeOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return `${String(response.status)} ${body.error?.code ?? ""}`;
}

beforeAll(async () => {
  fx = await createIsolationFixture();
  await more(fx.a, "A");
  await more(fx.b, "B");
}, 900_000);

afterAll(async () => {
  await (fx as IsolationFixture | undefined)?.close();
});

describe("a cursor opens only its own listing", () => {
  it("every list route of ROUTES has a cursor and is in this test", () => {
    const listed = ROUTES.filter(
      (r) => r.method === "GET" && r.id.endsWith(".list") && r.id !== "organizations.list",
    ).map((r) => r.id);
    expect(listed.sort()).toEqual([...Object.keys(LISTS), ...OWED].sort());
  });

  it("every list route of ROUTES refuses a cursor of every other list route, of the same route in the other organization, and of the same route with another filter", async () => {
    const a = fx.a;
    const ownCursors: Record<string, string> = {};
    const bCursors: Record<string, string> = {};
    for (const id of Object.keys(LISTS)) {
      ownCursors[id] = await cursorOf(a, id, null);
      bCursors[id] = await cursorOf(fx.b, id, null);
    }
    const wrong: string[] = [];
    const ask = async (id: string, query: string, expected: string, label: string) => {
      const answer = await send(a, id, query);
      const seen = await codeOf(answer);
      if (seen !== expected) wrong.push(`${id} with ${label}: ${seen}, expected ${expected}`);
    };
    for (const [id, { filter, otherFilter }] of Object.entries(LISTS)) {
      // Control: its own cursor opens the next page.
      const own = await send(a, id, `limit=1&cursor=${encodeURIComponent(ownCursors[id] ?? "")}`);
      expect(own.status, `${id} with its own cursor`).toBe(200);
      await own.arrayBuffer();
      for (const other of Object.keys(LISTS)) {
        if (other === id) continue;
        await ask(
          id,
          `limit=1&cursor=${encodeURIComponent(ownCursors[other] ?? "")}`,
          "400 malformed_request",
          `the cursor of ${other}`,
        );
      }
      await ask(
        id,
        `limit=1&cursor=${encodeURIComponent(bCursors[id] ?? "")}`,
        "400 malformed_request",
        "B's cursor of the same route",
      );
      if (filter !== null) {
        await ask(
          id,
          `limit=1&${filter.replace("PROJECT", a.ids.projectId)}&cursor=${encodeURIComponent(ownCursors[id] ?? "")}`,
          otherFilter ?? "",
          `its own cursor under ${filter}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  }, 300_000);
});
