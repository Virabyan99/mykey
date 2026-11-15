// Run 5.1 Task C (FR-1.39, FR-1.41, FR-1.43, P-88): credentials.issue through
// the API. The token is shown once, in the 201; a replay never shows it again.
// Tokens are compared by booleans, lengths and digests only.
import { randomBytes, randomUUID } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import { OpenBaoClient, environmentPrefix, machineTokenRole } from "@mykey/openbao";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { baoAnswer } from "../../harness/bao-raw.ts";
import {
  clearCredentials,
  createCredentialsFixture,
  expectCatalogMatchesBackend,
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
  for (const env of ["env1a", "env1b", "env2a"] as const) {
    await clearCredentials(f, f.env(env).environmentId);
    await f.api.superuser.query(
      "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
      [f.env(env).environmentId],
    );
  }
});

const envId = (env: EnvName) => f.env(env).environmentId;

async function rowCount(env: EnvName): Promise<number> {
  const result = await f.api.superuser.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM app.machine_credential WHERE environment_id = $1",
    [envId(env)],
  );
  return result.rows[0]?.count ?? 0;
}

async function backendExpiry(token: string): Promise<number> {
  const lookup = await baoAnswer(f.stack, token, "GET", "auth/token/lookup-self", {
    namespace: f.fx.namespace,
  });
  expect(lookup.status).toBe(200);
  return Date.parse((lookup.body.data as { expire_time: string }).expire_time);
}

describe("issue", () => {
  it("the owner with a fresh code issues: 201, no-store, a token once", async () => {
    const name = `CHECK_${randomBytes(4).toString("hex").toUpperCase()}`;
    expect((await f.create("env1a", name, "synthetic")).status).toBe(201);
    const answer = await f.issue("env1a");
    expect(answer.status).toBe(201);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const token = answer.body.token as string;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(answer.body.credential).toMatchObject({
      state: "active",
      environmentId: envId("env1a"),
    });
    // The token is real: it lists its environment's names directly in OpenBao.
    const { projectId, environmentId } = f.env("env1a");
    const listed = await new OpenBaoClient(f.stack.bao, {
      namespace: f.fx.namespace,
      token,
    }).kvList(environmentPrefix(projectId, environmentId));
    expect(listed.ok && listed.data.names.includes(name)).toBe(true);
    await expectCatalogMatchesBackend(f, envId("env1a"));
  });

  it("ttlSeconds: out of range → 422, not an integer → 400; absent → the maximum", async () => {
    const before = await rowCount("env1a");
    for (const ttlSeconds of [0, -1, LIMITS.machineToken.maxTtlSeconds + 1]) {
      const answer = await f.issue("env1a", { ttlSeconds });
      expect(answer.status, JSON.stringify(ttlSeconds)).toBe(422);
      expect(answer.code).toBe("validation_failed");
    }
    // A value of the wrong type is 400 malformed_request (validate.ts, Doc 06 §9).
    for (const ttlSeconds of [1.5, "60"]) {
      const answer = await f.issue("env1a", { ttlSeconds });
      expect(answer.status, JSON.stringify(ttlSeconds)).toBe(400);
      expect(answer.code).toBe("malformed_request");
    }
    expect(await rowCount("env1a")).toBe(before);
    const answer = await f.issue("env1a");
    expect(answer.status).toBe(201);
    const expiresAt = Date.parse((answer.body.credential as { expiresAt: string }).expiresAt);
    const expected = Date.now() + LIMITS.machineToken.maxTtlSeconds * 1000;
    expect(Math.abs(expiresAt - expected)).toBeLessThan(60_000);
  });

  it("a session without a fresh code → fresh_verification_required; with one, 201", async () => {
    await f.api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '1 hour'",
    );
    const stale = await f.issue("env1a", {}, { fresh: false });
    expect(stale.status).toBe(403);
    expect(stale.code).toBe("fresh_verification_required");
    expect((await f.issue("env1a")).status).toBe(201);
  });

  it("who may issue: owner and admin; members are denied; another organization sees nothing", async () => {
    expect((await f.issue("env1a", {}, { user: "adminA" })).status).toBe(201);
    for (const user of ["editorA", "readerA", "envEditorA"] as const) {
      const answer = await f.issue("env1a", {}, { user });
      expect(answer.status, user).toBe(403);
      expect(answer.code, user).toBe("action_denied");
    }
    const hidden = await f.issue("env1a", {}, { user: "ownerB" });
    expect(hidden.status).toBe(404);
    expect(hidden.code).toBe("not_found");
  });

  it("environment pending → state_conflict; archived → 409 state_conflict", async () => {
    for (const state of ["pending", "archived"]) {
      await f.api.superuser.query("UPDATE app.environment SET state = $2 WHERE id = $1", [
        envId("env1b"),
        state,
      ]);
      const answer = await f.issue("env1b");
      expect(answer.status, state).toBe(409);
      expect(answer.code, state).toBe("state_conflict");
    }
    expect(await rowCount("env1b")).toBe(0);
  });

  it("the shown expiry is the backend's: a role maximum of 60 and a request of 120", async () => {
    const name = `machine-env-${envId("env1a")}`;
    const role = machineTokenRole(envId("env1a"));
    await f.admin.putTokenRole(f.fx.namespace, name, {
      ...role,
      token_explicit_max_ttl: 60,
    });
    let answer;
    try {
      answer = await f.issue("env1a", { ttlSeconds: 120 });
    } finally {
      await f.admin.putTokenRole(f.fx.namespace, name, role);
    }
    expect(answer.status).toBe(201);
    const shown = Date.parse((answer.body.credential as { expiresAt: string }).expiresAt);
    expect(Math.abs(shown - (await backendExpiry(answer.body.token as string)))).toBeLessThan(
      2_000,
    );
    expect(shown - Date.now()).toBeLessThan(61_000);
  });
});

