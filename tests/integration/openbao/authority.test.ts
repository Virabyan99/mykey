// The authority matrix against real OpenBao (Run 2.1 Task C, PO-3): every cell
// is sent with a real token of its identity, every denial has a control, and
// the observations are written to docs/evidence/session-2/authority-matrix.json
// for scripts/authority-matrix.ts to render. Then the hostile-API-process
// measurements of Doc 06 §1.2 item 5 and §17.4.
//
// Tokens, secret ids and response bodies are never printed.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIMITS } from "@mykey/contracts";
import {
  AUTHORITY_MATRIX,
  ROOT_CONTROLS,
  SELF_OPERATIONS,
  cellColumn,
  cellKey,
  controlOf,
  renderMachinePolicy,
  renderPolicy,
  type AuthorityCell,
  type AuthorityRequest,
  type Column,
  type Identity,
} from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import {
  baoFetch,
  getSharedStack,
  readAuditLog,
  startStack,
  type Stack,
} from "../../harness/stack.ts";

const OBSERVATIONS_FILE = resolve(
  import.meta.dirname,
  "../../../docs/evidence/session-2/authority-matrix.json",
);
const SEED = "SEED";
const CONCURRENCY = 8;
/** Cached tokens are replaced well before the shortest TTL (issuer, 60 s) runs out. */
const TOKEN_MAX_AGE_MS = 20_000;

let stack: Stack;
let a: OrgFixture;
let b: OrgFixture;

/** Objects the requests may create outside the two fixtures' KV: removed in afterAll. */
const created = {
  namespaces: [] as { parent: string; name: string }[],
  authMounts: [] as { namespace: string; name: string }[],
};

interface Observation {
  status: number;
  inline?: number;
}
const observations = new Map<string, Observation>();
const controls = new Map<string, { by: string; status: number }>();
let matrixComplete = false;
let inlineComplete = false;
let openbaoVersion = "";

// ---------------------------------------------------------------------------
// Places and placeholders

interface Place {
  /** "" is the root namespace. */
  namespace: string;
  projectId: string;
  environmentId: string;
}

function placeOf(column: Column): Place {
  const env = (org: OrgFixture, index: number): Place => ({
    namespace: org.namespace,
    projectId: org.projectId,
    environmentId: org.environments[index]!.id,
  });
  switch (column) {
    case "own":
      return env(a, 0);
    case "other_environment":
      return env(a, 1);
    case "other_organization":
    case "other_organization_path":
      return env(b, 0);
    case "root":
      return { ...env(a, 0), namespace: "" };
  }
}

function hex(bytes = 6): string {
  return randomBytes(bytes).toString("hex");
}

async function rootCall(
  place: Place,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return baoFetch(stack, `/v1/${path}`, {
    method,
    ...(place.namespace === "" ? {} : { namespace: place.namespace }),
    ...(body === undefined ? {} : { body }),
  });
}

async function writeVictim(place: Place): Promise<string> {
  const name = `V_${hex().toUpperCase()}`;
  const written = await rootCall(
    place,
    "POST",
    `kv/data/p/${place.projectId}/e/${place.environmentId}/${name}`,
    { options: { cas: 0 }, data: { value: "synthetic-victim", operation_id: "v", format: 1 } },
  );
  if (written.status !== 200) throw new Error(`victim write returned HTTP ${written.status}`);
  return name;
}

async function mintAccessor(place: Place): Promise<string> {
  const machine = `machine-env-${place.environmentId}`;
  const minted =
    place.namespace === ""
      ? await rootCall(place, "POST", "auth/token/create", {
          ttl: "120s",
          policies: ["authority-none"],
          no_default_policy: true,
        })
      : await rootCall(place, "POST", `auth/token/create/${machine}`, {
          ttl: "120s",
          policies: [machine],
          no_default_policy: true,
        });
  if (minted.status !== 200) throw new Error(`accessor mint returned HTTP ${minted.status}`);
  return ((await minted.json()) as { auth: { accessor: string } }).auth.accessor;
}

interface Prepared {
  path: string;
  /** "" is the root namespace. */
  namespace: string;
  method: string;
  body?: unknown;
}

