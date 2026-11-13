// Run 3.9 Task D (FR-1.19): projects and environments are never deleted in
// Stage 1 — no route, no repository function and no database right can.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES } from "@mykey/contracts";
import { startTestApi, type TestApi } from "../../harness/api.ts";
import { createTenants, type Tenants } from "../../harness/tenants.ts";

let api: TestApi;
let tenants: Tenants;

beforeAll(async () => {
  api = await startTestApi();
  tenants = await createTenants(api);
}, 300_000);

afterAll(async () => {
  await api.close();
});

async function counts(): Promise<string> {
  const result = await api.superuser.query<{ p: string; e: string }>(
    "SELECT (SELECT count(*) FROM app.project)::text AS p, (SELECT count(*) FROM app.environment)::text AS e",
  );
  return JSON.stringify(result.rows[0]);
}

describe("no deletion", () => {
  it("DELETE on every project and environment path, as the owner with the right Origin → 404, nothing changed", async () => {
    const { a } = tenants;
    const before = await counts();
    const cookie = await tenants.cookie("ownerA");
    const base = `/v1/organizations/${a.organizationId}`;
    for (const path of [
      `${base}/projects`,
      `${base}/projects/${a.project1}`,
      `${base}/projects/${a.project1}/environments`,
      `${base}/projects/${a.project1}/environments/${a.env1a}`,
    ]) {
      const response = await api.request("DELETE", path, { cookie });
      expect(response.status, path).toBe(404);
    }
    expect(await counts()).toBe(before);
  });

  it("no route has a method other than GET, POST and PATCH; only secrets.delete names a deletion", () => {
    expect(new Set(ROUTES.map((route) => route.method))).toEqual(new Set(["GET", "POST", "PATCH"]));
    // The action part of the id; `secrets.undelete` restores, it deletes nothing.
    expect(ROUTES.filter((route) => route.id.endsWith(".delete")).map((route) => route.id)).toEqual(
      ["secrets.delete"],
    );
  });

  it("api_runtime and provisioner_runtime cannot delete a project or an environment", async () => {
    for (const role of ["api_runtime", "provisioner_runtime"] as const) {
      for (const table of ["app.project", "app.environment"]) {
        await expect(
          api.database.pool(role).query(`DELETE FROM ${table} WHERE false`),
          `${role} ${table}`,
        ).rejects.toThrow(/permission denied/);
      }
    }
  });

  it("no exported function of the resource repository deletes or removes", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../../packages/db/src/repos/resources.ts"),
      "utf8",
    );
    const exported = [...source.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(5);
    expect(exported.filter((name) => /^(delete|remove)/i.test(name ?? ""))).toEqual([]);
    expect(source).not.toMatch(/DELETE FROM app\.(project|environment)/);
  });
});
