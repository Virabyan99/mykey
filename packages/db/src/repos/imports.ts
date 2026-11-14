// Import previews and entries (Run 4.7, P-76, Doc 06 §8 "Import"). A preview
// row holds the owner, the scope, the HMAC of the exact file and, per entry,
// its name, line, classification and the version and tag observed under the
// lock — never a value, a digest of a value or a length.
import type { UserId } from "@mykey/contracts";
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
