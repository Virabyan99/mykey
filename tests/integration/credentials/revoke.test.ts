// Run 5.2 Task A (P-89, FR-1.42, D-40): revocation is denied in the product
// first — the credential `revoking` in a committed transaction before OpenBao
// is asked — and is called `revoked` only after a lookup proved the token gone.
// Tokens are compared by status codes and booleans only.
import { randomUUID } from "node:crypto";
import { environmentPrefix, OpenBaoClient, renderPolicy } from "@mykey/openbao";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearCredentials,
  createCredentialsFixture,
  expectCatalogMatchesBackend,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import type { EnvName } from "../../harness/secrets-fixture.ts";
import { baoAnswer } from "../../harness/bao-raw.ts";
import { readAuditLog } from "../../harness/stack.ts";

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
  await f.setUpstreamClosed(false);
  for (const env of ["env1a", "env1b", "env2a"] as const) {
    await clearCredentials(f, f.env(env).environmentId);
    await f.api.superuser.query(
      "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
      [f.env(env).environmentId],
    );
  }
});

/** The status OpenBao answers when the token lists its environment: 200 alive, 403 dead. */
async function tokenReads(env: EnvName, token: string): Promise<number> {
  const { projectId, environmentId } = f.env(env);
  const listed = await new OpenBaoClient(f.stack.bao, {
    namespace: f.fx.namespace,
    token,
  }).kvList(environmentPrefix(projectId, environmentId));
  if (listed.ok) return 200;
  return listed.kind === "not_found" ? 200 : "status" in listed ? listed.status : 0;
}

async function stateOf(credentialId: string): Promise<string | undefined> {
  return (
    await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE id = $1",
      [credentialId],
    )
  ).rows[0]?.state;
}

async function operationState(operationId: string) {
  return (
    await f.api.superuser.query<{ state: string; error_code: string | null }>(
      "SELECT state, error_code FROM app.operation WHERE id = $1",
      [operationId],
    )
  ).rows[0];
}

async function shown(env: EnvName, credentialId: string): Promise<string | undefined> {
  const answer = await f.send("GET", `${f.env(env).path}/credentials`, { key: null });
  const list = answer.body.credentials as { credentialId: string; state: string }[];
  return list.find((c) => c.credentialId === credentialId)?.state;
}

/** What OpenBao answers to a lookup of the credential's accessor (root token): 200 alive, 400 gone. */
async function accessorAnswers(credentialId: string): Promise<number> {
  const row = await f.api.superuser.query<{ accessor: string }>(
    "SELECT accessor FROM app.machine_credential WHERE id = $1",
    [credentialId],
  );
  const answer = await baoAnswer(
    f.stack,
    f.stack.bao.rootToken,
    "POST",
    "auth/token/lookup-accessor",
    { namespace: f.fx.namespace, body: { accessor: row.rows[0]!.accessor } },
  );
  return answer.status;
}

