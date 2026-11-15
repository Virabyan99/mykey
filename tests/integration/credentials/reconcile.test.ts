// Run 5.2 Task C (P-90, FR-1.43, D-40): `ops reconcile-credentials` settles an
// environment's credentials from the backend. A token with the environment's
// machine policy that no live row names is revoked and proven gone; a
// `revoking` row is finished; a `needs_review` issuance is closed only when its
// token was found (by the operation id in its meta) or the executors are
// excluded — otherwise exit 3. The AppRole login tokens of the namespace are in
// the accessor list too and are left alone. The output holds ids and counts:
// never an accessor or a token (compared here by booleans only).
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { issuerBaoFromDirectory } from "@mykey/api";
import { appRoleLogin, machineName, type IssuedToken } from "@mykey/openbao";
import { runOps } from "@mykey/ops";
import type { OrganizationId } from "@mykey/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { baoAnswer } from "../../harness/bao-raw.ts";
import {
  clearCredentials,
  createCredentialsFixture,
  expectCatalogMatchesBackend,
  issueFor,
  machineAccessors,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import type { EnvName } from "../../harness/secrets-fixture.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setFaults(null);
  f.relay.setMode("pass");
  for (const env of ["env1a", "env1b", "env2a"] as const) {
    await clearCredentials(f, f.env(env).environmentId);
  }
});

const envId = (env: EnvName) => f.env(env).environmentId;

/** Everything the command printed, and its exit code. `env` is a fixture name or a raw id. */
async function reconcile(
  env: string,
  extra: string[] = [],
): Promise<{ code: number; out: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  stdout.on("data", (chunk: Buffer) => (out += String(chunk)));
  stderr.on("data", (chunk: Buffer) => (out += String(chunk)));
  const stdin = new PassThrough();
  stdin.end();
  const id = env.startsWith("env") ? envId(env as EnvName) : env;
  const code = await runOps(["reconcile-credentials", "--environment", id, ...extra], {
    stdin,
    stdout,
    stderr,
    env: {
      database: f.api.database.targets.maintenance,
      openBao: { target: f.stack.bao, rootToken: f.stack.bao.rootToken },
    },
  });
  return { code, out };
}

/** A token of the environment's machine role made with the issuer identity, as an executor would. */
async function issuerToken(env: EnvName, meta?: Record<string, string>): Promise<IssuedToken> {
  const issuer = issuerBaoFromDirectory(f.stack.bao, f.secretsDirectory);
  const opened = await issuer.open(f.tenants.a.organizationId as OrganizationId);
  if (!opened?.ok) throw new Error("issuer session failed");
  try {
    const made = await opened.data.client.tokenCreateFromRole(
      machineName(envId(env)),
      600,
      { operationId: randomUUID(), dispatchId: randomUUID() },
      meta,
    );
    if (!made.ok) throw new Error("token create failed");
    return made.data;
  } finally {
    await opened.data.close();
  }
}

/** lookup-self with the token: 200 alive, 403 dead. */
async function alive(token: string): Promise<boolean> {
  const answer = await baoAnswer(f.stack, token, "GET", "auth/token/lookup-self", {
    namespace: f.fx.namespace,
  });
  return answer.status === 200;
}

const stateOf = async (credentialId: string): Promise<string | undefined> =>
  (
    await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE id = $1",
      [credentialId],
    )
  ).rows[0]?.state;

const operation = async (operationId: string) =>
  (
    await f.api.superuser.query<{
      state: string;
      error_code: string | null;
      completed_at: Date | null;
    }>("SELECT state, error_code, completed_at FROM app.operation WHERE id = $1", [operationId])
  ).rows[0];

const credentialOf = async (operationId: string): Promise<string> =>
  (
    await f.api.superuser.query<{ id: string }>(
      "SELECT id FROM app.machine_credential WHERE issuance_operation_id = $1",
      [operationId],
    )
  ).rows[0]!.id;

const auditOf = async (env: EnvName) =>
  (
    await f.api.superuser.query<{ details: Record<string, unknown>; outcome: string }>(
      `SELECT details, outcome FROM audit.event
        WHERE action = 'operator.reconcile_credentials' AND target_id = $1
        ORDER BY occurred_at, id`,
      [envId(env)],
    )
  ).rows;

/** An issuance left unresolved (needs_review / uncertain) by a fault at `point`. */
async function unresolvedIssuance(
  env: EnvName,
  point: "after_marker" | "after_create_sent",
): Promise<{ operationId: string; credentialId: string }> {
  f.setFaults((at) => {
    if (at === point) throw new Error("fault");
  });
  const answer = await f.issue(env);
  f.setFaults(null);
  expect(answer.code).toBe("outcome_unknown");
  const operationId = answer.operationId!;
  const credentialId = await credentialOf(operationId);
  expect(await stateOf(credentialId)).toBe("needs_review");
  return { operationId, credentialId };
}

