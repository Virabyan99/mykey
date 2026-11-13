// Run 3.9 Task C (P-59, Doc 06 §9): lists are keyset pages in id order under
// signed cursors; a create between two pages is `409 listing_changed`, a
// rename is not; a cursor that is tampered with or belongs elsewhere is
// `400 malformed_request`; a member sees only what its grants make visible;
// no answer names an OpenBao object.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EnvironmentId, OrganizationId, ProjectId } from "@mykey/contracts";
import { createProject, withTransaction } from "@mykey/db";
import type { FixtureUser } from "../../harness/tenants.ts";
import { createProvisioningFixture, type ProvisioningFixture } from "../provisioning/fixture.ts";

let fx: ProvisioningFixture;
const bodies: string[] = [];

beforeAll(async () => {
  fx = await createProvisioningFixture({ shared: true });
  // 120 projects through the repository (no request needed to make them).
  const scope = { organizationId: fx.tenants.a.organizationId as OrganizationId };
  for (let index = 0; index < 120; index += 1) {
    await withTransaction(fx.api.pool, (tx) =>
      createProject(tx, scope, {
        projectId: randomUUID() as ProjectId,
        name: `Listed ${String(index).padStart(3, "0")}`,
        developmentEnvironmentId: randomUUID() as EnvironmentId,
      }),
    );
  }
}, 600_000);

afterAll(async () => {
  // No answer of this file names an OpenBao object.
  for (const body of bodies) {
    expect(body).not.toMatch(/org-|kv\/|machine-env-/);
  }
  await fx.close();
}, 300_000);

async function get(path: string, user: FixtureUser = "ownerA") {
  const response = await fx.api.request("GET", path, { cookie: await fx.tenants.cookie(user) });
  const text = await response.text();
  bodies.push(text);
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
}

const projectsPath = (query = "", org = fx.tenants.a.organizationId) =>
  `/v1/organizations/${org}/projects${query}`;
const ids = (body: Record<string, unknown>, key = "projects") =>
  (body[key] as { id: string }[]).map((item) => item.id);

async function allPages(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const query = `?limit=${String(limit)}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = await get(projectsPath(query));
    expect(page.status).toBe(200);
    seen.push(...ids(page.body));
    cursor = page.body.nextCursor as string | null;
  } while (cursor !== null);
  return seen;
}

describe("pages", () => {
  it("default page 50; limit=100 gives 100; limit=101 and limit=0 are 422", async () => {
    expect(ids((await get(projectsPath())).body)).toHaveLength(50);
    expect(ids((await get(projectsPath("?limit=100"))).body)).toHaveLength(100);
    for (const limit of ["101", "0"]) {
      const answer = await get(projectsPath(`?limit=${limit}`));
      expect(answer.status, limit).toBe(422);
    }
  });

  it("pages are in id order, disjoint and complete", async () => {
    const seen = await allPages(50);
    const stored = await fx.api.superuser.query<{ id: string }>(
      "SELECT id FROM app.project WHERE organization_id = $1 ORDER BY id",
      [fx.tenants.a.organizationId],
    );
    expect(seen).toEqual(stored.rows.map((row) => row.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(122);
  });

  it("a project created between two pages → 409 listing_changed on the next page; a fresh first page works", async () => {
    const first = await get(projectsPath("?limit=10"));
    const cursor = first.body.nextCursor as string;
    const created = await fx.api.request("POST", projectsPath(), {
      body: { name: `Between ${randomUUID().slice(0, 6)}` },
      cookie: await fx.tenants.cookie("ownerA"),
      headers: { "idempotency-key": randomUUID() },
    });
    expect(created.status).toBe(201);
    const next = await get(projectsPath(`?limit=10&cursor=${encodeURIComponent(cursor)}`));
    expect(next.status).toBe(409);
    expect((next.body.error as { code: string }).code).toBe("listing_changed");
    expect((await get(projectsPath("?limit=10"))).status).toBe(200);
  });

  it("a rename between two pages does not disturb them", async () => {
    const first = await get(projectsPath("?limit=10"));
    const target = ids(first.body)[3]!;
    const renamed = await fx.api.request("PATCH", `${projectsPath()}/${target}`, {
      body: { name: `Renamed ${randomUUID().slice(0, 6)}` },
      cookie: await fx.tenants.cookie("ownerA"),
      headers: { "idempotency-key": randomUUID() },
    });
    expect(renamed.status).toBe(200);
    const cursor = first.body.nextCursor as string;
    const next = await get(projectsPath(`?limit=10&cursor=${encodeURIComponent(cursor)}`));
    expect(next.status).toBe(200);
    expect(ids(next.body)[0]! > ids(first.body).at(-1)!).toBe(true);
  });

  it("a tampered cursor, a cursor of the other list and a cursor of organization B → 400 malformed_request", async () => {
    const first = await get(projectsPath("?limit=5"));
    const cursor = first.body.nextCursor as string;
    const tampered = `${cursor.slice(0, 5)}${cursor[5] === "A" ? "B" : "A"}${cursor.slice(6)}`;
    const answers = [
      await get(projectsPath(`?cursor=${encodeURIComponent(tampered)}`)),
      await get(
        `/v1/organizations/${fx.tenants.a.organizationId}/projects/${fx.tenants.a.project1}/environments?cursor=${encodeURIComponent(cursor)}`,
      ),
      await get(
        projectsPath(`?cursor=${encodeURIComponent(cursor)}`, fx.tenants.b.organizationId),
        "ownerB",
      ),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect((answer.body.error as { code: string }).code).toBe("malformed_request");
    }
  });
});

describe("what a member sees", () => {
  it("envEditorA: project 1 and, inside it, environment 1a only; ungrantedA: an empty list", async () => {
    const { a } = fx.tenants;
    const projects = await get(projectsPath("?limit=100"), "envEditorA");
    expect(ids(projects.body)).toEqual([a.project1]);
    const environments = await get(
      `/v1/organizations/${a.organizationId}/projects/${a.project1}/environments`,
      "envEditorA",
    );
    expect(ids(environments.body, "environments")).toEqual([a.env1a]);
    const empty = await get(projectsPath(), "ungrantedA");
    expect(empty).toEqual({ status: 200, body: { projects: [], nextCursor: null } });
    // A project grant shows every environment of the project.
    const editor = await get(
      `/v1/organizations/${a.organizationId}/projects/${a.project1}/environments`,
      "editorA",
    );
    expect(ids(editor.body, "environments").sort()).toEqual([a.env1a, a.env1b].sort());
  });
});
