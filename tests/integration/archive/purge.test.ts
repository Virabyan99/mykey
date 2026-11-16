// Run 6.2 Task B (P-112, P-131, FR-1.81, Doc 10 §4.1 rule 8): rows leave
// audit.event only through audit.purge_archived(), only 365 days old, only in
// whole intervals whose segments are verified and whose recount equals them;
// the purge writes its own row. Nobody deletes, updates or truncates directly.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeArchived } from "@mykey/db";
import { createArchiveFixture, plusHours, type ArchiveFixture } from "./fixture.ts";

let f: ArchiveFixture;

beforeAll(async () => {
  f = await createArchiveFixture();
}, 300_000);

afterAll(async () => {
  await f.close();
});

const sha = (n: number): string => n.toString(16).padStart(64, "0");
let sequence = 0;

/** A segment row written as the superuser (the purge reads only the table). */
async function segment(
  from: string,
  rows: number,
  opts: { verified?: boolean } = {},
): Promise<void> {
  sequence += 1;
  await f.db.pool("superuser").query(
    `INSERT INTO audit.archive_segment (sequence, stream, host, from_at, to_at, row_count, sha256,
       previous_sha256, object_key, uploaded_at, verified_at)
     VALUES ($1, 'app', 'test', $2::timestamptz, $2::timestamptz + interval '1 day', $3, $4, $5, $6,
             now(), CASE WHEN $7 THEN now() END)`,
    [
      sequence,
      from,
      rows,
      sha(sequence),
      sequence === 1 ? null : sha(sequence - 1),
      `test/app/${String(sequence)}`,
      opts.verified ?? true,
    ],
  );
}

const present = async (from: string): Promise<number> =>
  Number(
    (
      await f.db.pool("superuser").query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit.event
          WHERE occurred_at >= $1::timestamptz AND occurred_at < $1::timestamptz + interval '1 day'`,
        [from],
      )
    ).rows[0]?.n,
  );

const before365 = async (): Promise<string> =>
  (
    await f.db
      .pool("superuser")
      .query<{ at: string }>("SELECT (now() - interval '365 days')::text AS at")
  ).rows[0]?.at ?? "";

describe("audit.purge_archived (P-112)", () => {
  it("rows older than 365 days in a verified, fully counted interval are deleted; 364 days old stay; system.audit_purge says how many", async () => {
    const old = await f.dayStart(370);
    const young = await f.dayStart(364);
    await f.rows([plusHours(old, 1), plusHours(old, 2), plusHours(old, 3)]);
    await f.rows([plusHours(young, 1)]);
    await segment(old, 3);
    await segment(young, 1);
    const purged = await purgeArchived(f.db.pool("maintenance"), await before365());
    expect(purged).toEqual({ rows: 3, intervals: 1 });
    expect(await present(old)).toBe(0);
    expect(await present(young)).toBe(1);
    const row = await f.db
      .pool("superuser")
      .query<{ details: unknown; organization_id: string | null; occurred_at: Date }>(
        "SELECT details, organization_id, occurred_at FROM audit.event WHERE action = 'system.audit_purge' ORDER BY occurred_at DESC LIMIT 1",
      );
    expect(row.rows[0]?.details).toEqual({ rows: 3, intervals: 1 });
    expect(row.rows[0]?.organization_id).toBeNull();
    const marked = await f.db
      .pool("superuser")
      .query("SELECT 1 FROM audit.archive_segment WHERE purged_at IS NOT NULL");
    expect(marked.rowCount).toBe(1);
  });

  it("an interval with an unverified segment keeps its rows", async () => {
    const day = await f.dayStart(380);
    await f.rows([plusHours(day, 4)]);
    await segment(day, 1, { verified: false });
    expect((await purgeArchived(f.db.pool("maintenance"), await before365())).rows).toBe(0);
    expect(await present(day)).toBe(1);
  });

  it("an interval whose recount exceeds its manifests keeps its rows", async () => {
    const day = await f.dayStart(390);
    await f.rows([plusHours(day, 4), plusHours(day, 5)]);
    await segment(day, 1);
    expect((await purgeArchived(f.db.pool("maintenance"), await before365())).rows).toBe(0);
    expect(await present(day)).toBe(2);
  });

  it("refuses a before less than 365 days ago (22023)", async () => {
    const error = await purgeArchived(f.db.pool("maintenance"), new Date().toISOString()).then(
      () => null,
      (caught: unknown) => caught as { code?: string },
    );
    expect(error?.code).toBe("22023");
  });

  it("the purge's own audit row is never purged in the same call", async () => {
    const count = async () =>
      Number(
        (
          await f.db
            .pool("superuser")
            .query<{ n: string }>(
              "SELECT count(*)::text AS n FROM audit.event WHERE action = 'system.audit_purge'",
            )
        ).rows[0]?.n,
      );
    const start = await count();
    await purgeArchived(f.db.pool("maintenance"), await before365());
    expect(await count()).toBe(start + 1);
  });
});

describe("nobody changes audit.event directly (P-112, P-131)", () => {
  const statements = (id: string) => ({
    delete: `DELETE FROM audit.event WHERE id = '${id}'`,
    update: `UPDATE audit.event SET outcome = 'failure' WHERE id = '${id}'`,
    truncate: "TRUNCATE audit.event",
  });

  it("maintenance cannot DELETE, UPDATE or TRUNCATE (42501)", async () => {
    const [id = randomUUID()] = await f.rows([new Date().toISOString()]);
    for (const [kind, sql] of Object.entries(statements(id))) {
      const error = await f.db
        .pool("maintenance")
        .query(sql)
        .then(
          () => null,
          (caught: unknown) => caught as { code?: string },
        );
      expect(error?.code, kind).toBe("42501");
    }
  });

  it("the owner's own session and the superuser are refused UPDATE and TRUNCATE by the trigger, even on no row", async () => {
    for (const login of ["migration_owner", "superuser"] as const) {
      for (const sql of [
        "UPDATE audit.event SET outcome = 'failure' WHERE false",
        "TRUNCATE audit.event",
      ]) {
        const error = await f.db
          .pool(login)
          .query(sql)
          .then(
            () => null,
            (caught: unknown) => caught as { code?: string; message?: string },
          );
        expect(error?.code, `${login}: ${sql}`).toBe("42501");
        expect(error?.message).toMatch(/append-only/);
      }
    }
  });
});
