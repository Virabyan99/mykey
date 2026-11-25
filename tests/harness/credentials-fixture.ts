// The fixture of the credential suites (Run 5.1): the secrets fixture — A
// provisioned through the product, the API with A's runtime and issuer
// identities, OpenBao behind the TLS relay — plus helpers that issue through
// the route and read what OpenBao itself holds.
//
// Tokens never leave the helpers but in their return value; a failing
// assertion prints digests, counts or booleans (Doc 10 §4.1 rule 2).
import { randomUUID } from "node:crypto";
import type { Handler } from "@mykey/api";
import type { EnvironmentId, RouteDef } from "@mykey/contracts";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { machineName } from "@mykey/openbao";
import { expect } from "vitest";
import {
  createSecretsFixture,
  idleAdvisoryLocks,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "./secrets-fixture.ts";
import { baoAnswer } from "./bao-raw.ts";
import type { FixtureUser } from "./tenants.ts";

export type CredentialsFixture = SecretsFixture & {
  /** Every session of the test database becomes freshly verified (FR-1.77). */
  freshen(): Promise<void>;
  /** POST credentials with a fresh session (default owner, a new key). */
  issue(
    env: EnvName,
    body?: { name?: string; ttlSeconds?: number } | Record<string, unknown>,
    opts?: { user?: FixtureUser; key?: string; to?: "first" | "second"; fresh?: boolean },
  ): Promise<Answer>;
  /** POST credentials/:credential/revoke (Run 5.2), `{ confirmed: true }`, a new key. */
  revoke(
    env: EnvName,
    credentialId: string,
    opts?: { user?: FixtureUser; key?: string; to?: "first" | "second"; body?: unknown },
  ): Promise<Answer>;
  /**
   * POST runtime-credentials (Session 11) with a fresh session and a new key.
   * `path` issues in another environment than a named one (a place made by a test).
   */
  issueRuntime(
    env: EnvName,
    body?: Record<string, unknown>,
    opts?: { user?: FixtureUser; key?: string; fresh?: boolean; path?: string },
  ): Promise<Answer>;
  admin: OpenBaoAdmin;
};

export async function createCredentialsFixture(
  opts: {
    processes?: 1 | 2;
    runtime?: "ok" | "broken";
    /** More test-only routes. */
    routes?: readonly { def: RouteDef; handler: Handler }[];
    /** Run 6.1: a private stack with these override files (infra/compose/dev). */
    stackOverrides?: readonly string[];
    /** Run 6.3: the product's rate limits. */
    rateLimits?: "product";
    /** Run 7.3: the built workspace the in-process API serves. */
    webDirectory?: string;
    /** Run 11.3: the edge hop the in-process API trusts (secrets-fixture.ts). */
    trustedProxy?: string;
  } = {},
): Promise<CredentialsFixture> {
  const base = await createSecretsFixture({
    ...(opts.stackOverrides === undefined
      ? {}
      : { private: true, stackOverrides: opts.stackOverrides }),
    ...(opts.routes === undefined ? {} : { routes: opts.routes }),
    ...(opts.processes === undefined ? {} : { processes: opts.processes }),
    ...(opts.runtime === undefined ? {} : { runtime: opts.runtime }),
    ...(opts.rateLimits === undefined ? {} : { rateLimits: opts.rateLimits }),
    ...(opts.webDirectory === undefined ? {} : { webDirectory: opts.webDirectory }),
    ...(opts.trustedProxy === undefined ? {} : { trustedProxy: opts.trustedProxy }),
  });
  const admin = new OpenBaoAdmin(base.stack.bao, base.stack.bao.rootToken);
  const freshen = async (): Promise<void> => {
    await base.api.superuser.query("UPDATE auth.session SET totp_verified_at = now()");
  };
  return Object.assign<SecretsFixture, Omit<CredentialsFixture, keyof SecretsFixture>>(base, {
    admin,
    freshen,
    revoke(
      env: EnvName,
      credentialId: string,
      init: { user?: FixtureUser; key?: string; to?: "first" | "second"; body?: unknown } = {},
    ): Promise<Answer> {
      return base.send("POST", `${base.env(env).path}/credentials/${credentialId}/revoke`, {
        body: init.body ?? { confirmed: true },
        key: init.key ?? randomUUID(),
        ...(init.user === undefined ? {} : { user: init.user }),
        ...(init.to === undefined ? {} : { to: init.to }),
      });
    },
    async issueRuntime(
      env: EnvName,
      body: Record<string, unknown> = {},
      init: { user?: FixtureUser; key?: string; fresh?: boolean; path?: string } = {},
    ): Promise<Answer> {
      if (init.fresh !== false) await freshen();
      return base.send("POST", `${init.path ?? base.env(env).path}/runtime-credentials`, {
        body: { name: "server", ...body },
        key: init.key ?? randomUUID(),
        ...(init.user === undefined ? {} : { user: init.user }),
      });
    },
    async issue(
      env: EnvName,
      body: Record<string, unknown> = {},
      init: { user?: FixtureUser; key?: string; to?: "first" | "second"; fresh?: boolean } = {},
    ): Promise<Answer> {
      if (init.fresh !== false) await freshen();
      return base.send("POST", `${base.env(env).path}/credentials`, {
        body: { name: "deploy", ...body },
        key: init.key ?? randomUUID(),
        ...(init.user === undefined ? {} : { user: init.user }),
        ...(init.to === undefined ? {} : { to: init.to }),
      });
    },
  });
}

/** Issues one credential through the route and answers what a test needs; fails unless 201. */
export async function issueFor(
  fixture: CredentialsFixture,
  env: EnvName,
  body: { name?: string; ttlSeconds?: number } = {},
): Promise<{ credentialId: string; token: string; operationId: string }> {
  const answer = await fixture.issue(env, body);
  expect(answer.status, `issue: ${answer.code ?? ""}`).toBe(201);
  const credential = answer.body.credential as { credentialId: string };
  return {
    credentialId: credential.credentialId,
    token: answer.body.token as string,
    operationId: answer.body.operationId as string,
  };
}

/**
 * Issues one runtime credential through the route; fails unless 201. The
 * client secret leaves only in the return value (rule 2): a failing assertion
 * on it prints booleans and lengths.
 */
export async function issueRuntimeFor(
  fixture: CredentialsFixture,
  env: EnvName,
  body: Record<string, unknown> = {},
  opts: { path?: string } = {},
): Promise<{ credentialId: string; clientSecret: string; operationId: string; requestId: string }> {
  const answer = await fixture.issueRuntime(env, body, opts);
  expect(answer.status, `issue runtime: ${answer.code ?? ""}`).toBe(201);
  const credential = answer.body.credential as { credentialId: string };
  return {
    credentialId: credential.credentialId,
    clientSecret: answer.body.clientSecret as string,
    operationId: answer.body.operationId as string,
    requestId: answer.headers.get("x-request-id") ?? "",
  };
}

/**
 * The tokens OpenBao holds for an environment (root token): every accessor of
 * A's namespace whose policies name `machine-env-<environmentId>`. The login
 * tokens of the AppRoles are listed by OpenBao too and are left out by policy.
 */
export async function machineAccessors(
  fixture: SecretsFixture,
  environmentId: string,
): Promise<{ accessor: string; meta: Record<string, string> | null }[]> {
  const policy = machineName(environmentId as EnvironmentId);
  const admin = new OpenBaoAdmin(fixture.stack.bao, fixture.stack.bao.rootToken);
  const found: { accessor: string; meta: Record<string, string> | null }[] = [];
  for (const accessor of await admin.listAccessors(fixture.fx.namespace)) {
    const lookup = await baoAnswer(
      fixture.stack,
      fixture.stack.bao.rootToken,
      "POST",
      "auth/token/lookup-accessor",
      { namespace: fixture.fx.namespace, body: { accessor } },
    );
    if (lookup.status !== 200) continue; // gone between the list and the lookup
    const data = (lookup.body.data ?? {}) as { policies?: string[]; meta?: Record<string, string> };
    if (data.policies?.includes(policy) === true) {
      found.push({ accessor, meta: data.meta ?? null });
    }
  }
  return found;
}

/** Revokes a token by accessor with the root token (test clean-up). */
export async function rootRevoke(fixture: SecretsFixture, accessor: string): Promise<void> {
  const answer = await baoAnswer(
    fixture.stack,
    fixture.stack.bao.rootToken,
    "POST",
    "auth/token/revoke-accessor",
    { namespace: fixture.fx.namespace, body: { accessor } },
  );
  expect([200, 204]).toContain(answer.status);
}

/**
 * The invariant every credential test ends with (Review focus 1): every token
 * OpenBao holds for the environment is the accessor of an `active`, unexpired
 * row, and every such row's token exists; no advisory lock is left.
 */
export async function expectCatalogMatchesBackend(
  fixture: SecretsFixture,
  environmentId: string,
): Promise<void> {
  // Session 11: a runtime row holds no token of its own, so it names none here.
  const rows = await fixture.api.superuser.query<{ accessor: string }>(
    `SELECT accessor FROM app.machine_credential
      WHERE environment_id = $1 AND state = 'active' AND effective_expires_at > now()
        AND kind = 'token'`,
    [environmentId],
  );
  const catalog = rows.rows.map((row) => row.accessor).sort();
  const backend = (await machineAccessors(fixture, environmentId)).map((t) => t.accessor).sort();
  // Accessors are not secrets, but the comparison prints counts only.
  expect(backend.length, "tokens in OpenBao").toBe(catalog.length);
  expect(
    backend.every((accessor, index) => accessor === catalog[index]),
    "the same accessors",
  ).toBe(true);
  expect(await idleAdvisoryLocks(fixture), "advisory locks of idle connections").toBe(0);
}

/**
 * Test clean-up: every token of the environment revoked with the root token
 * and every row of it closed by the superuser, so the next test starts from a
 * catalog that matches the backend and no unresolved issuance.
 */
export async function clearCredentials(
  fixture: SecretsFixture,
  environmentId: string,
): Promise<void> {
  for (const { accessor } of await machineAccessors(fixture, environmentId)) {
    await rootRevoke(fixture, accessor);
  }
  await fixture.api.superuser.query(
    "UPDATE app.machine_credential SET state = 'revoked' WHERE environment_id = $1",
    [environmentId],
  );
}
