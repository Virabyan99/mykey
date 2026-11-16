// The audit archive's rows (Run 6.2, P-112, migration 0016). Segments form one
// chain per host over the streams `app` and `openbao`. Times cross this module
// as ISO strings with microseconds (UTC), so an interval's bounds are exactly
// what PostgreSQL stored. Every time decision is database time.
import type { Queryable } from "../tx.ts";

export type SegmentStream = "app" | "openbao";

export interface SegmentRow {
  sequence: bigint;
  stream: SegmentStream;
  host: string;
  /** The rotated file's name for `openbao`; null for `app`. */
  source: string | null;
  /** ISO 8601 UTC with microseconds. */
  fromAt: string;
  toAt: string;
  rowCount: number;
  sha256: string;
  previousSha256: string | null;
  objectKey: string;
  uploadedAt: Date | null;
  verifiedAt: Date | null;
  purgedAt: Date | null;
}

const ISO = (column: string): string =>
  `to_char((${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SEGMENT_COLUMNS = `sequence::text AS sequence, stream, host, source,
  ${ISO("from_at")} AS from_at, ${ISO("to_at")} AS to_at, row_count, sha256,
  previous_sha256, object_key, uploaded_at, verified_at, purged_at`;

interface SegmentDbRow {
  sequence: string;
  stream: SegmentStream;
  host: string;
  source: string | null;
  from_at: string;
  to_at: string;
  row_count: string | number;
  sha256: string;
  previous_sha256: string | null;
  object_key: string;
  uploaded_at: Date | null;
  verified_at: Date | null;
  purged_at: Date | null;
}

const segmentOf = (row: SegmentDbRow): SegmentRow => ({
  sequence: BigInt(row.sequence),
  stream: row.stream,
  host: row.host,
  source: row.source,
  fromAt: row.from_at,
  toAt: row.to_at,
  rowCount: Number(row.row_count),
  sha256: row.sha256,
  previousSha256: row.previous_sha256,
  objectKey: row.object_key,
  uploadedAt: row.uploaded_at,
  verifiedAt: row.verified_at,
  purgedAt: row.purged_at,
});

/** Every segment, in sequence order. */
export async function listSegments(db: Queryable): Promise<SegmentRow[]> {
  const result = await db.query<SegmentDbRow>(
    `SELECT ${SEGMENT_COLUMNS} FROM audit.archive_segment ORDER BY sequence`,
  );
  return result.rows.map(segmentOf);
}

/**
 * What is wrong with the chain: a sequence that does not follow its
 * predecessor by one (a gap or a repeat), or a previous_sha256 that is not
 * the predecessor's sha256. Empty when the chain is whole.
 */
export function chainProblems(segments: readonly SegmentRow[]): string[] {
  const problems: string[] = [];
  let previous: SegmentRow | undefined;
  for (const segment of segments) {
    const expected = previous === undefined ? 1n : previous.sequence + 1n;
    if (segment.sequence !== expected) {
      problems.push(`sequence ${String(segment.sequence)} follows ${String(expected - 1n)}`);
    }
    const link = previous === undefined ? null : previous.sha256;
    if (segment.previousSha256 !== link) {
      problems.push(`sequence ${String(segment.sequence)}: previous_sha256 does not match`);
    }
    previous = segment;
  }
  return problems;
}

/** Database time as an ISO string with microseconds. */
export async function databaseNow(db: Queryable): Promise<string> {
  const result = await db.query<{ now: string }>(`SELECT ${ISO("now()")} AS now`);
  return result.rows[0]?.now ?? "";
}

/**
 * The next closed UTC day of stream `app`: the day after the last `app`
 * segment, or the day of the oldest event when there is none. Null when that
 * day ended less than 15 minutes ago (or there is no event at all).
 */
export async function nextSegmentInterval(
  db: Queryable,
): Promise<{ from: string; to: string } | null> {
  const result = await db.query<{ from_at: string | null; to_at: string | null; due: boolean }>(
    `WITH start AS (
       SELECT coalesce(
         (SELECT max(to_at) FROM audit.archive_segment WHERE stream = 'app'),
         (SELECT date_trunc('day', min(occurred_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            FROM audit.event)
       ) AS from_at
     )
     SELECT ${ISO("from_at")} AS from_at, ${ISO("from_at + interval '1 day'")} AS to_at,
            from_at + interval '1 day' + interval '15 minutes' <= now() AS due
       FROM start`,
  );
  const row = result.rows[0];
  if (row?.from_at === null || row?.from_at === undefined || row.to_at === null || !row.due) {
    return null;
  }
  return { from: row.from_at, to: row.to_at };
}

/**
 * The rows of [from, to) as NDJSON lines in (occurred_at, id) order, leaving
 * out `excluded` ids (rows an earlier segment of the interval already holds).
 */
export async function intervalLines(
  db: Queryable,
  from: string,
  to: string,
  excluded: readonly string[] = [],
): Promise<{ id: string; line: string }[]> {
  const result = await db.query<{ id: string; line: string }>(
    `SELECT id::text AS id,
            json_build_object(
              'id', id, 'occurredAt', ${ISO("occurred_at")}, 'actorKind', actor_kind,
              'actorId', actor_id, 'source', source_category, 'organizationId', organization_id,
              'action', action, 'targetKind', target_kind, 'targetId', target_id,
              'outcome', outcome, 'requestId', request_id, 'operationId', operation_id,
              'details', details)::text AS line
       FROM audit.event
      WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
        AND NOT (id = ANY ($3::uuid[]))
      ORDER BY occurred_at, id`,
    [from, to, excluded],
  );
  return result.rows;
}

/** For every `app` interval not purged: the rows its segments hold and the rows present now. */
export async function recountIntervals(
  db: Queryable,
): Promise<{ from: string; to: string; archived: number; present: number }[]> {
  const result = await db.query<{
    from_at: string;
    to_at: string;
    archived: string;
    present: string;
  }>(
    `SELECT ${ISO("s.from_at")} AS from_at, ${ISO("s.to_at")} AS to_at,
            sum(s.row_count)::text AS archived,
            (SELECT count(*) FROM audit.event e
              WHERE e.occurred_at >= s.from_at AND e.occurred_at < s.to_at)::text AS present
       FROM audit.archive_segment s
      WHERE s.stream = 'app' AND s.purged_at IS NULL
      GROUP BY s.from_at, s.to_at
      ORDER BY s.from_at`,
  );
  return result.rows.map((row) => ({
    from: row.from_at,
    to: row.to_at,
    archived: Number(row.archived),
    present: Number(row.present),
  }));
}

/** The segments of one `app` interval, in sequence order. */
export async function intervalSegments(
  db: Queryable,
  from: string,
  to: string,
): Promise<SegmentRow[]> {
  const result = await db.query<SegmentDbRow>(
    `SELECT ${SEGMENT_COLUMNS} FROM audit.archive_segment
      WHERE stream = 'app' AND from_at = $1::timestamptz AND to_at = $2::timestamptz
      ORDER BY sequence`,
    [from, to],
  );
  return result.rows.map(segmentOf);
}

/** The `openbao` segment of one rotated file, if any. */
export async function sourceSegment(db: Queryable, source: string): Promise<SegmentRow | null> {
  const result = await db.query<SegmentDbRow>(
    `SELECT ${SEGMENT_COLUMNS} FROM audit.archive_segment
      WHERE stream = 'openbao' AND source = $1`,
    [source],
  );
  const [row] = result.rows;
  return row === undefined ? null : segmentOf(row);
}

export type NewSegment = Omit<SegmentRow, "uploadedAt" | "verifiedAt" | "purgedAt">;

export async function insertSegment(db: Queryable, s: NewSegment): Promise<void> {
  await db.query(
    `INSERT INTO audit.archive_segment
       (sequence, stream, host, source, from_at, to_at, row_count, sha256, previous_sha256,
        object_key)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10)`,
    [
      s.sequence.toString(),
      s.stream,
      s.host,
      s.source,
      s.fromAt,
      s.toAt,
      s.rowCount,
      s.sha256,
      s.previousSha256,
      s.objectKey,
    ],
  );
}

export async function markUploaded(db: Queryable, sequence: bigint): Promise<void> {
  await db.query(
    "UPDATE audit.archive_segment SET uploaded_at = now() WHERE sequence = $1 AND uploaded_at IS NULL",
    [sequence.toString()],
  );
}

export async function markVerified(db: Queryable, sequence: bigint): Promise<void> {
  await db.query(
    `UPDATE audit.archive_segment SET verified_at = now(), uploaded_at = coalesce(uploaded_at, now())
      WHERE sequence = $1 AND verified_at IS NULL`,
    [sequence.toString()],
  );
}

/** `SELECT audit.purge_archived($1)`: whole verified, fully counted intervals that ended before `before`. */
export async function purgeArchived(
  db: Queryable,
  before: string,
): Promise<{ rows: number; intervals: number }> {
  // One statement: the function's deletes, marks and audit row commit together.
  const result = await db.query<{ purged_rows: string; purged_intervals: number }>(
    "SELECT purged_rows::text, purged_intervals FROM audit.purge_archived($1::timestamptz)",
    [before],
  );
  const row = result.rows[0];
  return { rows: Number(row?.purged_rows ?? 0), intervals: row?.purged_intervals ?? 0 };
}

/** The archive job's advisory key, shared with audit.purge_archived(). */
export const ARCHIVE_LOCK_SQL = "hashtext('mykey.audit_archive')";
