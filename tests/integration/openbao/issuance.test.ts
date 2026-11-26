// Machine-token issuance proof (Run 2.2, early PO-2) against the pinned
// OpenBao: a 60 s issuer login, using only the fixed token role
// `machine-env-<eid>`, mints a token with exactly the required shape and
// nothing more. D-18 quotes these test names.
//
// The normal issuance path goes through the typed client (appRoleLogin →
// tokenCreateFromRole → tokenLookupAccessor → tokenRevokeSelf). Every hostile
// or unusual request is sent raw with baoFetch.
//
// Tokens, accessors and secret ids are never printed.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { issuerBaoFromDirectory } from "@mykey/api";
import { LIMITS } from "@mykey/contracts";
import {
  OpenBaoClient,
  appRoleLogin,
  machineTokenRole,
  type Correlation,
  type IssuedToken,
  type OpenBaoTarget,
  type TokenInfo,
} from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { revokeAndVerify } from "@mykey/operations";
import { startTlsRelay } from "../../harness/tls-relay.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authOf,
  baoAnswer,
  dataOf,
  errorsOf,
  pollUntil,
  warningsOf,
  type BaoAnswer as Answer,
} from "../../harness/bao-raw.ts";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import { getSharedStack, type Stack } from "../../harness/stack.ts";

const MAX_TTL = LIMITS.machineToken.maxTtlSeconds;
const SEED = "SEED";
const DENIED = "permission denied";
const NOT_A_SUBSET = "must be subset of the role's allowed policies";

let stack: Stack;
let a: OrgFixture;
let b: OrgFixture;
let admin: OpenBaoAdmin;
let root: string;

/** One raw request, in A's namespace unless told otherwise ("" is the root namespace). */
function call(
  token: string,
  method: string,
  path: string,
  opts: { namespace?: string; body?: unknown } = {},
): Promise<Answer> {
  return baoAnswer(stack, token, method, path, {
    ...opts,
    namespace: opts.namespace ?? a.namespace,
  });
}

function correlation(): Correlation {
  return { operationId: randomUUID(), dispatchId: randomUUID() };
}

