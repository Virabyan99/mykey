// secrets.undelete (Run 4.4, FR-1.28, P-70, P-74): the deleted current
// version comes back as the same version, with a new tag; capacity is
// checked before the effect from the row's kept byte count.
import { randomBytes } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
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
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

interface Current {
  version: number;
  stateTag: string;
}
const unique = (prefix = "U"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (bytes = 40): string => randomBytes(bytes).toString("hex").slice(0, bytes);
const currentOf = (answer: Answer): Current => {
  const result = answer.body.result as Current;
  return { version: result.version, stateTag: result.stateTag };
};

async function deletedKey(
  env: EnvName,
  value: string,
): Promise<{ name: string; deleted: Current }> {
  const name = unique();
  const created = await f.create(env, name, value);
  expect(created.status).toBe(201);
  const deleted = await f.act(env, name, "delete", currentOf(created));
  expect(deleted.status).toBe(200);
  return { name, deleted: currentOf(deleted) };
}

async function liveBytes(env: EnvName): Promise<number> {
  const result = await f.api.superuser.query<{ live_value_bytes: string }>(
    "SELECT live_value_bytes FROM app.environment WHERE id = $1",
    [f.env(env).environmentId],
  );
  return Number(result.rows[0]?.live_value_bytes);
}

describe("secrets.undelete", () => {
  it("200, live, the same version, a new tag, the digest equal, live bytes restored", async () => {
    const value = synthetic(30);
    const { name, deleted } = await deletedKey("env1a", value);
    const before = await liveBytes("env1a");
    const answer = await f.act("env1a", name, "undelete", deleted);
    expect(answer.status).toBe(200);
    const result = answer.body.result as { version: number; state: string; stateTag: string };
    expect(result.version).toBe(1);
    expect(result.state).toBe("live");
    expect(result.stateTag === deleted.stateTag).toBe(false);
    const backend = await f.backend("env1a", name);
    expect(backend?.versions).toHaveLength(1);
    expect(backend?.versions[0]?.deleted).toBe(false);
    expect(backend?.versions[0]?.digest).toBe(sha256(value));
    expect(await liveBytes("env1a")).toBe(before + 30);
    await expectIndexMatchesBackend(f, "env1a");
  });

  // AC-1.15, PO-7: the ABA case. The version comes back as the same number,
  // so only the tag tells the two live states apart.
  it("a tag captured before a delete and undelete is refused at the same version, and nothing is written", async () => {
    const name = unique();
    const created = await f.create("env1a", name, synthetic());
    expect(created.status).toBe(201);
    const captured = currentOf(created);
    const deleted = await f.act("env1a", name, "delete", captured);
    expect(deleted.status).toBe(200);
    const undeleted = await f.act("env1a", name, "undelete", currentOf(deleted));
    expect(undeleted.status).toBe(200);
    expect(currentOf(undeleted).version).toBe(captured.version);

    const update = await f.update("env1a", name, synthetic(), captured);
    expect(update.status).toBe(409);
    expect(update.code).toBe("version_conflict");
    const deleteAgain = await f.act("env1a", name, "delete", captured);
    expect(deleteAgain.status).toBe(409);
    expect(deleteAgain.code).toBe("version_conflict");

    const backend = await f.backend("env1a", name);
    expect(backend?.versions).toHaveLength(1);
    expect(backend?.versions[0]?.deleted).toBe(false);
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("undelete of a live key is 409 state_conflict", async () => {
    const name = unique();
    const created = await f.create("env1a", name, synthetic());
    const answer = await f.act("env1a", name, "undelete", currentOf(created));
    expect(answer.status).toBe(409);
    expect(answer.code).toBe("state_conflict");
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("an undelete that would pass 8 MiB is 507 and sends nothing", async () => {
    const { name, deleted } = await deletedKey("env1b", synthetic(20));
    const { environmentId } = f.env("env1b");
    const db = f.api.superuser;
    const real = await liveBytes("env1b");
    const raise = LIMITS.environment.maxLiveValueBytes - 19 - real;
    await db.query(
      "UPDATE app.environment SET live_value_bytes = live_value_bytes + $2 WHERE id = $1",
      [environmentId, raise],
    );
    try {
      const answer = await f.act("env1b", name, "undelete", deleted);
      expect(answer.status).toBe(507);
      expect(answer.code).toBe("capacity_exceeded");
      expect(answer.details).toEqual({ limit: "bytes" });
      expect((await f.backend("env1b", name))?.versions[0]?.deleted).toBe(true);
    } finally {
      await db.query(
        "UPDATE app.environment SET live_value_bytes = live_value_bytes - $2 WHERE id = $1",
        [environmentId, raise],
      );
    }
    await expectIndexMatchesBackend(f, "env1b");
  });

  it("a delayed answer is 503 outcome_unknown", async () => {
    const { name, deleted } = await deletedKey("env2a", synthetic());
    f.setFaults((at) => {
      if (at === "after_dispatch_marker") f.relay.delayResponses(8_000);
    });
    const answer = await f.act("env2a", name, "undelete", deleted);
    f.setFaults(null);
    f.relay.clear();
    try {
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("outcome_unknown");
      expect((await f.indexRow("env2a", name))?.state).toBe("needs_review");
    } finally {
      await f.api.superuser.query("DELETE FROM app.effect_slot WHERE scope_key = $1", [
        `env:${f.env("env2a").environmentId}`,
      ]);
    }
  }, 30_000);
});
