// Gate of Session 6 (review finding B): a restored database's audit chain ends
// at its pair, while the lost host had already archived later segments under
// the same host name, and those objects are locked. The restored host must
// archive its own next segments beside them, not stop on a key it cannot
// overwrite. A restore always writes a new backend incarnation, so the
// incarnation is part of every new segment's key.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeIncarnation } from "@mykey/db";
import { createArchiveFixture, plusHours, type ArchiveFixture } from "./fixture.ts";

let lost: ArchiveFixture;
let restored: ArchiveFixture;
const lostIncarnation = randomUUID();
const restoredIncarnation = randomUUID();

beforeAll(async () => {
  lost = await createArchiveFixture();
  restored = await createArchiveFixture();
  await writeIncarnation(lost.db.pool("superuser"), lostIncarnation, null);
  await writeIncarnation(restored.db.pool("superuser"), restoredIncarnation, randomUUID());
}, 300_000);

afterAll(async () => {
  await lost.close();
  await restored.close();
});

describe("a restored chain beside the lost host's segments (review finding B)", () => {
  it("each segment's key holds the database's backend incarnation", async () => {
    const day = await lost.dayStart(3);
    await lost.rows([plusHours(day, 2), plusHours(day, 5)]);
    await lost.archive();
    const segments = await lost.segments();
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.object_key.startsWith(`test/${lostIncarnation}/app/`)).toBe(true);
    }
  });

  it("the restored host, same name, other rows, archives into the same bucket without stopping", async () => {
    const day = await restored.dayStart(3);
    await restored.rows([plusHours(day, 7)]);
    // The lost host's objects are in the store already (the first test).
    const result = await restored.archive(lost.store);
    expect(result.segments).toBeGreaterThan(0);
    const segments = await restored.segments();
    for (const segment of segments) {
      expect(segment.verified_at).not.toBeNull();
      expect(segment.object_key.startsWith(`test/${restoredIncarnation}/app/`)).toBe(true);
    }
    const lostKeys = new Set((await lost.segments()).map((segment) => segment.object_key));
    expect(segments.some((segment) => lostKeys.has(segment.object_key))).toBe(false);
  });
});
