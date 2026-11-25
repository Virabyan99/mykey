// Run 5.5 Task B (P-97 layer 3, FR-1.47, FR-1.79): the CLI's own client module
// against the real API of the fixture (real PostgreSQL and OpenBao). Every
// body the API sends passes the CLI's validators, the values' digests equal
// the owner's export, and refusals come back as the CLI's categories with the
// server's request id. Tokens are locals; values are compared by digest.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CliError, createClient, type ApiClient, type Selector } from "@mykey/cli";
import { API_MAJOR } from "@mykey/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  issueRuntimeFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { ENV_NAMES, digestOf, exportDigests } from "../../harness/machine.ts";
import { idleAdvisoryLocks, type EnvName } from "../../harness/secrets-fixture.ts";

let f: CredentialsFixture;
let client: ApiClient;

beforeAll(async () => {
  f = await createCredentialsFixture();
  client = createClient(new URL(f.api.baseUrl), {
    extraCa: readFileSync(f.stack.api.certAuthorityPath, "utf8"),
  });
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setFaults(null);
  expect(await idleAdvisoryLocks(f)).toBe(0);
});

const selectorOf = (env: EnvName): Selector => ({
  project: f.env(env).projectId,
  env: ENV_NAMES[env],
});
const unique = (): string => `C_${randomBytes(5).toString("hex").toUpperCase()}`;

async function refusal(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("the call succeeded");
}

describe("the CLI's client against the real API", () => {
  it("version answers the CLI's major", async () => {
    expect(await client.version()).toEqual({ apiMajor: API_MAJOR });
  });

  it("keys and resolve of a seeded environment pass the CLI's validators; the digests equal the owner's export", async () => {
    const names = [unique(), unique(), unique()];
    for (const name of names) {
      const answer = await f.create("env1a", name, `synthetic-${randomUUID()}`);
      expect(answer.status).toBe(201);
    }
    const { token } = await issueFor(f, "env1a");
    const keys = await client.keys(selectorOf("env1a"), token);
    for (const name of names) expect(keys.names).toContain(name);
    expect(keys.count).toBe(keys.names.length);

    const resolved = await client.resolve(selectorOf("env1a"), token);
    expect(resolved.entries.map((entry) => entry.name)).toEqual(keys.names);
    const digests = new Map(resolved.entries.map((entry) => [entry.name, digestOf(entry.value)]));
    expect(digests).toEqual(await exportDigests(f, "env1a"));
  });

  it("a revoked token → denied with a request id", async () => {
    const { token, credentialId } = await issueFor(f, "env1a");
    const revoked = await f.revoke("env1a", credentialId);
    expect(revoked.status).toBe(200);
    const error = await refusal(() => client.keys(selectorOf("env1a"), token));
    expect([error.category, error.code]).toEqual(["denied", "unauthenticated"]);
    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the token of 1a on 1b's path → denied", async () => {
    const { token } = await issueFor(f, "env1a");
    const error = await refusal(() => client.resolve(selectorOf("env1b"), token));
    expect([error.category, error.code]).toEqual(["denied", "not_found"]);
    expect(error.requestId).not.toBeNull();
  });

  // Run 11.4 (Session 11, P-187): what `secrets run` does with a runtime
  // credential, on the real API. The process itself runs in tests/cli.
  it("a runtime credential: the client's exchange, then resolve with its token, gives all 25 entries; revoked, the exchange is denied with a request id", async () => {
    await f.seedEnvironment("env2a", 25, 64);
    const { clientSecret, credentialId } = await issueRuntimeFor(f, "env2a");
    const exchanged = await client.exchange(clientSecret);
    expect(Object.keys(exchanged)).toEqual(["token"]);
    const resolved = await client.resolve(selectorOf("env2a"), exchanged.token);
    expect(resolved.count).toBe(25);
    const digests = new Map(resolved.entries.map((entry) => [entry.name, digestOf(entry.value)]));
    expect(digests).toEqual(await exportDigests(f, "env2a"));
    // The client secret is not a machine token.
    const direct = await refusal(() => client.resolve(selectorOf("env2a"), clientSecret));
    expect([direct.category, direct.code]).toEqual(["denied", "unauthenticated"]);

    const revoked = await f.revoke("env2a", credentialId);
    expect(revoked.status).toBe(200);
    const error = await refusal(() => client.exchange(clientSecret));
    expect([error.category, error.code]).toEqual(["denied", "unauthenticated"]);
    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const after = await refusal(() => client.resolve(selectorOf("env2a"), exchanged.token));
    expect([after.category, after.code]).toEqual(["denied", "unauthenticated"]);
  });

  it("a held slot → unavailable with code key_under_review", async () => {
    const { token } = await issueFor(f, "env1b");
    f.setFaults((point) => {
      if (point === "after_send") throw new Error("fault: the answer is lost");
    });
    const write = await f.create("env1b", unique(), `synthetic-${randomUUID()}`);
    f.setFaults(null);
    expect(write.code).toBe("outcome_unknown");
    for (const call of [
      () => client.keys(selectorOf("env1b"), token),
      () => client.resolve(selectorOf("env1b"), token),
    ]) {
      const error = await refusal(call);
      expect([error.category, error.code]).toEqual(["unavailable", "key_under_review"]);
    }
  });
});
