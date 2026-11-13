// Run 3.7 Task D (FR-1.11, Doc 10 §4.1 rule 5): a change to a membership, a
// grant, a session or an account takes effect on the very next request of a
// live session, with no new sign-in and no cache to wait for.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { signInComplete, startTestApi, type TestApi } from "../../harness/api.ts";
import { createTenants, type FixtureUser, type Tenants } from "../../harness/tenants.ts";
import { pathIn, requestOf, type PathIds } from "./requests.ts";

let api: TestApi;
let tenants: Tenants;
/** Set by a test: the stub of this route waits for `release` before it answers. */
let latch: { routeId: string; entered: () => void; release: Promise<void> } | null = null;

beforeAll(async () => {
  api = await startTestApi({
    stubs: true,
    stubHook: async (routeId) => {
      if (latch?.routeId !== routeId) return;
      latch.entered();
      await latch.release;
    },
  });
}, 300_000);

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  // Fresh tenants for every case: each one changes memberships or grants.
  tenants = await createTenants(api);
}, 300_000);

const route = (id: string): RouteDef => ROUTES.find((candidate) => candidate.id === id)!;
const at = (target: "p1/e1a" | "p2/e2a"): PathIds =>
  target === "p1/e1a"
    ? { org: tenants.a.organizationId, project: tenants.a.project1, env: tenants.a.env1a }
    : { org: tenants.a.organizationId, project: tenants.a.project2, env: tenants.a.env2a };

async function status(
  user: FixtureUser,
  id: string,
  ids: PathIds = at("p1/e1a"),
  cookie?: string,
): Promise<number> {
  const def = route(id);
  const response = await api.request(def.method, pathIn(def, ids), {
    ...requestOf(def),
    cookie: cookie ?? (await tenants.cookie(user)),
  });
  return response.status;
}

const grantOf = (user: FixtureUser) =>
  api.superuser.query("DELETE FROM app.access_grant WHERE user_id = $1", [tenants.userId(user)]);

describe("revocation takes effect on the next request", () => {
  it("grant deleted → the next request is 404", async () => {
    expect(await status("editorA", "secrets.list")).toBe(204);
    await grantOf("editorA");
    expect(await status("editorA", "secrets.list")).toBe(404);
  });

  it("grant lowered editor → reader → the next write is 403", async () => {
    expect(await status("editorA", "secrets.create")).toBe(204);
    await api.superuser.query("UPDATE app.access_grant SET role = 'reader' WHERE user_id = $1", [
      tenants.userId("editorA"),
    ]);
    expect(await status("editorA", "secrets.create")).toBe(403);
    expect(await status("editorA", "secrets.list")).toBe(204);
  });

  it("membership revoked → 404 on every route of the organization; organizations.list no longer shows it", async () => {
    expect(await status("editorA", "secrets.list")).toBe(204);
    await api.superuser.query(
      "UPDATE app.membership SET state = 'revoked' WHERE user_id = $1 AND organization_id = $2",
      [tenants.userId("editorA"), tenants.a.organizationId],
    );
    for (const def of ROUTES.filter(
      (r) => (r.auth === "human" || r.auth === "human_fresh_totp") && r.scope !== "none",
    )) {
      expect(await status("editorA", def.id), def.id).toBe(404);
    }
    const list = await api.request("GET", "/v1/organizations", {
      cookie: await tenants.cookie("editorA"),
    });
    expect(await list.json()).toEqual({ organizations: [] });
  });

  it("admin lowered to member → 403 / 404 as the matrix says", async () => {
    // projects.create and projects.list have their handlers since Run 3.9.
    expect(await status("adminA", "projects.create")).toBe(201);
    expect(await status("adminA", "secrets.list")).toBe(204);
    await api.superuser.query("UPDATE app.membership SET role = 'member' WHERE user_id = $1", [
      tenants.userId("adminA"),
    ]);
    expect(await status("adminA", "projects.create")).toBe(403);
    expect(await status("adminA", "audit.list")).toBe(403);
    expect(await status("adminA", "secrets.list")).toBe(404);
    expect(await status("adminA", "projects.list")).toBe(200);
  });

  it("session revoked → 401", async () => {
    const session = await signInComplete(api, tenants.credentials("ownerA"));
    expect(await status("ownerA", "secrets.list", at("p1/e1a"), session.cookie)).toBe(204);
    await api.superuser.query("DELETE FROM auth.session WHERE id = $1", [session.sessionId]);
    expect(await status("ownerA", "secrets.list", at("p1/e1a"), session.cookie)).toBe(401);
    // Another session of the same user is untouched.
    expect(await status("ownerA", "secrets.list")).toBe(204);
  });

  it("account disabled → 401", async () => {
    expect(await status("readerA", "secrets.list")).toBe(204);
    await api.superuser.query(
      "UPDATE auth.account_state SET state = 'disabled' WHERE user_id = $1",
      [tenants.userId("readerA")],
    );
    expect(await status("readerA", "secrets.list")).toBe(401);
  });

  it("a change flips the very next request, 20 times in a row", async () => {
    const user = tenants.userId("ungrantedA");
    for (let round = 0; round < 20; round += 1) {
      await api.superuser.query(
        `INSERT INTO app.access_grant (id, organization_id, user_id, project_id, role)
         VALUES (gen_random_uuid(), $1, $2, $3, 'reader')`,
        [tenants.a.organizationId, user, tenants.a.project1],
      );
      expect(await status("ungrantedA", "secrets.list"), `round ${String(round)} on`).toBe(204);
      await grantOf("ungrantedA");
      expect(await status("ungrantedA", "secrets.list"), `round ${String(round)} off`).toBe(404);
    }
  });

  it("a request already inside its handler finishes; the one after is denied", async () => {
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    latch = {
      routeId: "secrets.list",
      entered: () => {
        entered();
      },
      release: new Promise<void>((resolve) => (release = resolve)),
    };
    try {
      const running = status("editorA", "secrets.list");
      await inside;
      await grantOf("editorA");
      release();
      expect(await running).toBe(204);
    } finally {
      latch = null;
    }
    expect(await status("editorA", "secrets.list")).toBe(404);
  });
});
