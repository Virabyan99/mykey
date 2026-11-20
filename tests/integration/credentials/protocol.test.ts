// Run 5.1 Task B (P-86, P-87, D-40): the issuance protocol through the route.
// The marker commits the credential `issuing` and the operation `executing`
// before the one create; a failure after it delivers nothing and leaves the
// issuance unresolved, which blocks the next one for that environment; a
// token that cannot be delivered is revoked and its absence proven.
//
// Tokens are compared by booleans and counts only.
import { randomUUID } from "node:crypto";
import { renderPolicy, machineTokenRole } from "@mykey/openbao";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  f = await createCredentialsFixture({ processes: 2 });
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setFaults(null);
  f.setBao("relay");
  for (const env of ["env1a", "env1b", "env2a"] as const) {
    await clearCredentials(f, f.env(env).environmentId);
    await reopen(env);
  }
});

const envId = (env: EnvName) => f.env(env).environmentId;

/** The operator clears a review and puts a resource back to active (superuser). */
async function reopen(env: EnvName): Promise<void> {
  await f.api.superuser.query(
    "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
    [envId(env)],
  );
}

async function credentialOf(operationId: string) {
  const result = await f.api.superuser.query<{
    state: string;
    accessor: string | null;
    effective_expires_at: Date | null;
  }>(
    "SELECT state, accessor, effective_expires_at FROM app.machine_credential WHERE issuance_operation_id = $1",
    [operationId],
  );
  return result.rows[0] ?? null;
}

async function operationOf(operationId: string) {
  const result = await f.api.superuser.query<{ state: string; error_code: string | null }>(
    "SELECT state, error_code FROM app.operation WHERE id = $1",
    [operationId],
  );
  return result.rows[0] ?? null;
}

async function rowsOf(env: EnvName): Promise<{ state: string }[]> {
  return (
    await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE environment_id = $1",
      [envId(env)],
    )
  ).rows;
}

async function environmentState(env: EnvName): Promise<string | undefined> {
  return (
    await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.environment WHERE id = $1",
      [envId(env)],
    )
  ).rows[0]?.state;
}

describe("after the marker nothing is delivered", () => {
  for (const point of [
    "after_marker",
    "after_create_sent",
    "after_verify",
    "before_finalize_commit",
  ]) {
    it(`a throw at ${point} answers 503 outcome_unknown with the operation id`, async () => {
      f.setFaults((at) => {
        if (at === point) throw new Error("fault");
      });
      const answer = await f.issue("env1a");
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("outcome_unknown");
      expect(answer.operationId).toBeDefined();
      expect("token" in answer.body).toBe(false);
      expect(await credentialOf(answer.operationId!)).toMatchObject({ state: "needs_review" });
      expect(await operationOf(answer.operationId!)).toMatchObject({ state: "uncertain" });
      // Whether a token exists depends on the point; none is named by an active row.
      const tokens = await machineAccessors(f, envId("env1a"));
      expect(tokens.length).toBe(point === "after_marker" ? 0 : 1);
      if (tokens.length === 1) expect(tokens[0]!.meta?.operation_id).toBe(answer.operationId);
    });
  }
});

