// Run 11.3 Task B (P-187, P-188, P-189; D-81): machine.exchange. A runtime
// credential's client secret is the bearer; the answer is a machine token of
// the credential's one environment that lives 900 seconds and cannot be
// renewed. The product stores nothing of it: the token is attributed later by
// the `meta` the issuer gave it.
//
// The fixture's API trusts the loopback hop as its edge, so `from` is the
// caller's address as a host's edge would report it; without it the source is
// the peer (the loopback address).
//
// Client secrets and tokens are locals of the tests and never appear in an
// assertion message. Values are synthetic and compared by digest.
import { randomBytes, randomUUID } from "node:crypto";
import { API_MAJOR, LIMITS } from "@mykey/contracts";
import { machineName } from "@mykey/openbao";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authOf, baoAnswer, dataOf } from "../../harness/bao-raw.ts";
import {
  createCredentialsFixture,
  issueFor,
  issueRuntimeFor,
  machineAccessors,
  rootRevoke,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import {
  ENV_NAMES,
  exchangeCall,
  exportDigests,
  machineCall,
  machinePath,
  resolveDigests,
  type MachineAnswer,
} from "../../harness/machine.ts";
import { measure } from "../../harness/measure.ts";

const EDGE = "127.0.0.1";
const NETWORK = "203.0.113.0/24";
const INSIDE = "203.0.113.7";
const OUTSIDE = "198.51.100.9";
const SEEDED = 25;
const TTL = LIMITS.runtimeCredential.exchangeTtlSeconds;

let f: CredentialsFixture;
const names: string[] = [];

beforeAll(async () => {
  f = await createCredentialsFixture({ trustedProxy: EDGE });
  for (let index = 0; index < SEEDED; index += 1) {
    const name = `EXCHANGE_${String(index).padStart(2, "0")}`;
    const made = await f.create("env1a", name, `synthetic-${randomUUID()}`);
    expect(made.status, name).toBe(201);
    names.push(name);
  }
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setFaults(null);
  f.setBeforeHandler(null);
  f.relay.clear();
  f.api.setGate("open");
  await setCapture("idle");
});

const q = () => f.api.superuser;
const envId = (): string => f.env("env1a").environmentId;

const now = async (): Promise<Date> =>
  (await q().query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;

async function setCapture(mode: "idle" | "capturing"): Promise<void> {
  await f.api.database
    .pool("maintenance")
    .query(
      "UPDATE app.service_control SET capture_mode = $1, owner = $2, pair_id = NULL, updated_at = now()",
      [mode, mode === "idle" ? null : "exchange-test"],
    );
}

/** `access.denied` rows with a machine actor written after `since`. */
async function denials(
  since: Date,
): Promise<{ actor_id: string; route: string; reason: string }[]> {
  const rows = await q().query<{ actor_id: string; route: string; reason: string }>(
    `SELECT actor_id, details->>'routeId' AS route, details->>'reason' AS reason
       FROM audit.event
      WHERE action = 'access.denied' AND actor_kind = 'machine' AND occurred_at >= $1
      ORDER BY occurred_at`,
    [since],
  );
  return rows.rows;
}

/** Every audit row of one request. */
async function auditOf(answer: MachineAnswer) {
  const rows = await q().query<{
    action: string;
    actor_kind: string;
    actor_id: string;
    target_kind: string;
    target_id: string;
    outcome: string;
    details: Record<string, unknown>;
  }>(
    `SELECT action, actor_kind, actor_id, target_kind, target_id, outcome, details
       FROM audit.event WHERE request_id = $1`,
    [answer.headers.get("x-request-id")],
  );
  return rows.rows;
}

/** An exchange that must answer 200; the token leaves only in the return value. */
async function exchanged(
  secret: string,
  from?: string,
): Promise<{ token: string; expiresAt: string }> {
  const answer = await exchangeCall(f, { secret, ...(from === undefined ? {} : { from }) });
  expect(answer.status, `exchange: ${answer.code ?? ""}`).toBe(200);
  return { token: answer.body.token as string, expiresAt: answer.body.expiresAt as string };
}

/** The accessor of a live token, as the root token sees it. */
async function accessorOf(token: string): Promise<string> {
  const lookup = await baoAnswer(f.stack, f.stack.bao.rootToken, "POST", "auth/token/lookup", {
    namespace: f.fx.namespace,
    body: { token },
  });
  expect(lookup.status).toBe(200);
  return dataOf(lookup).accessor as string;
}

async function lookupAccessor(accessor: string) {
  return baoAnswer(f.stack, f.stack.bao.rootToken, "POST", "auth/token/lookup-accessor", {
    namespace: f.fx.namespace,
    body: { accessor },
  });
}

/** What two refusals must share: everything but the request id. */
const shape = (answer: MachineAnswer) => {
  const requestId = answer.headers.get("x-request-id") ?? "";
  return {
    status: answer.status,
    headers: [...answer.headers.keys()].filter((name) => name !== "date").sort(),
    body: answer.text.replace(requestId, "<id>"),
    length: answer.headers.get("content-length"),
  };
};

const other = (): string => randomBytes(32).toString("base64url");

describe("an exchange", () => {
  it("exchange answers 200 with a token and expiresAt at most 900 s away; with it machine.resolve returns all 25 seeded values, complete: true, and machine.keys the 25 names", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    const before = await now();
    const started = performance.now();
    const answer = await exchangeCall(f, { secret: credential.clientSecret });
    measure("exchange.one_ms", Math.round(performance.now() - started));
    const after = await now();
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual([
      "apiMajor",
      "environmentName",
      "expiresAt",
      "projectId",
      "token",
    ]);
    expect(answer.body).toMatchObject({
      apiMajor: API_MAJOR,
      projectId: f.env("env1a").projectId,
      environmentName: ENV_NAMES.env1a,
    });
    // One buffered body that nothing may keep.
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(Number(answer.headers.get("content-length"))).toBe(answer.bytes.length);
    expect(answer.headers.get("content-encoding")).toBeNull();
    const expiresAt = Date.parse(answer.body.expiresAt as string);
    expect(expiresAt - after.getTime()).toBeLessThanOrEqual(TTL * 1000);
    expect(expiresAt - before.getTime()).toBeGreaterThan((TTL - 10) * 1000);

    const token = answer.body.token as string;
    expect(typeof token).toBe("string");
    // The token is OpenBao's, not a client secret under another name.
    expect(token.startsWith("mkrc.")).toBe(false);
    const resolve = await machineCall(f, "resolve", { token });
    expect(resolve.status, resolve.code ?? "").toBe(200);
    expect(resolve.body).toMatchObject({ count: SEEDED, complete: true });
    expect(new Map(resolveDigests(resolve))).toEqual(await exportDigests(f, "env1a"));
    const keys = await machineCall(f, "keys", { token });
    expect(keys.status, keys.code ?? "").toBe(200);
    expect(keys.body.names).toEqual([...names].sort());

    // The audit row of the exchange, and the reads attributed to the credential.
    expect(await auditOf(answer)).toEqual([
      {
        action: "machine.exchange",
        actor_kind: "machine",
        actor_id: credential.credentialId,
        target_kind: "environment",
        target_id: envId(),
        outcome: "success",
        details: { credentialId: credential.credentialId, ttlSeconds: TTL },
      },
    ]);
    expect((await auditOf(resolve)).map((row) => [row.action, row.actor_id])).toEqual([
      ["machine.resolve", credential.credentialId],
    ]);
    // The product keeps nothing of the token: the row has no accessor, and it was used.
    const row = await q().query<{ accessor: string | null; used: boolean }>(
      "SELECT accessor, last_used_at IS NOT NULL AS used FROM app.machine_credential WHERE id = $1",
      [credential.credentialId],
    );
    expect(row.rows[0]).toEqual({ accessor: null, used: true });
    // In OpenBao it is what the measurement of issuance.test.ts says.
    const seen = dataOf(await lookupAccessor(await accessorOf(token)));
    expect(seen).toMatchObject({
      orphan: true,
      renewable: false,
      policies: [machineName(f.env("env1a").environmentId)],
      creation_ttl: TTL,
      meta: { credential_id: credential.credentialId, exchange: "1" },
    });
  });

  it("two exchanges of one credential give two tokens, and both resolve", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    const first = await exchanged(credential.clientSecret);
    const second = await exchanged(credential.clientSecret);
    expect(first.token === second.token).toBe(false);
    for (const token of [first.token, second.token]) {
      expect((await machineCall(f, "keys", { token })).status).toBe(200);
    }
  });
});

