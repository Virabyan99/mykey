// Run 5.4 Task A (P-93, FR-1.44, D-42): machine authentication by the
// presented token. One Authorization header `Bearer <token>`; OpenBao's
// lookup-self with that token; the accessor must be an active, unexpired
// credential of this organization; the path must name exactly its project and
// environment (404 otherwise, the same for absent and foreign); the parents
// must be active; no selector. Tokens are locals of the tests and never appear
// in an assertion message.
import { randomUUID } from "node:crypto";
import { appRoleLogin, machineName } from "@mykey/openbao";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { baoAnswer } from "../../harness/bao-raw.ts";
import {
  createCredentialsFixture,
  issueFor,
  rootRevoke,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { machineCall, machinePath, type MachineAnswer } from "../../harness/machine.ts";
import { readAuditLog } from "../../harness/stack.ts";
import type { FixtureUser } from "../../harness/tenants.ts";

let f: CredentialsFixture;
/** A credential of env1a and its token, issued once. */
let a: { credentialId: string; token: string };

beforeAll(async () => {
  f = await createCredentialsFixture();
  const made = await f.create("env1a", "AUTH_SEED", "synthetic-seed");
  expect(made.status).toBe(201);
  a = await issueFor(f, "env1a");
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(() => {
  f.relay.clear();
  f.setBeforeHandler(null);
  f.api.setGate("open");
});

const q = () => f.api.superuser;

/** OpenBao's lookup-self requests in A's namespace so far. */
async function lookupSelfCount(): Promise<number> {
  return (await readAuditLog(f.stack)).filter(
    (entry) =>
      entry.type === "request" &&
      entry.namespacePath.startsWith(f.fx.namespace) &&
      entry.path === "auth/token/lookup-self",
  ).length;
}

/** `access.denied` rows with a machine actor written after `since`. */
async function machineDenials(since: Date): Promise<{ actor_id: string; reason: string }[]> {
  const rows = await q().query<{ actor_id: string; reason: string }>(
    `SELECT actor_id, details->>'reason' AS reason FROM audit.event
      WHERE action = 'access.denied' AND actor_kind = 'machine' AND occurred_at >= $1
      ORDER BY occurred_at`,
    [since],
  );
  return rows.rows;
}

const now = async (): Promise<Date> =>
  (await q().query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;

const shape = (answer: MachineAnswer) => {
  const requestId = answer.headers.get("x-request-id") ?? "";
  return {
    status: answer.status,
    headers: [...answer.headers.keys()].filter((name) => name !== "date").sort(),
    body: answer.text.replace(requestId, "<id>"),
    length: answer.headers.get("content-length"),
  };
};

describe("a valid token", () => {
  it("200 on keys and resolve", async () => {
    const keys = await machineCall(f, "keys", { token: a.token });
    expect(keys.status, keys.code ?? "").toBe(200);
    const resolve = await machineCall(f, "resolve", { token: a.token });
    expect(resolve.status, resolve.code ?? "").toBe(200);
  });
});

describe("malformed credentials", () => {
  it("each answers 401 unauthenticated with no request to OpenBao", async () => {
    const before = await lookupSelfCount();
    const cases: [string, Record<string, string | string[]>][] = [
      ["no header", {}],
      ["scheme Basic", { authorization: "Basic dXNlcjpwYXNz" }],
      ["two Authorization headers", { authorization: [`Bearer ${a.token}`, `Bearer ${a.token}`] }],
      ["an empty token", { authorization: "Bearer " }],
      ["4,097 bytes", { authorization: `Bearer ${"a".repeat(4097)}` }],
      ["a space in the token", { authorization: "Bearer abc def" }],
      ["a control character in the token", { authorization: "Bearer abc\tdef" }],
    ];
    for (const [label, headers] of cases) {
      for (const route of ["keys", "resolve"] as const) {
        const answer = await machineCall(f, route, { headers });
        expect([answer.status, answer.code], `${route}: ${label}`).toEqual([
          401,
          "unauthenticated",
        ]);
      }
    }
    expect(await lookupSelfCount()).toBe(before);
  });

  it("a cookie beside the bearer → 400 mixed_authentication; each alone: the cookie 401, the bearer 200", async () => {
    const cookie = await f.tenants.cookie("ownerA");
    const mixed = await machineCall(f, "keys", { token: a.token, headers: { cookie } });
    expect([mixed.status, mixed.code]).toEqual([400, "mixed_authentication"]);
    const cookieOnly = await machineCall(f, "keys", { headers: { cookie } });
    expect([cookieOnly.status, cookieOnly.code]).toEqual([401, "unauthenticated"]);
    const bearerOnly = await machineCall(f, "keys", { token: a.token });
    expect(bearerOnly.status).toBe(200);
  });
});

describe("tokens that are real but not credentials", () => {
  it("the runtime's login token, the issuer's, and a token with 1a's machine policy made outside the product: 401, and no audit row", async () => {
    const since = await now();
    const tokens: string[] = [];
    for (const identity of ["runtime", "issuer"] as const) {
      const credential = f.fx.credentials[identity];
      const login = await appRoleLogin(
        f.stack.bao,
        f.fx.namespace,
        credential.roleId,
        credential.secretId,
      );
      expect(login.ok, identity).toBe(true);
      if (login.ok) tokens.push(login.data.token);
    }
    const name = machineName(f.env("env1a").environmentId);
    const outside = await baoAnswer(
      f.stack,
      f.stack.bao.rootToken,
      "POST",
      `auth/token/create/${name}`,
      { namespace: f.fx.namespace, body: { ttl: "10m" } },
    );
    expect(outside.status).toBe(200);
    const auth = (outside.body as { auth: { client_token: string; accessor: string } }).auth;
    tokens.push(auth.client_token);
    try {
      for (const [index, token] of tokens.entries()) {
        const answer = await machineCall(f, "resolve", { token });
        expect([answer.status, answer.code], `token ${String(index)}`).toEqual([
          401,
          "unauthenticated",
        ]);
        expect(answer.body.entries).toBeUndefined();
      }
      expect(await machineDenials(since)).toEqual([]);
    } finally {
      await rootRevoke(f, auth.accessor);
    }
  });
});

describe("the path must name the credential's own environment", () => {
  it("the token of 1a on the path of 1b, of project 2, of an absent project and of an absent environment name: four equal 404 answers, each audited", async () => {
    const since = await now();
    const p1 = f.env("env1a").projectId;
    const p2 = f.env("env2a").projectId;
    const paths = [
      machinePath(p1, "prod", "keys"),
      machinePath(p2, "dev", "keys"),
      machinePath(randomUUID(), "dev", "keys"),
      machinePath(p1, "no-such-environment", "keys"),
    ];
    const answers = [];
    for (const path of paths) answers.push(await machineCall(f, "keys", { token: a.token, path }));
    expect(answers.map((answer) => [answer.status, answer.code])).toEqual(
      paths.map(() => [404, "not_found"]),
    );
    const shapes = answers.map(shape);
    for (const other of shapes.slice(1)) expect(other).toEqual(shapes[0]);
    const denials = await machineDenials(since);
    expect(denials).toEqual(paths.map(() => ({ actor_id: a.credentialId, reason: "hidden" })));
  });
});

describe("credential states", () => {
  it("revoked through the product → 401 (OpenBao refuses it: not attributable, no audit row)", async () => {
    const own = await issueFor(f, "env1a");
    const revoked = await f.revoke("env1a", own.credentialId);
    expect(revoked.status).toBe(200);
    const since = await now();
    const answer = await machineCall(f, "keys", { token: own.token });
    expect([answer.status, answer.code]).toEqual([401, "unauthenticated"]);
    expect(await machineDenials(since)).toEqual([]);
  });

  it("expired (a lifetime of 2 s) → 401", async () => {
    const own = await issueFor(f, "env1a", { ttlSeconds: 2 });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const answer = await machineCall(f, "keys", { token: own.token });
    expect([answer.status, answer.code]).toEqual([401, "unauthenticated"]);
  });

  it("effective_expires_at in the past while OpenBao still accepts the token → 401 by the product's own check, audited", async () => {
    const own = await issueFor(f, "env1a");
    await q().query(
      "UPDATE app.machine_credential SET effective_expires_at = now() - interval '1 second' WHERE id = $1",
      [own.credentialId],
    );
    const self = await baoAnswer(f.stack, own.token, "GET", "auth/token/lookup-self", {
      namespace: f.fx.namespace,
    });
    expect(self.status).toBe(200);
    const since = await now();
    const answer = await machineCall(f, "keys", { token: own.token });
    expect([answer.status, answer.code]).toEqual([401, "unauthenticated"]);
    expect(await machineDenials(since)).toEqual([{ actor_id: own.credentialId, reason: "state" }]);
  });
});

describe("parents", () => {
  const envId = () => f.env("env1a").environmentId;

  it("environment revoking → 403 action_denied (audited); needs_review → 503 backend_inconsistent", async () => {
    try {
      await q().query("UPDATE app.environment SET state = 'revoking' WHERE id = $1", [envId()]);
      const since = await now();
      const denied = await machineCall(f, "keys", { token: a.token });
      expect([denied.status, denied.code]).toEqual([403, "action_denied"]);
      expect(await machineDenials(since)).toEqual([{ actor_id: a.credentialId, reason: "state" }]);
      await q().query(
        "UPDATE app.environment SET state = 'needs_review', review_reason = 'drift' WHERE id = $1",
        [envId()],
      );
      const review = await machineCall(f, "resolve", { token: a.token });
      expect([review.status, review.code]).toEqual([503, "backend_inconsistent"]);
    } finally {
      await q().query(
        "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
        [envId()],
      );
    }
  });

  it("the organization in review → 503 backend_inconsistent; the gate closed → 503 quarantined", async () => {
    const org = f.tenants.a.organizationId;
    try {
      await q().query(
        "UPDATE app.organization SET state = 'needs_review', review_reason = 'drift' WHERE id = $1",
        [org],
      );
      const review = await machineCall(f, "keys", { token: a.token });
      expect([review.status, review.code]).toEqual([503, "backend_inconsistent"]);
    } finally {
      await q().query(
        "UPDATE app.organization SET state = 'active', review_reason = NULL WHERE id = $1",
        [org],
      );
    }
    f.api.setGate("closed");
    const closed = await machineCall(f, "keys", { token: a.token });
    expect([closed.status, closed.code]).toEqual([503, "quarantined"]);
  });
});

describe("selectors", () => {
  it("a query parameter or a body key → 400 forbidden_selector; an empty body and {} are accepted by resolve", async () => {
    for (const query of ["version=1", "history=true", "name=A"]) {
      for (const route of ["keys", "resolve"] as const) {
        const answer = await machineCall(f, route, { token: a.token, query });
        expect([answer.status, answer.code], `${route}?${query}`).toEqual([
          400,
          "forbidden_selector",
        ]);
      }
    }
    for (const text of ['{"version":1}', '{"names":["A"]}']) {
      const answer = await machineCall(f, "resolve", { token: a.token, body: { text } });
      expect([answer.status, answer.code], text).toEqual([400, "forbidden_selector"]);
    }
    const empty = await machineCall(f, "resolve", { token: a.token });
    expect(empty.status).toBe(200);
    const braces = await machineCall(f, "resolve", { token: a.token, body: { text: "{}" } });
    expect(braces.status).toBe(200);
  });
});

describe("one kind of credential per route", () => {
  it("a bearer on a human route → 401; a complete human session on a machine route → 401", async () => {
    const human = await machineCall(f, "keys", {
      token: a.token,
      path: `${f.env("env1a").path}/secrets`,
    });
    expect([human.status, human.code]).toEqual([401, "unauthenticated"]);
    const users: FixtureUser[] = [
      "ownerA",
      "adminA",
      "editorA",
      "readerA",
      "envEditorA",
      "ungrantedA",
      "ownerB",
    ];
    for (const user of users) {
      const cookie = await f.tenants.cookie(user);
      for (const route of ["keys", "resolve"] as const) {
        const answer = await machineCall(f, route, { headers: { cookie } });
        expect(answer.status, `${user} ${route}`).toBe(401);
      }
    }
  });
});

describe("the backend", () => {
  it("OpenBao does not answer → 503 dependency_unavailable, never 401", async () => {
    f.relay.setMode("drop");
    const answer = await machineCall(f, "keys", { token: a.token });
    expect([answer.status, answer.code]).toEqual([503, "dependency_unavailable"]);
  });
});

describe("last use", () => {
  it("last_used_at is written by the first request and not again within the minute", async () => {
    const own = await issueFor(f, "env1a");
    const read = async () =>
      (
        await q().query<{ last_used_at: Date | null }>(
          "SELECT last_used_at FROM app.machine_credential WHERE id = $1",
          [own.credentialId],
        )
      ).rows[0]?.last_used_at ?? null;
    expect(await read()).toBeNull();
    expect((await machineCall(f, "keys", { token: own.token })).status).toBe(200);
    const first = await read();
    expect(first).not.toBeNull();
    expect((await machineCall(f, "keys", { token: own.token })).status).toBe(200);
    expect((await read())?.getTime()).toBe(first?.getTime());
  });
});
