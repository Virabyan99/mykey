// Run 11.3 Task A, Review focus 1: the code written when a credential row
// without an accessor meant "an issuance that never finished". A runtime
// credential has no accessor for its whole life. Each case starts with an
// environment that holds one active 30-day token and one active runtime
// credential, and walks one such place: archive, reactivation, the sweep,
// reconcile-credentials, the next issuance.
//
// The restore's two commands are proven with a runtime credential in the
// restore suite (tests/integration/restore/invalidate.test.ts, Task C).
import { randomUUID } from "node:crypto";
import type { OrganizationId } from "@mykey/contracts";
import { createPool } from "@mykey/db";
import { OpenBaoClient } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { sweepCredentials } from "@mykey/operations";
import { reconcileCredentials } from "@mykey/operations/operator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearCredentials,
  createCredentialsFixture,
  expectCatalogMatchesBackend,
  issueFor,
  issueRuntimeFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import {
  archive,
  issueAt,
  newProject,
  reactivate,
  resourceState,
  type Place,
} from "../../harness/lifecycle-fixture.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  await clearCredentials(f, f.env("env1a").environmentId);
});

interface Kinds {
  kind: string;
  state: string;
}

const credentials = async (environmentId: string): Promise<Kinds[]> =>
  (
    await f.api.superuser.query<Kinds>(
      "SELECT kind, state FROM app.machine_credential WHERE environment_id = $1 ORDER BY kind",
      [environmentId],
    )
  ).rows;

/** A new project whose one environment holds an active token and an active runtime credential. */
async function placeWithBoth(): Promise<Place> {
  const place = await newProject(f);
  await issueAt(f, place);
  await issueRuntimeFor(f, "env1a", {}, { path: place.path });
  expect(await credentials(place.environmentId)).toEqual([
    { kind: "runtime", state: "active" },
    { kind: "token", state: "active" },
  ]);
  return place;
}

const REVOKED = [
  { kind: "runtime", state: "revoked" },
  { kind: "token", state: "revoked" },
];

describe("archive and reactivation", () => {
  it("environments.archive answers 200, counts both in credentialsRevoked, and both rows are revoked", async () => {
    const place = await placeWithBoth();
    const answer = await archive(f, place.path);
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body).toMatchObject({
      state: "succeeded",
      result: { state: "archived", environments: 1, credentialsRevoked: 2 },
    });
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("archived");
    expect(await credentials(place.environmentId)).toEqual(REVOKED);

    // environments.reactivate after it answers 200, and both stay revoked.
    const back = await reactivate(f, place.path);
    expect(back.status, back.code ?? "").toBe(200);
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("active");
    expect(await credentials(place.environmentId)).toEqual(REVOKED);
  });

  it("projects.archive closes both, and projects.reactivate after it answers 200, and both stay revoked", async () => {
    const place = await placeWithBoth();
    const answer = await archive(f, place.projectPath);
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body).toMatchObject({
      state: "succeeded",
      result: { state: "archived", credentialsRevoked: 2 },
    });
    expect(await credentials(place.environmentId)).toEqual(REVOKED);
    const back = await reactivate(f, place.projectPath);
    expect(back.status, back.code ?? "").toBe(200);
    expect((await resourceState(f, "project", place.projectId)).state).toBe("active");
    expect(await credentials(place.environmentId)).toEqual(REVOKED);
  });

  it("an environment that holds only a runtime credential is archived with OpenBao's tokens untouched", async () => {
    const place = await newProject(f);
    await issueRuntimeFor(f, "env1a", {}, { path: place.path });
    const answer = await archive(f, place.path);
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body).toMatchObject({ result: { state: "archived", credentialsRevoked: 1 } });
    expect(await credentials(place.environmentId)).toEqual([{ kind: "runtime", state: "revoked" }]);
  });
});

describe("the sweep, reconcile-credentials and the next issuance", () => {
  const environmentId = () => f.env("env1a").environmentId;

  async function both(): Promise<{ tokenId: string; runtimeId: string }> {
    const token = await issueFor(f, "env1a", { ttlSeconds: 600 });
    const runtime = await issueRuntimeFor(f, "env1a");
    return { tokenId: token.credentialId, runtimeId: runtime.credentialId };
  }

  const stateOf = async (credentialId: string): Promise<string | undefined> =>
    (
      await f.api.superuser.query<{ state: string }>(
        "SELECT state FROM app.machine_credential WHERE id = $1",
        [credentialId],
      )
    ).rows[0]?.state;

  it("the credential sweep leaves the runtime row active", async () => {
    const { runtimeId, tokenId } = await both();
    // With every executing operation treated as stale: a runtime row is not an unfinished issuance.
    const swept = await sweepCredentials(f.api.pool, {
      environmentId: environmentId(),
      staleSeconds: 0,
    });
    expect(swept).toEqual({ uncertain: [], expired: 0 });
    expect(await stateOf(runtimeId)).toBe("active");
    expect(await stateOf(tokenId)).toBe("active");
  });

  it("the sweep's expiry rule covers a runtime row past its expiry (control: the row above stays active)", async () => {
    const { runtimeId } = await both();
    await f.api.superuser.query(
      "UPDATE app.machine_credential SET effective_expires_at = now() - interval '1 second' WHERE id = $1",
      [runtimeId],
    );
    const swept = await sweepCredentials(f.api.pool, { environmentId: environmentId() });
    expect(swept.expired).toBe(1);
    expect(await stateOf(runtimeId)).toBe("expired");
  });

  it("reconcile-credentials leaves the runtime row active and reports nothing left", async () => {
    const { runtimeId, tokenId } = await both();
    const pool = createPool(f.api.database.targets.maintenance, { max: 2 });
    try {
      const result = await reconcileCredentials(
        {
          pool,
          admin: new OpenBaoAdmin(f.stack.bao, f.stack.bao.rootToken),
          bao: new OpenBaoClient(f.stack.bao, {
            namespace: f.fx.namespace,
            token: f.stack.bao.rootToken,
          }),
          requestId: randomUUID(),
        },
        {
          scope: {
            organizationId: f.tenants.a.organizationId as OrganizationId,
            projectId: f.env("env1a").projectId,
            environmentId: environmentId(),
          },
          executorsExcluded: true,
        },
      );
      expect(result).toEqual({
        kind: "done",
        unrecordedRevoked: 0,
        revocationsCompleted: 0,
        issuancesSettled: 0,
        left: [],
      });
    } finally {
      await pool.end();
    }
    expect(await stateOf(runtimeId)).toBe("active");
    expect(await stateOf(tokenId)).toBe("active");
    await expectCatalogMatchesBackend(f, environmentId());
  });

  it("issuing a 30-day token is not blocked by the runtime row", async () => {
    await issueRuntimeFor(f, "env1a");
    const first = await f.issue("env1a", { ttlSeconds: 600 });
    expect(first.status, first.code).toBe(201);
    const second = await f.issue("env1a", { ttlSeconds: 600 });
    expect(second.status, second.code).toBe(201);
  });
});