describe("a bearer that is not this credential's secret", () => {
  it("a wrong secret for a real id, an unknown id, a mkac string and an OpenBao-shaped token each answer 401 with the same body; the audit table gains no row; the log gains machine_unauthenticated", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    const [, id, secret] = credential.clientSecret.split(".") as [string, string, string];
    const machine = await issueFor(f, "env1a");
    const cases: [string, string][] = [
      ["a wrong secret for a real id", `mkrc.${id}.${other()}`],
      ["an unknown id", `mkrc.${randomUUID()}.${other()}`],
      // The right id and the right secret under the other credential's prefix.
      ["a mkac string", `mkac.${id}.${secret}`],
      ["an OpenBao-shaped token", `hvs.${randomBytes(24).toString("base64url")}`],
      ["a real 30-day machine token", machine.token],
      ["the secret without its prefix", secret],
    ];
    const answers: MachineAnswer[] = [];
    for (const [label, bearer] of cases) {
      const answer = await exchangeCall(f, { secret: bearer });
      expect([answer.status, answer.code], label).toEqual([401, "unauthenticated"]);
      expect("token" in answer.body, label).toBe(false);
      answers.push(answer);
    }
    expect(new Set(answers.map((answer) => JSON.stringify(shape(answer)))).size).toBe(1);
    for (const answer of answers) expect(await auditOf(answer)).toEqual([]);
    const ids = new Set(answers.map((answer) => answer.headers.get("x-request-id")));
    const logged = f.api.logs.filter(
      (entry) => entry.event === "machine_unauthenticated" && ids.has(entry.requestId),
    );
    expect(logged.length).toBe(cases.length);
    // No log line of these requests holds a part of what was presented.
    const text = JSON.stringify(f.api.logs);
    expect(text.includes(secret)).toBe(false);
    expect(text.includes(id)).toBe(false);
    // The control: the credential's own secret is accepted.
    await exchanged(credential.clientSecret);
  });

  it("no header, two Authorization headers and a Basic scheme are 401; a cookie beside the bearer is 400 mixed_authentication", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    const bearer = `Bearer ${credential.clientSecret}`;
    for (const headers of [
      {},
      { authorization: [bearer, bearer] },
      { authorization: "Basic dXNlcjpwYXNz" },
    ] as Record<string, string | string[]>[]) {
      const answer = await exchangeCall(f, { headers });
      expect([answer.status, answer.code]).toEqual([401, "unauthenticated"]);
    }
    const cookie = await f.tenants.cookie("ownerA");
    const mixed = await exchangeCall(f, { secret: credential.clientSecret, headers: { cookie } });
    expect([mixed.status, mixed.code]).toEqual([400, "mixed_authentication"]);
    // A complete human session is no runtime credential.
    const human = await exchangeCall(f, { headers: { cookie } });
    expect([human.status, human.code]).toEqual([401, "unauthenticated"]);
  });
});

