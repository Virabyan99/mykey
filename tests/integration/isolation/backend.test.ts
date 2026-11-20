// Run 8.2 (P-151): the second organization attacks both stores directly.
// OpenBao: A's AppRole credentials log in nowhere but A's namespace, and the
// machine token the product issued for A's environment is refused on every
// KV, token and sys path of B's namespace. PostgreSQL: as api_runtime, no
// identity column of schema app can be changed (the list comes from the
// catalog), with a control the same role may update. This extends
// openbao/authority.test.ts and database/privileges.test.ts across
// organizations; the authority matrix file is not touched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@mykey/db";
import { baoFetch } from "../../harness/stack.ts";
import { createIsolationFixture, type IsolationFixture } from "./fixture.ts";

let fx: IsolationFixture;

beforeAll(async () => {
  fx = await createIsolationFixture();
}, 900_000);

afterAll(async () => {
  await (fx as IsolationFixture | undefined)?.close();
});

const nsOf = (organizationId: string) => `org-${organizationId}`;

describe("OpenBao across organizations", () => {
  it("A's runtime, issuer and provisioner role ids and secret ids cannot log in inside B's namespace or in the root namespace", async () => {
    const wrong: string[] = [];
    for (const identity of ["runtime", "issuer", "provisioner"] as const) {
      const { roleId, secretId } = fx.a.appRole(identity);
      for (const namespace of [nsOf(fx.b.organizationId), ""]) {
        const answer = await baoFetch(fx.stack, "/v1/auth/approle/login", {
          method: "POST",
          token: "",
          ...(namespace === "" ? {} : { namespace }),
          body: { role_id: roleId, secret_id: secretId },
        });
        const body = (await answer.json().catch(() => ({}))) as { auth?: unknown };
        if (answer.status === 200 || body.auth !== undefined) {
          wrong.push(`${identity} in ${namespace || "root"}: ${String(answer.status)}`);
        }
      }
      // Control: in A's own namespace the same pair logs in.
      const own = await baoFetch(fx.stack, "/v1/auth/approle/login", {
        method: "POST",
        token: "",
        namespace: nsOf(fx.a.organizationId),
        body: { role_id: roleId, secret_id: secretId },
      });
      expect(own.status, `${identity} in A's namespace`).toBe(200);
      await own.arrayBuffer();
    }
    expect(wrong).toEqual([]);
  });

  it("the token the product issued for A's environment gets 403 for every KV, token and sys path of B's namespace", async () => {
    const b = fx.b;
    const secret = `p/${b.ids.projectId}/e/${b.ids.environmentId}/${b.ids.secretName}`;
    const paths: [string, string, unknown?][] = [
      ["GET", `kv/data/${secret}`],
      ["GET", `kv/metadata/${secret}`],
      ["GET", `kv/metadata/p/${b.ids.projectId}/e/${b.ids.environmentId}/?list=true`],
      ["POST", `kv/data/${secret}`, { data: { value: "x" } }],
      ["DELETE", `kv/metadata/${secret}`],
      ["GET", "kv/config"],
      ["POST", "auth/token/create", {}],
      ["POST", "auth/token/renew-self", {}],
      ["GET", "auth/token/accessors?list=true"],
      ["GET", "sys/mounts"],
      ["GET", "sys/auth"],
      ["GET", "sys/policies/acl?list=true"],
      ["GET", "sys/namespaces?list=true"],
      ["GET", "auth/approle/role?list=true"],
    ];
    const wrong: string[] = [];
    for (const [method, path, body] of paths) {
      const answer = await baoFetch(fx.stack, `/v1/${path}`, {
        method,
        token: fx.a.machineToken,
        namespace: nsOf(b.organizationId),
        ...(body === undefined ? {} : { body }),
      });
      await answer.arrayBuffer();
      if (answer.status !== 403) wrong.push(`${method} ${path}: ${String(answer.status)}`);
    }
    expect(wrong).toEqual([]);
    // OpenBao answers lookup-self about the caller's own token whatever namespace is
    // named: it must be A's token's own record, naming A's namespace and nothing of B.
    const self = await baoFetch(fx.stack, "/v1/auth/token/lookup-self", {
      token: fx.a.machineToken,
      namespace: nsOf(b.organizationId),
    });
    const selfText = await self.text();
    const selfBody = JSON.parse(selfText) as { data?: { namespace_path?: string } };
    expect(selfBody.data?.namespace_path).toBe(`${nsOf(fx.a.organizationId)}/`);
    for (const id of [b.organizationId, b.ids.projectId, b.ids.environmentId, b.ids.secretName]) {
      expect(selfText.includes(id)).toBe(false);
    }
    // Control: the token reads its own environment's secret in A's namespace.
    const a = fx.a;
    const own = await baoFetch(
      fx.stack,
      `/v1/kv/data/p/${a.ids.projectId}/e/${a.ids.environmentId}/${a.ids.secretName}`,
      { token: a.machineToken, namespace: nsOf(a.organizationId) },
    );
    expect(own.status).toBe(200);
    await own.arrayBuffer();
  });
});

describe("PostgreSQL across organizations", () => {
  it("as api_runtime, an UPDATE of organization_id, project_id or environment_id fails on every table of schema app that has the column", async () => {
    const columns = await fx.f.api.superuser.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'app'
          AND column_name IN ('organization_id', 'project_id', 'environment_id')
        ORDER BY 1, 2`,
    );
    expect(columns.rows.length).toBeGreaterThanOrEqual(15);
    const pool = createPool(fx.f.api.database.targets.api_runtime, { max: 1 });
    const allowed: string[] = [];
    try {
      for (const { table_name: table, column_name: column } of columns.rows) {
        const outcome = await pool
          .query(`UPDATE app."${table}" SET "${column}" = $1 WHERE "${column}" = $2`, [
            fx.b.organizationId,
            column === "organization_id" ? fx.a.organizationId : fx.a.ids.projectId,
          ])
          .then(
            () => "updated",
            (error: unknown) => (error as { code?: string }).code ?? "error",
          );
        // 42501: permission denied (the column grant); anything else is a finding.
        if (outcome !== "42501") allowed.push(`${table}.${column}: ${outcome}`);
      }
      // Control: the same role updates a column it may.
      await expect(
        pool.query("UPDATE app.project SET name = name WHERE id = $1", [fx.a.ids.projectId]),
      ).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
    expect(allowed).toEqual([]);
  });
});
