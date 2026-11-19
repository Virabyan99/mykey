// Run 6.2 Task B (P-112, FR-1.81, Review focus 4): audit segments. Real
// PostgreSQL; the store is a local directory (R2 itself: segment.cloud.test.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesOf, type ObjectStore } from "@mykey/backup";
import { ArchiveStopped, manifestKeyOf, MANIFEST_FORMAT } from "@mykey/ops";
import { createArchiveFixture, plusHours, type ArchiveFixture } from "./fixture.ts";

let f: ArchiveFixture;

beforeAll(async () => {
  f = await createArchiveFixture();
}, 300_000);

afterAll(async () => {
  await f.close();
});

const objectLines = (key: string): { id: string; occurredAt: string }[] => {
  const text = gunzipSync(readFileSync(join(f.storeDir, ...key.split("/")))).toString("utf8");
  return text === ""
    ? []
    : text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: string; occurredAt: string });
};

describe("segments of stream app (P-112)", () => {
  it("one closed day becomes one segment of the day's rows in order; sha256 is the object's; today is not archived; the manifest names it", async () => {
    const day = await f.dayStart(6);
    const ids = await f.rows([plusHours(day, 15), plusHours(day, 3), plusHours(day, 9)]);
    const today = await f.dayStart(0);
    const [todays] = await f.rows([plusHours(today, 0)]);
    const result = await f.archive();
    expect(result.segments).toBeGreaterThanOrEqual(5);
    const [first] = await f.segments();
    expect(first?.sequence).toBe("1");
    expect(first?.from_at.toISOString()).toBe(new Date(day).toISOString());
    expect(first?.row_count).toBe("3");
    expect(first?.verified_at).not.toBeNull();
    const key = first?.object_key ?? "";
    expect(key).toMatch(/^test\/app\/\d{4}\/\d{2}\/segment-0000000001\.ndjson\.gz$/);
    const bytes = readFileSync(join(f.storeDir, ...key.split("/")));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(first?.sha256);
    // Ordered by occurred_at: 03:00, 09:00, 15:00.
    expect(objectLines(key).map((line) => line.id)).toEqual([ids[1], ids[2], ids[0]]);
    const manifest = JSON.parse(
      readFileSync(join(f.storeDir, ...manifestKeyOf(key).split("/")), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      format: MANIFEST_FORMAT,
      stream: "app",
      host: "test",
      sequence: 1,
      rows: 3,
      sha256: first?.sha256,
      previousSha256: null,
    });
    const all = (await f.segments()).flatMap((segment) => objectLines(segment.object_key));
    expect(all.map((line) => line.id)).not.toContain(todays);
    const lastTo = (await f.segments()).at(-1)?.to_at.getTime() ?? 0;
    expect(lastTo).toBeLessThanOrEqual(Date.parse(today));
  });

  it("sequence and previous_sha256 chain over the days; a second run archives nothing", async () => {
    const segments = await f.segments();
    expect(segments.length).toBeGreaterThanOrEqual(5);
    segments.forEach((segment, index) => {
      expect(segment.sequence).toBe(String(index + 1));
      expect(segment.previous_sha256).toBe(index === 0 ? null : segments[index - 1]?.sha256);
    });
    const again = await f.archive();
    expect(again).toMatchObject({ segments: 0, lateSegments: 0 });
    expect((await f.segments()).length).toBe(segments.length);
  });

  it("a row committed late with an archived day's timestamp is in a supplementary segment after the next run, exactly once", async () => {
    const day = await f.dayStart(4);
    const late = f.db.pool("superuser");
    const client = await late.connect();
    let lateId = "";
    try {
      await client.query("BEGIN");
      lateId =
        (
          await client.query<{ id: string }>(
            `INSERT INTO audit.event (id, occurred_at, actor_kind, source_category, action, outcome, details)
           VALUES (gen_random_uuid(), $1::timestamptz, 'system', 'system', 'operator.operations_expire',
                   'success', '{"expired": 0}'::jsonb) RETURNING id::text`,
            [plusHours(day, 12)],
          )
        ).rows[0]?.id ?? "";
      // The run while the transaction is open does not see the row.
      expect((await f.archive()).lateSegments).toBe(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const after = await f.archive();
    expect(after.lateSegments).toBe(1);
    const supplementary = (await f.segments()).at(-1);
    expect(supplementary?.from_at.toISOString()).toBe(new Date(day).toISOString());
    expect(objectLines(supplementary?.object_key ?? "").map((line) => line.id)).toEqual([lateId]);
    expect((await f.archive()).lateSegments).toBe(0);
    const everywhere = (await f.segments())
      .flatMap((segment) => objectLines(segment.object_key))
      .filter((line) => line.id === lateId);
    expect(everywhere).toHaveLength(1);
  });

  it("an object that reads back different leaves verified_at null and the job fails; an honest run then verifies it", async () => {
    // A late row: the next segment is a supplementary one. Only objects written
    // by this run read back changed; the earlier ones stay honest.
    const day = await f.dayStart(3);
    await f.rows([plusHours(day, 7)]);
    const earlier = new Set((await f.store.list("")).map((entry) => entry.key));
    const lying: ObjectStore = {
      ...f.store,
      async get(key) {
        const body = await bytesOf(await f.store.get(key));
        if (!key.endsWith(".gz") || earlier.has(key)) return Readable.from([body]);
        const changed = Buffer.from(body);
        changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 0xff;
        return Readable.from([changed]);
      },
    };
    await expect(f.archive(lying)).rejects.toBeInstanceOf(ArchiveStopped);
    const pending = (await f.segments()).at(-1);
    expect(pending?.verified_at).toBeNull();
    const honest = await f.archive();
    expect(honest.segments).toBe(1);
    expect((await f.segments()).at(-1)?.verified_at).not.toBeNull();
  });

  it("a missing sequence number or a wrong previous hash stops the job with exit 1 and writes nothing", async () => {
    const superuser = f.db.pool("superuser");
    const before = await f.segments();
    const objects = await f.store.list("");
    const day = await f.dayStart(2);
    await f.rows([plusHours(day, 5)]);

    await superuser.query(
      "UPDATE audit.archive_segment SET previous_sha256 = repeat('0', 64) WHERE sequence = 3",
    );
    const wrongHash = await f.command();
    expect(wrongHash.code).toBe(1);
    expect(wrongHash.stderr).toMatch(/chain is broken: sequence 3: previous_sha256/);
    expect((await f.segments()).length).toBe(before.length);
    expect(await f.store.list("")).toEqual(objects);
    await superuser.query(
      "UPDATE audit.archive_segment SET previous_sha256 = $1 WHERE sequence = 3",
      [before[1]?.sha256],
    );

    const removed = before[1];
    await superuser.query("DELETE FROM audit.archive_segment WHERE sequence = 2");
    try {
      const gap = await f.command();
      expect(gap.code).toBe(1);
      expect(gap.stderr).toMatch(/chain is broken: sequence 3 follows 1/);
      expect((await f.segments()).length).toBe(before.length - 1);
      expect(await f.store.list("")).toEqual(objects);
    } finally {
      await superuser.query(
        `INSERT INTO audit.archive_segment (sequence, stream, host, source, from_at, to_at, row_count,
           sha256, previous_sha256, object_key, uploaded_at, verified_at)
         VALUES (2, 'app', 'test', NULL, $1, $2, $3, $4, $5, $6, now(), now())`,
        [
          removed?.from_at,
          removed?.to_at,
          removed?.row_count,
          removed?.sha256,
          removed?.previous_sha256,
          removed?.object_key,
        ],
      );
    }
    // Whole again: the run goes on.
    expect((await f.command()).code).toBe(0);
  });
});