describe("a credential that may not exchange", () => {
  it("a revoked credential, an expired one, and a call from outside its CIDRs each answer 401 and write access.denied with the machine actor", async () => {
    const revoked = await issueRuntimeFor(f, "env1a");
    expect((await f.revoke("env1a", revoked.credentialId)).status).toBe(200);
    const expired = await issueRuntimeFor(f, "env1a");
    await q().query(
      "UPDATE app.machine_credential SET effective_expires_at = now() - interval '1 second' WHERE id = $1",
      [expired.credentialId],
    );
    const bound = await issueRuntimeFor(f, "env1a", { cidrs: [NETWORK] });

    const since = await now();
    const cases: [string, string, string | undefined, string][] = [
      ["revoked", revoked.clientSecret, undefined, revoked.credentialId],
      ["expired", expired.clientSecret, undefined, expired.credentialId],
      // Without the edge's header the source is the peer, which is not in the network.
      ["from the peer", bound.clientSecret, undefined, bound.credentialId],
      ["from outside", bound.clientSecret, OUTSIDE, bound.credentialId],
    ];
    const answers: MachineAnswer[] = [];
    for (const [label, secret, from] of cases) {
      const answer = await exchangeCall(f, { secret, ...(from === undefined ? {} : { from }) });
      expect([answer.status, answer.code], label).toEqual([401, "unauthenticated"]);
      answers.push(answer);
    }
    // The caller learns nothing from which of them it met.
    expect(new Set(answers.map((answer) => JSON.stringify(shape(answer)))).size).toBe(1);
    expect(await denials(since)).toEqual([
      { actor_id: revoked.credentialId, route: "machine.exchange", reason: "state" },
      { actor_id: expired.credentialId, route: "machine.exchange", reason: "state" },
      { actor_id: bound.credentialId, route: "machine.exchange", reason: "source" },
      { actor_id: bound.credentialId, route: "machine.exchange", reason: "source" },
    ]);
    // No audit row holds an address.
    const rows = await q().query<{ text: string }>(
      "SELECT row_to_json(e)::text AS text FROM audit.event e WHERE occurred_at >= $1",
      [since],
    );
    for (const address of [OUTSIDE, INSIDE, EDGE]) {
      expect(rows.rows.some((row) => row.text.includes(address))).toBe(false);
    }
    // The control: the same call from inside the network, through the trusted edge.
    await exchanged(bound.clientSecret, INSIDE);
  });

  it("the environment revoking is 403 action_denied, audited; in review 503 backend_inconsistent; the gate closed 503 quarantined", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    try {
      await q().query("UPDATE app.environment SET state = 'revoking' WHERE id = $1", [envId()]);
      const since = await now();
      const denied = await exchangeCall(f, { secret: credential.clientSecret });
      expect([denied.status, denied.code]).toEqual([403, "action_denied"]);
      expect(await denials(since)).toEqual([
        { actor_id: credential.credentialId, route: "machine.exchange", reason: "state" },
      ]);
      await q().query(
        "UPDATE app.environment SET state = 'needs_review', review_reason = 'drift' WHERE id = $1",
        [envId()],
      );
      const review = await exchangeCall(f, { secret: credential.clientSecret });
      expect([review.status, review.code]).toEqual([503, "backend_inconsistent"]);
    } finally {
      await q().query(
        "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
        [envId()],
      );
    }
    f.api.setGate("closed");
    const closed = await exchangeCall(f, { secret: credential.clientSecret });
    expect([closed.status, closed.code]).toEqual([503, "quarantined"]);
    f.api.setGate("open");
    await exchanged(credential.clientSecret);
  });
});

