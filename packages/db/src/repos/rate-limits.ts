// Rate-limit counters (P-48, Doc 06 §11) in `app.rate_limit`: one row per
// (scope, keyed digest, window). Windows are cut on database time with
// `date_bin`, so every API process counts into the same rows. A row holds no
// address, e-mail or user id — only HMAC digests (packages/auth/src/throttle.ts).
import type { Queryable } from "../tx.ts";

/** Adds one to the counter of the current window; returns the new count and the seconds the window has left. */
export async function bumpCounter(
  db: Queryable,
  scope: string,
  keyDigest: Buffer,
  windowSeconds: number,
): Promise<{ count: number; secondsLeft: number }> {
  const result = await db.query<{ count: number; seconds_left: number }>(
    `INSERT INTO app.rate_limit AS r (scope, key_digest, window_start, count)
     VALUES ($1, $2, date_bin(make_interval(secs => $3), now(), timestamptz 'epoch'), 1)
     ON CONFLICT (scope, key_digest, window_start) DO UPDATE SET count = r.count + 1
     RETURNING r.count,
               ceil(extract(epoch FROM r.window_start + make_interval(secs => $3) - now()))::int
                 AS seconds_left`,
    [scope, keyDigest, windowSeconds],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("rate counter: no row returned");
  return { count: row.count, secondsLeft: Math.max(1, row.seconds_left) };
}

/** The sum of the current window and the `windows - 1` before it. */
export async function sumCounters(
  db: Queryable,
  scope: string,
  keyDigest: Buffer,
  windowSeconds: number,
  windows: number,
): Promise<number> {
  const result = await db.query<{ total: number }>(
    `SELECT coalesce(sum(count), 0)::int AS total FROM app.rate_limit
      WHERE scope = $1 AND key_digest = $2
        AND window_start >= date_bin(make_interval(secs => $3), now(), timestamptz 'epoch')
                            - make_interval(secs => $3 * ($4 - 1))`,
    [scope, keyDigest, windowSeconds, windows],
  );
  return result.rows[0]?.total ?? 0;
}

/** Seconds left of a lock row younger than `durationSeconds`, or null when there is none. */
export async function lockSecondsLeft(
  db: Queryable,
  scope: string,
  keyDigest: Buffer,
  durationSeconds: number,
): Promise<number | null> {
  const result = await db.query<{ left: number }>(
    `SELECT ceil(extract(epoch FROM max(window_start) + make_interval(secs => $3) - now()))::int AS left
       FROM app.rate_limit
      WHERE scope = $1 AND key_digest = $2
        AND window_start > now() - make_interval(secs => $3)
     HAVING count(*) > 0`,
    [scope, keyDigest, durationSeconds],
  );
  const left = result.rows[0]?.left;
  return left === undefined ? null : Math.max(1, left);
}

/** Starts a lock now (its row's window_start is the moment the lock began). */
export async function insertLock(db: Queryable, scope: string, keyDigest: Buffer): Promise<void> {
  await db.query(
    `INSERT INTO app.rate_limit (scope, key_digest, window_start, count) VALUES ($1, $2, now(), 1)
     ON CONFLICT DO NOTHING`,
    [scope, keyDigest],
  );
}

/** Removes every row of the given scopes for one digest. */
export async function deleteCounters(
  db: Queryable,
  scopes: readonly string[],
  keyDigest: Buffer,
): Promise<void> {
  await db.query("DELETE FROM app.rate_limit WHERE scope = ANY ($1::text[]) AND key_digest = $2", [
    scopes,
    keyDigest,
  ]);
}

/** Deletes up to `batch` rows whose window began more than `olderThanSeconds` ago; returns how many. */
export async function sweepCounters(
  db: Queryable,
  olderThanSeconds: number,
  batch: number,
): Promise<number> {
  const result = await db.query(
    `DELETE FROM app.rate_limit WHERE ctid IN (
       SELECT ctid FROM app.rate_limit
        WHERE window_start < now() - make_interval(secs => $1)
        LIMIT $2)`,
    [olderThanSeconds, batch],
  );
  return result.rowCount ?? 0;
}
