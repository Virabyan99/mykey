// Run 6.5 Task C (P-119): a real pair bundle of the local stack — a pg_dump,
// the globals and a Raft snapshot packed into its own Restic repository —
// through the pair job's own token (`mykey-staging-pairs-upload`) and r2Store,
// under `probe/` of `mykey-staging-pairs` (no lock there until Run 6.5 Task D
// sets the 30-day rule on `pairs/`; the probe object is deleted afterwards).
// Its size and the upload time go into docs/evidence/cost-sheet.md. Run 6.6
// adds the retention clean-up to this file. Cloud tests describe provider
// behaviour: a failure is a finding to record, never something to fix by
// weakening the assertion.
//
// Run 6.6 Task B (P-121): applyRetention with the real store, in the fixture
// bucket's probe/ (locked 600 s). Each run makes one pair-shaped prefix
// probe/ret-<epochMs>-<pairId>/ (eligible.json, bundle.tar). The prefixes of a
// run at least eleven minutes earlier are cleaned up; this run's own is
// refused with 409 and reported, not thrown. Outcomes are appended to
// docs/evidence/session-6/run-6.6-retention-cloud.json.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf, loadR2Credentials, r2Store } from "@mykey/backup";
import { findPair, type PairRow } from "@mykey/db";
import { applyRetention } from "@mykey/operations/operator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restic, tarIn } from "../../harness/restic.ts";
import { FIXTURE_BUCKET } from "../../../infra/backup/retention-fixture/upload.ts";
import { prepareDatabase, run } from "../../integration/database/setup.ts";
import {
  baoFetch,
  freshDatabase,
  pgDumpToFile,
  pgGlobalsToFile,
  startStack,
  type Stack,
} from "../../harness/stack.ts";

const store = r2Store(loadR2Credentials("mykey-staging-pairs-upload"), "mykey-staging-pairs");
const key = `probe/${new Date().toISOString().slice(0, 10)}/${randomBytes(6).toString("hex")}/bundle.tar`;
let stack: Stack;
let work: string;

beforeAll(async () => {
  stack = await startStack();
  work = mkdtempSync(join(tmpdir(), "mykey-pair-cloud-"));
}, 600_000);

afterAll(async () => {
  rmSync(work, { recursive: true, force: true });
  await stack.stop();
}, 300_000);

describe("a real pair bundle in the pairs bucket (P-119)", () => {
  it("is put, read back and compared through the pair job's token; the probe object is then deleted", async () => {
    const database = await freshDatabase(stack);
    const artifacts = join(work, "artifacts");
    mkdirSync(artifacts);
    await pgDumpToFile(stack, database.database, join(artifacts, "postgres.dump"));
    await pgGlobalsToFile(stack, join(artifacts, "globals.sql"));
    const snapshot = await baoFetch(stack, "/v1/sys/storage/raft/snapshot");
    expect(snapshot.status).toBe(200);
    writeFileSync(join(artifacts, "openbao.snap"), new Uint8Array(await snapshot.arrayBuffer()));

    const password = join(work, "password");
    writeFileSync(password, randomBytes(24).toString("hex"));
    mkdirSync(join(work, "repo"));
    const paths = { repo: join(work, "repo"), password };
    expect((await restic(paths, ["init"])).code).toBe(0);
    expect(
      (await restic({ ...paths, artifacts }, ["backup", "--host", "mykey", "/artifacts"])).code,
    ).toBe(0);
    await tarIn(work, ["-C", "/d", "-cf", "/d/bundle.tar", "repo"]);
    const bundle = join(work, "bundle.tar");
    const sent = await digestOf(createReadStream(bundle));

    const started = Date.now();
    await store.put(key, createReadStream(bundle), sent);
    const uploadMs = Date.now() - started;
    const back = await digestOf(await store.get(key));
    expect(back).toEqual(sent);
    expect((await store.head(key))?.bytes).toBe(sent.bytes);

    const deleted = await store.deleteChecked([key]);
    expect(deleted).toEqual([{ key, deleted: true }]);
    expect(await store.head(key)).toBeNull();

    writeFileSync(
      join(import.meta.dirname, "../../../docs/evidence/session-6/run-6.5-pair-cloud.json"),
      `${JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          bucket: "mykey-staging-pairs",
          token: "mykey-staging-pairs-upload",
          bundleBytes: sent.bytes,
          uploadMs,
          readBackEqual: back.sha256 === sent.sha256,
          probeDeleted: true,
        },
        null,
        2,
      )}
`,
    );
    await database.drop();
  }, 600_000);
});

const RET_PREFIX = /^probe\/ret-(\d{13})-([0-9a-f-]{36})\/$/;
const EARLIER_RUN_MS = 11 * 60_000;
const RETENTION_LOG = "docs/evidence/session-6/run-6.6-retention-cloud.json";

