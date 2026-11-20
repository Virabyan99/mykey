// Run 8.2 (P-151): the grants of staging's real database are the matrix the
// integration suite proves (tests/harness/privilege-matrix.ts). It reads the
// catalog through the superuser tunnel and changes nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matrixProblems } from "../harness/privilege-matrix.ts";
import { connectStaging, type StagingStack } from "../harness/staging.ts";
import { stagingDatabase } from "../harness/staging-db.ts";

let staging: StagingStack;

beforeAll(async () => {
  staging = await connectStaging();
}, 120_000);

afterAll(async () => {
  await (staging as StagingStack | undefined)?.close();
});

describe("staging's database", () => {
  it("the privileges in staging's database equal the matrix", async () => {
    const db = await stagingDatabase(staging);
    try {
      const superuser = db.pool("superuser");
      // Control: the catalog is the migrated product's, not an empty database.
      const tables = await superuser.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'app'",
      );
      expect(Number(tables.rows[0]?.count)).toBeGreaterThanOrEqual(19);
      expect(await matrixProblems(superuser)).toEqual([]);
    } finally {
      await db.drop();
    }
  }, 300_000);
});
