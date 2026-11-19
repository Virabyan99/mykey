// Run 6.6 Task B (P-121, D-53; FR-1.78, AC-1.36): the retention job against a
// real database and a directory store whose answers a switch can bend.
// Order per pair: eligible.json, a HEAD that proves it gone, the row expired
// with deleted_at, then bundle.tar. A refusal leaves the rest for the next run.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { directoryStore, planRetention, type DeleteOutcome, type ObjectStore } from "@mykey/backup";
import { findPair, listPairs } from "@mykey/db";
import { applyRetention } from "@mykey/operations/operator";
import { runOps } from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

const DAY = 86_400_000;
let db: TestDatabase;
let work: string;

beforeAll(async () => {
  db = await prepareDatabase({ migrate: true });
  work = mkdtempSync(join(tmpdir(), "mykey-retention-test-"));
}, 300_000);

afterAll(async () => {
  rmSync(work, { recursive: true, force: true });
  await db.drop();
});

interface Bent {
  store: ObjectStore;
  /** Keys a delete refuses as R2 does inside a lock. */
  refuse: Set<string>;
  /** Keys a delete reports as deleted but leaves in place. */
  lie: Set<string>;
  /** Every key list passed to deleteChecked, in order. */
  calls: string[][];
  aborted: string[];
}

function bentStore(): Bent {
  const plain = directoryStore(mkdtempSync(join(work, "bucket-")));
  const bent: Bent = { store: plain, refuse: new Set(), lie: new Set(), calls: [], aborted: [] };
  bent.store = {
    ...plain,
    async deleteChecked(keys) {
      bent.calls.push([...keys]);
      const outcomes: DeleteOutcome[] = [];
      for (const key of keys) {
        if (bent.refuse.has(key)) {
          outcomes.push({ key, deleted: false, errorCode: "ObjectLockedByBucketPolicy" });
        } else if (bent.lie.has(key)) {
          outcomes.push({ key, deleted: true });
        } else {
          outcomes.push(...(await plain.deleteChecked([key])));
        }
      }
      return outcomes;
    },
    abortStaleUploads(prefix) {
      bent.aborted.push(prefix);
      return Promise.resolve(2);
    },
  };
  return bent;
}

