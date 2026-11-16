// ops audit-archive   (Run 6.2, P-112, D-48): the daily job of the audit
// trail, as `maintenance` on the host (ops-run.sh audit-archive).
//
//  1. One run at a time (an advisory lock that audit.purge_archived() shares).
//  2. The chain of segments must be whole — sequence 1, 2, 3… and each
//     previous_sha256 the sha256 of the one before — or the job stops with
//     exit 1 and writes nothing.
//  3. A segment recorded but not verified (a run that stopped) is rebuilt from
//     its rows or its file; when the rebuild has its recorded sha256 it is
//     uploaded where absent and verified, otherwise the job stops.
//  4. `app`: every archived interval is recounted; rows committed late into it
//     become a supplementary segment of the same interval holding exactly the
//     ids no earlier segment of it holds (read back from their objects). Then
//     one segment per closed UTC day, cut 15 minutes after the day ended.
//  5. `openbao`: each rotated audit file in the rotated directory becomes one
//     segment; the local file is removed only once its segment is verified.
//  6. Each segment: recorded, then the gzip body and its manifest are put,
//     read back and compared; only then verified_at, with one
//     system.audit_archive row in the same transaction.
//  7. Retention: audit.purge_archived(now − 365 days).
//
// Prints counts only. Exit 0 done, 1 stopped (the failed unit is the alert),
// 2 another run holds the lock.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";
import { appendAudit } from "@mykey/audit";
import { bytesOf, digestOf, type ObjectStore } from "@mykey/backup";
import { LIMITS } from "@mykey/contracts";
import {
  ARCHIVE_LOCK_SQL,
  chainProblems,
  createPool,
  databaseNow,
  insertSegment,
  intervalLines,
  intervalSegments,
  listSegments,
  markUploaded,
  markVerified,
  nextSegmentInterval,
  purgeArchived,
  recountIntervals,
  sourceSegment,
  withTransaction,
  type NewSegment,
  type SegmentRow,
  type SegmentStream,
} from "@mykey/db";
import type pg from "pg";
import { EXIT, type OpsCommand } from "../cli.ts";

export interface ArchiveDeps {
  pool: pg.Pool;
  store: ObjectStore;
  /** `staging` or `prod`: the first part of every object key. */
  host: string;
  /** Where the rotation leaves OpenBao's audit files; null where there is none. */
  rotatedDir: string | null;
}

export interface ArchiveResult {
  segments: number;
  lateSegments: number;
  rotatedFiles: number;
  purgedRows: number;
}

/** The job stopped on purpose; the reason names what is wrong, never a value. */
export class ArchiveStopped extends Error {}
/** Another run holds the lock. */
export class ArchiveBusy extends Error {}

export const MANIFEST_FORMAT = "mykey-audit-segment/1";
const ROTATED = /^audit-[0-9]{8}T[0-9]{6}Z\.log$/;

function segmentKey(host: string, stream: SegmentStream, from: string, sequence: bigint): string {
  const base = `${host}/${stream}/${from.slice(0, 4)}/${from.slice(5, 7)}/segment-${sequence
    .toString()
    .padStart(10, "0")}`;
  return `${base}.${stream === "app" ? "ndjson.gz" : "log.gz"}`;
}

export function manifestKeyOf(objectKey: string): string {
  return objectKey.replace(/\.(ndjson|log)\.gz$/, ".manifest.json");
}