/** Fills the placeholders of a request for a column; sets up victims, accessors and fresh names. */
async function prepare(request: AuthorityRequest, column: Column): Promise<Prepared> {
  const place = placeOf(column);
  let path = request.path;
  let namespace = place.namespace;
  if (path.startsWith("{ns}/")) {
    path = `${place.namespace}/${path.slice("{ns}/".length)}`;
    namespace = "";
  }
  const values = new Map<string, string>([
    ["{pid}", place.projectId],
    ["{eid}", place.environmentId],
    ["{seed}", SEED],
  ]);
  const text = `${path} ${JSON.stringify(request.body ?? null)}`;
  if (text.includes("{victim}")) values.set("{victim}", await writeVictim(place));
  if (text.includes("{accessor}")) values.set("{accessor}", await mintAccessor(place));
  if (text.includes("{fresh}")) {
    const name = `f${hex()}`;
    values.set("{fresh}", name);
    if (path.includes("sys/namespaces/"))
      created.namespaces.push({ parent: place.namespace, name });
    if (path.includes("sys/auth/")) created.authMounts.push({ namespace: place.namespace, name });
  }
  if (text.includes("{machinePolicy}")) {
    values.set(
      "{machinePolicy}",
      renderMachinePolicy(place.projectId as never, place.environmentId as never),
    );
  }
  if (text.includes("{runtimePolicy}")) values.set("{runtimePolicy}", renderPolicy("runtime"));
  const fill = (value: string): string => {
    let out = value;
    for (const [placeholder, replacement] of values) out = out.replaceAll(placeholder, replacement);
    return out;
  };
  const fillBody = (value: unknown): unknown => {
    if (typeof value === "string") return fill(value);
    if (Array.isArray(value)) return value.map(fillBody);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillBody(v)]));
    }
    return value;
  };
  return {
    path: fill(path),
    namespace,
    method: request.method,
    ...(request.body === undefined ? {} : { body: fillBody(request.body) }),
  };
}

/** Sends a prepared request; returns only the status. The body is read and dropped. */
async function send(
  prepared: Prepared,
  auth: { token: string } | { inlineHeaders: Record<string, string> },
): Promise<number> {
  const headers: Record<string, string> = "inlineHeaders" in auth ? { ...auth.inlineHeaders } : {};
  if (prepared.method === "PATCH") headers["content-type"] = "application/merge-patch+json";
  const response = await baoFetch(stack, `/v1/${prepared.path}`, {
    method: prepared.method,
    token: "token" in auth ? auth.token : "",
    ...(prepared.namespace === "" ? {} : { namespace: prepared.namespace }),
    ...(prepared.body === undefined ? {} : { body: prepared.body }),
    headers,
  });
  await response.arrayBuffer();
  return response.status;
}

// ---------------------------------------------------------------------------
// Tokens

async function mintMachineToken(org: OrgFixture, index: number, ttl = "600s"): Promise<string> {
  const machine = org.environments[index]!.machineName;
  const minted = await baoFetch(stack, `/v1/auth/token/create/${machine}`, {
    method: "POST",
    namespace: org.namespace,
    body: { ttl, policies: [machine], no_default_policy: true },
  });
  if (minted.status !== 200) throw new Error(`machine token mint returned HTTP ${minted.status}`);
  return ((await minted.json()) as { auth: { client_token: string } }).auth.client_token;
}

/** A 120 s renewable token with the `default` policy (which grants renew-self), minted by root. */
async function mintRenewableToken(place: Place): Promise<string> {
  const minted = await rootCall(place, "POST", "auth/token/create", {
    ttl: "120s",
    policies: ["default"],
    renewable: true,
  });
  if (minted.status !== 200) throw new Error(`renewable token mint returned HTTP ${minted.status}`);
  return ((await minted.json()) as { auth: { client_token: string } }).auth.client_token;
}

async function newToken(identity: Identity): Promise<string> {
  switch (identity) {
    case "runtime":
    case "issuer":
    case "provisioner":
      return a.login(identity);
    case "machine":
      return mintMachineToken(a, 0);
    case "backup": {
      const minted = await baoFetch(stack, "/v1/auth/token/create", {
        method: "POST",
        body: { ttl: "600s", policies: ["backup"], no_default_policy: true },
      });
      if (minted.status !== 200)
        throw new Error(`backup token mint returned HTTP ${minted.status}`);
      return ((await minted.json()) as { auth: { client_token: string } }).auth.client_token;
    }
  }
}

const tokenCache = new Map<Identity, { at: number; token: Promise<string> }>();

function tokenFor(identity: Identity, fresh: boolean): Promise<string> {
  if (fresh) return newToken(identity);
  const cached = tokenCache.get(identity);
  if (cached !== undefined && Date.now() - cached.at < TOKEN_MAX_AGE_MS) return cached.token;
  const token = newToken(identity);
  tokenCache.set(identity, { at: Date.now(), token });
  return token;
}

