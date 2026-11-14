// Import previews and entries (Run 4.7, P-76, Doc 06 §8 "Import"). A preview
// row holds the owner, the scope, the HMAC of the exact file and, per entry,
// its name, line, classification and the version and tag observed under the
// lock — never a value, a digest of a value or a length.
import type { OperationId, UserId } from "@mykey/contracts";
import type pg from "pg";
import type { EnvironmentScope } from "../scope.ts";
import type { Queryable } from "../tx.ts";

/** One classified entry as stored (the shape of `classifyEntries` in @mykey/operations). */
export interface ImportEntryRecord {
  ordinal: number;
  line: number;
  name: string | null;
  classification: "create" | "update" | "unchanged" | "invalid" | "duplicate" | "conflict";
  expectedVersion: number | null;
  expectedStateTag: string | null;
}

/** Inserts a preview that expires `ttlSeconds` after database time now; answers that time. */
export async function insertPreview(
  tx: pg.PoolClient,
  preview: {
    id: string;
    scope: EnvironmentScope;
    ownerUserId: UserId;
    fileHmac: Buffer;
    hmacKeyId: string;
    entries: readonly ImportEntryRecord[];
    ttlSeconds: number;
  },
): Promise<Date> {
  const result = await tx.query<{ expires_at: Date }>(
    `INSERT INTO app.import_preview (id, organization_id, environment_id, owner_user_id,
       file_hmac, hmac_key_id, expires_at, entries)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8)
     RETURNING expires_at`,
    [
      preview.id,
      preview.scope.organizationId,
      preview.scope.environmentId,
      preview.ownerUserId,
      preview.fileHmac,
      preview.hmacKeyId,
      preview.ttlSeconds,
      JSON.stringify(preview.entries),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("preview insert returned no row");
  return row.expires_at;
}

/**
 * Removes previews nothing needs any more: expired and never claimed, or
 * claimed by an import that has finished. Answers how many went.
 */
export async function deleteDeadPreviews(db: Queryable): Promise<number> {
  const result = await db.query(
    `DELETE FROM app.import_preview p
      WHERE (p.claimed_by_operation_id IS NULL AND p.expires_at < now())
         OR EXISTS (SELECT 1 FROM app.operation o
                     WHERE o.id = p.claimed_by_operation_id AND o.completed_at IS NOT NULL)`,
  );
  return result.rowCount ?? 0;
}

/** The seven outcomes of an entry (Doc 06 §8). */
export type EntryOutcome =
  "created" | "updated" | "unchanged" | "conflict" | "rejected" | "uncertain" | "not_attempted";

export const ENTRY_OUTCOMES: readonly EntryOutcome[] = [
  "created",
  "updated",
  "unchanged",
  "conflict",
  "rejected",
  "uncertain",
  "not_attempted",
];

export type PreviewClaim =
  | { kind: "claimed"; fileHmac: Buffer; hmacKeyId: string; entries: ImportEntryRecord[] }
  | { kind: "absent" | "expired" | "taken" };

/**
 * Claims the caller's own preview of this environment for `operationId`:
 * `absent` when there is none (another member's, another environment's),
 * `taken` when an import already claimed it, `expired` past its expiry on
 * database time. Locks the row until the transaction ends.
 */
export async function claimPreview(
  tx: pg.PoolClient,
  id: string,
  scope: EnvironmentScope,
  userId: UserId,
  operationId: OperationId,
): Promise<PreviewClaim> {
  const found = await tx.query<{
    file_hmac: Buffer;
    hmac_key_id: string;
    entries: ImportEntryRecord[];
    claimed: boolean;
    expired: boolean;
  }>(
    `SELECT file_hmac, hmac_key_id, entries, claimed_by_operation_id IS NOT NULL AS claimed,
            expires_at < now() AS expired
       FROM app.import_preview
      WHERE id = $1 AND organization_id = $2 AND environment_id = $3 AND owner_user_id = $4
      FOR UPDATE`,
    [id, scope.organizationId, scope.environmentId, userId],
  );
  const row = found.rows[0];
  if (row === undefined) return { kind: "absent" };
  if (row.claimed) return { kind: "taken" };
  if (row.expired) return { kind: "expired" };
  await tx.query("UPDATE app.import_preview SET claimed_by_operation_id = $2 WHERE id = $1", [
    id,
    operationId,
  ]);
  return {
    kind: "claimed",
    fileHmac: row.file_hmac,
    hmacKeyId: row.hmac_key_id,
    entries: row.entries,
  };
}

/** The import's entries, copied from the preview at acceptance; none has an outcome yet. */
export async function insertImportEntries(
  tx: pg.PoolClient,
  parentId: OperationId,
  entries: readonly ImportEntryRecord[],
): Promise<void> {
  await tx.query(
    `INSERT INTO app.import_entry (id, parent_operation_id, ordinal, name, classification,
       expected_version, expected_state_tag)
     SELECT gen_random_uuid(), $1, e.ordinal, e.name, e.classification, e."expectedVersion",
            e."expectedStateTag"
       FROM jsonb_to_recordset($2::jsonb)
         AS e(ordinal int, name text, classification text, "expectedVersion" int,
              "expectedStateTag" text)`,
    [parentId, JSON.stringify(entries)],
  );
}

export interface PendingEntry {
  ordinal: number;
  name: string;
  classification: ImportEntryRecord["classification"];
  expectedVersion: number | null;
  expectedStateTag: string | null;
}

/** The entry with the lowest ordinal that has no outcome yet; null when none is left. */
export async function nextImportEntry(
  db: Queryable,
  parentId: OperationId,
): Promise<PendingEntry | null> {
  const result = await db.query<{
    ordinal: number;
    name: string;
    classification: ImportEntryRecord["classification"];
    expected_version: number | null;
    expected_state_tag: string | null;
  }>(
    `SELECT ordinal, name, classification, expected_version, expected_state_tag
       FROM app.import_entry
      WHERE parent_operation_id = $1 AND outcome IS NULL
      ORDER BY ordinal LIMIT 1`,
    [parentId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        ordinal: row.ordinal,
        name: row.name,
        classification: row.classification,
        expectedVersion: row.expected_version,
        expectedStateTag: row.expected_state_tag,
      };
}

/** The entry's outcome, and the child operation that wrote it (kept when null). */
export async function recordImportOutcome(
  tx: Queryable,
  parentId: OperationId,
  ordinal: number,
  outcome: EntryOutcome,
  childOperationId: OperationId | null,
): Promise<void> {
  await tx.query(
    `UPDATE app.import_entry SET outcome = $3,
            child_operation_id = coalesce($4, child_operation_id)
      WHERE parent_operation_id = $1 AND ordinal = $2`,
    [parentId, ordinal, outcome, childOperationId],
  );
}

/** The entry a child operation acts on (its parent and its name are unique together). */
export async function entryOfChild(
  db: Queryable,
  parentId: OperationId,
  name: string,
): Promise<{ ordinal: number; outcome: EntryOutcome | null } | null> {
  const result = await db.query<{ ordinal: number; outcome: EntryOutcome | null }>(
    "SELECT ordinal, outcome FROM app.import_entry WHERE parent_operation_id = $1 AND name = $2",
    [parentId, name],
  );
  return result.rows[0] ?? null;
}

/** Every entry without an outcome becomes not_attempted. */
export async function closeImportEntries(tx: Queryable, parentId: OperationId): Promise<void> {
  await tx.query(
    `UPDATE app.import_entry SET outcome = 'not_attempted'
      WHERE parent_operation_id = $1 AND outcome IS NULL`,
    [parentId],
  );
}

export interface ImportResult {
  counts: Record<EntryOutcome, number>;
  entries: { ordinal: number; name: string; outcome: EntryOutcome }[];
}

/** The outcomes so far, in ordinal order; entries without one are left out. */
export async function importResult(db: Queryable, parentId: OperationId): Promise<ImportResult> {
  const result = await db.query<{ ordinal: number; name: string; outcome: EntryOutcome }>(
    `SELECT ordinal, name, outcome FROM app.import_entry
      WHERE parent_operation_id = $1 AND outcome IS NOT NULL ORDER BY ordinal`,
    [parentId],
  );
  const counts = Object.fromEntries(ENTRY_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    EntryOutcome,
    number
  >;
  for (const row of result.rows) counts[row.outcome] += 1;
  return { counts, entries: result.rows };
}

/** The file binding of an accepted import (its claimed preview); null once the preview is gone. */
export async function fileOfParent(
  db: Queryable,
  parentId: OperationId,
): Promise<{ fileHmac: Buffer; hmacKeyId: string } | null> {
  const result = await db.query<{ file_hmac: Buffer; hmac_key_id: string }>(
    "SELECT file_hmac, hmac_key_id FROM app.import_preview WHERE claimed_by_operation_id = $1",
    [parentId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { fileHmac: row.file_hmac, hmacKeyId: row.hmac_key_id };
}
