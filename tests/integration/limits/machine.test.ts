// Run 6.3 Task A (P-113, FR-1.60, D-49): the limits of machine requests, with
// the product's limits. A token nobody can attribute costs one lookup in
// OpenBao (counted at the relay the API reaches it through); after 30 of them in a minute a source is refused before the lookup,
// valid credentials from that source included (the stated price of the rule,
// in limits.md). Each credential has its own 60 a minute. A counter table that
// refuses makes a machine read 503 before OpenBao is asked.
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { windowSecondsLeft } from "@mykey/api";
import { AUTOMATION_SECRET_PREFIX, LIMITS } from "@mykey/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  automationCall,
  clearAutomation,
  issueAutomationFor,
  strangerSecret,
} from "../../harness/automation.ts";
import {
  createCredentialsFixture,
  issueFor,
  issueRuntimeFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { exchangeCall, machineCall } from "../../harness/machine.ts";

let f: CredentialsFixture;
let a: { credentialId: string; token: string };
let b: { credentialId: string; token: string };

beforeAll(async () => {
  f = await createCredentialsFixture({ rateLimits: "product" });
  const made = await f.create("env1a", "LIMIT_SEED", "synthetic-seed");
  expect(made.status).toBe(201);
  a = await issueFor(f, "env1a");
  b = await issueFor(f, "env1a");
}, 600_000);

afterAll(async () => {
  await f.close();
});

beforeEach(async () => {
  const left = windowSecondsLeft(Date.now());
  if (left < 25) await sleep(left * 1000 + 500);
  await f.api.superuser.query("DELETE FROM app.rate_limit");
}, 60_000);

/**
 * Requests the API sent to OpenBao so far, counted at the fixture's TLS relay
 * (a GET without a body is one record). OpenBao's audit device does not record
 * a lookup with a token it never issued, so the relay is where the cost shows.
 */
function lookups(): number {
  return f.relay.forwardedAt.length;
}

/** A token of the right shape that OpenBao never issued. */
const unknownToken = (): string => `hvs.${randomBytes(24).toString("base64url")}`;

const nextWindow = () =>
  f.api.superuser.query(
    "UPDATE app.rate_limit SET window_start = window_start - interval '1 minute'",
  );

describe("tokens nobody can attribute (rl:machine-miss, 30)", () => {
  it("30 unknown tokens cost 30 lookups; the next 30 cost none and answer 429", async () => {
    for (let i = 0; i < 30; i += 1) {
      const before = lookups();
      const answer = await machineCall(f, i % 2 === 0 ? "keys" : "resolve", {
        token: unknownToken(),
      });
      expect([answer.status, answer.code], `miss ${String(i + 1)}`).toEqual([
        401,
        "unauthenticated",
      ]);
      // Each miss asked OpenBao (one new connection: its records pass the relay).
      expect(lookups() - before, `miss ${String(i + 1)}`).toBeGreaterThanOrEqual(1);
    }
    const afterMisses = lookups();
    for (let i = 0; i < 30; i += 1) {
      const answer = await machineCall(f, "keys", { token: unknownToken() });
      expect([answer.status, answer.code]).toEqual([429, "rate_limited"]);
      const retryAfter = Number(answer.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
    }
    expect(lookups()).toBe(afterMisses);
  }, 180_000);

  it("a valid credential from the same source is refused too until the window ends", async () => {
    for (let i = 0; i < 30; i += 1) {
      await machineCall(f, "keys", { token: unknownToken() });
    }
    const held = await machineCall(f, "resolve", { token: a.token });
    expect([held.status, held.code]).toEqual([429, "rate_limited"]);
    await nextWindow();
    const served = await machineCall(f, "resolve", { token: a.token });
    expect(served.status, served.code ?? "").toBe(200);
  }, 180_000);

  it("a malformed header costs no lookup and is not counted", async () => {
    for (let i = 0; i < 40; i += 1) {
      const answer = await machineCall(f, "keys", { headers: { authorization: "Basic eA==" } });
      expect(answer.status).toBe(401);
    }
    const served = await machineCall(f, "keys", { token: a.token });
    expect(served.status, served.code ?? "").toBe(200);
  }, 120_000);
});

describe("per credential (rl:credential, 60)", () => {
  it("the 61st request of one credential is 429 while another credential of the same environment is served", async () => {
    for (let i = 0; i < 60; i += 1) {
      const answer = await machineCall(f, "keys", { token: a.token });
      expect(answer.status, `request ${String(i + 1)}: ${answer.code ?? ""}`).toBe(200);
    }
    const refused = await machineCall(f, "keys", { token: a.token });
    expect([refused.status, refused.code]).toEqual([429, "rate_limited"]);
    const other = await machineCall(f, "keys", { token: b.token });
    expect(other.status, other.code ?? "").toBe(200);
    await nextWindow();
    expect((await machineCall(f, "keys", { token: a.token })).status).toBe(200);
  }, 180_000);
});

describe("a counter table that refuses", () => {
  it("a machine read is 503 dependency_unavailable and OpenBao was not asked; with the rights back it succeeds", async () => {
    const before = lookups();
    await f.api.superuser.query("REVOKE INSERT, UPDATE ON app.rate_limit FROM api_runtime");
    try {
      const answer = await machineCall(f, "resolve", { token: a.token });
      expect([answer.status, answer.code]).toEqual([503, "dependency_unavailable"]);
      expect(lookups()).toBe(before);
    } finally {
      await f.api.superuser.query("GRANT INSERT, UPDATE ON app.rate_limit TO api_runtime");
    }
    const served = await machineCall(f, "resolve", { token: a.token });
    expect(served.status, served.code ?? "").toBe(200);
  }, 120_000);
});

describe("one request at a time per credential (P-114)", () => {
  it("a second keys or resolve of the same credential while one runs is 503 busy at once, without waiting for the environment's lock", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const first = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.setFaults(async (point) => {
      if (point !== "after_backend_read") return;
      reached();
      await held;
    });
    try {
      const running = machineCall(f, "resolve", { token: a.token });
      await first;
      for (const route of ["resolve", "keys"] as const) {
        const started = performance.now();
        const second = await machineCall(f, route, { token: a.token });
        expect([second.status, second.code], route).toEqual([503, "busy"]);
        expect(performance.now() - started, route).toBeLessThan(1500);
      }
      release();
      expect((await running).status).toBe(200);
    } finally {
      release();
      f.setFaults(null);
    }
    expect((await machineCall(f, "resolve", { token: a.token })).status).toBe(200);
  }, 120_000);
});

// Session 11 (Run 11.3, P-187, P-196): the exchange. A client secret nobody
// can attribute costs one read of the database and is a miss of its source,
// counted with the tokens nobody can attribute; each runtime credential has
// its own 10 exchanges a minute.
describe("the exchange (rl:machine-miss 30, rl:exchange 10)", () => {
  /** A client secret of the right shape that names no credential. */
  const stranger = (): string => `mkrc.${randomUUID()}.${randomBytes(32).toString("base64url")}`;

  it("the 31st miss of one source in a minute answers 429 before the database is read for the credential", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    for (let i = 0; i < 30; i += 1) {
      const answer = await exchangeCall(f, { secret: stranger() });
      expect([answer.status, answer.code], `miss ${String(i + 1)}`).toEqual([
        401,
        "unauthenticated",
      ]);
    }
    // With the table unreadable, a request that read it would answer 503.
    await f.api.superuser.query("REVOKE SELECT ON app.machine_credential FROM api_runtime");
    try {
      // The credential's own secret is refused too: the stated price of the rule.
      for (const secret of [stranger(), credential.clientSecret]) {
        const refused = await exchangeCall(f, { secret });
        expect([refused.status, refused.code]).toEqual([429, "rate_limited"]);
        const retryAfter = Number(refused.headers.get("retry-after"));
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);
      }
      // The control: in the next window the table is read, and that read fails.
      await nextWindow();
      const read = await exchangeCall(f, { secret: credential.clientSecret });
      expect([read.status, read.code]).toEqual([503, "dependency_unavailable"]);
    } finally {
      await f.api.superuser.query("GRANT SELECT ON app.machine_credential TO api_runtime");
    }
    const served = await exchangeCall(f, { secret: credential.clientSecret });
    expect(served.status, served.code ?? "").toBe(200);
  }, 180_000);

  it("a bearer that is no client secret costs no read and is not counted", async () => {
    const credential = await issueRuntimeFor(f, "env1a");
    for (let i = 0; i < 40; i += 1) {
      const answer = await exchangeCall(f, { secret: unknownToken() });
      expect(answer.status).toBe(401);
    }
    const served = await exchangeCall(f, { secret: credential.clientSecret });
    expect(served.status, served.code ?? "").toBe(200);
  }, 120_000);

  it("the 11th exchange of one credential in a minute answers 429 with retry-after", async () => {
    const one = await issueRuntimeFor(f, "env1a");
    const two = await issueRuntimeFor(f, "env1a");
    let token = "";
    for (let i = 0; i < 10; i += 1) {
      const answer = await exchangeCall(f, { secret: one.clientSecret });
      expect(answer.status, `exchange ${String(i + 1)}: ${answer.code ?? ""}`).toBe(200);
      token = answer.body.token as string;
    }
    const refused = await exchangeCall(f, { secret: one.clientSecret });
    expect([refused.status, refused.code]).toEqual([429, "rate_limited"]);
    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect("token" in refused.body).toBe(false);
    // Another credential of the same environment is served, and a token already minted reads.
    expect((await exchangeCall(f, { secret: two.clientSecret })).status).toBe(200);
    expect((await machineCall(f, "keys", { token })).status).toBe(200);
    await nextWindow();
    expect((await exchangeCall(f, { secret: one.clientSecret })).status).toBe(200);
  }, 180_000);
});

