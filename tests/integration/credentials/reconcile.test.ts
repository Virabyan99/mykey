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
import { createPool } from "@mykey/db";
import {
  OpenBaoClient,
  appRoleLogin,
  machineName,
  namespaceFor,
  type IssuedToken,
} from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { reconcileCredentials } from "@mykey/operations/operator";
import { runOps } from "@mykey/ops";
import type { OrganizationId } from "@mykey/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { baoAnswer } from "../../harness/bao-raw.ts";
import {
  clearCredentials,
  createCredentialsFixture,
  expectCatalogMatchesBackend,
  issueFor,
  issueRuntimeFor,
  machineAccessors,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { exchangeCall } from "../../harness/machine.ts";
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

/**
 * reconcileCredentials as the command calls it, with the real stores, except
 * that a revoke of `silent`, and every lookup of it after one, is answered by a
 * timeout without being sent: the listing still sees the token, it stays alive
 * in OpenBao and its absence cannot be proven.
 */
async function reconcileWithSilent(env: EnvName, silent: string, executorsExcluded: boolean) {
  const pool = createPool(f.api.database.targets.maintenance, { max: 3 });
  const organizationId = f.tenants.a.organizationId as OrganizationId;
  const real = new OpenBaoClient(f.stack.bao, {
    namespace: namespaceFor(organizationId),
    token: f.stack.bao.rootToken,
  });
  const unanswered = { ok: false as const, kind: "unknown" as const, cause: "timeout" as const };
  let revokeTried = false;
  const bao = new Proxy(real, {
    get(target, property, receiver) {
      if (property === "tokenRevokeAccessor" || property === "tokenLookupAccessor") {
        return (accessor: string, ...rest: unknown[]) => {
          if (accessor === silent && property === "tokenRevokeAccessor") revokeTried = true;
          return accessor === silent && revokeTried
            ? Promise.resolve(unanswered)
            : (target[property] as (...args: unknown[]) => Promise<unknown>).call(
                target,
                accessor,
                ...rest,
              );
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  try {
    return await reconcileCredentials(
      {
        pool,
        admin: new OpenBaoAdmin(f.stack.bao, f.stack.bao.rootToken),
        bao,
        requestId: randomUUID(),
      },
      {
        scope: {
          organizationId,
          projectId: f.env(env).projectId,
          environmentId: envId(env),
        },
        executorsExcluded,
      },
    );
  } finally {
    await pool.end();
  }
}

describe("ops reconcile-credentials", () => {
  // Gate review, Critical 1 (Doc 10 §4.1 rule 11): exclusion ends a create that
  // may still arrive; it never settles a token that was found and not proven gone.
  it("excluded, but the issuance's own token was found and its revocation is unproven: the row stays needs_review (unproven), the token still works; a run with OpenBao answering settles it", async () => {
    const { operationId, credentialId } = await unresolvedIssuance("env1b", "after_create_sent");
    const [token] = await machineAccessors(f, envId("env1b"));
    expect(token?.meta?.operation_id).toBe(operationId);
    const result = await reconcileWithSilent("env1b", token!.accessor, true);
    if (result.kind !== "done") throw new Error(`reconcile answered ${result.kind}`);
    expect(result.issuancesSettled).toBe(0);
    expect(result.left.map((entry) => entry.reason)).toEqual(["unproven"]);
    expect(await stateOf(credentialId)).toBe("needs_review");
    expect((await operation(operationId))?.state).toBe("uncertain");
    expect((await machineAccessors(f, envId("env1b"))).length).toBe(1);
    expect((await f.issue("env1b")).code).toBe("state_conflict");

    const answered = await reconcile("env1b", ["--executors-excluded", "yes"]);
    expect(answered.code).toBe(0);
    expect(answered.out).toContain("issuances-settled 1");
    expect(await stateOf(credentialId)).toBe("revoked");
    expect(await machineAccessors(f, envId("env1b"))).toEqual([]);
  });

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
    const before = (await auditOf("env1b")).length;
    await issuerToken("env1b");
    expect((await reconcile("env1b")).code).toBe(0);
    const again = await reconcile("env1b");
    expect(again.code).toBe(0);
    expect(again.out).toContain("nothing to change");
    const audit = await auditOf("env1b");
    expect(audit).toHaveLength(before + 2);
    expect(audit.at(-1)?.details).toMatchObject({
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

  // Session 11 (Run 11.3, P-190): an exchanged token has no row of its own. It
  // is recorded by the runtime credential its meta names, while that
  // credential is active and unexpired; every other rule is unchanged.
  it("reconcile-credentials with a live exchanged token: nothing is revoked, nothing is left; after the credential is revoked, the same command revokes the token as unrecorded", async () => {
    const runtime = await issueRuntimeFor(f, "env1a");
    const exchange = await exchangeCall(f, { secret: runtime.clientSecret });
    expect(exchange.status, exchange.code ?? "").toBe(200);
    const token = exchange.body.token as string;
    // The controls: tokens that claim to be exchanged and name no usable credential.
    const expired = await issueRuntimeFor(f, "env1a");
    const ofExpired = await exchangeCall(f, { secret: expired.clientSecret });
    expect(ofExpired.status).toBe(200);
    await f.api.superuser.query(
      "UPDATE app.machine_credential SET effective_expires_at = now() - interval '1 second' WHERE id = $1",
      [expired.credentialId],
    );
    const ofNobody = await issuerToken("env1a", { credential_id: randomUUID(), exchange: "1" });
    // A token that names the live credential without saying it was exchanged is not exempt.
    const unmarked = await issuerToken("env1a", { credential_id: runtime.credentialId });

    const run = await reconcile("env1a");
    expect(run.code).toBe(0);
    expect(run.out).toContain("unrecorded-revoked 3");
    expect(run.out).toContain("revocations-completed 0");
    expect(run.out).toContain("issuances-settled 0");
    expect(await alive(token)).toBe(true);
    expect(await alive(ofExpired.body.token as string)).toBe(false);
    expect(await alive(ofNobody.token)).toBe(false);
    expect(await alive(unmarked.token)).toBe(false);
    expect(await stateOf(runtime.credentialId)).toBe("active");
    expect((await auditOf("env1a")).at(-1)).toMatchObject({
      outcome: "success",
      details: { unrecordedRevoked: 3, left: 0 },
    });
    // A second run finds nothing to do, and the token still reads.
    const again = await reconcile("env1a");
    expect(again.code).toBe(0);
    expect(again.out).toContain("unrecorded-revoked 0");
    expect(await alive(token)).toBe(true);
    for (const secret of [token, runtime.clientSecret, ofNobody.token, ofNobody.accessor]) {
      expect(run.out.includes(secret)).toBe(false);
    }

    // After the revocation nothing records the token: the operator's command ends it.
    expect((await f.revoke("env1a", runtime.credentialId)).status).toBe(200);
    const after = await reconcile("env1a");
    expect(after.code).toBe(0);
    expect(after.out).toContain("unrecorded-revoked 1");
    expect(await alive(token)).toBe(false);
  });

  it("usage: no --environment → 64; an unknown environment → 2", async () => {
    expect((await reconcile("not-a-uuid")).code).toBe(64);
    expect((await reconcile(randomUUID())).code).toBe(2);
  });
});
