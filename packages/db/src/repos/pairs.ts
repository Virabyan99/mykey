// Run 6.5 (P-119, P-120, D-52): the rows of app.backup_pair, written by
// maintenance (the coordinator and `ops pair`). A pair is a `candidate` from
// its capture until it is verified; then `eligible` until eligible_until, or
// `ineligible` with a reason. A pair whose capture window holds an access
// reduction never becomes eligible.
import type { Queryable } from "../tx.ts";

export type PairStatus = "candidate" | "eligible" | "ineligible" | "expired";

export interface PairRow {
  id: string;
  host: string;
  captureStartedAt: Date;
  status: PairStatus;
  eligibleUntil: Date | null;
  objectKey: string | null;
  manifestSha256: string | null;
  invalidReason: string | null;
  verifiedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

interface Stored {
  id: string;
  host: string | null;
  capture_started_at: Date;
  validation_status: PairStatus;
  eligible_until: Date | null;
  object_key: string | null;
  manifest_sha256: string | null;
  invalid_reason: string | null;
  verified_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

const COLUMNS = `id, host, capture_started_at, validation_status, eligible_until, object_key,
  manifest_sha256, invalid_reason, verified_at, deleted_at, created_at`;

function toRow(stored: Stored): PairRow {
  return {
    id: stored.id,
    host: stored.host ?? "",
    captureStartedAt: stored.capture_started_at,
    status: stored.validation_status,
    eligibleUntil: stored.eligible_until,
    objectKey: stored.object_key,
    manifestSha256: stored.manifest_sha256,
    invalidReason: stored.invalid_reason,
    verifiedAt: stored.verified_at,
    deletedAt: stored.deleted_at,
    createdAt: stored.created_at,
  };
}

export async function insertCandidate(
  tx: Queryable,
  p: {
    id: string;
    host: string;
    captureStartedAt: Date;
    boundary: unknown;
    schemaRevision: string;
    releaseBuild: string;
    keyRefs: unknown;
    artifactHashes?: unknown;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO app.backup_pair (id, host, capture_started_at, boundary, artifact_hashes,
                                  schema_revision, release_commit, key_refs, validation_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'candidate')`,
    [
      p.id,
      p.host,
      p.captureStartedAt,
      JSON.stringify(p.boundary),
      JSON.stringify(p.artifactHashes ?? {}),
      p.schemaRevision,
      p.releaseBuild,
      JSON.stringify(p.keyRefs),
    ],
  );
}

/**
 * candidate → eligible, only when no access reduction was recorded between
 * the capture and the release of the freeze (the row's created_at). False
 * when the pair was not a candidate or a reduction crossed it.
 */
export async function markEligible(
  tx: Queryable,
  id: string,
  v: { objectKey: string; manifestSha256: string; artifactHashes: unknown; eligibleUntil: Date },
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.backup_pair p
        SET validation_status = 'eligible', object_key = $2, manifest_sha256 = $3,
            artifact_hashes = $4, eligible_until = $5, verified_at = now()
      WHERE p.id = $1 AND p.validation_status = 'candidate'
        AND NOT EXISTS (SELECT 1 FROM app.backup_invalidation i
                         WHERE i.at >= p.capture_started_at AND i.at <= p.created_at)`,
    [id, v.objectKey, v.manifestSha256, JSON.stringify(v.artifactHashes), v.eligibleUntil],
  );
  return result.rowCount === 1;
}

/** candidate → ineligible with a reason; false when it was not a candidate. */
export async function markIneligible(tx: Queryable, id: string, reason: string): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.backup_pair SET validation_status = 'ineligible', invalid_reason = $2
      WHERE id = $1 AND validation_status = 'candidate'`,
    [id, reason],
  );
  return result.rowCount === 1;
}

/** Whether an access reduction was recorded inside the pair's capture window. */
export async function crossedByReduction(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query<{ crossed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM app.backup_pair p JOIN app.backup_invalidation i
                      ON i.at >= p.capture_started_at AND i.at <= p.created_at
                     WHERE p.id = $1) AS crossed`,
    [id],
  );
  return result.rows[0]?.crossed === true;
}

export async function findPair(db: Queryable, id: string): Promise<PairRow | null> {
  const result = await db.query<Stored>(`SELECT ${COLUMNS} FROM app.backup_pair WHERE id = $1`, [
    id,
  ]);
  const stored = result.rows[0];
  return stored === undefined ? null : toRow(stored);
}

export async function newestEligible(db: Queryable, host: string): Promise<PairRow | null> {
  const result = await db.query<Stored>(
    `SELECT ${COLUMNS} FROM app.backup_pair
      WHERE host = $1 AND validation_status = 'eligible' AND deleted_at IS NULL
      ORDER BY capture_started_at DESC LIMIT 1`,
    [host],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toRow(stored);
}

/** Candidates older than the deadline (P-120: two hours) become ineligible; their ids. */
export async function expireCandidates(db: Queryable, olderThanSeconds: number): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE app.backup_pair SET validation_status = 'ineligible', invalid_reason = 'deadline'
      WHERE validation_status = 'candidate'
        AND capture_started_at < now() - make_interval(secs => $1)
      RETURNING id`,
    [olderThanSeconds],
  );
  return result.rows.map((row) => row.id);
}
