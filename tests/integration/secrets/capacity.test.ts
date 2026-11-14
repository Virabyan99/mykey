// Environment capacity (Run 4.2 Task C, Doc 06 §11, P-70): 1,000 names and
// 8 MiB of live values. A refusal is 507 capacity_exceeded with the limit
// named, and nothing is sent.
import { randomBytes, randomUUID } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  type Answer,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

const unique = (prefix = "K"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
/** A synthetic value of exactly `bytes` ASCII bytes. */
const ofLength = (bytes: number): string =>
  randomBytes(Math.ceil(bytes / 2) + 1)
    .toString("hex")
    .slice(0, bytes);

const currentOf = (answer: Answer) => {
  const result = answer.body.result as { version: number; stateTag: string };
  return { version: result.version, stateTag: result.stateTag };
};

describe("capacity", () => {
  it("the 1,001st name is 507 { limit: names }; a deleted name counts; nothing is sent", async () => {
    const { environmentId } = f.env("env1b");
    const db = f.api.superuser;
    const filler = "FILL_";
    // 999 rows inserted as deleted names (no live bytes): a deleted name still counts.
    await db.query(
      `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version,
         state_tag, state, live_value_bytes, last_changed_at)
       SELECT $1, $2 || lpad(n::text, 4, '0'), $3, 1, md5(n::text), 'deleted', 0, now()
         FROM generate_series(1, 999) AS n`,
      [environmentId, filler, f.tenants.a.organizationId],
    );
    try {
      const last = await f.create("env1b", unique(), ofLength(8));
      expect(last.status).toBe(201);
      const name = unique();
      const refused = await f.create("env1b", name, ofLength(8));
      expect(refused.status).toBe(507);
      expect(refused.code).toBe("capacity_exceeded");
      expect(refused.details).toEqual({ limit: "names" });
      expect(refused.operationId).toBeUndefined();
      expect(await f.backend("env1b", name)).toBeNull();
    } finally {
      await db.query(
        "DELETE FROM app.secret_index WHERE environment_id = $1 AND name LIKE $2 || '%'",
        [environmentId, filler],
      );
    }
    await expectIndexMatchesBackend(f, "env1b");
  }, 120_000);

  it("at 8 MiB − 10 live bytes: +11 is 507 { limit: bytes } and sends nothing, +10 passes; a create of 11 bytes is 507", async () => {
    const { environmentId } = f.env("env1a");
    const db = f.api.superuser;
    const name = unique();
    const created = await f.create("env1a", name, ofLength(3));
    expect(created.status).toBe(201);
    const current = currentOf(created);
    const actual = async () =>
      Number(
        (
          await db.query<{ live_value_bytes: string }>(
            "SELECT live_value_bytes FROM app.environment WHERE id = $1",
            [environmentId],
          )
        ).rows[0]?.live_value_bytes,
      );
    const real = await actual();
    // The counter alone is raised: the environment holds 8 MiB − 10 as far as admission knows.
    const raise = LIMITS.environment.maxLiveValueBytes - 10 - real;
    await db.query(
      "UPDATE app.environment SET live_value_bytes = live_value_bytes + $2 WHERE id = $1",
      [environmentId, raise],
    );
    try {
      const over = await f.update("env1a", name, ofLength(3 + 11), current);
      expect(over.status).toBe(507);
      expect(over.code).toBe("capacity_exceeded");
      expect(over.details).toEqual({ limit: "bytes" });
      expect((await f.backend("env1a", name))?.versions).toHaveLength(1);

      const newName = unique();
      const createOver = await f.create("env1a", newName, ofLength(11));
      expect(createOver.status).toBe(507);
      expect(createOver.details).toEqual({ limit: "bytes" });
      expect(await f.backend("env1a", newName)).toBeNull();

      const fits = await f.update("env1a", name, ofLength(3 + 10), current);
      expect(fits.status).toBe(200);
      expect(await actual()).toBe(LIMITS.environment.maxLiveValueBytes);
    } finally {
      await db.query(
        "UPDATE app.environment SET live_value_bytes = live_value_bytes - $2 WHERE id = $1",
        [environmentId, raise],
      );
    }
    await expectIndexMatchesBackend(f, "env1a");
  });

  it("a refused create leaves no operation and no audited change", async () => {
    const { environmentId } = f.env("env1b");
    const db = f.api.superuser;
    await db.query("UPDATE app.environment SET live_value_bytes = $2 WHERE id = $1", [
      environmentId,
      LIMITS.environment.maxLiveValueBytes,
    ]);
    const before = (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM app.operation WHERE environment_id = $1",
        [environmentId],
      )
    ).rows[0]?.count;
    try {
      const key = randomUUID();
      const refused = await f.create("env1b", unique(), ofLength(1), { key });
      expect(refused.status).toBe(507);
      const after = (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM app.operation WHERE environment_id = $1",
          [environmentId],
        )
      ).rows[0]?.count;
      expect(after).toBe(before);
    } finally {
      await db.query(
        `UPDATE app.environment SET live_value_bytes =
           (SELECT coalesce(sum(live_value_bytes), 0) FROM app.secret_index
             WHERE environment_id = $1 AND state = 'live')
         WHERE id = $1`,
        [environmentId],
      );
    }
    await expectIndexMatchesBackend(f, "env1b");
  });
});