/** A cell that would revoke or renew its token gets a token of its own. */
function needsFreshToken(cell: AuthorityCell): boolean {
  return cell.action === "token.revoke_self" || cell.action === "token.renew_self";
}

async function inlineHeadersFor(org: OrgFixture): Promise<Record<string, string>> {
  const roleId = await baoFetch(stack, "/v1/auth/approle/role/runtime/role-id", {
    namespace: org.namespace,
  });
  const secretId = await baoFetch(stack, "/v1/auth/approle/role/runtime/secret-id", {
    method: "POST",
    namespace: org.namespace,
  });
  const parameter = (key: string, value: string): string =>
    Buffer.from(JSON.stringify({ key, value })).toString("base64url");
  return {
    "X-Vault-Inline-Auth-Path": "auth/approle/login",
    "X-Vault-Inline-Auth-Namespace": org.namespace,
    "X-Vault-Inline-Auth-Parameter-role": parameter(
      "role_id",
      ((await roleId.json()) as { data: { role_id: string } }).data.role_id,
    ),
    "X-Vault-Inline-Auth-Parameter-secret": parameter(
      "secret_id",
      ((await secretId.json()) as { data: { secret_id: string } }).data.secret_id,
    ),
  };
}

async function pool<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const item = items[next]!;
        next += 1;
        await work(item);
      }
    }),
  );
}

function expected(cell: AuthorityCell): string {
  if (cell.expect === "allow") return "200/204";
  return String(cell.expectStatus ?? 403);
}

function matches(cell: AuthorityCell, status: number): boolean {
  if (cell.expect === "allow") return status === 200 || status === 204;
  return status === (cell.expectStatus ?? 403);
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  stack = await getSharedStack();
  [a, b] = await Promise.all([createOrgFixture(stack), createOrgFixture(stack)]);
  const admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
  await admin.putPolicy("", "backup", renderPolicy("backup"));
  for (const [org, index] of [
    [a, 0],
    [a, 1],
    [b, 0],
  ] as const) {
    const place: Place = {
      namespace: org.namespace,
      projectId: org.projectId,
      environmentId: org.environments[index]!.id,
    };
    const seeded = await rootCall(
      place,
      "POST",
      `kv/data/p/${place.projectId}/e/${place.environmentId}/${SEED}`,
      { options: { cas: 0 }, data: { value: "synthetic-seed", operation_id: "s", format: 1 } },
    );
    if (seeded.status !== 200) throw new Error(`seed write returned HTTP ${seeded.status}`);
  }
  // One child namespace each, so that listing children has something to list.
  for (const org of [a, b]) {
    const child = await baoFetch(stack, "/v1/sys/namespaces/kids", {
      method: "POST",
      namespace: org.namespace,
    });
    if (child.status !== 200) throw new Error(`child namespace returned HTTP ${child.status}`);
    created.namespaces.push({ parent: org.namespace, name: "kids" });
  }
  const health = await baoFetch(stack, "/v1/sys/seal-status", { token: "" });
  openbaoVersion = ((await health.json()) as { version: string }).version;
});