describe("retention with the real store (P-121)", () => {
  it("a pair-shaped prefix of a run eleven minutes earlier is cleaned up by applyRetention; one made now is refused with 409 and reported, not thrown", async () => {
    const uploader = r2Store(loadR2Credentials("mykey-fixture-upload"), FIXTURE_BUCKET);
    const cleaner = r2Store(loadR2Credentials("mykey-fixture-cleanup"), FIXTURE_BUCKET);
    const database = await prepareDatabase({ migrate: true, stack });
    try {
      const startedAt = Date.now();
      const listed = await cleaner.list("probe/ret-");
      const byPrefix = new Map<string, string[]>();
      for (const { key: k } of listed) {
        const prefix = k.slice(0, k.indexOf("/", "probe/ret-".length) + 1);
        byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), k]);
      }
      const earlier = [...byPrefix.entries()].filter(
        ([prefix]) => startedAt - Number(RET_PREFIX.exec(prefix)?.[1]) >= EARLIER_RUN_MS,
      );

      // This run's pair-shaped prefix, locked for the next 600 s.
      const ownId = randomUUID();
      const own = `probe/ret-${String(startedAt)}-${ownId}/`;
      for (const name of ["bundle.tar", "eligible.json"]) {
        const body = randomBytes(256);
        await uploader.put(`${own}${name}`, body, {
          bytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        });
      }

      // Rows for every pair in the plan: each 40 days old, beside a newer one.
      const rowFor = async (id: string): Promise<PairRow> => {
        await run(
          database.pool("superuser"),
          `INSERT INTO app.backup_pair (id, host, capture_started_at, boundary, artifact_hashes,
             schema_revision, release_commit, key_refs, validation_status, eligible_until, created_at)
           VALUES ($1, 'cloudtest', now() - interval '40 days', '{}', '{}', '0017_capture_barrier',
                   'abcdef123456', '{}', 'eligible', now() - interval '10 days', now() - interval '40 days')`,
          [id],
        );
        const row = await findPair(database.pool("superuser"), id);
        if (row === null) throw new Error("row not written");
        return row;
      };
      const sortKeys = (keys: string[]): string[] =>
        [...keys].sort(
          (a, b) => Number(!a.endsWith("/eligible.json")) - Number(!b.endsWith("/eligible.json")),
        );
      const plan = {
        expire: [],
        keep: [],
        orphans: [],
        delete: [
          ...(await Promise.all(
            earlier.map(async ([prefix, keys]) => ({
              pair: await rowFor(RET_PREFIX.exec(prefix)?.[2] ?? ""),
              keys: sortKeys(keys),
            })),
          )),
          {
            pair: await rowFor(ownId),
            keys: sortKeys([`${own}bundle.tar`, `${own}eligible.json`]),
          },
        ],
      };
      const now = new Date();
      const result = await applyRetention(
        { pool: database.pool("maintenance"), store: cleaner, host: "cloudtest", now: () => now },
        plan,
      );

      // This run's: eligible.json refused (409), reported; the bundle untouched; the row stays.
      expect(result.refused).toEqual([
        { key: `${own}eligible.json`, code: "ObjectLockedByBucketPolicy" },
      ]);
      expect(await cleaner.head(`${own}bundle.tar`)).not.toBeNull();
      expect((await findPair(database.pool("superuser"), ownId))?.status).toBe("eligible");
      // Earlier runs': every object deleted and gone, rows closed.
      const earlierKeys = earlier.flatMap(([, keys]) => keys);
      expect([...result.deleted].sort()).toEqual([...earlierKeys].sort());
      expect(result.stillPresent).toEqual([]);
      for (const k of earlierKeys) expect(await cleaner.head(k), k).toBeNull();
      expect(result.closed.length).toBe(earlier.length);

      const log = existsSync(RETENTION_LOG)
        ? (JSON.parse(readFileSync(RETENTION_LOG, "utf8")) as unknown[])
        : [];
      log.push({
        run: own,
        startedAt: new Date(startedAt).toISOString(),
        cleanedUp: earlier.map(([prefix, keys]) => ({
          prefix,
          objects: keys.length,
          ageMinutes: Math.round((startedAt - Number(RET_PREFIX.exec(prefix)?.[1])) / 60_000),
        })),
        ownRefused: result.refused,
        note:
          earlier.length === 0
            ? `no ret- prefix at least 11 min older; the next run after ${new Date(startedAt + EARLIER_RUN_MS).toISOString()} cleans this one up`
            : "earlier prefixes deleted by applyRetention after their lock, proven gone by HEAD",
      });
      writeFileSync(RETENTION_LOG, `${JSON.stringify(log, null, 2)}\n`);
    } finally {
      await database.drop();
    }
  }, 600_000);
});