function hex(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

function role(org: OrgFixture, index = 0): string {
  return org.environments[index]!.machineName;
}

function prefixOf(org: OrgFixture, index = 0): string {
  return `p/${org.projectId}/e/${org.environments[index]!.id}/`;
}

function seedPath(org: OrgFixture, index = 0): string {
  return `kv/data/${prefixOf(org, index)}${SEED}`;
}

/** The body Run 5.1 sends (the typed client's), as a raw request. */
function normalBody(org: OrgFixture, index = 0): Record<string, unknown> {
  return { ttl: `${MAX_TTL}s`, policies: [role(org, index)], no_default_policy: true };
}

async function writeObject(namespace: string, path: string): Promise<void> {
  const written = await call(root, "POST", `kv/data/${path}`, {
    namespace,
    body: { options: { cas: 0 }, data: { value: "synthetic-seed", operation_id: "s", format: 1 } },
  });
  if (written.status !== 200) throw new Error(`seed write returned HTTP ${written.status}`);
}

/** The accessors of a namespace, as an operator lists them. */
async function accessors(namespace: string): Promise<Set<string>> {
  return new Set(await admin.listAccessors(namespace));
}

function added(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((accessor) => !before.has(accessor));
}

async function rootLookupAccessor(accessor: string, namespace = a.namespace): Promise<Answer> {
  return call(root, "POST", "auth/token/lookup-accessor", { namespace, body: { accessor } });
}

async function rootRevokeAccessor(accessor: string, namespace = a.namespace): Promise<void> {
  const revoked = await call(root, "POST", "auth/token/revoke-accessor", {
    namespace,
    body: { accessor },
  });
  expect(revoked.status).toBe(204);
}

function typed(token: string, org: OrgFixture = a): OpenBaoClient {
  return new OpenBaoClient(stack.bao, { namespace: org.namespace, token });
}

/** The accessor of a live token, as the root token sees it in the token's namespace. */
async function accessorOf(token: string, org: OrgFixture = a): Promise<string> {
  const lookup = await call(root, "POST", "auth/token/lookup", {
    namespace: org.namespace,
    body: { token },
  });
  expect(lookup.status).toBe(200);
  return dataOf(lookup).accessor as string;
}

/** Does the token read the seed of A's first environment? Returns the status. */
async function readsSeed(token: string): Promise<number> {
  return (await call(token, "GET", seedPath(a))).status;
}

/** The issuer's read of its own role: 200 while the issuer token lives, 403 after. */
async function issuerAlive(issuer: string): Promise<number> {
  return (await call(issuer, "GET", `auth/token/roles/${role(a)}`)).status;
}

/**
 * The whole issuance sequence of Run 5.1, typed: a 60 s issuer login, the token
 * from the fixed role, its lookup by accessor, the issuer's revoke-self.
 */
async function issue(
  ttlSeconds: number = MAX_TTL,
): Promise<{ issued: IssuedToken; info: TokenInfo }> {
  const issuer = typed(await a.login("issuer"));
  const created = await issuer.tokenCreateFromRole(role(a), ttlSeconds, correlation());
  if (!created.ok) throw new Error("issuance failed");
  const lookup = await issuer.tokenLookupAccessor(created.data.accessor);
  if (!lookup.ok) throw new Error("lookup by accessor failed");
  expect(await issuer.tokenRevokeSelf()).toEqual({ ok: true, status: 204, data: null });
  return { issued: created.data, info: lookup.data };
}

beforeAll(async () => {
  stack = await getSharedStack();
  root = stack.bao.rootToken;
  admin = new OpenBaoAdmin(stack.bao, root);
  a = await createOrgFixture(stack);
  b = await createOrgFixture(stack);
  await writeObject(a.namespace, `${prefixOf(a, 0)}${SEED}`);
  await writeObject(a.namespace, `${prefixOf(a, 1)}${SEED}`);
  await writeObject(b.namespace, `${prefixOf(b, 0)}${SEED}`);
  // A's own path, written in B as well: the same read with B's namespace header has a control.
  await writeObject(b.namespace, `${prefixOf(a, 0)}${SEED}`);
});

afterAll(async () => {
  // Unset when beforeAll failed; that failure is the one to report.
  await (a as OrgFixture | undefined)?.drop();
  await (b as OrgFixture | undefined)?.drop();
});

describe("machine-token issuance by the issuer through a fixed token role", () => {
  it("issued token has the required shape", async () => {
    const { issued, info } = await issue();
    expect(issued.ttlSeconds).toBe(MAX_TTL);
    const self = await typed(issued.token).tokenLookupSelf();
    expect(self.ok).toBe(true);
    if (!self.ok) return;
    for (const seen of [info, self.data]) {
      expect(seen).toMatchObject({
        accessor: issued.accessor,
        orphan: true,
        renewable: false,
        type: "service",
        policies: [role(a)],
        namespacePath: `${a.namespace}/`,
        // Observed on 2.7.2: the lookup field is 0 although the role holds
        // token_explicit_max_ttl 2592000. The cap is proven by behaviour in
        // "the issuer cannot widen anything" (a TTL above it is cut to it).
        explicitMaxTtlSeconds: 0,
      });
      expect(seen.ttlSeconds).toBeGreaterThanOrEqual(MAX_TTL - 5);
      expect(seen.ttlSeconds).toBeLessThanOrEqual(MAX_TTL);
    }
    // The lookup by accessor and lookup-self agree on everything but the clock.
    const { ttlSeconds: ttlByAccessor, ...byAccessor } = info;
    const { ttlSeconds: ttlBySelf, ...bySelf } = self.data;
    expect(bySelf).toEqual(byAccessor);
    expect(Math.abs(ttlBySelf - ttlByAccessor)).toBeLessThanOrEqual(5);
    // Where the cap lives on 2.7.2: creation_ttl and expire_time, not explicit_max_ttl.
    const raw = dataOf(await rootLookupAccessor(issued.accessor));
    expect(raw.creation_ttl).toBe(MAX_TTL);
    expect(raw.role).toBe(role(a));
    expect(raw.num_uses).toBe(0);
    const lifetime = Date.parse(raw.expire_time as string) - Date.parse(raw.issue_time as string);
    expect(Math.round(lifetime / 1000)).toBe(MAX_TTL);
    expect(await readsSeed(issued.token)).toBe(200);
    await rootRevokeAccessor(issued.accessor);
  });

  it("the issuer cannot widen anything", async () => {
    const issuer = await a.login("issuer");
    const create = (body: Record<string, unknown>): Promise<Answer> =>
      call(issuer, "POST", `auth/token/create/${role(a)}`, { body });
    const lookup = async (accessor: string): Promise<Record<string, unknown>> => {
      const answer = await call(issuer, "POST", "auth/token/lookup-accessor", {
        body: { accessor },
      });
      expect(answer.status).toBe(200);
      return dataOf(answer);
    };
    const revoke = async (accessor: string): Promise<void> => {
      const answer = await call(issuer, "POST", "auth/token/revoke-accessor", {
        body: { accessor },
      });
      expect(answer.status).toBe(204);
    };
    const base = normalBody(a);

    // Refused: exact status and error text, no token made, and the control —
    // the same request without the override — mints.
    const refused: [string, Record<string, unknown>, string][] = [
      ["policies runtime", { policies: ["runtime"] }, NOT_A_SUBSET],
      ["policies default", { policies: ["default"] }, NOT_A_SUBSET],
      ["policies machine + default", { policies: [role(a), "default"] }, NOT_A_SUBSET],
      ["period 1h", { period: "1h" }, "root or sudo privileges required to create periodic token"],
      ["id chosen", { id: "chosen" }, "root or sudo privileges required to specify token id"],
    ];
    for (const [name, override, error] of refused) {
      const before = await accessors(a.namespace);
      const answer = await create({ ...base, ...override });
      expect(answer.status, name).toBe(400);
      expect(errorsOf(answer), name).toContain(error);
      expect(answer.body.auth ?? null, name).toBeNull();
      expect(added(before, await accessors(a.namespace)), name).toEqual([]);
      const control = await create(base);
      expect(control.status, `${name} control`).toBe(200);
      await revoke(authOf(control).accessor);
    }

    // Accepted, without effect: the token is looked up to prove it. The token
    // mount's own maximum is 768 h (2,764,800 s), above the role's 720 h, so a
    // TTL of 2,592,000 after a larger request is the role's cap and nothing else.
    const capped = (data: Record<string, unknown>): void => {
      expect(data.creation_ttl).toBe(MAX_TTL);
      expect(data.ttl as number).toBeLessThanOrEqual(MAX_TTL);
      expect(data.ttl as number).toBeGreaterThanOrEqual(MAX_TTL - 5);
    };
    const TTL_CAPPED = 'exceeded the effective max_ttl of "720h"; TTL value is capped accordingly';
    const LESSER = "using the lesser value of 2592000 seconds";
    const accepted: {
      name: string;
      override: Record<string, unknown>;
      warnings: string[];
      check: (data: Record<string, unknown>) => void;
    }[] = [
      {
        name: "ttl 2592001s",
        override: { ttl: `${MAX_TTL + 1}s` },
        warnings: [TTL_CAPPED],
        check: capped,
      },
      {
        name: "explicit_max_ttl 9000h",
        override: { explicit_max_ttl: "9000h" },
        warnings: [LESSER],
        check: (data) => {
          capped(data);
          // Observed: the lookup field echoes the request (9000 h), not the cap.
          expect(data.explicit_max_ttl).toBe(9000 * 3600);
        },
      },
      {
        name: "ttl and explicit_max_ttl 9000h",
        override: { ttl: "9000h", explicit_max_ttl: "9000h" },
        warnings: [LESSER, TTL_CAPPED],
        check: (data) => {
          capped(data);
          expect(data.explicit_max_ttl).toBe(9000 * 3600);
        },
      },
      {
        name: "renewable true",
        override: { renewable: true },
        warnings: [],
        check: (data) => {
          expect(data.renewable).toBe(false);
        },
      },
      {
        name: "no_parent false",
        override: { no_parent: false },
        warnings: [],
        check: (data) => {
          expect(data.orphan).toBe(true);
        },
      },
      {
        name: "no_default_policy false",
        override: { no_default_policy: false },
        warnings: [],
        check: (data) => {
          expect(data.policies).toEqual([role(a)]);
        },
      },
      {
        name: "type batch",
        override: { type: "batch" },
        warnings: [],
        check: (data) => {
          expect(data.type).toBe("service");
        },
      },
    ];
    for (const { name, override, warnings, check } of accepted) {
      const answer = await create({ ...base, ...override });
      expect(answer.status, name).toBe(200);
      for (const warning of warnings) expect(warningsOf(answer), name).toContain(warning);
      if (warnings.length === 0) expect(warningsOf(answer), name).toBe("");
      expect(authOf(answer).lease_duration, name).toBeLessThanOrEqual(MAX_TTL);
      const data = await lookup(authOf(answer).accessor);
      check(data);
      // Every other property stays as the role sets it.
      expect(data, name).toMatchObject({
        orphan: true,
        renewable: false,
        type: "service",
        policies: [role(a)],
        namespace_path: `${a.namespace}/`,
      });
      await revoke(authOf(answer).accessor);
    }

    // `renewable: true` by behaviour: even the root token cannot renew the token.
    {
      const answer = await create({ ...base, ttl: "600s", renewable: true });
      expect(answer.status).toBe(200);
      const { accessor } = authOf(answer);
      const renewed = await call(root, "POST", "auth/token/renew-accessor", {
        body: { accessor, increment: "1h" },
      });
      // Observed: a bare "invalid request"; the control below is the discriminator.
      expect(renewed.status).toBe(400);
      expect(errorsOf(renewed)).toContain("invalid request");
      expect((await lookup(accessor)).ttl as number).toBeLessThanOrEqual(600);
      // Control: the same request for a renewable 120 s token succeeds and extends it.
      const renewable = await call(root, "POST", "auth/token/create", {
        body: { ttl: "120s", policies: ["default"], renewable: true },
      });
      const control = await call(root, "POST", "auth/token/renew-accessor", {
        body: { accessor: authOf(renewable).accessor, increment: "1h" },
      });
      expect(control.status).toBe(200);
      expect(authOf(control).lease_duration).toBeGreaterThan(120);
      await revoke(accessor);
      await rootRevokeAccessor(authOf(renewable).accessor);
    }

    // The machine role of organization B, with A's issuer: in B, and through
    // the root namespace with B's path prefix.
    const roleB = role(b);
    const bodyB = normalBody(b);
    const inB = await call(issuer, "POST", `auth/token/create/${roleB}`, {
      namespace: b.namespace,
      body: bodyB,
    });
    expect(inB.status).toBe(403);
    expect(errorsOf(inB)).toContain(DENIED);
    const viaRoot = await call(issuer, "POST", `${b.namespace}/auth/token/create/${roleB}`, {
      namespace: "",
      body: bodyB,
    });
    expect(viaRoot.status).toBe(403);
    expect(errorsOf(viaRoot)).toContain(DENIED);
    // Control: B's own issuer, same request.
    const issuerB = await b.login("issuer");
    const control = await call(issuerB, "POST", `auth/token/create/${roleB}`, {
      namespace: b.namespace,
      body: bodyB,
    });
    expect(control.status).toBe(200);
    await rootRevokeAccessor(authOf(control).accessor, b.namespace);
    const controlViaRoot = await call(
      issuerB,
      "POST",
      `${b.namespace}/auth/token/create/${roleB}`,
      {
        namespace: "",
        body: bodyB,
      },
    );
    expect(controlViaRoot.status).toBe(200);
    await rootRevokeAccessor(authOf(controlViaRoot).accessor, b.namespace);
  });

  it("what the issuer may still choose (D-18)", async () => {
    // Parameters that narrow a token or label it. None of them widens it.
    const issuer = await a.login("issuer");
    const base = normalBody(a);
    const chosen: [string, Record<string, unknown>, (data: Record<string, unknown>) => void][] = [
      [
        "shorter ttl",
        { ttl: "600s" },
        (data) => {
          expect(data.creation_ttl).toBe(600);
        },
      ],
      [
        "num_uses 3",
        { num_uses: 3 },
        (data) => {
          expect(data.num_uses).toBe(3);
        },
      ],
      [
        "meta",
        { meta: { purpose: "synthetic" } },
        (data) => {
          expect(data.meta).toEqual({ purpose: "synthetic" });
        },
      ],
      [
        "display_name",
        { display_name: "synthetic" },
        (data) => {
          expect(data.display_name).toBe("token-synthetic");
        },
      ],
      [
        "policies omitted",
        { policies: undefined },
        (data) => {
          expect(data.policies).toEqual([role(a)]);
        },
      ],
    ];
    for (const [name, override, check] of chosen) {
      const answer = await call(issuer, "POST", `auth/token/create/${role(a)}`, {
        body: { ...base, ...override },
      });
      expect(answer.status, name).toBe(200);
      const data = dataOf(await rootLookupAccessor(authOf(answer).accessor));
      check(data);
      expect(data, name).toMatchObject({ orphan: true, renewable: false, type: "service" });
      await rootRevokeAccessor(authOf(answer).accessor);
    }
    const alias = await call(issuer, "POST", `auth/token/create/${role(a)}`, {
      body: { ...base, entity_alias: "synthetic" },
    });
    expect(alias.status).toBe(400);
    expect(errorsOf(alias)).toContain("invalid 'entity_alias' value");
    // A role name of the family that does not exist: the policy lets the request
    // through and the token store answers 400 (not a denial).
    const absent = `machine-env-${randomUUID()}`;
    const unknown = await call(issuer, "POST", `auth/token/create/${absent}`, {
      body: { ...base, policies: [absent] },
    });
    expect(unknown.status).toBe(400);
    expect(errorsOf(unknown)).toContain(`unknown role ${absent}`);
  });

  it("the issuer has no other way to make a token", async () => {
    const issuer = await a.login("issuer");
    const body = { ttl: "60s", policies: [role(a)], no_default_policy: true };
    // `unknown-role` is outside the machine-env family. It does not exist yet:
    // the root token's answer tells a missing role (400) from the issuer's denial (403).
    const before = await call(root, "POST", "auth/token/create/unknown-role", { body });
    expect(before.status).toBe(400);
    expect(errorsOf(before)).toContain("unknown role unknown-role");
    const written = await call(root, "POST", "auth/token/roles/unknown-role", {
      body: { allowed_policies: [role(a)], orphan: true, token_no_default_policy: true },
    });
    expect(written.status).toBe(204);
    try {
      for (const path of [
        "auth/token/create",
        "auth/token/create-orphan",
        "auth/token/create/unknown-role",
      ]) {
        const denied = await call(issuer, "POST", path, { body });
        expect(denied.status, path).toBe(403);
        expect(errorsOf(denied), path).toContain(DENIED);
        // Control: the root token, same request, mints.
        const control = await call(root, "POST", path, { body });
        expect(control.status, `${path} control`).toBe(200);
        await rootRevokeAccessor(authOf(control).accessor);
      }
    } finally {
      const removed = await call(root, "DELETE", "auth/token/roles/unknown-role");
      expect(removed.status).toBe(204);
    }
  });

  it("the token outlives its issuer", async () => {
    // 1. A 3-second issuer login (test-only AppRole role, not a product template) expires.
    const shortRole = `issuer-3s-${hex()}`;
    const written = await call(root, "POST", `auth/approle/role/${shortRole}`, {
      body: {
        token_policies: ["issuer"],
        token_no_default_policy: true,
        token_type: "service",
        token_ttl: 3,
        token_max_ttl: 3,
        secret_id_num_uses: 0,
      },
    });
    expect(written.status).toBe(204);
    try {
      const roleId = dataOf(await call(root, "GET", `auth/approle/role/${shortRole}/role-id`))
        .role_id as string;
      const secretId = dataOf(await call(root, "POST", `auth/approle/role/${shortRole}/secret-id`))
        .secret_id as string;
      const login = await appRoleLogin(stack.bao, a.namespace, roleId, secretId);
      if (!login.ok) throw new Error("short issuer login failed");
      expect(login.data.ttlSeconds).toBe(3);
      const shortIssuer = login.data.token;
      const created = await typed(shortIssuer).tokenCreateFromRole(role(a), 600, correlation());
      if (!created.ok) throw new Error("issuance by the short issuer failed");
      expect(await issuerAlive(shortIssuer)).toBe(200);
      expect(await pollUntil(async () => (await issuerAlive(shortIssuer)) === 403, 20_000)).toBe(
        true,
      );
      // The machine token reads at once, while the issuer is already refused.
      expect(await readsSeed(created.data.token)).toBe(200);
      // Observed under load: the expired issuer is refused at once, but its
      // accessor can still be looked up (200) for a moment, until the
      // expiration manager removes it; then 400 "invalid accessor".
      let gone = await rootLookupAccessor(login.data.accessor);
      expect(
        await pollUntil(async () => {
          gone = await rootLookupAccessor(login.data.accessor);
          return gone.status !== 200;
        }, 30_000),
      ).toBe(true);
      expect(gone.status).toBe(400);
      expect(errorsOf(gone)).toContain("invalid accessor");
      // And after the issuer is gone from the token store as well.
      expect(await readsSeed(created.data.token)).toBe(200);
      await rootRevokeAccessor(created.data.accessor);
    } finally {
      const removed = await call(root, "DELETE", `auth/approle/role/${shortRole}`);
      expect(removed.status).toBe(204);
    }

    // 2. The issuer revokes itself.
    {
      const issuer = await a.login("issuer");
      const created = await typed(issuer).tokenCreateFromRole(role(a), 600, correlation());
      if (!created.ok) throw new Error("issuance failed");
      expect(await typed(issuer).tokenRevokeSelf()).toEqual({ ok: true, status: 204, data: null });
      expect(await issuerAlive(issuer)).toBe(403);
      expect(await readsSeed(created.data.token)).toBe(200);
      await rootRevokeAccessor(created.data.accessor);
    }

    // 3. The root token revokes the issuer by accessor.
    {
      const issuer = await a.login("issuer");
      const created = await typed(issuer).tokenCreateFromRole(role(a), 600, correlation());
      if (!created.ok) throw new Error("issuance failed");
      expect(await issuerAlive(issuer)).toBe(200);
      await rootRevokeAccessor(await accessorOf(issuer));
      expect(await issuerAlive(issuer)).toBe(403);
      expect(await readsSeed(created.data.token)).toBe(200);
      await rootRevokeAccessor(created.data.accessor);
    }
  });

  it("revoking the accessor kills it", async () => {
    const { issued } = await issue(600);
    expect(await readsSeed(issued.token)).toBe(200);
    const issuer = typed(await a.login("issuer"));
    // Control for the lookup below: the live accessor is found.
    expect(await issuer.tokenLookupAccessor(issued.accessor)).toMatchObject({ ok: true });
    expect(await issuer.tokenRevokeAccessor(issued.accessor, correlation())).toEqual({
      ok: true,
      status: 204,
      data: null,
    });
    const read = await call(issued.token, "GET", seedPath(a));
    expect(read.status).toBe(403);
    expect(errorsOf(read)).toContain(DENIED);
    expect(await issuer.tokenLookupAccessor(issued.accessor)).toEqual({
      ok: false,
      kind: "invalid",
      status: 400,
    });
    const raw = await call(await a.login("issuer"), "POST", "auth/token/lookup-accessor", {
      body: { accessor: issued.accessor },
    });
    expect(raw.status).toBe(400);
    expect(errorsOf(raw)).toContain("invalid accessor");
    // Observed: revoking an accessor that no longer exists answers 200, not an error.
    const again = await call(root, "POST", "auth/token/revoke-accessor", {
      body: { accessor: issued.accessor },
    });
    expect(again.status).toBe(200);
  });

  it("a short token expires by itself", async () => {
    const started = Date.now();
    const { issued } = await issue(2);
    expect(issued.ttlSeconds).toBe(2);
    expect(await readsSeed(issued.token)).toBe(200);
    let refusedAt = 0;
    const expired = await pollUntil(async () => {
      if ((await readsSeed(issued.token)) === 200) return false;
      refusedAt = Date.now();
      return true;
    }, 15_000);
    expect(expired).toBe(true);
    // It did not die early: the 2 s started after `started`.
    expect(refusedAt - started).toBeGreaterThanOrEqual(1_500);
    await sleep(Math.max(0, started + 3_000 - Date.now()));
    const read = await call(issued.token, "GET", seedPath(a));
    expect(read.status).toBe(403);
    expect(errorsOf(read)).toContain(DENIED);
  });

  it("the machine token can only read its environment", async () => {
    const { issued } = await issue(600);
    const machine = issued.token;
    const runtime = await a.login("runtime");
    const envelope = { value: "synthetic-w", operation_id: "w", format: 1 };
    const victim = `${prefixOf(a)}V_${hex().toUpperCase()}`;
    await writeObject(a.namespace, victim);

    // Allowed.
    expect(await readsSeed(machine)).toBe(200);
    const listed = await call(machine, "GET", `kv/metadata/${prefixOf(a)}?list=true`);
    expect(listed.status).toBe(200);
    expect(dataOf(listed).keys).toContain(SEED);
    const self = await call(machine, "GET", "auth/token/lookup-self");
    expect(self.status).toBe(200);
    expect(dataOf(self).accessor).toBe(issued.accessor);

    // Denied, each with its control (same request, an identity that may).
    const renewable = authOf(
      await call(root, "POST", "auth/token/create", {
        body: { ttl: "120s", policies: ["default"], renewable: true },
      }),
    ).client_token;
    const fresh = `kv/data/${prefixOf(a)}W_${hex().toUpperCase()}`;
    const cases: {
      name: string;
      method: string;
      path: string;
      body?: unknown;
      namespace?: string;
      control: string;
      expect: number;
    }[] = [
      {
        name: "write",
        method: "POST",
        path: fresh,
        body: { options: { cas: 0 }, data: envelope },
        control: runtime,
        expect: 200,
      },
      {
        name: "soft delete",
        method: "POST",
        path: `kv/delete/${victim}`,
        body: { versions: [1] },
        control: runtime,
        expect: 204,
      },
      {
        name: "undelete",
        method: "POST",
        path: `kv/undelete/${victim}`,
        body: { versions: [1] },
        control: runtime,
        expect: 204,
      },
      {
        name: "destroy",
        method: "POST",
        path: `kv/destroy/${victim}`,
        body: { versions: [1] },
        control: root,
        expect: 204,
      },
      {
        name: "metadata delete",
        method: "DELETE",
        path: `kv/metadata/${victim}`,
        control: root,
        expect: 204,
      },
      {
        name: "renew-self",
        method: "POST",
        path: "auth/token/renew-self",
        body: {},
        control: renewable,
        expect: 200,
      },
      {
        name: "token create",
        method: "POST",
        path: "auth/token/create",
        body: { ttl: "60s", policies: [role(a)], no_default_policy: true },
        control: root,
        expect: 200,
      },
      {
        name: "read another environment",
        method: "GET",
        path: seedPath(a, 1),
        control: runtime,
        expect: 200,
      },
      {
        name: "list the project",
        method: "GET",
        path: `kv/metadata/p/${a.projectId}/e/?list=true`,
        control: runtime,
        expect: 200,
      },
      {
        name: "the same read in B",
        method: "GET",
        path: seedPath(a),
        namespace: b.namespace,
        control: await b.login("runtime"),
        expect: 200,
      },
    ];
    for (const item of cases) {
      const opts = {
        ...(item.body === undefined ? {} : { body: item.body }),
        ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
      };
      const denied = await call(machine, item.method, item.path, opts);
      expect(denied.status, item.name).toBe(403);
      expect(errorsOf(denied), item.name).toContain(DENIED);
      const control = await call(item.control, item.method, item.path, opts);
      expect(control.status, `${item.name} control`).toBe(item.expect);
      if (item.name === "token create") await rootRevokeAccessor(authOf(control).accessor);
    }
    // The token is alive after all of it: the denials were not a dead token.
    expect(await readsSeed(machine)).toBe(200);
    await rootRevokeAccessor(issued.accessor);
  });

  it("an operator can find a token nobody recorded", async () => {
    const issuer = typed(await a.login("issuer"));
    const before = await accessors(a.namespace);
    // Issue and throw the answer away.
    expect((await issuer.tokenCreateFromRole(role(a), 600, correlation())).ok).toBe(true);
    expect(await issuer.tokenRevokeSelf()).toMatchObject({ ok: true, status: 204 });

    const listed = await accessors(a.namespace);
    const found: string[] = [];
    for (const accessor of added(before, listed)) {
      const data = dataOf(await rootLookupAccessor(accessor));
      if (data.orphan === true && JSON.stringify(data.policies) === JSON.stringify([role(a)])) {
        found.push(accessor);
      }
    }
    expect(found).toHaveLength(1);
    const lost = found[0]!;

    // Enumeration is per namespace: neither B nor the root namespace lists it.
    // Control: B's list does show a token minted in B.
    const tokenB = await call(root, "POST", `auth/token/create/${role(b)}`, {
      namespace: b.namespace,
      body: normalBody(b),
    });
    expect(tokenB.status).toBe(200);
    const accessorB = authOf(tokenB).accessor;
    const listB = await accessors(b.namespace);
    expect(listB.has(accessorB)).toBe(true);
    expect(listB.has(lost)).toBe(false);
    const listRoot = await accessors("");
    expect(listRoot.size).toBeGreaterThan(0);
    expect(listRoot.has(lost)).toBe(false);
    expect(listRoot.has(accessorB)).toBe(false);
    expect((await accessors(a.namespace)).has(accessorB)).toBe(false);
    await rootRevokeAccessor(accessorB, b.namespace);

    await rootRevokeAccessor(lost);
    expect((await accessors(a.namespace)).has(lost)).toBe(false);
  });
});

// Run 5.1 Task A: what the product's issuance reads about a token, and the
// issuer session of P-85 (login → the step's calls → revoke-self).
describe("token metadata, lifetime and issuer sessions (Run 5.1)", () => {
  const directories: string[] = [];

  /** A directory as the host delivers it to the API, with A's issuer credential. */
  async function issuerDirectory(
    opts: { secretId?: string; files?: boolean } = {},
  ): Promise<string> {
    const directory = mkdtempSync(join(tmpdir(), "mykey-issuer-"));
    directories.push(directory);
    if (opts.files === false) return directory;
    const credential = await a.credential("issuer");
    writeFileSync(join(directory, "organization-id"), a.organizationId);
    writeFileSync(join(directory, "issuer-role-id"), credential.roleId);
    writeFileSync(join(directory, "issuer-secret-id"), opts.secretId ?? credential.secretId);
    return directory;
  }

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  it("meta given at creation comes back from lookup-accessor and lookup-self", async () => {
    const meta = { credential_id: randomUUID(), operation_id: randomUUID() };
    const issuer = typed(await a.login("issuer"));
    const created = await issuer.tokenCreateFromRole(role(a), 600, correlation(), meta);
    if (!created.ok) throw new Error("issuance failed");
    const byAccessor = await issuer.tokenLookupAccessor(created.data.accessor);
    const bySelf = await typed(created.data.token).tokenLookupSelf();
    expect(byAccessor.ok && bySelf.ok).toBe(true);
    if (!byAccessor.ok || !bySelf.ok) return;
    for (const seen of [byAccessor.data, bySelf.data]) {
      expect(seen.meta).toEqual(meta);
      expect(seen).toMatchObject({
        orphan: true,
        renewable: false,
        type: "service",
        policies: [role(a)],
      });
    }
    // Control: a token made without meta reads back none.
    const plain = await issuer.tokenCreateFromRole(role(a), 600, correlation());
    if (!plain.ok) throw new Error("issuance failed");
    const plainInfo = await issuer.tokenLookupAccessor(plain.data.accessor);
    expect(plainInfo.ok && plainInfo.data.meta).toBeNull();
    await issuer.tokenRevokeSelf();
    await rootRevokeAccessor(created.data.accessor);
    await rootRevokeAccessor(plain.data.accessor);
  });

  it("TokenInfo carries creation ttl, uses, expiry and issue time", async () => {
    const { issued, info } = await issue(120);
    expect(info.creationTtlSeconds).toBe(120);
    expect(info.numUses).toBe(0);
    expect(info.issueTime).not.toBeNull();
    expect(info.expireTime).not.toBeNull();
    const lifetime = (Date.parse(info.expireTime!) - Date.parse(info.issueTime!)) / 1000;
    expect(lifetime).toBeGreaterThanOrEqual(118);
    expect(lifetime).toBeLessThanOrEqual(122);
    await rootRevokeAccessor(issued.accessor);
  });

  it("a role whose maximum is shorter gives a shorter token", async () => {
    const roleName = role(a);
    const changed = await call(root, "POST", `auth/token/roles/${roleName}`, {
      body: { ...machineTokenRole(a.environments[0]!.id), token_explicit_max_ttl: 60 },
    });
    expect(changed.status).toBe(204);
    try {
      const { issued, info } = await issue(120);
      expect(info.creationTtlSeconds).toBe(60);
      await rootRevokeAccessor(issued.accessor);
    } finally {
      await admin.putTokenRole(a.namespace, roleName, machineTokenRole(a.environments[0]!.id));
    }
    // Control: restored, the same request gives 120.
    const { issued, info } = await issue(120);
    expect(info.creationTtlSeconds).toBe(120);
    await rootRevokeAccessor(issued.accessor);
  });

  it("issuerBaoFromDirectory: a session, closed; no files; a wrong secret id", async () => {
    const issuer = issuerBaoFromDirectory(stack.bao, await issuerDirectory());
    const opened = await issuer.open(a.organizationId);
    expect(opened?.ok).toBe(true);
    if (opened?.ok !== true) return;
    const session = opened.data;
    const { issued } = await issue(600);
    expect((await session.client.tokenLookupAccessor(issued.accessor)).ok).toBe(true);
    await session.close();
    expect(await session.client.tokenLookupAccessor(issued.accessor)).toEqual({
      ok: false,
      kind: "denied",
      status: 403,
    });
    // close() never throws, also a second time.
    await session.close();
    await rootRevokeAccessor(issued.accessor);
    // Another organization than the directory's: this process holds no issuer for it.
    expect(await issuer.open(b.organizationId)).toBeNull();

    const empty = issuerBaoFromDirectory(stack.bao, await issuerDirectory({ files: false }));
    expect(await empty.open(a.organizationId)).toBeNull();

    const wrong = issuerBaoFromDirectory(
      stack.bao,
      await issuerDirectory({ secretId: randomUUID() }),
    );
    const refused = await wrong.open(a.organizationId);
    expect(refused).not.toBeNull();
    expect(refused?.ok).toBe(false);
  });

  describe("revokeAndVerify", () => {
    async function session(target: OpenBaoTarget = stack.bao) {
      const opened = await issuerBaoFromDirectory(target, await issuerDirectory()).open(
        a.organizationId,
      );
      if (opened?.ok !== true) throw new Error("issuer session failed");
      return opened.data;
    }

    it("an accessor already revoked is absent; one OpenBao cannot place is unproven", async () => {
      const { issued } = await issue(600);
      await rootRevokeAccessor(issued.accessor);
      const s = await session();
      try {
        // A revocation sent again (P-89): the accessor no longer exists.
        expect(await revokeAndVerify(s, issued.accessor, correlation())).toBe("absent");
        // Observed: a string that was never an accessor of this namespace does not
        // answer 400, so nothing proves its absence.
        expect(await revokeAndVerify(s, randomBytes(12).toString("base64url"), correlation())).toBe(
          "unproven",
        );
      } finally {
        await s.close();
      }
    });

    it("a live token is absent afterwards and denied", async () => {
      const { issued } = await issue(600);
      expect(await readsSeed(issued.token)).toBe(200);
      const s = await session();
      try {
        expect(await revokeAndVerify(s, issued.accessor, correlation())).toBe("absent");
      } finally {
        await s.close();
      }
      expect(await readsSeed(issued.token)).toBe(403);
    });

    it("OpenBao unreachable before the call: not_sent", async () => {
      const { issued } = await issue(600);
      const s = await session();
      // The session's token, on a client whose connection is never made.
      const closed = {
        client: new OpenBaoClient(
          {
            url: `https://127.0.0.1:${String(await freePort())}`,
            caCertPath: stack.bao.caCertPath,
          },
          { namespace: a.namespace, token: "unused-token" },
        ),
        close: () => s.close(),
      };
      try {
        expect(await revokeAndVerify(closed, issued.accessor, correlation())).toBe("not_sent");
      } finally {
        await s.close();
      }
      // Control: nothing was revoked.
      expect(await readsSeed(issued.token)).toBe(200);
      await rootRevokeAccessor(issued.accessor);
    });

    it("answers that never come back: unproven", async () => {
      const { issued } = await issue(600);
      const baoUrl = new URL(stack.bao.url);
      const relay = await startTlsRelay({ host: baoUrl.hostname, port: Number(baoUrl.port) });
      try {
        const s = await session({
          url: `https://127.0.0.1:${String(relay.port)}`,
          caCertPath: stack.bao.caCertPath,
        });
        relay.setMode("drop");
        try {
          expect(await revokeAndVerify(s, issued.accessor, correlation())).toBe("unproven");
        } finally {
          relay.setMode("pass");
          await s.close();
        }
      } finally {
        await relay.close();
      }
      // The revoke itself reached OpenBao: the token is dead although nothing said so.
      expect(await readsSeed(issued.token)).toBe(403);
      const lookup = await rootLookupAccessor(issued.accessor);
      expect(lookup.status).toBe(400);
    });
  });
});

// Run 11.3 Task B Step 1 (P-187, P-188; D-81 quotes these names): what the
// exchange of a runtime credential rests on, measured on the pinned OpenBao
// before any code uses it. The exchange mints with the same issuer identity
// and the same fixed role as a 30-day token, at 900 s, with a meta that names
// the runtime credential.
describe("the token of an exchange (Run 11.3)", () => {
  const EXCHANGE_TTL = LIMITS.runtimeCredential.exchangeTtlSeconds;

  async function mint(
    ttlSeconds: number,
    meta: Record<string, string>,
  ): Promise<{ issued: IssuedToken; info: TokenInfo }> {
    const issuer = typed(await a.login("issuer"));
    const created = await issuer.tokenCreateFromRole(role(a), ttlSeconds, correlation(), meta);
    if (!created.ok) throw new Error("the exchange's create failed");
    const lookup = await issuer.tokenLookupAccessor(created.data.accessor);
    if (!lookup.ok) throw new Error("lookup by accessor failed");
    await issuer.tokenRevokeSelf();
    return { issued: created.data, info: lookup.data };
  }

  it("the issuer mints a 900 s token from a machine-env role with meta; lookup-self shows ttl ≤ 900, not renewable, orphan, policies exactly [machine-env-<eid>], meta.credential_id", async () => {
    expect(EXCHANGE_TTL).toBe(900);
    const credentialId = randomUUID();
    const meta = { credential_id: credentialId, exchange: "1" };
    const { issued, info } = await mint(EXCHANGE_TTL, meta);
    try {
      const self = await typed(issued.token).tokenLookupSelf();
      expect(self.ok).toBe(true);
      if (!self.ok) return;
      for (const seen of [info, self.data]) {
        expect(seen).toMatchObject({
          accessor: issued.accessor,
          orphan: true,
          renewable: false,
          type: "service",
          policies: [role(a)],
          numUses: 0,
          creationTtlSeconds: EXCHANGE_TTL,
          namespacePath: `${a.namespace}/`,
          meta,
        });
        expect(seen.ttlSeconds).toBeLessThanOrEqual(EXCHANGE_TTL);
        expect(seen.ttlSeconds).toBeGreaterThanOrEqual(EXCHANGE_TTL - 5);
      }
      const lifetime =
        Date.parse(self.data.expireTime ?? "") - Date.parse(self.data.issueTime ?? "");
      expect(Math.round(lifetime / 1000)).toBe(EXCHANGE_TTL);
      // It is a machine token of its environment: it reads there and nowhere else.
      expect(await readsSeed(issued.token)).toBe(200);
      expect((await call(issued.token, "GET", seedPath(a, 1))).status).toBe(403);
    } finally {
      await rootRevokeAccessor(issued.accessor);
    }
  });

  it("renew-self leaves its lifetime unchanged", async () => {
    const { issued } = await mint(EXCHANGE_TTL, { credential_id: randomUUID(), exchange: "1" });
    try {
      const before = dataOf(await rootLookupAccessor(issued.accessor)).expire_time;
      const renewed = await call(issued.token, "POST", "auth/token/renew-self", {
        body: { increment: "24h" },
      });
      // Observed on 2.7.2: the machine policy does not grant renew-self at all.
      expect(renewed.status).toBe(403);
      // Whatever the answer, the token ends when it was going to end.
      const after = dataOf(await rootLookupAccessor(issued.accessor));
      expect(after.expire_time).toBe(before);
      expect(after.renewable).toBe(false);
      // Nor can the issuer, which made it, lengthen it.
      const issuer = await a.login("issuer");
      const byIssuer = await call(issuer, "POST", "auth/token/renew-accessor", {
        body: { accessor: issued.accessor, increment: "24h" },
      });
      expect(byIssuer.status).not.toBe(200);
      expect(dataOf(await rootLookupAccessor(issued.accessor)).expire_time).toBe(before);
    } finally {
      await rootRevokeAccessor(issued.accessor);
    }
  });

  it("a 2 s token reads, and 3 s later it is refused", async () => {
    const meta = { credential_id: randomUUID(), exchange: "1" };
    // The control: a 60 s token minted beside it still reads afterwards.
    const control = await mint(60, meta);
    try {
      const short = await mint(2, meta);
      expect(await readsSeed(short.issued.token)).toBe(200);
      await sleep(3_000);
      expect(await readsSeed(short.issued.token)).toBe(403);
      expect((await rootLookupAccessor(short.issued.accessor)).status).toBe(400);
      expect(await readsSeed(control.issued.token)).toBe(200);
    } finally {
      await rootRevokeAccessor(control.issued.accessor);
    }
  });

  it("the issuer cannot ask for a policy the role does not allow, with or without meta", async () => {
    const issuer = await a.login("issuer");
    const before = await accessors(a.namespace);
    const meta = { credential_id: randomUUID(), exchange: "1" };
    for (const policies of [[role(a), "default"], [role(a, 1)], ["root"], [role(a), role(a, 1)]]) {
      for (const extra of [{}, { meta }]) {
        const answer = await call(issuer, "POST", `auth/token/create/${role(a)}`, {
          body: { ttl: `${String(EXCHANGE_TTL)}s`, policies, no_default_policy: true, ...extra },
        });
        expect(answer.status, JSON.stringify(policies)).toBe(400);
        expect(errorsOf(answer)).toContain(NOT_A_SUBSET);
      }
    }
    // Nothing was made: the namespace holds the issuer's own login token and no more.
    const made = added(before, await accessors(a.namespace));
    expect(made.length).toBeLessThanOrEqual(1);
    await call(issuer, "POST", "auth/token/revoke-self");
  });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}