describe("revocation (P-189)", () => {
  it("revoke after an exchange: the next exchange is 401, and the token already minted answers 401 on machine.resolve at once", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    const { token } = await exchanged(credential.clientSecret);
    expect((await machineCall(f, "resolve", { token })).status).toBe(200);
    const accessor = await accessorOf(token);

    const since = await now();
    expect((await f.revoke("env1a", credential.credentialId)).status).toBe(200);
    const again = await exchangeCall(f, { secret: credential.clientSecret });
    expect([again.status, again.code]).toEqual([401, "unauthenticated"]);
    for (const route of ["resolve", "keys"] as const) {
      const answer = await machineCall(f, route, { token });
      expect([answer.status, answer.code], route).toEqual([401, "unauthenticated"]);
      expect(answer.body.entries).toBeUndefined();
    }
    expect((await denials(since)).map((row) => [row.actor_id, row.reason])).toEqual([
      [credential.credentialId, "state"],
      [credential.credentialId, "state"],
      [credential.credentialId, "state"],
    ]);

    // The measurement for P-189: in OpenBao the token lives on until its own end.
    // The product stored no accessor, so it revoked none.
    const still = await lookupAccessor(accessor);
    expect(still.status).toBe(200);
    const left = dataOf(still).ttl as number;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(TTL);
    measure("exchange.token_ttl_seconds_left_after_revoke", left);
    await rootRevoke(f, accessor);
  });
});