describe("ops reconcile-credentials", () => {
  it("a token with the environment's machine policy that no row names is revoked and counted; an active credential and the AppRole login tokens are left alone", async () => {
    const active = await issueFor(f, "env1a", { ttlSeconds: 600 });
    const stray = await issuerToken("env1a");
    const runtime = f.fx.credentials.runtime;
    const login = await appRoleLogin(f.stack.bao, f.fx.namespace, runtime.roleId, runtime.secretId);
    if (!login.ok) throw new Error("runtime login failed");
    expect(await alive(stray.token)).toBe(true);
    expect((await machineAccessors(f, envId("env1a"))).length).toBe(2);

    const run = await reconcile("env1a");
    expect(run.code).toBe(0);
    expect(run.out).toContain("unrecorded-revoked 1");
    expect(run.out).toContain("revocations-completed 0");
    expect(run.out).toContain("issuances-settled 0");
    expect(await alive(stray.token)).toBe(false);
    // The active credential is untouched and its token still reads.
    expect(await stateOf(active.credentialId)).toBe("active");
    expect(await alive(active.token)).toBe(true);
    // The login token of the runtime AppRole was listed and left alone; the API still works.
    expect(await alive(login.data.token)).toBe(true);
    expect(
      (await f.create("env1a", `RC_${randomUUID().slice(0, 8).toUpperCase()}`, "x")).status,
    ).toBe(201);
    await expectCatalogMatchesBackend(f, envId("env1a"));
    // Ids and counts only.
    for (const secret of [stray.token, stray.accessor, active.token, login.data.token]) {
      expect(run.out.includes(secret)).toBe(false);
    }
    const audit = await auditOf("env1a");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      outcome: "success",
      details: {
        unrecordedRevoked: 1,
        revocationsCompleted: 0,
        issuancesSettled: 0,
        left: 0,
        executorsExcluded: false,
      },
    });
  });

  it("a second run changes nothing and says so; it writes one more audit row", async () => {
    await issuerToken("env1b");
    expect((await reconcile("env1b")).code).toBe(0);
    const again = await reconcile("env1b");
    expect(again.code).toBe(0);
    expect(again.out).toContain("nothing to change");
    const audit = await auditOf("env1b");
    expect(audit).toHaveLength(2);
    expect(audit[1]?.details).toMatchObject({
      unrecordedRevoked: 0,
      revocationsCompleted: 0,
      issuancesSettled: 0,
      left: 0,
    });
  });

  it("needs_review with no token found: exit 3 without --executors-excluded and nothing changes; with it → revoked and rejected; then a new issuance → 201", async () => {
    const { operationId, credentialId } = await unresolvedIssuance("env2a", "after_marker");
    const refused = await reconcile("env2a");
    expect(refused.code).toBe(3);
    expect(refused.out).toContain(`left ${credentialId} needs_exclusion`);
    expect(refused.out).toContain("--executors-excluded yes");
    expect(await stateOf(credentialId)).toBe("needs_review");
    expect((await operation(operationId))?.state).toBe("uncertain");
    expect((await f.issue("env2a")).code).toBe("state_conflict");

    const settled = await reconcile("env2a", ["--executors-excluded", "yes"]);
    expect(settled.code).toBe(0);
    expect(settled.out).toContain("issuances-settled 1");
    expect(await stateOf(credentialId)).toBe("revoked");
    expect(await operation(operationId)).toMatchObject({
      state: "rejected",
      error_code: "dependency_unavailable",
    });
    expect((await operation(operationId))?.completed_at).not.toBeNull();
    const next = await f.issue("env2a");
    expect(next.status).toBe(201);
    await expectCatalogMatchesBackend(f, envId("env2a"));
    const audit = await auditOf("env2a");
    expect(audit.map((row) => row.details.left)).toEqual([1, 0]);
    expect(audit.map((row) => row.details.executorsExcluded)).toEqual([false, true]);
  });

  it("needs_review whose token is found by its operation id: revoked, settled without the flag, exit 0", async () => {
    const { operationId, credentialId } = await unresolvedIssuance("env1a", "after_create_sent");
    const tokens = await machineAccessors(f, envId("env1a"));
    expect(tokens.map((t) => t.meta?.operation_id)).toEqual([operationId]);
    const run = await reconcile("env1a");
    expect(run.code).toBe(0);
    expect(run.out).toContain("unrecorded-revoked 1");
    expect(run.out).toContain("issuances-settled 1");
    expect(await machineAccessors(f, envId("env1a"))).toEqual([]);
    expect(await stateOf(credentialId)).toBe("revoked");
    expect(await operation(operationId)).toMatchObject({
      state: "rejected",
      error_code: "dependency_unavailable",
    });
    expect(run.out.includes(tokens[0]!.accessor)).toBe(false);
  });

  it("a revoking credential is revoked again, proven, and its revocations succeed", async () => {
    const issued = await issueFor(f, "env1b", { ttlSeconds: 600 });
    f.setFaults((point) => {
      // Nothing comes back from OpenBao: the revocation cannot be proven.
      if (point === "after_revoke_marker") f.relay.setMode("drop");
    });
    const first = await f.revoke("env1b", issued.credentialId);
    f.setFaults(null);
    f.relay.setMode("pass");
    expect(first.code).toBe("outcome_unknown");
    expect(await stateOf(issued.credentialId)).toBe("revoking");
    const run = await reconcile("env1b");
    expect(run.code).toBe(0);
    expect(run.out).toContain("revocations-completed 1");
    expect(run.out).toContain("unrecorded-revoked 0");
    expect(await stateOf(issued.credentialId)).toBe("revoked");
    expect(await operation(first.operationId!)).toMatchObject({ state: "succeeded" });
    expect(await alive(issued.token)).toBe(false);
  });

  it("usage: no --environment → 64; an unknown environment → 2", async () => {
    expect((await reconcile("not-a-uuid")).code).toBe(64);
    expect((await reconcile(randomUUID())).code).toBe(2);
  });
});
