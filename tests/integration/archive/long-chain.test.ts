// Session 6 gate (staging): the segment list was ordered by its text alias
// (`sequence::text AS sequence ... ORDER BY sequence`), so from segment 10 on
// the chain read 1, 10, 11, 2 … and the job stopped for good on a whole chain.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSegments, chainProblems } from "@mykey/db";
import { createArchiveFixture, plusHours, type ArchiveFixture } from "./fixture.ts";

let f: ArchiveFixture;

beforeAll(async () => {
  f = await createArchiveFixture();
}, 300_000);

afterAll(async () => {
  await f.close();
});

describe("a chain of more than nine segments (Session 6 gate)", () => {
  it("lists in numeric order, and the next run does not stop on it", async () => {
    const day = await f.dayStart(12);
    await f.rows([plusHours(day, 1)]);
    const first = await f.archive();
    expect(first.segments).toBeGreaterThanOrEqual(11);
    const listed = await listSegments(f.db.pool("superuser"));
    expect(listed.map((segment) => Number(segment.sequence))).toEqual(
      listed.map((_, index) => index + 1),
    );
    expect(chainProblems(listed)).toEqual([]);
    await expect(f.archive()).resolves.toMatchObject({ segments: 0 });
  });
});