describe("the token belongs to one environment (P-188)", () => {
  it("the token is refused on another environment's path with 404, and a 30-day token of the same environment still resolves", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    const { token } = await exchanged(credential.clientSecret);
    const p1 = f.env("env1a").projectId;
    const since = await now();
    const paths = [
      machinePath(p1, ENV_NAMES.env1b, "resolve"),
      machinePath(f.env("env2a").projectId, ENV_NAMES.env2a, "resolve"),
      machinePath(randomUUID(), ENV_NAMES.env1a, "resolve"),
    ];
    const answers: MachineAnswer[] = [];
    for (const path of paths) {
      const answer = await machineCall(f, "resolve", { token, path });
      expect([answer.status, answer.code], path).toEqual([404, "not_found"]);
      answers.push(answer);
    }
    expect(new Set(answers.map((answer) => JSON.stringify(shape(answer)))).size).toBe(1);
    expect((await denials(since)).map((row) => [row.actor_id, row.reason])).toEqual(
      paths.map(() => [credential.credentialId, "hidden"]),
    );
    const machine = await issueFor(f, "env1a");
    const resolve = await machineCall(f, "resolve", { token: machine.token });
    expect(resolve.status, resolve.code ?? "").toBe(200);
    expect(resolve.body.count).toBe(SEEDED);
  });

  it("a token whose meta names a runtime credential of another environment is 401 on both paths, and nothing is audited", async () => {
    // Only the issuer can make such a token (D-17); the root token stands in for
    // a hostile one. The policy is 1a's, the meta names a credential of 1b.
    const ofB = await issueRuntimeFor(f, "env1b");
    const made = await baoAnswer(
      f.stack,
      f.stack.bao.rootToken,
      "POST",
      `auth/token/create/${machineName(f.env("env1a").environmentId)}`,
      {
        namespace: f.fx.namespace,
        body: { ttl: "10m", meta: { credential_id: ofB.credentialId, exchange: "1" } },
      },
    );
    expect(made.status).toBe(200);
    const forged = authOf(made);
    try {
      const since = await now();
      for (const env of ["env1b", "env1a"] as const) {
        for (const route of ["keys", "resolve"] as const) {
          const answer = await machineCall(f, route, { token: forged.client_token, env });
          expect([answer.status, answer.code], `${env} ${route}`).toEqual([401, "unauthenticated"]);
          expect(answer.body.names).toBeUndefined();
          expect(answer.body.entries).toBeUndefined();
        }
      }
      expect(await denials(since)).toEqual([]);
      // The control: a token the exchange minted for that credential reads 1b.
      const real = await exchanged(ofB.clientSecret);
      expect((await machineCall(f, "keys", { token: real.token, env: "env1b" })).status).toBe(200);
    } finally {
      await rootRevoke(f, forged.accessor);
    }
  });

  it("a machine request from outside a runtime credential's CIDRs is 401, and the same request for a 30-day token, which has none, is 200", async () => {
    const bound = await issueRuntimeFor(f, "env1a", { cidrs: [NETWORK] });
    const { token } = await exchanged(bound.clientSecret, INSIDE);
    const since = await now();
    for (const from of [undefined, OUTSIDE]) {
      const answer = await machineCall(f, "resolve", {
        token,
        ...(from === undefined ? {} : { from }),
      });
      expect([answer.status, answer.code], from ?? "the peer").toEqual([401, "unauthenticated"]);
    }
    expect(await denials(since)).toEqual([
      { actor_id: bound.credentialId, route: "machine.resolve", reason: "source" },
      { actor_id: bound.credentialId, route: "machine.resolve", reason: "source" },
    ]);
    expect((await machineCall(f, "resolve", { token, from: INSIDE })).status).toBe(200);
    const machine = await issueFor(f, "env1a");
    expect((await machineCall(f, "resolve", { token: machine.token })).status).toBe(200);
    expect((await machineCall(f, "resolve", { token: machine.token, from: OUTSIDE })).status).toBe(
      200,
    );
  });
});