const utc = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/** A pair row and (for eligible and ineligible pairs) its two objects. */
async function seedPair(
  bent: Bent,
  host: string,
  daysAgo: number,
  status: "eligible" | "ineligible" | "candidate",
): Promise<{ id: string; prefix: string }> {
  const id = randomUUID();
  const captured = new Date(Date.now() - daysAgo * DAY);
  const prefix = `pairs/${host}/${utc(captured)}-${id}/`;
  await run(
    db.pool("superuser"),
    `INSERT INTO app.backup_pair (id, host, capture_started_at, boundary, artifact_hashes,
       schema_revision, release_commit, key_refs, validation_status, eligible_until, object_key,
       invalid_reason, created_at)
     VALUES ($1, $2, $3, '{}', '{}', '0017_capture_barrier', 'abcdef123456', '{}', $4, $5, $6, $7, $3)`,
    [
      id,
      host,
      captured,
      status,
      status === "eligible" ? new Date(captured.getTime() + 30 * DAY) : null,
      status === "eligible" ? prefix : null,
      status === "ineligible" ? "aborted" : null,
    ],
  );
  if (status !== "candidate") {
    for (const name of ["bundle.tar", "eligible.json"]) {
      const body = randomBytes(64);
      const { createHash } = await import("node:crypto");
      await bent.store.put(`${prefix}${name}`, body, {
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    }
  }
  return { id, prefix };
}

async function retention(bent: Bent, host: string): ReturnType<typeof applyRetention> {
  const now = new Date();
  const plan = planRetention(
    await listPairs(db.pool("maintenance"), host),
    await bent.store.list(`pairs/${host}/`),
    host,
    now,
  );
  return applyRetention(
    { pool: db.pool("maintenance"), store: bent.store, host, now: () => now },
    plan,
  );
}

async function ops(bent: Bent, host: string): Promise<{ code: number; out: string; err: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  const { generateKeyPairSync } = await import("node:crypto");
  const code = await runOps(["pair", "--step", "retention"], {
    stdin: new PassThrough(),
    stdout,
    stderr,
    env: {
      database: db.targets.maintenance,
      pairs: {
        store: bent.store,
        host,
        signing: { key: generateKeyPairSync("ed25519").privateKey, keyId: "k1" },
      },
    },
  });
  return { code, out, err };
}

describe("the retention job (P-121)", () => {
  it("eligible.json goes first; when bundle.tar is refused the row is expired, the refusal is recorded and the next run tries only the bundle", async () => {
    const bent = bentStore();
    const old = await seedPair(bent, "h1", 40, "eligible");
    await seedPair(bent, "h1", 1, "eligible");
    bent.refuse.add(`${old.prefix}bundle.tar`);

    const first = await retention(bent, "h1");
    expect(bent.calls).toEqual([[`${old.prefix}eligible.json`], [`${old.prefix}bundle.tar`]]);
    expect(first.deleted).toEqual([`${old.prefix}eligible.json`]);
    expect(first.refused).toEqual([
      { key: `${old.prefix}bundle.tar`, code: "ObjectLockedByBucketPolicy" },
    ]);
    const closed = await findPair(db.pool("superuser"), old.id);
    expect(closed?.status).toBe("expired");
    expect(closed?.deletedAt).toBeInstanceOf(Date);

    bent.refuse.clear();
    bent.calls.length = 0;
    const second = await retention(bent, "h1");
    expect(bent.calls).toEqual([[`${old.prefix}bundle.tar`]]);
    expect(second.deleted).toEqual([`${old.prefix}bundle.tar`]);
    expect(await bent.store.list(old.prefix)).toEqual([]);
  });

  it("a refused eligible.json leaves the row as it is and the bundle untouched", async () => {
    const bent = bentStore();
    const old = await seedPair(bent, "h2", 40, "eligible");
    await seedPair(bent, "h2", 1, "eligible");
    bent.refuse.add(`${old.prefix}eligible.json`);
    const result = await retention(bent, "h2");
    expect(bent.calls).toEqual([[`${old.prefix}eligible.json`]]);
    expect(result.refused.map((r) => r.key)).toEqual([`${old.prefix}eligible.json`]);
    expect((await findPair(db.pool("superuser"), old.id))?.status).toBe("eligible");
  });

  it("a delete that answers success for a key that is still there is reported as stillPresent and the job exits 1", async () => {
    const bent = bentStore();
    const old = await seedPair(bent, "h3", 40, "eligible");
    await seedPair(bent, "h3", 1, "eligible");
    bent.lie.add(`${old.prefix}eligible.json`);
    const answer = await ops(bent, "h3");
    expect(answer.code, answer.err).toBe(1);
    expect(answer.err).toContain("still present");
    // eligible.json was not proven gone: the row stays, the bundle is not touched.
    expect((await findPair(db.pool("superuser"), old.id))?.status).toBe("eligible");
    expect(bent.calls).toEqual([[`${old.prefix}eligible.json`]]);
  });

  it("system.backup_cleanup carries the three counts; a run that deletes nothing says so and exits 0", async () => {
    const bent = bentStore();
    const old = await seedPair(bent, "h4", 40, "eligible");
    const fresh = await seedPair(bent, "h4", 1, "eligible");
    const lockedOne = await seedPair(bent, "h4", 10, "ineligible");
    const first = await ops(bent, "h4");
    expect(first.code, first.err).toBe(0);
    const second = await ops(bent, "h4");
    expect(second.code, second.err).toBe(0);
    expect(second.out).toContain("nothing to delete");
    const events = await run<{ details: { deleted: number; kept: number; refused: number } }>(
      db.pool("superuser"),
      `SELECT details FROM audit.event WHERE action = 'system.backup_cleanup' ORDER BY occurred_at`,
    );
    expect(events.slice(-2).map((row) => row.details)).toEqual([
      { deleted: 2, kept: 2, refused: 0 },
      { deleted: 0, kept: 2, refused: 0 },
    ]);
    expect(await bent.store.list(old.prefix)).toEqual([]);
    expect((await bent.store.list(fresh.prefix)).length).toBe(2);
    expect((await bent.store.list(lockedOne.prefix)).length).toBe(2);
  });

  it("stale multipart uploads are aborted under the host's prefix", async () => {
    const bent = bentStore();
    await seedPair(bent, "h5", 1, "eligible");
    const result = await retention(bent, "h5");
    expect(bent.aborted).toEqual(["pairs/h5/"]);
    expect(result.uploadsAborted).toBe(2);
  });

  it("a candidate past its two hours becomes ineligible (deadline) before anything is deleted", async () => {
    const bent = bentStore();
    await seedPair(bent, "h6", 1, "eligible");
    const stale = await seedPair(bent, "h6", 0.5, "candidate");
    const result = await retention(bent, "h6");
    expect(result.expired).toEqual([stale.id]);
    const row = await findPair(db.pool("superuser"), stale.id);
    expect([row?.status, row?.invalidReason]).toEqual(["ineligible", "deadline"]);
  });

  it("the newest eligible pair stays even when every pair is expired", async () => {
    const bent = bentStore();
    const older = await seedPair(bent, "h7", 50, "eligible");
    const newest = await seedPair(bent, "h7", 40, "eligible");
    await retention(bent, "h7");
    expect(await bent.store.list(older.prefix)).toEqual([]);
    expect((await bent.store.list(newest.prefix)).length).toBe(2);
    expect((await findPair(db.pool("superuser"), newest.id))?.status).toBe("eligible");
  });
});
