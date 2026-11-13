// secrets.history (Run 4.3 Task A, FR-1.26, P-73): OpenBao's versions of a
// key joined with the index's version events — who wrote each version, and
// its last delete or undelete. Never a value. Delete, undelete and restore
// have no route before Run 4.4: here the fixture makes those changes the way
// the protocol records them (backend change, version event, index, counters);
// Run 4.4 proves the same history through its routes.
import { randomBytes, randomUUID } from "node:crypto";
import { secretPath } from "@mykey/openbao";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import type { FixtureUser } from "../../harness/tenants.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

interface HistoryVersion {
  version: number;
  createdAt: string;
  deleted: boolean;
  destroyed: boolean;
  current: boolean;
  written: {
    action: string | null;
    actor: { kind: string; id: string | null };
    operationId: string | null;
  };
  lastChange: {
    action: string;
    actor: { kind: string; id: string | null };
    occurredAt: string;
  } | null;
}

const unique = (prefix = "H"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

function history(
  env: EnvName,
  name: string,
  query = "",
  user: FixtureUser = "ownerA",
): Promise<Answer> {
  return f.send("GET", `${f.env(env).path}/secrets/${name}/history${query}`, { user, key: null });
}

const versionsOf = (answer: Answer): HistoryVersion[] => answer.body.versions as HistoryVersion[];

async function created(env: EnvName, name: string, value: string) {
  const answer = await f.create(env, name, value);
  expect(answer.status).toBe(201);
  return answer.body.result as { version: number; stateTag: string };
}

async function updated(
  env: EnvName,
  name: string,
  value: string,
  current: { version: number; stateTag: string },
) {
  const answer = await f.update(env, name, value, current);
  expect(answer.status).toBe(200);
  return answer.body.result as { version: number; stateTag: string };
}

/** A version event as the protocol writes it (Run 4.4's actions, made by the fixture here). */
async function versionEvent(
  env: EnvName,
  name: string,
  version: number,
  action: string,
): Promise<void> {
  const { environmentId } = f.env(env);
  await f.api.superuser.query(
    `INSERT INTO app.secret_version_event (id, organization_id, environment_id, name, version,
       operation_id, actor_kind, actor_id, action, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'user', $7, $8, now())`,
    [
      randomUUID(),
      f.tenants.a.organizationId,
      environmentId,
      name,
      version,
      randomUUID(),
      f.tenants.userId("ownerA"),
      action,
    ],
  );
}

const correlation = () => ({ operationId: randomUUID(), dispatchId: randomUUID() });

describe("secrets.history", () => {
  it("create, update, update, delete, undelete, restore: four versions newest first, who wrote each, the last change", async () => {
    const mark = canary();
    const env: EnvName = "env1a";
    const name = unique();
    const { projectId, environmentId } = f.env(env);
    const path = secretPath(projectId, environmentId, name);
    const db = f.api.superuser;
    const first = await created(env, name, `${mark}-1`);
    const second = await updated(env, name, `${mark}-2`, first);
    expect((await updated(env, name, `${mark}-3`, second)).version).toBe(3);
    const bytes = (await f.indexRow(env, name))?.live_value_bytes ?? 0;

    // Delete version 3, then undelete it.
    expect((await f.operatorBao().kvSoftDelete(path, 3, correlation())).ok).toBe(true);
    await versionEvent(env, name, 3, "secret.delete");
    await db.query(
      "UPDATE app.secret_index SET state = 'deleted' WHERE environment_id = $1 AND name = $2",
      [environmentId, name],
    );
    await db.query(
      "UPDATE app.environment SET live_value_bytes = live_value_bytes - $2 WHERE id = $1",
      [environmentId, bytes],
    );
    expect((await f.operatorBao().kvUndelete(path, 3, correlation())).ok).toBe(true);
    await versionEvent(env, name, 3, "secret.undelete");
    await db.query(
      "UPDATE app.secret_index SET state = 'live' WHERE environment_id = $1 AND name = $2",
      [environmentId, name],
    );
    await db.query(
      "UPDATE app.environment SET live_value_bytes = live_value_bytes + $2 WHERE id = $1",
      [environmentId, bytes],
    );

    // Restore version 1's value as version 4.
    const restoredValue = `${mark}-1`;
    const restored = await f
      .operatorBao()
      .kvWrite(
        path,
        { value: restoredValue, operation_id: randomUUID(), format: 1 },
        3,
        correlation(),
      );
    expect(restored.ok).toBe(true);
    await versionEvent(env, name, 4, "secret.restore");
    const restoredBytes = Buffer.byteLength(restoredValue, "utf8");
    await db.query(
      `UPDATE app.secret_index SET current_version = 4, live_value_bytes = $3, state_tag = $4
        WHERE environment_id = $1 AND name = $2`,
      [environmentId, name, restoredBytes, randomBytes(16).toString("base64url")],
    );
    await db.query(
      "UPDATE app.environment SET live_value_bytes = live_value_bytes - $2 + $3 WHERE id = $1",
      [environmentId, bytes, restoredBytes],
    );

    const answer = await history(env, name);
    expect(answer.status).toBe(200);
    expect(answer.body.name).toBe(name);
    expect(answer.body.currentVersion).toBe(4);
    expect(answer.body.state).toBe("live");
    const versions = versionsOf(answer);
    expect(versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(versions.map((v) => v.written.action)).toEqual([
      "restore",
      "update",
      "update",
      "create",
    ]);
    expect(versions.map((v) => v.current)).toEqual([true, false, false, false]);
    for (const v of versions) {
      expect(v.written.actor).toEqual({ kind: "user", id: f.tenants.userId("ownerA") });
    }
    expect(versions[1]?.lastChange?.action).toBe("undelete");
    expect(versions[0]?.lastChange).toBeNull();
    expect(versions[2]?.lastChange).toBeNull();

    // No value anywhere in the body.
    const keys = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === "object") {
        for (const [key, inner] of Object.entries(node)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk(answer.body);
    expect(keys.has("value")).toBe(false);
    expect(answer.text.includes(mark)).toBe(false);
    await expectIndexMatchesBackend(f, env);
  });

  it("a version written past the product has actor unknown and action null", async () => {
    const env: EnvName = "env2a";
    const name = unique();
    const first = await created(env, name, `synthetic-${randomUUID()}`);
    const { projectId, environmentId } = f.env(env);
    const outside = await f
      .operatorBao()
      .kvWrite(
        secretPath(projectId, environmentId, name),
        { value: `synthetic-${randomUUID()}`, operation_id: randomUUID(), format: 1 },
        first.version,
        correlation(),
      );
    expect(outside.ok).toBe(true);
    const versions = versionsOf(await history(env, name));
    expect(versions[0]?.version).toBe(2);
    expect(versions[0]?.written).toEqual({
      action: null,
      actor: { kind: "unknown", id: null },
      operationId: null,
    });
    expect(versions[1]?.written.action).toBe("create");
  });

  it("limit, cursor and version parameters are 400 unsupported_history_parameter", async () => {
    const name = unique();
    await created("env1a", name, `synthetic-${randomUUID()}`);
    for (const query of ["?limit=5", "?cursor=x", "?version=1"]) {
      const answer = await history("env1a", name, query);
      expect(answer.status, query).toBe(400);
      expect(answer.code).toBe("unsupported_history_parameter");
    }
  });

  it("after 21 writes there are 20 versions and version 1 is gone", async () => {
    const name = unique();
    let current = await created("env1a", name, `synthetic-${randomUUID()}`);
    for (let i = 0; i < 20; i += 1)
      current = await updated("env1a", name, `synthetic-${randomUUID()}`, current);
    const versions = versionsOf(await history("env1a", name));
    expect(versions).toHaveLength(20);
    expect(versions[0]?.version).toBe(21);
    expect(versions.at(-1)?.version).toBe(2);
    await expectIndexMatchesBackend(f, "env1a");
  }, 120_000);

  it("a key in review answers 200 with its state; an absent or invalid name is 404", async () => {
    const name = unique();
    await created("env2a", name, `synthetic-${randomUUID()}`);
    await f.api.superuser.query(
      "UPDATE app.secret_index SET state = 'needs_review' WHERE environment_id = $1 AND name = $2",
      [f.env("env2a").environmentId, name],
    );
    const review = await history("env2a", name);
    expect(review.status).toBe(200);
    expect(review.body.state).toBe("needs_review");
    for (const absent of [unique("ABSENT"), "lower"]) {
      const answer = await history("env1a", absent);
      expect(answer.status, absent).toBe(404);
      expect(answer.code).toBe("not_found");
    }
  });

  it("OpenBao unreachable is 503 dependency_unavailable", async () => {
    const name = unique();
    await created("env1a", name, `synthetic-${randomUUID()}`);
    f.setBao("closed");
    try {
      const answer = await history("env1a", name);
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("dependency_unavailable");
    } finally {
      f.setBao("relay");
    }
  });

  it("roles: a reader reads history; an ungranted member and another organization's owner get 404", async () => {
    const name = unique();
    await created("env1a", name, `synthetic-${randomUUID()}`);
    expect((await history("env1a", name, "", "readerA")).status).toBe(200);
    expect((await history("env1a", name, "", "ungrantedA")).status).toBe(404);
    expect((await history("env1a", name, "", "ownerB")).status).toBe(404);
  });
});