describe("selectors", () => {
  it("a query parameter or a body key is 400 forbidden_selector", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    const secret = credential.clientSecret;
    const before = (await machineAccessors(f, envId())).length;
    for (const query of ["environment=prod", "ttl=86400", "project=x"]) {
      const answer = await exchangeCall(f, { secret, query });
      expect([answer.status, answer.code], query).toEqual([400, "forbidden_selector"]);
    }
    for (const text of ['{"ttlSeconds":86400}', '{"environmentId":"x"}', "[]"]) {
      const answer = await exchangeCall(f, { secret, body: { text } });
      expect([answer.status, answer.code], text).toEqual([400, "forbidden_selector"]);
    }
    // None of them made a token.
    expect((await machineAccessors(f, envId())).length).toBe(before);
    // A caller nobody knows learns nothing from a selector: 401 first.
    const anonymous = await exchangeCall(f, {
      secret: `mkrc.${randomUUID()}.${other()}`,
      query: "a=1",
    });
    expect([anonymous.status, anonymous.code]).toEqual([401, "unauthenticated"]);
    // No body and `{}` are no selector.
    const braces = await exchangeCall(f, { secret, body: { text: "{}" } });
    expect(braces.status, braces.code ?? "").toBe(200);
  });
});

describe("when a server needs it most (Review focus 3)", () => {
  it("with the capture mode set to capturing, exchange answers 200", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    await setCapture("capturing");
    const { token } = await exchanged(credential.clientSecret);
    const resolve = await machineCall(f, "resolve", { token });
    expect(resolve.status, resolve.code ?? "").toBe(200);
    // The control: a write is refused while the pair is captured.
    const write = await f.create(
      "env1a",
      `CAPTURED_${randomBytes(4).toString("hex").toUpperCase()}`,
      "synthetic",
    );
    expect([write.status, write.code]).toEqual([503, "busy"]);
  });

  it("OpenBao does not answer: 503 dependency_unavailable, never 401, and no token", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    f.relay.setMode("drop");
    const answer = await exchangeCall(f, { secret: credential.clientSecret });
    expect([answer.status, answer.code]).toEqual([503, "dependency_unavailable"]);
    expect("token" in answer.body).toBe(false);
    f.relay.clear();
    await exchanged(credential.clientSecret);
  });
});

