// secrets.delete (Run 4.4, FR-1.27, P-74): a soft delete of the current
// version under the protocol. The backend keeps no marker of who deleted
// (D-20): success rests on the pre-read under the lock, the slot, and the
// read-back showing the version deleted.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
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

interface Current {
  version: number;
  stateTag: string;
}
const unique = (prefix = "D"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (bytes = 40): string => randomBytes(bytes).toString("hex").slice(0, bytes);
const currentOf = (answer: Answer): Current => {
  const result = answer.body.result as Current;
  return { version: result.version, stateTag: result.stateTag };
};

async function created(env: EnvName, name: string, value = synthetic()): Promise<Current> {
  const answer = await f.create(env, name, value);
  expect(answer.status).toBe(201);
  return currentOf(answer);
}

async function liveBytes(env: EnvName): Promise<number> {
  const result = await f.api.superuser.query<{ live_value_bytes: string }>(
    "SELECT live_value_bytes FROM app.environment WHERE id = $1",
    [f.env(env).environmentId],
  );
  return Number(result.rows[0]?.live_value_bytes);
}

describe("secrets.delete", () => {
  it("200, state deleted, a new tag, the backend's version deleted, live bytes reduced", async () => {
    const name = unique();
    const current = await created("env1a", name, synthetic(40));
    const before = await liveBytes("env1a");
    const answer = await f.act("env1a", name, "delete", current);
    expect(answer.status).toBe(200);
    const result = answer.body.result as { version: number; state: string; stateTag: string };
    expect(result.state).toBe("deleted");
    expect(result.version).toBe(1);
    expect(result.stateTag === current.stateTag).toBe(false);
    const backend = await f.backend("env1a", name);
    expect(backend?.currentVersion).toBe(1);
    expect(backend?.versions[0]?.deleted).toBe(true);
    expect(await liveBytes("env1a")).toBe(before - 40);
    const row = await f.indexRow("env1a", name);
    expect(row?.state).toBe("deleted");
    expect(row?.live_value_bytes).toBe(40);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("after it: reveal and update are 409 state_conflict, create is 409 already_exists, the list shows it deleted", async () => {
    const name = unique();
    const current = await created("env1a", name);
    const deleted = currentOf(await f.act("env1a", name, "delete", current));
    const reveal = await f.send("POST", `${f.env("env1a").path}/secrets/${name}/reveal`, {
      body: {},
      key: null,
    });
    expect(reveal.status).toBe(409);
    expect(reveal.code).toBe("state_conflict");
    const update = await f.update("env1a", name, synthetic(), deleted);
    expect(update.status).toBe(409);
    expect(update.code).toBe("state_conflict");
    const create = await f.create("env1a", name, synthetic());
    expect(create.status).toBe(409);
    expect(create.code).toBe("already_exists");
    const list = await f.send("GET", `${f.env("env1a").path}/secrets?prefix=${name}`, {
      key: null,
    });
    expect(
      (list.body.secrets as { name: string; state: string }[]).map((s) => [s.name, s.state]),
    ).toEqual([[name, "deleted"]]);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a stale tag is 409 version_conflict; confirmed missing or false is refused; nothing changes", async () => {
    const name = unique();
    const current = await created("env1a", name);
    const stale = await f.act("env1a", name, "delete", {
      version: current.version,
      stateTag: randomBytes(16).toString("base64url"),
    });
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("version_conflict");
    const missing = await f.act("env1a", name, "delete", current, { confirmed: null });
    expect(missing.status).toBe(422);
    const falsy = await f.act("env1a", name, "delete", current, { confirmed: false });
    expect(falsy.status).toBe(422);
    expect((await f.backend("env1a", name))?.versions[0]?.deleted).toBe(false);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a replay answers the same result with one audited change", async () => {
    const name = unique();
    const current = await created("env1a", name);
    const key = randomUUID();
    const first = await f.act("env1a", name, "delete", current, { key });
    const again = await f.act("env1a", name, "delete", current, { key });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.operationId).toBe(first.body.operationId);
    expect(again.body.result).toEqual(first.body.result);
    expect(await f.auditedChanges(first.body.operationId as string)).toBe(1);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("two deletes with the same tag at once: one 200 and one 409", async () => {
    for (let round = 0; round < 5; round += 1) {
      const name = unique();
      const current = await created("env1a", name);
      const [a, b] = await Promise.all([
        f.act("env1a", name, "delete", current, { to: "first" }),
        f.act("env1a", name, "delete", current, { to: "second" }),
      ]);
      expect([a.status, b.status].sort(), `round ${String(round)}`).toEqual([200, 409]);
    }
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("lifecycle races across two processes (AC-1.15): delete × update, undelete × restore — one wins, one version change", async () => {
    for (let round = 0; round < 5; round += 1) {
      const name = unique();
      const current = await created("env1a", name);
      const [del, upd] = await Promise.all([
        f.act("env1a", name, "delete", current, { to: "first" }),
        f.update("env1a", name, synthetic(), current, { to: "second" }),
      ]);
      expect([del.status, upd.status].sort(), `delete × update ${String(round)}`).toEqual([
        200, 409,
      ]);
      const backend = await f.backend("env1a", name);
      // Exactly one effect: either version 1 deleted, or version 2 written — never both.
      const deletedOne = backend?.versions[0]?.deleted === true;
      const wroteTwo = backend?.currentVersion === 2;
      expect(deletedOne !== wroteTwo).toBe(true);
    }
    for (let round = 0; round < 5; round += 1) {
      const name = unique();
      const first = await created("env1a", name);
      const second = await f.update("env1a", name, synthetic(), first);
      const deleted = currentOf(await f.act("env1a", name, "delete", currentOf(second)));
      const [und, res] = await Promise.all([
        f.act("env1a", name, "undelete", deleted, { to: "first" }),
        f.act("env1a", name, "restore", deleted, { to: "second", sourceVersion: 1 }),
      ]);
      expect([und.status, res.status].sort(), `undelete × restore ${String(round)}`).toEqual([
        200, 409,
      ]);
      const backend = await f.backend("env1a", name);
      const undeleted = backend?.currentVersion === 2 && backend.versions[1]?.deleted === false;
      const restored = backend?.currentVersion === 3;
      expect(undeleted !== restored).toBe(true);
    }
    await expectIndexMatchesBackend(f, "env1a");
  }, 120_000);

  it("a delayed answer is 503 outcome_unknown, the key in review, the slot held", async () => {
    const name = unique();
    const current = await created("env2a", name);
    f.setFaults((at) => {
      if (at === "after_dispatch_marker") f.relay.delayResponses(8_000);
    });
    const answer = await f.act("env2a", name, "delete", current);
    f.setFaults(null);
    f.relay.clear();
    try {
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("outcome_unknown");
      expect((await f.indexRow("env2a", name))?.state).toBe("needs_review");
      const slot = await f.api.superuser.query(
        "SELECT operation_id FROM app.effect_slot WHERE operation_id = $1",
        [answer.operationId],
      );
      expect(slot.rowCount).toBe(1);
    } finally {
      await f.api.superuser.query("DELETE FROM app.effect_slot WHERE scope_key = $1", [
        `env:${f.env("env2a").environmentId}`,
      ]);
    }
  }, 30_000);

  it("roles: a reader is 403 and an ungranted member 404, nothing deleted; an editor deletes", async () => {
    const name = unique();
    const current = await created("env1a", name);
    const reader = await f.act("env1a", name, "delete", current, { user: "readerA" });
    expect(reader.status).toBe(403);
    const ungranted = await f.act("env1a", name, "delete", current, { user: "ungrantedA" });
    expect(ungranted.status).toBe(404);
    expect((await f.backend("env1a", name))?.versions[0]?.deleted).toBe(false);
    const editor = await f.act("env1a", name, "delete", current, { user: "editorA" });
    expect(editor.status).toBe(200);
    await expectIndexMatchesBackend(f, "env1a");
  });
});