describe("revoke", () => {
  it("revoke: 200, the credential reads revoked, the accessor answers 400, the token is denied", async () => {
    const issued = await issueFor(f, "env1a", { ttlSeconds: 600 });
    expect(await tokenReads("env1a", issued.token)).toBe(200);
    const answer = await f.revoke("env1a", issued.credentialId);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      state: "succeeded",
      result: { credentialId: issued.credentialId, state: "revoked" },
    });
    expect(await stateOf(issued.credentialId)).toBe("revoked");
    expect(await shown("env1a", issued.credentialId)).toBe("revoked");
    expect(await accessorAnswers(issued.credentialId)).toBe(400);
    expect(await tokenReads("env1a", issued.token)).toBe(403);
    await expectCatalogMatchesBackend(f, f.env("env1a").environmentId);
  });

  it("the denied state is committed before the backend is asked", async () => {
    const issued = await issueFor(f, "env1a", { ttlSeconds: 600 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const atMarker = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.setFaults(async (point) => {
      if (point === "after_revoke_marker") {
        reached();
        await held;
      }
    });
    const pending = f.revoke("env1a", issued.credentialId);
    await atMarker;
    expect(await stateOf(issued.credentialId)).toBe("revoking");
    expect(await tokenReads("env1a", issued.token)).toBe(200);
    release();
    expect((await pending).status).toBe(200);
    expect(await tokenReads("env1a", issued.token)).toBe(403);
  });

  it("revoking is never shown as revoked; a new request finishes it and settles the first", async () => {
    const issued = await issueFor(f, "env1a", { ttlSeconds: 600 });
    f.setFaults((point) => {
      // The revoke passes; nothing comes back: neither its answer nor a lookup's.
      if (point === "after_revoke_marker") f.relay.setMode("hold");
    });
    const first = await f.revoke("env1a", issued.credentialId);
    expect(first.status).toBe(503);
    expect(first.code).toBe("outcome_unknown");
    expect(await stateOf(issued.credentialId)).toBe("revoking");
    f.setFaults(null);
    f.relay.setMode("pass");
    expect(await shown("env1a", issued.credentialId)).toBe("revoking");
    expect(await operationState(first.operationId!)).toMatchObject({ state: "uncertain" });
    const second = await f.revoke("env1a", issued.credentialId);
    expect(second.status).toBe(200);
    expect(await stateOf(issued.credentialId)).toBe("revoked");
    expect(await operationState(first.operationId!)).toMatchObject({ state: "succeeded" });
  });

  it("a refusal is not a revocation", async () => {
    const issued = await issueFor(f, "env1a", { ttlSeconds: 600 });
    const policy = renderPolicy("issuer");
    await f.admin.putPolicy(
      f.fx.namespace,
      "issuer",
      policy
        .split("\n")
        .filter((line) => !line.includes("auth/token/revoke-accessor"))
        .join("\n"),
    );
    let answer;
    try {
      answer = await f.revoke("env1a", issued.credentialId);
    } finally {
      await f.admin.putPolicy(f.fx.namespace, "issuer", policy);
    }
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("backend_inconsistent");
    expect(await operationState(answer.operationId!)).toMatchObject({
      state: "rejected",
      error_code: "backend_inconsistent",
    });
    expect(await stateOf(issued.credentialId)).toBe("revoking");
    // Nothing pretended: the token still works in OpenBao.
    expect(await tokenReads("env1a", issued.token)).toBe(200);
  });

  it("OpenBao unreachable for the revoke itself: rejected dependency_unavailable, the credential revoking", async () => {
    const issued = await issueFor(f, "env1a", { ttlSeconds: 600 });
    f.setFaults(async (point) => {
      if (point === "after_revoke_marker") await f.setUpstreamClosed(true);
    });
    const answer = await f.revoke("env1a", issued.credentialId);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("dependency_unavailable");
    expect(await operationState(answer.operationId!)).toMatchObject({
      state: "rejected",
      error_code: "dependency_unavailable",
    });
    expect(await stateOf(issued.credentialId)).toBe("revoking");
    await f.setUpstreamClosed(false);
    expect(await tokenReads("env1a", issued.token)).toBe(200);
  });

  it("an expired credential is revoked; a revoked one → 409; one in needs_review → 409 with the issuance's id", async () => {
    const expiring = await issueFor(f, "env1b", { ttlSeconds: 2 });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const expired = await f.revoke("env1b", expiring.credentialId);
    expect(expired.status).toBe(200);
    const again = await f.revoke("env1b", expiring.credentialId);
    expect(again.status).toBe(409);
    expect(again.code).toBe("state_conflict");
    f.setFaults((point) => {
      if (point === "after_marker") throw new Error("fault");
    });
    const unresolved = await f.issue("env1b");
    expect(unresolved.code).toBe("outcome_unknown");
    f.setFaults(null);
    const row = await f.api.superuser.query<{ id: string }>(
      "SELECT id FROM app.machine_credential WHERE issuance_operation_id = $1",
      [unresolved.operationId],
    );
    const review = await f.revoke("env1b", row.rows[0]!.id);
    expect(review.status).toBe(409);
    expect(review.code).toBe("state_conflict");
    expect(review.operationId).toBe(unresolved.operationId);
  });

  it("a second revoke while the first is executing → 409 with the first's id; a replay calls OpenBao once", async () => {
    const issued = await issueFor(f, "env1a", { ttlSeconds: 600 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const atMarker = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.setFaults(async (point) => {
      if (point === "after_revoke_marker") {
        reached();
        await held;
      }
    });
    const key = randomUUID();
    const pending = f.revoke("env1a", issued.credentialId, { key });
    await atMarker;
    const second = await f.revoke("env1a", issued.credentialId);
    release();
    const first = await pending;
    expect(second.status).toBe(409);
    expect(second.code).toBe("state_conflict");
    expect(second.operationId).toBe(first.body.operationId);
    f.setFaults(null);
    const replay = await f.revoke("env1a", issued.credentialId, { key });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const sent = (await readAuditLog(f.stack)).filter(
      (entry) =>
        entry.type === "request" &&
        entry.path === "auth/token/revoke-accessor" &&
        entry.headers["x-mykey-operation-id"]?.[0] === first.body.operationId,
    );
    expect(sent).toHaveLength(1);
  });

  it("revocation works in an environment that is in review, and in one that is archived", async () => {
    for (const state of ["needs_review", "archived"]) {
      const issued = await issueFor(f, "env2a", { ttlSeconds: 600 });
      await f.api.superuser.query(
        `UPDATE app.environment SET state = $2,
                review_reason = CASE WHEN $2 = 'needs_review' THEN 'backend_inconsistent' END
          WHERE id = $1`,
        [f.env("env2a").environmentId, state],
      );
      const answer = await f.revoke("env2a", issued.credentialId);
      expect(answer.status, state).toBe(200);
      expect(await tokenReads("env2a", issued.token)).toBe(403);
      await f.api.superuser.query(
        "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
        [f.env("env2a").environmentId],
      );
    }
  });

  it("who may revoke: owner and admin; a member is denied; another organization, or another environment's id, is hidden", async () => {
    const one = await issueFor(f, "env1a", { ttlSeconds: 600 });
    expect((await f.revoke("env1a", one.credentialId, { user: "adminA" })).status).toBe(200);
    const two = await issueFor(f, "env1a", { ttlSeconds: 600 });
    const denied = await f.revoke("env1a", two.credentialId, { user: "editorA" });
    expect(denied.status).toBe(403);
    expect(denied.code).toBe("action_denied");
    const hidden = await f.revoke("env1a", two.credentialId, { user: "ownerB" });
    expect(hidden.status).toBe(404);
    const other = await issueFor(f, "env1b", { ttlSeconds: 600 });
    const crossed = await f.revoke("env1a", other.credentialId);
    expect(crossed.status).toBe(404);
    expect(crossed.code).toBe("not_found");
    expect(await stateOf(other.credentialId)).toBe("active");
    expect((await f.revoke("env1a", "not-a-uuid")).status).toBe(404);
  });
});