describe("replay", () => {
  it("the same key and body after success → 409 credential_not_replayable; the state is read now", async () => {
    const key = randomUUID();
    const first = await f.issue("env1a", { ttlSeconds: 600 }, { key });
    expect(first.status).toBe(201);
    const credentialId = (first.body.credential as { credentialId: string }).credentialId;
    const again = await f.issue("env1a", { ttlSeconds: 600 }, { key });
    expect(again.status).toBe(409);
    expect(again.code).toBe("credential_not_replayable");
    expect(again.operationId).toBe(first.body.operationId);
    expect(again.details).toEqual({ credentialId, state: "active" });
    expect("token" in again.body).toBe(false);
    expect(again.text.includes(first.body.token as string)).toBe(false);
    await f.api.superuser.query(
      "UPDATE app.machine_credential SET state = 'revoked' WHERE id = $1",
      [credentialId],
    );
    const later = await f.issue("env1a", { ttlSeconds: 600 }, { key });
    expect(later.details).toEqual({ credentialId, state: "revoked" });
    const conflict = await f.issue("env1a", { ttlSeconds: 601 }, { key });
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("idempotency_conflict");
  });

  it("while the first is executing, the same request to the second process → 202 and no second row", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const atMarker = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.setFaults(async (point) => {
      if (point === "after_marker") {
        reached();
        await held;
      }
    });
    const key = randomUUID();
    const first = f.issue("env1b", {}, { key });
    await atMarker;
    const second = await f.issue("env1b", {}, { key, to: "second" });
    expect(second.status).toBe(202);
    expect(second.body.state).toBe("executing");
    expect("token" in second.body).toBe(false);
    expect(await rowCount("env1b")).toBe(1);
    release();
    expect((await first).status).toBe(201);
    expect(await rowCount("env1b")).toBe(1);
    await expectCatalogMatchesBackend(f, envId("env1b"));
  });
});
