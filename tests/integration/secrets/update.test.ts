// Secret update with expected version and state tag (Run 4.2 Task C,
// FR-1.24, AC-1.14). Values are synthetic; digests only.
import { randomBytes, randomUUID } from "node:crypto";
import { secretPath } from "@mykey/openbao";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  sha256,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture({ processes: 2 });
}, 600_000);

afterAll(async () => {
  await f.close();
});

const unique = (prefix = "U"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (): string => `synthetic-${randomUUID()}`;

interface Current {
  version: number;
  stateTag: string;
}

const currentOf = (answer: Answer): Current => {
  const result = answer.body.result as { version: number; stateTag: string };
  return { version: result.version, stateTag: result.stateTag };
};

async function created(env: EnvName = "env1a"): Promise<{ name: string; current: Current }> {
  const name = unique();
  const answer = await f.create(env, name, synthetic());
  expect(answer.status).toBe(201);
  return { name, current: currentOf(answer) };
}

describe("secrets.update", () => {
  it("with the current version and tag: 200, version 2, a new tag; the old tag is no longer accepted", async () => {
    const { name, current } = await created();
    const value = synthetic();
    const answer = await f.update("env1a", name, value, current);
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe("succeeded");
    const next = currentOf(answer);
    expect(next.version).toBe(2);
    expect(next.stateTag).toHaveLength(22);
    expect(next.stateTag === current.stateTag).toBe(false);
    const backend = await f.backend("env1a", name);
    expect(backend?.currentVersion).toBe(2);
    expect(backend?.versions[1]?.digest).toBe(sha256(value));
    expect(backend?.versions[1]?.operationId).toBe(answer.body.operationId);
    const stale = await f.update("env1a", name, synthetic(), {
      version: 2,
      stateTag: current.stateTag,
    });
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("version_conflict");
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a stale version is 409 version_conflict with the current version, tag and state", async () => {
    const { name, current } = await created();
    const next = currentOf(await f.update("env1a", name, synthetic(), current));
    const stale = await f.update("env1a", name, synthetic(), current);
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("version_conflict");
    expect(stale.details).toEqual({
      currentVersion: next.version,
      currentStateTag: next.stateTag,
      state: "live",
    });
    expect((await f.backend("env1a", name))?.versions).toHaveLength(2);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("the right version with a stale tag is 409", async () => {
    const { name, current } = await created();
    const answer = await f.update("env1a", name, synthetic(), {
      version: current.version,
      stateTag: randomBytes(16).toString("base64url"),
    });
    expect(answer.status).toBe(409);
    expect(answer.code).toBe("version_conflict");
    expect((await f.backend("env1a", name))?.versions).toHaveLength(1);
  });

  // Doc 06 §9 (validate.ts): a missing field or an unknown key is the wrong shape, 400 — not 422.
  it("a body without expectedVersion or expectedStateTag, or with an unknown key, is 400 malformed_request", async () => {
    const { name, current } = await created();
    const path = `${f.env("env1a").path}/secrets/${name}`;
    for (const body of [
      { value: "x", expectedStateTag: current.stateTag },
      { value: "x", expectedVersion: current.version },
      {
        value: "x",
        expectedVersion: current.version,
        expectedStateTag: current.stateTag,
        force: true,
      },
    ]) {
      const answer = await f.send("PATCH", path, { body });
      expect(answer.status).toBe(400);
      expect(answer.code).toBe("malformed_request");
    }
    expect((await f.backend("env1a", name))?.versions).toHaveLength(1);
  });

  it("an absent name is 404; a name that breaks the rules is 404", async () => {
    for (const name of [unique("ABSENT"), "lower"]) {
      const answer = await f.update("env1a", name, synthetic(), {
        version: 1,
        stateTag: randomBytes(16).toString("base64url"),
      });
      expect(answer.status, name).toBe(404);
      expect(answer.code).toBe("not_found");
    }
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a deleted current version is 409 state_conflict", async () => {
    const { name, current } = await created();
    const { projectId, environmentId } = f.env("env1a");
    const removed = await f
      .operatorBao()
      .kvSoftDelete(secretPath(projectId, environmentId, name), current.version, {
        operationId: randomUUID(),
        dispatchId: randomUUID(),
      });
    expect(removed.ok).toBe(true);
    const row = await f.indexRow("env1a", name);
    await f.api.superuser.query(
      "UPDATE app.secret_index SET state = 'deleted' WHERE environment_id = $1 AND name = $2",
      [environmentId, name],
    );
    await f.api.superuser.query(
      "UPDATE app.environment SET live_value_bytes = live_value_bytes - $2 WHERE id = $1",
      [environmentId, row?.live_value_bytes ?? 0],
    );
    const answer = await f.update("env1a", name, synthetic(), current);
    expect(answer.status).toBe(409);
    expect(answer.code).toBe("state_conflict");
    expect((await f.backend("env1a", name))?.versions).toHaveLength(1);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("two updates with the same version and tag at once: one 200, one 409, one new version (AC-1.14)", async () => {
    for (let round = 0; round < 20; round += 1) {
      const { name, current } = await created();
      const [a, b] = await Promise.all([
        f.update("env1a", name, synthetic(), current, { to: "first" }),
        f.update("env1a", name, synthetic(), current, { to: "second" }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses, `round ${String(round)}`).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      const winner = a.status === 200 ? a : b;
      expect(loser.code).toBe("version_conflict");
      expect((await f.backend("env1a", name))?.versions).toHaveLength(2);
      expect(await f.auditedChanges(winner.body.operationId as string)).toBe(1);
    }
    await expectIndexMatchesBackend(f, "env1a");
  }, 300_000);

  it("twenty updates of twenty keys of one environment at once: each succeeds, after busy retries with its key", async () => {
    const keys = [];
    for (let index = 0; index < 20; index += 1) keys.push(await created("env1b"));
    const attempts = keys.map((entry) => ({ ...entry, key: randomUUID(), value: synthetic() }));
    let pending = attempts;
    for (let pass = 0; pending.length > 0 && pass < 20; pass += 1) {
      const answers = await Promise.all(
        pending.map((entry, index) =>
          f.update("env1b", entry.name, entry.value, entry.current, {
            key: entry.key,
            to: index % 2 === 0 ? "first" : "second",
          }),
        ),
      );
      for (const answer of answers) expect([200, 503]).toContain(answer.status);
      for (const answer of answers.filter((a) => a.status === 503))
        expect(answer.code).toBe("busy");
      pending = pending.filter((_entry, index) => answers[index]?.status !== 200);
    }
    expect(pending).toHaveLength(0);
    for (const entry of attempts) {
      const backend = await f.backend("env1b", entry.name);
      expect(backend?.currentVersion).toBe(2);
      expect(backend?.versions[1]?.digest).toBe(sha256(entry.value));
    }
    await expectIndexMatchesBackend(f, "env1b");
  }, 300_000);

  it("the backend moved underneath: 503 backend_inconsistent and the key is needs_review", async () => {
    const { name, current } = await created("env2a");
    const { projectId, environmentId } = f.env("env2a");
    const moved = await f
      .operatorBao()
      .kvWrite(
        secretPath(projectId, environmentId, name),
        { value: synthetic(), operation_id: randomUUID(), format: 1 },
        current.version,
        { operationId: randomUUID(), dispatchId: randomUUID() },
      );
    expect(moved.ok).toBe(true);
    const answer = await f.update("env2a", name, synthetic(), current);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("backend_inconsistent");
    expect((await f.indexRow("env2a", name))?.state).toBe("needs_review");
    expect((await f.backend("env2a", name))?.versions).toHaveLength(2);
    // The key in review refuses the next update.
    const next = await f.update("env2a", name, synthetic(), current);
    expect(next.status).toBe(409);
    expect(next.code).toBe("key_under_review");
  });

  it("the admission recheck: archived after the pipeline → 409, no operation; grant removed after the pipeline → 404", async () => {
    const { name, current } = await created("env1b");
    const { environmentId } = f.env("env1b");
    const db = f.api.superuser;
    const operations = async () =>
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM app.operation WHERE environment_id = $1 AND secret_name = $2",
          [environmentId, name],
        )
      ).rows[0]?.count;
    const before = await operations();
    f.setBeforeHandler(async (routeId) => {
      if (routeId !== "secrets.update") return;
      await db.query(
        "UPDATE app.environment SET state = 'archived', archive_origin = 'self' WHERE id = $1",
        [environmentId],
      );
    });
    try {
      const archived = await f.update("env1b", name, synthetic(), current);
      expect(archived.status).toBe(409);
      expect(archived.code).toBe("state_conflict");
      expect(await operations()).toBe(before);
    } finally {
      f.setBeforeHandler(null);
      await db.query(
        "UPDATE app.environment SET state = 'active', archive_origin = NULL WHERE id = $1",
        [environmentId],
      );
    }

    const editor = f.tenants.userId("editorA");
    const grants = await db.query<{ id: string }>(
      "SELECT id FROM app.access_grant WHERE user_id = $1",
      [editor],
    );
    const saved = await db.query(
      "SELECT id, organization_id, user_id, project_id, environment_id, role FROM app.access_grant WHERE user_id = $1",
      [editor],
    );
    f.setBeforeHandler(async (routeId) => {
      if (routeId !== "secrets.update") return;
      await db.query("DELETE FROM app.access_grant WHERE user_id = $1", [editor]);
    });
    try {
      const removed = await f.update("env1b", name, synthetic(), current, { user: "editorA" });
      expect(removed.status).toBe(404);
      expect(removed.code).toBe("not_found");
      expect(await operations()).toBe(before);
    } finally {
      f.setBeforeHandler(null);
      for (const row of saved.rows as {
        id: string;
        organization_id: string;
        user_id: string;
        project_id: string | null;
        environment_id: string | null;
        role: string;
      }[]) {
        await db.query(
          `INSERT INTO app.access_grant (id, organization_id, user_id, project_id, environment_id, role)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
          [row.id, row.organization_id, row.user_id, row.project_id, row.environment_id, row.role],
        );
      }
    }
    expect(grants.rowCount).toBeGreaterThan(0);
    // Control: the editor updates once the grant is back.
    const control = await f.update("env1b", name, synthetic(), current, { user: "editorA" });
    expect(control.status).toBe(200);
    await expectIndexMatchesBackend(f, "env1b");
  });
});