describe("the record", () => {
  it("an unresolved issuance blocks the next one for that environment and no other", async () => {
    f.setFaults((at) => {
      if (at === "after_marker") throw new Error("fault");
    });
    const first = await f.issue("env1a");
    expect(first.code).toBe("outcome_unknown");
    f.setFaults(null);
    const blocked = await f.issue("env1a");
    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe("state_conflict");
    expect(blocked.operationId).toBe(first.operationId);
    const other = await f.issue("env1b");
    expect(other.status).toBe(201);
    await clearCredentials(f, envId("env1a"));
    await expectCatalogMatchesBackend(f, envId("env1b"));
  });

  it("two issuances for one environment at once never leave two rows issuing", async () => {
    for (let round = 0; round < 20; round += 1) {
      await f.freshen();
      const answers = await Promise.all([
        f.issue("env1a", {}, { fresh: false }),
        f.issue("env1a", {}, { fresh: false, to: "second" }),
      ]);
      const statuses = answers.map((a) => (a.status === 201 ? "active" : (a.code ?? "?"))).sort();
      expect(
        statuses.join(",") === "active,active" || statuses.join(",") === "active,busy",
        `round ${String(round)}: ${statuses.join(",")}`,
      ).toBe(true);
      const issuing = (await rowsOf("env1a")).filter((row) => row.state === "issuing");
      expect(issuing).toHaveLength(0);
    }
    await expectCatalogMatchesBackend(f, envId("env1a"));
  });

  // Run 8.3 Step 1 (AC-1.40, "replacement races leave no escaped active
  // token"): replace-by-revoke with both requests at once, on two processes.
  it("a replacement issued while the old credential is revoked (20 rounds): the new one active, the old one revoked, no other token in the backend", async () => {
    let old = await issueFor(f, "env1a");
    for (let round = 0; round < 20; round += 1) {
      await f.freshen();
      const [issued, revoked] = await Promise.all([
        f.issue("env1a", {}, { fresh: false, to: round % 2 === 0 ? "first" : "second" }),
        f.revoke("env1a", old.credentialId, { to: round % 2 === 0 ? "second" : "first" }),
      ]);
      expect(issued.status, `round ${String(round)}: issue ${issued.code ?? ""}`).toBe(201);
      expect(revoked.status, `round ${String(round)}: revoke ${revoked.code ?? ""}`).toBe(200);
      const rows = (
        await f.api.superuser.query<{ id: string; state: string }>(
          "SELECT id, state FROM app.machine_credential WHERE environment_id = $1",
          [envId("env1a")],
        )
      ).rows;
      const fresh = (issued.body.credential as { credentialId: string }).credentialId;
      expect(rows.filter((row) => row.state === "active").map((row) => row.id)).toEqual([fresh]);
      expect(rows.find((row) => row.id === old.credentialId)?.state).toBe("revoked");
      await expectCatalogMatchesBackend(f, envId("env1a"));
      old = {
        credentialId: fresh,
        token: issued.body.token as string,
        operationId: issued.body.operationId as string,
      };
    }
  });

  it("as api_runtime: a second issuing row for one environment is refused by the database", async () => {
    const operation = randomUUID();
    const scope = f.env("env1a");
    const insert = (state: string) =>
      f.api.pool.query(
        `INSERT INTO app.machine_credential (id, organization_id, project_id, environment_id, name,
           issuance_operation_id, requested_expires_at, state, issued_by)
         VALUES ($1, $2, $3, $4, 'x', $5, now() + interval '1 hour', $6, $7)`,
        [
          randomUUID(),
          f.tenants.a.organizationId,
          scope.projectId,
          scope.environmentId,
          operation,
          state,
          f.tenants.userId("ownerA"),
        ],
      );
    await insert("issuing");
    await expect(insert("issuing")).rejects.toMatchObject({ code: "23505" });
    await expect(insert("needs_review")).rejects.toMatchObject({ code: "23505" });
    await expect(insert("lost")).rejects.toMatchObject({ code: "23514" });
    await expect(
      f.api.pool.query("DELETE FROM app.machine_credential WHERE environment_id = $1", [
        scope.environmentId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      f.api.pool.query("UPDATE app.machine_credential SET name = 'y' WHERE environment_id = $1", [
        scope.environmentId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the backend says no, or the token is wrong", () => {
  it("a refused create leaves no token and frees the environment", async () => {
    const issuerPolicy = renderPolicy("issuer");
    const withoutCreate = issuerPolicy
      .split("\n")
      .filter((line) => !line.includes("auth/token/create/"))
      .join("\n");
    await f.admin.putPolicy(f.fx.namespace, "issuer", withoutCreate);
    let answer;
    try {
      answer = await f.issue("env1a");
    } finally {
      await f.admin.putPolicy(f.fx.namespace, "issuer", issuerPolicy);
    }
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("backend_inconsistent");
    expect(await operationOf(answer.operationId!)).toMatchObject({
      state: "rejected",
      error_code: "backend_inconsistent",
    });
    expect(await credentialOf(answer.operationId!)).toMatchObject({
      state: "revoked",
      accessor: null,
    });
    expect(await environmentState("env1a")).toBe("needs_review");
    const drift = await f.api.superuser.query(
      `SELECT 1 FROM audit.event WHERE action = 'system.drift_detected' AND target_id = $1
         AND request_id = (SELECT request_id FROM audit.event WHERE operation_id = $2 LIMIT 1)`,
      [envId("env1a"), answer.operationId],
    );
    expect(drift.rowCount).toBe(1);
    expect(await machineAccessors(f, envId("env1a"))).toEqual([]);
    await reopen("env1a");
    const again = await f.issue("env1a");
    expect(again.status).toBe(201);
    await expectCatalogMatchesBackend(f, envId("env1a"));
  });

  it("a token that is not what was asked for is revoked, not delivered", async () => {
    const role = machineTokenRole(envId("env1a"));
    const name = `machine-env-${envId("env1a")}`;
    await f.admin.putTokenRole(f.fx.namespace, name, { ...role, renewable: true } as never);
    let answer;
    try {
      answer = await f.issue("env1a");
    } finally {
      await f.admin.putTokenRole(f.fx.namespace, name, role);
    }
    expect(answer.status).not.toBe(201);
    expect("token" in answer.body).toBe(false);
    expect(answer.code).toBe("backend_inconsistent");
    expect(await operationOf(answer.operationId!)).toMatchObject({ state: "rejected" });
    expect(await credentialOf(answer.operationId!)).toMatchObject({ state: "revoked" });
    expect(await machineAccessors(f, envId("env1a"))).toEqual([]);
    expect(await environmentState("env1a")).toBe("needs_review");
  });

  it("an archive that took precedence wins", async () => {
    f.setFaults(async (at) => {
      if (at === "after_verify") {
        await f.api.superuser.query("UPDATE app.environment SET state = 'revoking' WHERE id = $1", [
          envId("env1a"),
        ]);
      }
    });
    const answer = await f.issue("env1a");
    expect(answer.status).toBe(409);
    expect(answer.code).toBe("state_conflict");
    expect("token" in answer.body).toBe(false);
    expect(await machineAccessors(f, envId("env1a"))).toEqual([]);
    expect(await credentialOf(answer.operationId!)).toMatchObject({ state: "revoked" });
    expect(await operationOf(answer.operationId!)).toMatchObject({
      state: "rejected",
      error_code: "state_conflict",
    });
  });
});

describe("before the marker", () => {
  it("the environment's lock is held by a writer: 503 busy and no credential row", async () => {
    await f.restartSecond({ point: "after_dispatch_marker", action: "hang" });
    try {
      const secret = `HANG_${randomUUID().slice(0, 8).toUpperCase()}`;
      void f.create("env2a", secret, "synthetic", { to: "second" }).catch(() => undefined);
      // The writer holds the lock once its dispatch marker is committed.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const marked = await f.api.superuser.query(
          "SELECT 1 FROM app.operation WHERE secret_name = $1 AND state = 'executing'",
          [secret],
        );
        if ((marked.rowCount ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("the writer never reached its marker");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const before = (await rowsOf("env2a")).length;
      const answer = await f.issue("env2a");
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("busy");
      expect((await rowsOf("env2a")).length).toBe(before);
    } finally {
      // The hung request holds a pooled connection: a clean stop would wait for it.
      await f.second?.kill("SIGKILL");
      await f.restartSecond();
    }
    // The hung write is the second process's: it stays executing, its slot held; not this suite's concern.
    await f.api.superuser.query("DELETE FROM app.effect_slot WHERE scope_key = $1", [
      `env:${envId("env2a")}`,
    ]);
  });

  it("the issuer login fails: 503 dependency_unavailable, no operation, no credential row", async () => {
    const before = (await rowsOf("env1b")).length;
    f.setBao("closed");
    const key = randomUUID();
    const answer = await f.issue("env1b", {}, { key });
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("dependency_unavailable");
    expect((await rowsOf("env1b")).length).toBe(before);
    const operations = await f.api.superuser.query(
      "SELECT 1 FROM app.operation WHERE idempotency_key = $1",
      [key],
    );
    expect(operations.rowCount).toBe(0);
  });
});