afterAll(async () => {
  // Only a complete, passing run replaces the committed observations.
  if (matrixComplete && inlineComplete && controls.has("seal root")) {
    const cells: Record<string, number> = {};
    const inline: Record<string, number> = {};
    for (const cell of AUTHORITY_MATRIX) {
      const observed = observations.get(cellKey(cell))!;
      cells[cellKey(cell)] = observed.status;
      if (observed.inline !== undefined) inline[cellKey(cell)] = observed.inline;
    }
    const controlEntries = [...controls.entries()].sort(([x], [y]) => x.localeCompare(y));
    writeFileSync(
      OBSERVATIONS_FILE,
      `${JSON.stringify(
        { openbao: openbaoVersion, cells, inline, controls: Object.fromEntries(controlEntries) },
        null,
        2,
      )}\n`,
    );
  }
  // Everything the root controls (or a wrongly allowed request) created.
  for (const mount of created.authMounts) {
    await baoFetch(stack, `/v1/sys/auth/${mount.name}`, {
      method: "DELETE",
      ...(mount.namespace === "" ? {} : { namespace: mount.namespace }),
    });
  }
  for (const child of created.namespaces) {
    await baoFetch(stack, `/v1/sys/namespaces/${child.name}`, {
      method: "DELETE",
      ...(child.parent === "" ? {} : { namespace: child.parent }),
    });
  }
  for (const [path, method] of [
    ["sys/policies/acl/runtime", "DELETE"],
    ["sys/policies/acl/backup", "DELETE"],
    ["auth/token/roles/other", "DELETE"],
  ] as const) {
    await baoFetch(stack, `/v1/${path}`, { method });
  }
  for (const child of created.namespaces) {
    const deadline = Date.now() + 60_000;
    const where = child.parent === "" ? {} : { namespace: child.parent };
    while ((await baoFetch(stack, `/v1/sys/namespaces/${child.name}`, where)).status !== 404) {
      if (Date.now() > deadline) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  await (a as OrgFixture | undefined)?.drop();
  await (b as OrgFixture | undefined)?.drop();
});

describe("authority matrix with real tokens", () => {
  it("every cell gets exactly its expected answer, and every denial its control", async () => {
    await pool(AUTHORITY_MATRIX, async (cell) => {
      const prepared = await prepare(cell.request, cellColumn(cell));
      const token = await tokenFor(cell.identity, needsFreshToken(cell));
      observations.set(cellKey(cell), { status: await send(prepared, { token }) });
    });

    // Controls: an allowed identity's cell, or the same request by the root token.
    const groups = new Map<string, AuthorityCell>();
    for (const cell of AUTHORITY_MATRIX.filter((c) => c.expect === "deny")) {
      groups.set(`${cell.action} ${cellColumn(cell)}`, cell);
    }
    const privateControls: string[] = [];
    // One at a time: two concurrent writes of the same object (kv/config through
    // the header and through the path) make OpenBao answer 500 "transaction
    // commit failed" to one of them (Run 2.1 note).
    for (const [group, cell] of groups) {
      const control = controlOf(cell);
      if (control.by !== "root") {
        const allowed = observations.get(`${control.by} ${group}`)!;
        controls.set(group, { by: control.by, status: allowed.status });
        continue;
      }
      if (control.control?.privateStack === true) {
        privateControls.push(group);
        continue;
      }
      if (cell.action === "token.revoke_self") {
        // The root token never revokes itself: a missing identity control is a failure.
        controls.set(group, { by: "root (refused)", status: 0 });
        continue;
      }
      const prepared = await prepare(cell.request, cellColumn(cell));
      if (control.control?.mintedToken === true) {
        const token = await mintRenewableToken(placeOf(cellColumn(cell)));
        controls.set(group, {
          by: "renewable default-policy token",
          status: await send(prepared, { token }),
        });
        continue;
      }
      controls.set(group, {
        by: "root",
        status: await send(prepared, { token: stack.bao.rootToken }),
      });
    }

    const wrong: string[] = [];
    for (const cell of AUTHORITY_MATRIX) {
      const observed = observations.get(cellKey(cell))!.status;
      if (!matches(cell, observed)) {
        wrong.push(`${cellKey(cell)}: expected ${expected(cell)}, observed ${observed}`);
      }
    }
    for (const [group, control] of controls) {
      const declared = ROOT_CONTROLS.find(
        (entry) => `${entry.action} ${entry.column}` === group,
      )?.status;
      const ok =
        control.by === "root" && declared !== undefined
          ? control.status === declared
          : control.status === 200 || control.status === 204;
      if (!ok) wrong.push(`control ${group} by ${control.by}: observed ${control.status}`);
    }
    expect(privateControls).toEqual(["seal root"]);
    expect(wrong).toEqual([]);
    matrixComplete = true;
  });

  it("the root token's sys/seal control runs on a stack of its own", async () => {
    const own = await startStack();
    try {
      const sealed = await baoFetch(own, "/v1/sys/seal", {
        method: "PUT",
        token: own.bao.rootToken,
      });
      await sealed.arrayBuffer();
      const status = await baoFetch(own, "/v1/sys/seal-status", { token: "" });
      expect(((await status.json()) as { sealed: boolean }).sealed).toBe(true);
      expect(sealed.status).toBe(204);
      controls.set("seal root", { by: "root (own stack)", status: sealed.status });
    } finally {
      await own.stop();
    }
    // The shared stack is still unsealed.
    const shared = await baoFetch(stack, "/v1/sys/seal-status", { token: "" });
    expect(((await shared.json()) as { sealed: boolean }).sealed).toBe(false);
  }, 300_000);

  it("PO-3: inline AppRole authentication adds no right to the runtime row", async () => {
    const inlineHeaders = await inlineHeadersFor(a);
    const runtimeCells = AUTHORITY_MATRIX.filter((cell) => cell.identity === "runtime");
    await pool(runtimeCells, async (cell) => {
      const prepared = await prepare(cell.request, cellColumn(cell));
      const observed = observations.get(cellKey(cell));
      const status = await send(prepared, { inlineHeaders });
      if (observed !== undefined) observed.inline = status;
    });
    const rows = runtimeCells.map((cell) => ({
      key: cellKey(cell),
      ...observations.get(cellKey(cell))!,
    }));
    const allowed = (status: number | undefined): boolean => status === 200 || status === 204;
    // No cell is allowed inline that the token is denied …
    expect(rows.filter((o) => allowed(o.inline) && !allowed(o.status))).toEqual([]);
    // … and the only difference is that the unstored inline token cannot look itself up.
    expect(
      rows
        .filter((o) => o.inline !== o.status)
        .map((o) => `${o.key}: token ${o.status}, inline ${String(o.inline)}`),
    ).toEqual(
      ["own", "other_organization", "other_organization_path", "root"].map(
        (column) => `runtime token.lookup_self ${column}: token 200, inline 403`,
      ),
    );
    // Control: the inline pass did use its rights (the KV allows hold inline).
    expect(rows.filter((o) => o.key.startsWith("runtime kv.") && allowed(o.inline)).length).toBe(
      16,
    );
    inlineComplete = true;
  });

  it("PO-3: inline authentication stores no token and puts no secret id in the audit file", async () => {
    const admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
    const inlineHeaders = await inlineHeadersFor(a);
    const read = AUTHORITY_MATRIX.find((cell) => cellKey(cell) === "runtime kv.read own")!;
    const before = new Set(await admin.listAccessors(a.namespace));
    for (let i = 0; i < 5; i += 1) {
      expect(await send(await prepare(read.request, "own"), { inlineHeaders })).toBe(200);
    }
    const after = await admin.listAccessors(a.namespace);
    expect(after.filter((accessor) => !before.has(accessor))).toEqual([]);
    // Control: one standard login stores one token.
    await a.login("runtime");
    const afterLogin = await admin.listAccessors(a.namespace);
    expect(afterLogin.filter((accessor) => !before.has(accessor))).toHaveLength(1);

    const header = inlineHeaders["X-Vault-Inline-Auth-Parameter-secret"]!;
    const secret = JSON.parse(Buffer.from(header, "base64url").toString()) as { value: string };
    const raw = (await readAuditLog(stack)).map((entry) => entry.raw).join("\n");
    expect(raw.includes(secret.value)).toBe(false);
    expect(raw.includes(header)).toBe(false);
    // Control: the inline requests themselves are in the file.
    expect(raw.includes(`"path":"${a.namespace}/"`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Doc 06 §1.2 item 5 and §17.4: what a hostile API process holding the runtime
// and the issuer token of organization A can and cannot do. D-17 quotes these
// test names.

async function call(
  token: string,
  method: string,
  path: string,
  opts: { namespace?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await baoFetch(stack, `/v1/${path}`, {
    method,
    token,
    namespace: opts.namespace ?? a.namespace,
    ...(opts.body === undefined ? {} : { body: opts.body }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
}

function seedPath(org: OrgFixture, index: number): string {
  return `kv/data/p/${org.projectId}/e/${org.environments[index]!.id}/${SEED}`;
}

/**
 * A's issuer sending an accessor of B, or of the root namespace, to its own
 * lookup-accessor / revoke-accessor under A's namespace (Doc 06 §17.4).
 * Observed on 2.7.2: the token store refuses with HTTP 500 and the error
 * "cannot lookup token in different namespace" (the root token in A gets the
 * same answer), and the foreign token keeps working.
 */
const EXPECTED_FOREIGN_ACCESSOR_ANSWERS = {
  "lookup-accessor B": "500 different namespace",
  "revoke-accessor B": "500 different namespace",
  "lookup-accessor root": "500 different namespace",
  "revoke-accessor root": "500 different namespace",
};

function dataOf(body: unknown): Record<string, unknown> {
  return (body as { data: Record<string, unknown> }).data;
}

describe("a hostile API process holding the runtime and issuer tokens of A", () => {
  it("hostile: runtime reads and writes every environment of A", async () => {
    const runtime = await a.login("runtime");
    for (const index of [0, 1]) {
      const fresh = `kv/data/p/${a.projectId}/e/${a.environments[index]!.id}/H_${hex().toUpperCase()}`;
      const body = {
        options: { cas: 0 },
        data: { value: "synthetic-h", operation_id: "h", format: 1 },
      };
      expect((await call(runtime, "POST", fresh, { body })).status).toBe(200);
      expect((await call(runtime, "GET", fresh)).status).toBe(200);
      expect((await call(runtime, "GET", seedPath(a, index))).status).toBe(200);
    }
  });

  it("hostile: the issuer mints a 30-day read token for any environment of A", async () => {
    const issuer = await a.login("issuer");
    const target = a.environments[1]!.machineName;
    const maxTtl = LIMITS.machineToken.maxTtlSeconds;
    const minted = await call(issuer, "POST", `auth/token/create/${target}`, {
      body: { ttl: `${maxTtl}s`, policies: [target], no_default_policy: true },
    });
    expect(minted.status).toBe(200);
    const { client_token: token, accessor } = (
      minted.body as { auth: { client_token: string; accessor: string } }
    ).auth;
    const lookup = await call(issuer, "POST", "auth/token/lookup-accessor", { body: { accessor } });
    expect(lookup.status).toBe(200);
    const info = dataOf(lookup.body);
    expect(info.policies).toEqual([target]);
    expect(info.orphan).toBe(true);
    expect(info.renewable).toBe(false);
    expect(info.ttl as number).toBeGreaterThan(maxTtl - 120);
    expect(info.ttl as number).toBeLessThanOrEqual(maxTtl);
    // It reads environment 1 and nothing else.
    expect((await call(token, "GET", seedPath(a, 1))).status).toBe(200);
    expect((await call(token, "GET", seedPath(a, 0))).status).toBe(403);
    expect(
      (await call(issuer, "POST", "auth/token/revoke-accessor", { body: { accessor } })).status,
    ).toBe(204);
    expect((await call(token, "GET", seedPath(a, 1))).status).toBe(403);
  });

  it("hostile: the issuer revokes any accessor of A it knows, the runtime token's included", async () => {
    const runtime = await a.login("runtime");
    const issuer = await a.login("issuer");
    const self = await call(runtime, "GET", "auth/token/lookup-self");
    const accessor = dataOf(self.body).accessor as string;
    expect((await call(runtime, "GET", seedPath(a, 0))).status).toBe(200);
    expect(
      (await call(issuer, "POST", "auth/token/revoke-accessor", { body: { accessor } })).status,
    ).toBe(204);
    expect((await call(runtime, "GET", seedPath(a, 0))).status).toBe(403);
  });

  it("hostile: the issuer cannot mint a token outside the machine-env role family", async () => {
    const issuer = await a.login("issuer");
    const machine = a.environments[0]!.machineName;
    const request = { ttl: "60s", policies: [machine], no_default_policy: true };
    expect((await call(issuer, "POST", "auth/token/create", { body: request })).status).toBe(403);
    expect((await call(issuer, "POST", "auth/token/create-orphan", { body: request })).status).toBe(
      403,
    );
    // A role outside the family, written by the operator: the issuer cannot use it.
    const other = `other-${hex(4)}`;
    const role = { allowed_policies: ["runtime"], orphan: true, token_no_default_policy: true };
    expect(
      (await call(stack.bao.rootToken, "POST", `auth/token/roles/${other}`, { body: role })).status,
    ).toBe(204);
    const runtimeRequest = { ttl: "60s", policies: ["runtime"], no_default_policy: true };
    expect(
      (await call(issuer, "POST", `auth/token/create/${other}`, { body: runtimeRequest })).status,
    ).toBe(403);
    expect(
      (
        await call(stack.bao.rootToken, "POST", `auth/token/create/${other}`, {
          body: runtimeRequest,
        })
      ).status,
    ).toBe(200);
    // A machine role refuses a policy it does not allow.
    const widened = await call(issuer, "POST", `auth/token/create/${machine}`, {
      body: runtimeRequest,
    });
    expect(widened.status).toBe(400);
    // Control: the same role with its own policy mints.
    expect(
      (await call(issuer, "POST", `auth/token/create/${machine}`, { body: request })).status,
    ).toBe(200);
  });

  it("hostile: neither token changes a policy or role, or reaches organization B", async () => {
    const runtime = await a.login("runtime");
    const issuer = await a.login("issuer");
    const runtimePolicy = { policy: renderPolicy("runtime") };
    const machineB = b.environments[0]!.machineName;
    for (const token of [runtime, issuer]) {
      expect(
        (await call(token, "PUT", "sys/policies/acl/runtime", { body: runtimePolicy })).status,
      ).toBe(403);
      expect(
        (
          await call(token, "PUT", `sys/policies/acl/${a.environments[0]!.machineName}`, {
            body: { policy: 'path "*" { capabilities = ["read"] }' },
          })
        ).status,
      ).toBe(403);
      expect((await call(token, "GET", seedPath(b, 0), { namespace: b.namespace })).status).toBe(
        403,
      );
      expect(
        (
          await call(token, "POST", `auth/token/create/${machineB}`, {
            namespace: b.namespace,
            body: { ttl: "60s", policies: [machineB], no_default_policy: true },
          })
        ).status,
      ).toBe(403);
    }
    // Control: the same B read by B's own runtime token succeeds.
    const runtimeB = await b.login("runtime");
    expect((await call(runtimeB, "GET", seedPath(b, 0), { namespace: b.namespace })).status).toBe(
      200,
    );
  });

  it("hostile: every self operation sent to B or the root namespace acts on the caller's own token", async () => {
    expect(SELF_OPERATIONS).toHaveLength(15);
    const environment = a.environments[0]!.machineName;
    // A request each identity is allowed to make in A: it shows whether its token still lives.
    const probe: Partial<Record<Identity, string>> = {
      runtime: seedPath(a, 0),
      issuer: `auth/token/roles/${environment}`,
      provisioner: `sys/policies/acl/${environment}`,
    };
    for (const key of SELF_OPERATIONS) {
      const cell = AUTHORITY_MATRIX.find((c) => cellKey(c) === key)!;
      const column = cellColumn(cell);
      const token = await newToken(cell.identity);
      // The caller's own token, as the root token sees it in A.
      const own = dataOf(
        (await call(stack.bao.rootToken, "POST", "auth/token/lookup", { body: { token } })).body,
      );
      expect(own.namespace_path, key).toBe(`${a.namespace}/`);
      const prepared = await prepare(cell.request, column);
      const sendSelf = (): Promise<Response> =>
        baoFetch(stack, `/v1/${prepared.path}`, {
          method: prepared.method,
          token,
          ...(prepared.namespace === "" ? {} : { namespace: prepared.namespace }),
        });

      if (cell.action === "token.lookup_self") {
        const response = await sendSelf();
        expect(response.status, key).toBe(200);
        const seen = dataOf(await response.json());
        expect(seen.accessor, key).toBe(own.accessor);
        expect(seen.namespace_path, key).toBe(`${a.namespace}/`);
        expect(seen.policies, key).toEqual(own.policies);
        continue;
      }

      // revoke-self: a token that lives where the request is sent must survive it.
      const witness =
        column === "root"
          ? {
              token: await mintRenewableToken(placeOf("root")),
              namespace: "",
              path: "auth/token/lookup-self",
            }
          : { token: await b.login("runtime"), namespace: b.namespace, path: seedPath(b, 0) };
      const witnessStatus = async (): Promise<number> => {
        const response = await baoFetch(stack, `/v1/${witness.path}`, {
          token: witness.token,
          ...(witness.namespace === "" ? {} : { namespace: witness.namespace }),
        });
        await response.arrayBuffer();
        return response.status;
      };
      const probePath = probe[cell.identity]!;
      expect((await call(token, "GET", probePath)).status, key).toBe(200);
      expect(await witnessStatus(), key).toBe(200);
      const revoked = await sendSelf();
      await revoked.arrayBuffer();
      expect(revoked.status, key).toBe(204);
      expect((await call(token, "GET", probePath)).status, key).toBe(403);
      expect(await witnessStatus(), key).toBe(200);
    }
  });

  it("hostile: the issuer of A cannot look up or revoke an accessor of B or of the root namespace", async () => {
    const issuer = await a.login("issuer");
    const tokenB = await mintMachineToken(b, 0);
    const accessorB = dataOf(
      (
        await call(stack.bao.rootToken, "POST", "auth/token/lookup", {
          namespace: b.namespace,
          body: { token: tokenB },
        })
      ).body,
    ).accessor as string;
    const rootPlace = placeOf("root");
    const tokenRoot = await mintRenewableToken(rootPlace);
    const rootLookup = await baoFetch(stack, "/v1/auth/token/lookup", {
      method: "POST",
      body: { token: tokenRoot },
    });
    const accessorRoot = dataOf(await rootLookup.json()).accessor as string;

    // Sent under A's namespace with A's issuer token, as the issuer's policy allows.
    const answers: Record<string, string> = {};
    for (const [label, accessor] of [
      ["B", accessorB],
      ["root", accessorRoot],
    ] as const) {
      for (const action of ["lookup-accessor", "revoke-accessor"]) {
        const answer = await call(issuer, "POST", `auth/token/${action}`, { body: { accessor } });
        const errors = (answer.body as { errors?: string[] } | null)?.errors ?? [];
        const refusal = errors.some((e) =>
          e.includes("cannot lookup token in different namespace"),
        );
        answers[`${action} ${label}`] = `${answer.status}${refusal ? " different namespace" : ""}`;
      }
    }
    expect(answers).toEqual(EXPECTED_FOREIGN_ACCESSOR_ANSWERS);
    // The refusal is the namespace wall, not the issuer's policy: the root token in A gets it too.
    const rootInA = await call(stack.bao.rootToken, "POST", "auth/token/lookup-accessor", {
      body: { accessor: accessorB },
    });
    expect(rootInA.status).toBe(500);

    // Control: both tokens still work …
    expect((await call(tokenB, "GET", seedPath(b, 0), { namespace: b.namespace })).status).toBe(
      200,
    );
    const rootSelf = await baoFetch(stack, "/v1/auth/token/lookup-self", { token: tokenRoot });
    await rootSelf.arrayBuffer();
    expect(rootSelf.status).toBe(200);
    // … the same issuer request on an accessor of A succeeds …
    const accessorA = dataOf(
      (
        await call(stack.bao.rootToken, "POST", "auth/token/lookup", {
          body: { token: await mintMachineToken(a, 0) },
        })
      ).body,
    ).accessor as string;
    expect(
      (await call(issuer, "POST", "auth/token/lookup-accessor", { body: { accessor: accessorA } }))
        .status,
    ).toBe(200);
    // … and the root token, where each accessor lives, can revoke it.
    expect(
      (
        await call(stack.bao.rootToken, "POST", "auth/token/revoke-accessor", {
          namespace: b.namespace,
          body: { accessor: accessorB },
        })
      ).status,
    ).toBe(204);
    expect((await call(tokenB, "GET", seedPath(b, 0), { namespace: b.namespace })).status).toBe(
      403,
    );
    const rootRevoke = await baoFetch(stack, "/v1/auth/token/revoke-accessor", {
      method: "POST",
      body: { accessor: accessorRoot },
    });
    await rootRevoke.arrayBuffer();
    expect(rootRevoke.status).toBe(204);
  });

  it("hostile: the provisioner writes any policy under machine-env-*, and with the issuer holds every right in A", async () => {
    const provisioner = await a.login("provisioner");
    const issuer = await a.login("issuer");
    const name = `machine-env-${randomUUID()}`;
    const everything =
      'path "*" { capabilities = ["create", "read", "update", "delete", "list", "sudo"] }';
    expect(
      (await call(provisioner, "PUT", `sys/policies/acl/${name}`, { body: { policy: everything } }))
        .status,
    ).toBe(204);
    const role = {
      allowed_policies: [name],
      orphan: true,
      token_no_default_policy: true,
      token_explicit_max_ttl: LIMITS.machineToken.maxTtlSeconds,
    };
    expect(
      (await call(provisioner, "POST", `auth/token/roles/${name}`, { body: role })).status,
    ).toBe(204);
    const minted = await call(issuer, "POST", `auth/token/create/${name}`, {
      body: { ttl: "300s", policies: [name], no_default_policy: true },
    });
    expect(minted.status).toBe(200);
    const token = (minted.body as { auth: { client_token: string } }).auth.client_token;
    // Every right inside A: auth methods, accessor inventory (sudo), any policy text.
    expect((await call(token, "GET", "sys/auth")).status).toBe(200);
    expect((await call(token, "GET", "auth/token/accessors?list=true")).status).toBe(200);
    expect(
      (
        await call(token, "PUT", "sys/policies/acl/runtime", {
          body: { policy: renderPolicy("runtime") },
        })
      ).status,
    ).toBe(204);
    expect((await call(token, "GET", "kv/metadata/?list=true")).status).toBe(200);
    // Controls: neither the provisioner nor the issuer has these rights itself.
    expect((await call(provisioner, "GET", "sys/auth")).status).toBe(403);
    expect((await call(issuer, "GET", "sys/auth")).status).toBe(403);
    // The namespace wall holds: nothing in B, nothing in the root namespace.
    expect((await call(token, "GET", "sys/auth", { namespace: b.namespace })).status).toBe(403);
    expect((await call(token, "GET", seedPath(b, 0), { namespace: b.namespace })).status).toBe(403);
    const rootList = await baoFetch(stack, "/v1/sys/namespaces?list=true", { token });
    await rootList.arrayBuffer();
    expect(rootList.status).toBe(403);
  });
});