export function manifestOf(segment: NewSegment): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      format: MANIFEST_FORMAT,
      stream: segment.stream,
      host: segment.host,
      sequence: Number(segment.sequence),
      source: segment.source,
      from: segment.fromAt,
      to: segment.toAt,
      rows: segment.rowCount,
      sha256: segment.sha256,
      previousSha256: segment.previousSha256,
    })}\n`,
  );
}

const sha256Of = (body: Buffer): string => createHash("sha256").update(body).digest("hex");

/** A body to put: in memory (a day of rows) or a file (a rotated audit file). */
interface Body {
  open(): Buffer | Readable;
  bytes: number;
  sha256: string;
}

const bufferBody = (buffer: Buffer): Body => ({
  open: () => buffer,
  bytes: buffer.length,
  sha256: sha256Of(buffer),
});

function appBody(lines: readonly { line: string }[]): Body {
  const text = lines.map((entry) => entry.line).join("\n");
  return bufferBody(gzipSync(Buffer.from(lines.length === 0 ? "" : `${text}\n`)));
}

/** The ids an object of an `app` segment holds. */
async function idsOf(store: ObjectStore, segment: SegmentRow): Promise<string[]> {
  const body = await bytesOf(await store.get(segment.objectKey));
  if (sha256Of(body) !== segment.sha256) {
    throw new ArchiveStopped(`segment ${String(segment.sequence)} reads back differently`);
  }
  const text = gunzipSync(body).toString("utf8");
  return text === ""
    ? []
    : text
        .trimEnd()
        .split("\n")
        .map((line) => (JSON.parse(line) as { id: string }).id);
}

/** Microseconds at most, as PostgreSQL stores them; OpenBao writes nanoseconds. */
export function microsIso(time: string): string {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(time);
  if (match === null) throw new ArchiveStopped("an audit entry has no usable time");
  return `${match[1] ?? ""}.${`${match[2] ?? ""}000000`.slice(0, 6)}Z`;
}

/** One pass over a rotated file: its line count and the times of its first and last entries. */
async function fileFacts(path: string): Promise<{ lines: number; first: string; last: string }> {
  let lines = 0;
  let first: string | null = null;
  let last = "";
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of reader) {
    if (line === "") continue;
    lines += 1;
    first ??= line;
    last = line;
  }
  if (first === null) return { lines: 0, first: "", last: "" };
  const timeOf = (line: string): string => {
    try {
      const entry = JSON.parse(line) as { time?: unknown };
      if (typeof entry.time !== "string") throw new Error("no time");
      return microsIso(entry.time);
    } catch {
      throw new ArchiveStopped(`a rotated file ends or starts with an unreadable entry`);
    }
  };
  return { lines, first: timeOf(first), last: timeOf(last) };
}

/** The gzip of a rotated file, next to it; deterministic for the same file. */
async function fileBody(path: string): Promise<Body> {
  const gz = `${path}.gz`;
  await pipeline(createReadStream(path), createGzip(), createWriteStream(gz));
  const { sha256, bytes } = await digestOf(createReadStream(gz));
  return { open: () => createReadStream(gz), bytes, sha256 };
}

export async function auditArchive(deps: ArchiveDeps): Promise<ArchiveResult> {
  const result: ArchiveResult = { segments: 0, lateSegments: 0, rotatedFiles: 0, purgedRows: 0 };
  const lock = await deps.pool.connect();
  try {
    const got = await lock.query<{ got: boolean }>(
      `SELECT pg_try_advisory_lock(${ARCHIVE_LOCK_SQL}) AS got`,
    );
    if (got.rows[0]?.got !== true) throw new ArchiveBusy("another archive run holds the lock");
    try {
      await runLocked(deps, lock, result);
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(${ARCHIVE_LOCK_SQL})`);
    }
  } finally {
    lock.release();
  }
  return result;
}