describe("an exchange changes no product state (P-187)", () => {
  it("fault after_create_sent: the answer is 503, nothing is in review, the next exchange answers 200, and issuing a 30-day token is not blocked", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    const operations = async (): Promise<number> =>
      (await q().query<{ count: number }>("SELECT count(*)::int AS count FROM app.operation"))
        .rows[0]!.count;
    const before = await operations();
    f.setFaults((at) => {
      if (at === "after_create_sent") throw new Error("fault");
    });
    const lost = await exchangeCall(f, { secret: credential.clientSecret });
    expect([lost.status, lost.code]).toEqual([503, "dependency_unavailable"]);
    expect("token" in lost.body).toBe(false);
    f.setFaults(null);

    // No operation, no row in review, the environment as it was.
    expect(await operations()).toBe(before);
    const rows = await q().query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE environment_id = $1 AND state IN ('issuing', 'needs_review')",
      [envId()],
    );
    expect(rows.rows).toEqual([]);
    const environment = await q().query<{ state: string }>(
      "SELECT state FROM app.environment WHERE id = $1",
      [envId()],
    );
    expect(environment.rows[0]?.state).toBe("active");
    expect(await auditOf(lost)).toEqual([]);

    await exchanged(credential.clientSecret);
    const issued = await f.issue("env1a", { ttlSeconds: 600 });
    expect(issued.status, issued.code).toBe(201);
  });

  it("audit unavailable: the answer is 503 audit_unavailable and the minted token is refused afterwards", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    const mine = async (): Promise<number> =>
      (await machineAccessors(f, envId())).filter(
        (token) => token.meta?.credential_id === credential.credentialId,
      ).length;
    expect(await mine()).toBe(0);
    await q().query("REVOKE INSERT ON audit.event FROM api_runtime");
    try {
      const answer = await exchangeCall(f, { secret: credential.clientSecret });
      expect([answer.status, answer.code]).toEqual([503, "audit_unavailable"]);
      expect("token" in answer.body).toBe(false);
    } finally {
      await q().query("GRANT INSERT ON audit.event TO api_runtime");
    }
    // The token that was minted and never left is gone from OpenBao: nobody can use it.
    expect(await mine()).toBe(0);
    // The control: with the audit back, an exchange leaves its token in OpenBao.
    await exchanged(credential.clientSecret);
    expect(await mine()).toBe(1);
  });

  it("a credential revoked between the pipeline's read and the audit row gives no token", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    f.setBeforeHandler(async (routeId) => {
      if (routeId !== "machine.exchange") return;
      await q().query("UPDATE app.machine_credential SET state = 'revoked' WHERE id = $1", [
        credential.credentialId,
      ]);
    });
    const answer = await exchangeCall(f, { secret: credential.clientSecret });
    expect([answer.status, answer.code]).toEqual([401, "unauthenticated"]);
    expect("token" in answer.body).toBe(false);
    expect((await auditOf(answer)).map((row) => row.action)).toEqual([]);
    // The token that was minted for it is gone from OpenBao.
    const left = (await machineAccessors(f, envId())).filter(
      (token) => token.meta?.credential_id === credential.credentialId,
    );
    expect(left).toEqual([]);
  });

  // Run 11.3 Task D (D-81): the verifier is made over the secret and what the
  // credential is bound to, with a key PostgreSQL never holds. Whoever can
  // write the database and holds one client secret cannot point it elsewhere.
  it("a row a writer of the database alone moved to another environment, or freed of its networks, is refused: 401, no token, no audit row; as issued it is exchanged again", async () => {
    const credential = await issueRuntimeFor(f, "env1a", { cidrs: [NETWORK] });
    const row = (
      await q().query<{ project_id: string; environment_id: string; bound_cidrs: string[] }>(
        "SELECT project_id, environment_id, bound_cidrs FROM app.machine_credential WHERE id = $1",
        [credential.credentialId],
      )
    ).rows[0]!;
    const set = (projectId: string, environmentId: string, cidrs: string[]) =>
      q().query(
        `UPDATE app.machine_credential SET project_id = $2, environment_id = $3, bound_cidrs = $4
          WHERE id = $1`,
        [credential.credentialId, projectId, environmentId, cidrs],
      );
    const tokensOf = async (): Promise<number> => {
      let count = 0;
      for (const env of ["env1a", "env1b", "env2a"] as const) {
        count += (await machineAccessors(f, f.env(env).environmentId)).filter(
          (token) => token.meta?.credential_id === credential.credentialId,
        ).length;
      }
      return count;
    };
    const first = await exchangeCall(f, { secret: credential.clientSecret, from: INSIDE });
    expect(first.status, first.code ?? "").toBe(200);
    expect(await tokensOf()).toBe(1);

    const changes: [string, string, string, string[], string][] = [
      [
        "another environment of its project",
        row.project_id,
        f.env("env1b").environmentId,
        [NETWORK],
        INSIDE,
      ],
      [
        "an environment of another project",
        f.env("env2a").projectId,
        f.env("env2a").environmentId,
        [NETWORK],
        INSIDE,
      ],
      ["no networks", row.project_id, row.environment_id, [], OUTSIDE],
      [
        "a wider network",
        row.project_id,
        row.environment_id,
        ["0.0.0.0/1", "128.0.0.0/1"],
        OUTSIDE,
      ],
    ];
    try {
      for (const [label, projectId, environmentId, cidrs, from] of changes) {
        await set(projectId, environmentId, cidrs);
        const answer = await exchangeCall(f, { secret: credential.clientSecret, from });
        expect([answer.status, answer.code], label).toEqual([401, "unauthenticated"]);
        expect("token" in answer.body, label).toBe(false);
        expect(
          (await auditOf(answer)).map((entry) => entry.action),
          label,
        ).toEqual([]);
      }
    } finally {
      await set(row.project_id, row.environment_id, row.bound_cidrs);
    }
    // Nothing was minted for a changed row.
    expect(await tokensOf()).toBe(1);
    const again = await exchangeCall(f, { secret: credential.clientSecret, from: INSIDE });
    expect(again.status, again.code ?? "").toBe(200);
  });
});