// Session 11 (Run 11.5, P-194): an automation credential has its own 120
// requests a minute, counted after it is recognised and before anything else
// is decided; a secret nobody can attribute is a miss of its source, with the
// tokens and the client secrets nobody can attribute.
describe("automation (rl:automation 120, rl:machine-miss 30)", () => {
  it("the 121st request of one credential in a minute answers 429 with retry-after; another credential is served", async () => {
    expect(LIMITS.rate.perAutomationCredentialPerMinute).toBe(120);
    const one = await issueAutomationFor(f);
    const two = await issueAutomationFor(f, { name: "two" });
    try {
      // A request that is refused later in the pipeline is counted like a served one:
      // a project nobody manages is 404 for both credentials.
      const ids = { project: f.env("env1a").projectId };
      for (let i = 0; i < 120; i += 1) {
        const answer = await automationCall(f, "automation.projects.get", {
          secret: one.secret,
          ids,
        });
        expect([answer.status, answer.code], `request ${String(i + 1)}`).toEqual([
          404,
          "not_found",
        ]);
      }
      const refused = await automationCall(f, "automation.projects.get", {
        secret: one.secret,
        ids,
      });
      expect([refused.status, refused.code]).toEqual([429, "rate_limited"]);
      const retryAfter = Number(refused.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      const other = await automationCall(f, "automation.projects.get", { secret: two.secret, ids });
      expect([other.status, other.code]).toEqual([404, "not_found"]);
      await nextWindow();
      const again = await automationCall(f, "automation.projects.get", { secret: one.secret, ids });
      expect([again.status, again.code]).toEqual([404, "not_found"]);
    } finally {
      await clearAutomation(f);
    }
  }, 180_000);

  it("the 31st automation secret nobody can attribute from one source answers 429, its own credential included", async () => {
    const credential = await issueAutomationFor(f);
    try {
      const ids = { project: f.env("env1a").projectId };
      for (let i = 0; i < 30; i += 1) {
        const answer = await automationCall(f, "automation.projects.get", {
          secret: strangerSecret(AUTOMATION_SECRET_PREFIX, randomBytes(32)),
          ids,
        });
        expect([answer.status, answer.code], `miss ${String(i + 1)}`).toEqual([
          401,
          "unauthenticated",
        ]);
      }
      for (const secret of [
        strangerSecret(AUTOMATION_SECRET_PREFIX, randomBytes(32)),
        credential.secret,
      ]) {
        const refused = await automationCall(f, "automation.projects.get", { secret, ids });
        expect([refused.status, refused.code]).toEqual([429, "rate_limited"]);
      }
      await nextWindow();
      const served = await automationCall(f, "automation.projects.get", {
        secret: credential.secret,
        ids,
      });
      expect([served.status, served.code]).toEqual([404, "not_found"]);
    } finally {
      await clearAutomation(f);
    }
  }, 180_000);
});