async function runLocked(
  deps: ArchiveDeps,
  lock: pg.PoolClient,
  result: ArchiveResult,
): Promise<void> {
  const { pool, store, host } = deps;
  let chain = await listSegments(pool);
  const problems = chainProblems(chain);
  if (problems.length > 0) throw new ArchiveStopped(`the chain is broken: ${problems.join("; ")}`);

  /** Records, uploads, reads back and verifies one segment. */
  const ship = async (segment: NewSegment, body: Body, recorded: boolean): Promise<void> => {
    if (!recorded) await insertSegment(pool, segment);
    const manifestKey = manifestKeyOf(segment.objectKey);
    const manifest = manifestOf(segment);
    if ((await store.head(segment.objectKey)) === null) {
      await store.put(segment.objectKey, body.open(), { bytes: body.bytes, sha256: body.sha256 });
    }
    if ((await store.head(manifestKey)) === null) {
      await store.put(manifestKey, manifest, {
        bytes: manifest.length,
        sha256: sha256Of(manifest),
      });
    }
    await markUploaded(pool, segment.sequence);
    const back = await digestOf(await store.get(segment.objectKey));
    const backManifest = await bytesOf(await store.get(manifestKey));
    if (
      back.sha256 !== body.sha256 ||
      back.bytes !== body.bytes ||
      !backManifest.equals(manifest)
    ) {
      throw new ArchiveStopped(`segment ${String(segment.sequence)} reads back differently`);
    }
    await withTransaction(pool, async (tx) => {
      await markVerified(tx, segment.sequence);
      await appendAudit(tx, {
        action: "system.audit_archive",
        actor: { kind: "system", id: null },
        source: "system",
        organizationId: null,
        target: null,
        outcome: "success",
        requestId: null,
        operationId: null,
        details: {
          stream: segment.stream,
          sequence: Number(segment.sequence),
          rows: segment.rowCount,
        },
      });
    });
    result.segments += 1;
  };

  const next = (
    stream: SegmentStream,
    from: string,
    to: string,
    rows: number,
    sha: string,
    source: string | null,
  ): NewSegment => {
    const last = chain.at(-1);
    const sequence = last === undefined ? 1n : last.sequence + 1n;
    const segment: NewSegment = {
      sequence,
      stream,
      host,
      source,
      fromAt: from,
      toAt: to,
      rowCount: rows,
      sha256: sha,
      previousSha256: last?.sha256 ?? null,
      objectKey: segmentKey(host, stream, from, sequence),
    };
    chain = [...chain, { ...segment, uploadedAt: null, verifiedAt: null, purgedAt: null }];
    return segment;
  };

  /** The ids the segments of an interval before `sequence` hold. */
  const heldBefore = async (from: string, to: string, sequence: bigint): Promise<string[]> => {
    const ids: string[] = [];
    for (const earlier of await intervalSegments(pool, from, to)) {
      if (earlier.sequence < sequence) ids.push(...(await idsOf(store, earlier)));
    }
    return ids;
  };

  // 3. Segments a stopped run recorded but did not verify.
  for (const pending of chain.filter((segment) => segment.verifiedAt === null)) {
    let body: Body;
    if (pending.stream === "app") {
      const lines = await intervalLines(
        pool,
        pending.fromAt,
        pending.toAt,
        await heldBefore(pending.fromAt, pending.toAt, pending.sequence),
      );
      body = appBody(lines.slice(0, pending.rowCount));
    } else {
      const path =
        deps.rotatedDir === null || pending.source === null
          ? null
          : join(deps.rotatedDir, pending.source);
      if (path === null || !existsSync(path)) {
        throw new ArchiveStopped(`segment ${String(pending.sequence)}: its rotated file is gone`);
      }
      body = await fileBody(path);
    }
    if (body.sha256 !== pending.sha256) {
      throw new ArchiveStopped(`segment ${String(pending.sequence)} cannot be rebuilt as recorded`);
    }
    await ship(pending, body, true);
  }

  // 4. app: rows committed late, then the closed days.
  for (const interval of await recountIntervals(pool)) {
    if (interval.present === interval.archived) continue;
    if (interval.present < interval.archived) {
      throw new ArchiveStopped(`the interval from ${interval.from} holds fewer rows than archived`);
    }
    const held = await heldBefore(interval.from, interval.to, BigInt(Number.MAX_SAFE_INTEGER));
    const lines = await intervalLines(pool, interval.from, interval.to, held);
    if (lines.length !== interval.present - interval.archived) {
      throw new ArchiveStopped(`the interval from ${interval.from} does not recount`);
    }
    const body = appBody(lines);
    await ship(
      next("app", interval.from, interval.to, lines.length, body.sha256, null),
      body,
      false,
    );
    result.lateSegments += 1;
  }
  for (
    let day = await nextSegmentInterval(pool);
    day !== null;
    day = await nextSegmentInterval(pool)
  ) {
    const lines = await intervalLines(pool, day.from, day.to);
    const body = appBody(lines);
    await ship(next("app", day.from, day.to, lines.length, body.sha256, null), body, false);
  }

  // 5. openbao: rotated files, removed once verified.
  if (deps.rotatedDir !== null && existsSync(deps.rotatedDir)) {
    const names = readdirSync(deps.rotatedDir)
      .filter((name) => ROTATED.test(name))
      .sort();
    for (const name of names) {
      const path = join(deps.rotatedDir, name);
      const existing = await sourceSegment(pool, name);
      if (existing === null) {
        const facts = await fileFacts(path);
        const now = await databaseNow(pool);
        const body = await fileBody(path);
        const from = facts.lines === 0 ? now : facts.first;
        const to = facts.lines === 0 ? now : facts.last;
        await ship(next("openbao", from, to, facts.lines, body.sha256, name), body, false);
      } else if (existing.verifiedAt === null) {
        throw new ArchiveStopped(`segment ${String(existing.sequence)} is still unverified`);
      }
      rmSync(path, { force: true });
      rmSync(`${path}.gz`, { force: true });
      result.rotatedFiles += 1;
    }
  }

  // 7. Retention, on the connection that holds the lock (the function takes the same key).
  const now = await databaseNow(lock);
  const before = new Date(Date.parse(now) - LIMITS.audit.retentionDays * 86_400_000).toISOString();
  result.purgedRows = (await purgeArchived(lock, before)).rows;
}

export const auditArchiveCommand: OpsCommand = {
  flags: [],
  summary: "archive closed audit days and rotated OpenBao files, verified off-host; then retention",
  async run(_flags, io) {
    const archive = io.env.archive;
    if (io.env.database === undefined || archive === undefined) {
      io.stderr.write("audit-archive: runs as a host job (ops-run.sh audit-archive)\n");
      return EXIT.failed;
    }
    const pool = createPool(io.env.database, { max: LIMITS.db.opsPool });
    try {
      const result = await auditArchive({ pool, ...archive });
      io.stdout.write(
        `segments ${String(result.segments)} late ${String(result.lateSegments)} rotated ${String(
          result.rotatedFiles,
        )} purged ${String(result.purgedRows)}\n`,
      );
      return EXIT.ok;
    } catch (error) {
      if (error instanceof ArchiveBusy) {
        io.stderr.write(`audit-archive: ${error.message}\n`);
        return EXIT.refused;
      }
      if (error instanceof ArchiveStopped) {
        io.stderr.write(`audit-archive: stopped: ${error.message}\n`);
        return EXIT.failed;
      }
      io.stderr.write(
        `audit-archive failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
