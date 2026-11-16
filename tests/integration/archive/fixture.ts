// Shared set-up of the archive suites (Run 6.2): a fresh database, rows of
// audit.event at chosen times (database time), and the job over a store in a
// local directory. The bucket's own behaviour is the cloud test's.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { directoryStore, type ObjectStore } from "@mykey/backup";

import { auditArchive, runOps, type ArchiveResult } from "@mykey/ops";
import { prepareDatabase, type TestDatabase } from "../database/setup.ts";

export interface ArchiveFixture {
  db: TestDatabase;
  storeDir: string;
  store: ObjectStore;
  /** The start of the UTC day `daysAgo` days before today, database time, ISO. */
  dayStart(daysAgo: number): Promise<string>;
  /** Inserts rows (as the superuser, as a writer would) at the given times; their ids. */
  rows(times: readonly string[]): Promise<string[]>;
  /** One run of the job as maintenance. */
  archive(store?: ObjectStore, rotatedDir?: string | null): Promise<ArchiveResult>;
  /** One run of `ops audit-archive` as maintenance; its exit code and stderr. */
  command(store?: ObjectStore): Promise<{ code: number; stderr: string }>;
  segments(): Promise<
    {
      sequence: string;
      stream: string;
      from_at: Date;
      to_at: Date;
      row_count: string;
      sha256: string;
      previous_sha256: string | null;
      object_key: string;
      verified_at: Date | null;
      purged_at: Date | null;
    }[]
  >;
  close(): Promise<void>;
}

export async function createArchiveFixture(): Promise<ArchiveFixture> {
  const db = await prepareDatabase();
  const superuser = db.pool("superuser");
  const maintenance = db.pool("maintenance");
  const storeDir = mkdtempSync(join(tmpdir(), "mykey-archive-store-"));
  const store = directoryStore(storeDir);
  return {
    db,
    storeDir,
    store,
    async dayStart(daysAgo) {
      const result = await superuser.query<{ at: string }>(
        `SELECT to_char((date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $1))
                  , 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
        [daysAgo],
      );
      return result.rows[0]?.at ?? "";
    },
    async rows(times) {
      const ids: string[] = [];
      for (const time of times) {
        const id = randomUUID();
        await superuser.query(
          `INSERT INTO audit.event (id, occurred_at, actor_kind, source_category, action, outcome, details)
           VALUES ($1, $2::timestamptz, 'system', 'system', 'operator.operations_expire', 'success',
                   '{"expired": 0}'::jsonb)`,
          [id, time],
        );
        ids.push(id);
      }
      return ids;
    },
    archive(other, rotatedDir = null) {
      return auditArchive({ pool: maintenance, store: other ?? store, host: "test", rotatedDir });
    },
    async command(other) {
      const stderr: Buffer[] = [];
      const err = new PassThrough();
      err.on("data", (chunk: Buffer) => stderr.push(chunk));
      const input = new PassThrough();
      input.end();
      const code = await runOps(["audit-archive"], {
        stdin: input,
        stdout: new PassThrough(),
        stderr: err,
        env: {
          database: db.targets.maintenance,
          archive: { store: other ?? store, host: "test", rotatedDir: null },
        },
      });
      return { code, stderr: Buffer.concat(stderr).toString("utf8") };
    },
    async segments() {
      const result = await superuser.query(
        `SELECT sequence::text, stream, from_at, to_at, row_count::text, sha256, previous_sha256,
                object_key, verified_at, purged_at
           FROM audit.archive_segment ORDER BY sequence`,
      );
      return result.rows as Awaited<ReturnType<ArchiveFixture["segments"]>>;
    },
    async close() {
      await db.drop();
    },
  };
}

/** An ISO time `hours` after the given ISO time. */
export const plusHours = (iso: string, hours: number): string =>
  new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
