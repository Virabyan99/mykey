// Run 5.4 Task C (PO-2, FR-1.40, FR-1.45, D-42): a token issued by the
// product for environment 1a, used directly against OpenBao. It may read and
// list its own environment's values and look itself up; everything else is
// denied (403). Every denied call has a control: the same call with the root
// token is not denied, so a 403 is a denial and not a wrong path. The residual
// of FR-1.45 is asserted as it is. The test writes
// docs/evidence/session-5/native-scope.md, one line per call.
//
// Tokens and accessors are locals: assertion messages carry labels only.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";
import type { OrganizationId } from "@mykey/contracts";
import { environmentPrefix, machineName, namespaceFor } from "@mykey/openbao";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  rootRevoke,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { digestOf, machineCall, resolveDigests } from "../../harness/machine.ts";
import { baoFetch, freshNamespace, mountKvV2 } from "../../harness/stack.ts";

let f: CredentialsFixture;
let token: string;
const lines: string[] = [];
const toRevoke: string[] = [];

const EVIDENCE = join(import.meta.dirname, "../../../docs/evidence/session-5/native-scope.md");

beforeAll(async () => {
  f = await createCredentialsFixture();
  token = (await issueFor(f, "env1a")).token;
}, 600_000);

afterAll(async () => {
  for (const accessor of toRevoke) await rootRevoke(f, accessor).catch(() => undefined);
  await f.close();
  const markdown = [
    "# Native scope of a product-issued machine token (Run 5.4 Task C)",
    "",
    "PO-2, FR-1.40, FR-1.45. A token issued through `POST …/credentials` for environment 1a of the local stack, used directly against OpenBao 2.7.2 in its organization's namespace. Written by `tests/integration/machine/native-scope.test.ts`; every denied call has a control with the root token on the same path.",
    "",
    "| Call | Machine token | Root control |",
    "| --- | --- | --- |",
    ...lines,
    "",
  ].join("\n");
  writeFileSync(
    EVIDENCE,
    await format(markdown, { ...(await resolveConfig(EVIDENCE)), filepath: EVIDENCE }),
  );
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  namespace?: string;
}

async function status(as: string, call: Call): Promise<number> {
  const response = await baoFetch(f.stack, `/v1/${call.path}`, {
    method: call.method,
    token: as,
    ...((call.namespace ?? f.fx.namespace) === ""
      ? {}
      : { namespace: call.namespace ?? f.fx.namespace }),
    ...(call.body === undefined ? {} : { body: call.body }),
    ...(call.headers === undefined ? {} : { headers: call.headers }),
  });
  await response.arrayBuffer();
  return response.status;
}

async function rootJson(call: Call): Promise<Record<string, unknown>> {
  const response = await baoFetch(f.stack, `/v1/${call.path}`, {
    method: call.method,
    token: f.stack.bao.rootToken,
    namespace: f.fx.namespace,
    ...(call.body === undefined ? {} : { body: call.body }),
  });
  const text = await response.text();
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** A call as the evidence file shows it: ids and random namespace names replaced. */
const label = (call: Call) => {
  const generic = (text: string) =>
    text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, "<id>").replace(/^t-[0-9a-f]{12}$/u, "t-<random>");
  return (
    `\`${call.method} ${generic(call.path)}\`` +
    (call.namespace === undefined ? "" : ` (namespace \`${generic(call.namespace) || "root"}\`)`)
  );
};

async function allowed(call: Call): Promise<void> {
  const seen = await status(token, call);
  lines.push(`| ${label(call)} | ${String(seen)} | — |`);
  expect(seen, label(call)).toBe(200);
}

/**
 * The machine token is denied; then the control, the same call with the root
 * token (or `control` when the root token cannot make the same call safely),
 * must not be denied: 2xx, or 404 where `absentOk` says an empty listing is
 * all there is.
 */
async function denied(
  call: Call,
  opts: { control?: () => Promise<number>; absentOk?: boolean } = {},
): Promise<void> {
  const seen = await status(token, call);
  const control = opts.control ? await opts.control() : await status(f.stack.bao.rootToken, call);
  lines.push(`| ${label(call)} | ${String(seen)} | ${String(control)} |`);
  expect(seen, label(call)).toBe(403);
  const ok = (control >= 200 && control < 300) || (opts.absentOk === true && control === 404);
  expect(ok, `control of ${label(call)}: ${String(control)}`).toBe(true);
}

/** A token with the default policy, made by root, for the revocation controls. */
async function throwaway(): Promise<{ token: string; accessor: string }> {
  const made = await rootJson({
    method: "POST",
    path: "auth/token/create",
    body: { ttl: "5m", policies: ["default"] },
  });
  const auth = made.auth as { client_token: string; accessor: string };
  toRevoke.push(auth.accessor);
  return { token: auth.client_token, accessor: auth.accessor };
}

/** Records the tokens a root control created, so afterAll revokes them. */
async function creating(call: Call): Promise<number> {
  const response = await baoFetch(f.stack, `/v1/${call.path}`, {
    method: call.method,
    token: f.stack.bao.rootToken,
    namespace: f.fx.namespace,
    ...(call.body === undefined ? {} : { body: call.body }),
  });
  const text = await response.text();
  if (response.status === 200) {
    const auth = (JSON.parse(text) as { auth?: { accessor?: string } }).auth;
    if (auth?.accessor !== undefined) toRevoke.push(auth.accessor);
  }
  return response.status;
}

describe("a product-issued machine token against OpenBao itself", () => {
  it("reads and lists its own environment's values and looks itself up; writes, deletes and destroys there are denied, each with a root control", async () => {
    const one = f.env("env1a");
    const own = environmentPrefix(one.projectId, one.environmentId);
    for (const [env, name] of [
      ["env1a", "NATIVE_A"],
      ["env1b", "NATIVE_B"],
      ["env2a", "NATIVE_C"],
    ] as const) {
      expect((await f.create(env, name, `synthetic-${name}`)).status).toBe(201);
    }

    // Allowed.
    await allowed({ method: "GET", path: `kv/data/${own}NATIVE_A` });
    await allowed({ method: "GET", path: `kv/metadata/${own}?list=true` });
    await allowed({ method: "GET", path: "auth/token/lookup-self" });

    // Values and metadata of its own environment: no write, delete or destroy.
    // A scratch key written by root, removed again by the last control.
    const scratch = `kv/data/${own}NATIVE_SCRATCH`;
    const envelope = { value: "synthetic", operation_id: randomUUID(), format: 1 };
    expect(
      await status(f.stack.bao.rootToken, {
        method: "POST",
        path: scratch,
        body: { options: { cas: 0 }, data: envelope },
      }),
    ).toBe(200);
    // The keys root writes here are not in the index: removed in `finally`, or
    // the product's next read of 1a would rightly call it drift.
    const removeScratch = async () => {
      for (const name of ["NATIVE_NEW", "NATIVE_SCRATCH"]) {
        await status(f.stack.bao.rootToken, {
          method: "DELETE",
          path: `kv/metadata/${own}${name}`,
        });
      }
    };
    try {
      await scratchCalls();
    } finally {
      await removeScratch();
    }
  });

  async function scratchCalls(): Promise<void> {
    const one = f.env("env1a");
    const own = environmentPrefix(one.projectId, one.environmentId);
    const scratch = `kv/data/${own}NATIVE_SCRATCH`;
    const envelope = { value: "synthetic", operation_id: randomUUID(), format: 1 };
    const fresh = `kv/data/${own}NATIVE_NEW`;
    await denied({ method: "POST", path: fresh, body: { options: { cas: 0 }, data: envelope } });
    // Version 2 after root's control; the patch (cas required by the mount) makes 3.
    await denied({ method: "POST", path: scratch, body: { options: { cas: 1 }, data: envelope } });
    await denied({
      method: "PATCH",
      path: scratch,
      body: { options: { cas: 2 }, data: { value: "patched" } },
      headers: { "content-type": "application/merge-patch+json" },
    });
    await denied({ method: "DELETE", path: scratch });
    await denied({
      method: "POST",
      path: `kv/delete/${own}NATIVE_SCRATCH`,
      body: { versions: [1] },
    });
    await denied({
      method: "POST",
      path: `kv/undelete/${own}NATIVE_SCRATCH`,
      body: { versions: [1] },
    });
    await denied({
      method: "PUT",
      path: `kv/destroy/${own}NATIVE_SCRATCH`,
      body: { versions: [1] },
    });
    await denied({
      method: "POST",
      path: `kv/metadata/${own}NATIVE_SCRATCH`,
      body: { max_versions: 5 },
    });
    await denied({ method: "DELETE", path: `kv/metadata/${own}NATIVE_SCRATCH` });
  }

  it("cannot read or list another environment or project, nor create, look up or revoke tokens, nor read policies, mounts, auth, roles, namespaces, capabilities or identity", async () => {
    const one = f.env("env1a");
    const own = environmentPrefix(one.projectId, one.environmentId);
    const b = f.env("env1b");
    const other = environmentPrefix(b.projectId, b.environmentId);
    const p2 = f.env("env2a");
    const second = environmentPrefix(p2.projectId, p2.environmentId);

    // Other environments, another project, and the listings above its own.
    await denied({ method: "GET", path: `kv/data/${other}NATIVE_B` });
    await denied({ method: "GET", path: `kv/metadata/${other}?list=true` });
    await denied({ method: "GET", path: `kv/data/${second}NATIVE_C` });
    await denied({ method: "GET", path: `kv/metadata/${second}?list=true` });
    await denied({ method: "GET", path: `kv/metadata/p/${one.projectId}/?list=true` });
    await denied({ method: "GET", path: "kv/metadata/?list=true" });

    // Tokens: no creation, no lookup of another token, no revocation.
    const role = machineName(one.environmentId);
    for (const path of [
      "auth/token/create",
      "auth/token/create-orphan",
      `auth/token/create/${role}`,
    ]) {
      const call = { method: "POST", path, body: { ttl: "1m" } };
      await denied(call, { control: () => creating(call) });
    }
    const target = await throwaway();
    await denied({ method: "POST", path: "auth/token/lookup", body: { token: target.token } });
    await denied({
      method: "POST",
      path: "auth/token/lookup-accessor",
      body: { accessor: target.accessor },
    });
    const victim = await throwaway();
    await denied({
      method: "POST",
      path: "auth/token/revoke-accessor",
      body: { accessor: victim.accessor },
    });
    const self = await throwaway();
    await denied(
      { method: "POST", path: "auth/token/revoke-self" },
      { control: () => status(self.token, { method: "POST", path: "auth/token/revoke-self" }) },
    );

    // Policies, mounts, auth methods, roles, namespaces, capabilities, identity.
    await denied({ method: "GET", path: `sys/policies/acl/${role}` });
    await denied({ method: "GET", path: "sys/policies/acl?list=true" });
    await denied({
      method: "PUT",
      path: "sys/policies/acl/native-scratch",
      body: { policy: 'path "kv/data/none" { capabilities = ["read"] }' },
    });
    expect(
      await status(f.stack.bao.rootToken, {
        method: "DELETE",
        path: "sys/policies/acl/native-scratch",
      }),
    ).toBe(204);
    await denied({ method: "GET", path: "sys/mounts" });
    await denied({ method: "GET", path: "sys/auth" });
    await denied({ method: "GET", path: "auth/approle/role/runtime" });
    await denied({ method: "GET", path: "sys/namespaces?list=true" }, { absentOk: true });
    await denied({
      method: "POST",
      path: "sys/capabilities-self",
      body: { paths: [`kv/data/${own}NATIVE_A`] },
    });
    await denied({ method: "GET", path: "identity/entity/id?list=true" }, { absentOk: true });
  });

  it("auth/token/renew-self does not extend the token", async () => {
    const before = await rootJson({ method: "POST", path: "auth/token/lookup", body: { token } });
    const expireBefore = Date.parse((before.data as { expire_time: string }).expire_time);
    const renewed = await status(token, {
      method: "POST",
      path: "auth/token/renew-self",
      body: { increment: "720h" },
    });
    const after = await rootJson({ method: "POST", path: "auth/token/lookup", body: { token } });
    const expireAfter = Date.parse((after.data as { expire_time: string }).expire_time);
    lines.push(
      `| \`POST auth/token/renew-self\` | ${String(renewed)} | expire_time not later afterwards: ${String(expireAfter <= expireBefore)} |`,
    );
    expect(expireAfter).toBeLessThanOrEqual(expireBefore);
  });

  it("another namespace: the token with organization B's namespace and with the root namespace → 403 for a read and for lookup-self", async () => {
    const one = f.env("env1a");
    const own = environmentPrefix(one.projectId, one.environmentId);
    // Organization B has no namespace on this stack: OpenBao answers 404 for
    // it before it reads the token. A namespace that exists (another
    // organization's, as on a host) and the root namespace are what deny.
    const absent = namespaceFor(f.tenants.b.organizationId as OrganizationId);
    const unknown = await status(token, {
      method: "GET",
      path: "auth/token/lookup-self",
      namespace: absent,
    });
    lines.push(
      `| ${label({ method: "GET", path: "auth/token/lookup-self", namespace: absent })} — a namespace that does not exist | ${String(unknown)} | — |`,
    );
    expect([403, 404]).toContain(unknown);
    const foreign = await freshNamespace(f.stack);
    try {
      await mountKvV2(f.stack, foreign.path);
      for (const namespace of [foreign.path, ""]) {
        const read = { method: "GET", path: `kv/data/${own}NATIVE_A`, namespace };
        const seen = await status(token, read);
        lines.push(`| ${label(read)} | ${String(seen)} | — |`);
        expect(seen, label(read)).toBe(403);
        // Finding (Run 5.4): OpenBao 2.7.2 answers lookup-self from another
        // namespace with the token's own record. What matters is that the
        // record is the token's own namespace: the token acts nowhere else.
        const self = await baoFetch(f.stack, "/v1/auth/token/lookup-self", {
          method: "GET",
          token,
          ...(namespace === "" ? {} : { namespace }),
        });
        const body = (await self.json().catch(() => ({}))) as {
          data?: { namespace_path?: string };
        };
        const where = body.data?.namespace_path ?? null;
        lines.push(
          `| ${label({ method: "GET", path: "auth/token/lookup-self", namespace })} | ${String(self.status)} | the record names the token's own namespace: ${String(where === `${f.fx.namespace}/`)} |`,
        );
        if (self.status === 200) expect(where, "lookup-self namespace").toBe(`${f.fx.namespace}/`);
        else expect(self.status).toBe(403);
      }
    } finally {
      await foreign.drop();
    }
  });

  it("the residual, as it is (FR-1.45): version 1 is readable directly in OpenBao; through the product no request returns it", async () => {
    const one = f.env("env1a");
    const own = environmentPrefix(one.projectId, one.environmentId);
    const name = "NATIVE_RESIDUAL";
    const made = await f.create("env1a", name, "synthetic-version-one");
    expect(made.status).toBe(201);
    const updated = await f.update(
      "env1a",
      name,
      "synthetic-version-two",
      made.body.result as { version: number; stateTag: string },
    );
    expect(updated.status).toBe(200);
    const old = await status(token, { method: "GET", path: `kv/data/${own}${name}?version=1` });
    lines.push(
      `| \`GET kv/data/<own>/${name}?version=1\` (FR-1.45 residual) | ${String(old)} | — |`,
    );
    expect(old).toBe(200);
    const selector = await machineCall(f, "resolve", { token, query: "version=1" });
    expect([selector.status, selector.code]).toEqual([400, "forbidden_selector"]);
    const resolved = await machineCall(f, "resolve", { token });
    expect(resolved.status).toBe(200);
    expect(new Map(resolveDigests(resolved)).get(name)).toBe(digestOf("synthetic-version-two"));
  });
});
