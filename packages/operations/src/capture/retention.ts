// Run 6.6 (P-121, D-53; FR-1.78, AC-1.36): retention applies a plan of
// @mykey/backup's planRetention. Per pair, in this order:
//
//   1. eligible.json is deleted and a HEAD proves it gone — from then on the
//      pair does not exist for a restore;
//   2. the row becomes expired with deleted_at;
//   3. bundle.tar (and anything else under the prefix) is deleted and proven gone.
//
// A refusal or an object a delete claims but leaves stops that pair where it
// is; the next run plans what is left. Candidates past their deadline are made
// ineligible first. One system.backup_cleanup row carries the counts.
import type { ObjectStore, RetentionPlan } from "@mykey/backup";
import { appendAudit } from "@mykey/audit";
import { closePair, markIneligible, withTransaction, type PairRow } from "@mykey/db";
import type pg from "pg";

/** Multipart uploads older than this are abandoned: the pair job's upload takes minutes. */
const STALE_UPLOAD_SECONDS = 86_400;

export interface CleanupResult {
  /** Candidates made ineligible (deadline). */
  expired: string[];
  /** Pairs whose row was closed (expired, deleted_at) in this run. */
  closed: string[];
  deleted: string[];
  refused: { key: string; code: string }[];
  /** Keys a delete answered for but a HEAD still finds. */
  stillPresent: string[];
  uploadsAborted: number;
}

const ELIGIBLE_JSON = "/eligible.json";

export async function applyRetention(
  deps: { pool: pg.Pool; store: ObjectStore; host: string; now: () => Date },
  plan: RetentionPlan<PairRow>,
): Promise<CleanupResult> {
  const { pool, store } = deps;
  const result: CleanupResult = {
    expired: [],
    closed: [],
    deleted: [],
    refused: [],
    stillPresent: [],
    uploadsAborted: 0,
  };

  for (const pair of plan.expire) {
    await withTransaction(pool, async (tx) => {
      if (await markIneligible(tx, pair.id, "deadline")) {
        await appendAudit(tx, {
          action: "system.backup_invalidated",
          actor: { kind: "system", id: null },
          source: "system",
          organizationId: null,
          target: { kind: "backup_pair", id: pair.id },
          outcome: "success",
          requestId: null,
          operationId: null,
          details: { pairId: pair.id, reason: "deadline" },
        });
        result.expired.push(pair.id);
      }
    });
  }

  /** Deletes keys and proves each gone; true when every one is. */
  const remove = async (keys: string[]): Promise<boolean> => {
    if (keys.length === 0) return true;
    let all = true;
    for (const outcome of await store.deleteChecked(keys)) {
      const absent = outcome.deleted || outcome.errorCode === "NoSuchKey";
      if (!absent) {
        result.refused.push({ key: outcome.key, code: outcome.errorCode ?? "unknown" });
        all = false;
      } else if ((await store.head(outcome.key)) !== null) {
        result.stillPresent.push(outcome.key);
        all = false;
      } else {
        result.deleted.push(outcome.key);
      }
    }
    return all;
  };

  for (const { pair, keys } of plan.delete) {
    const record = keys.filter((key) => key.endsWith(ELIGIBLE_JSON));
    if (!(await remove(record))) continue;
    if (pair.deletedAt === null && (await closePair(pool, pair.id))) result.closed.push(pair.id);
    await remove(keys.filter((key) => !key.endsWith(ELIGIBLE_JSON)));
  }

  result.uploadsAborted = await store.abortStaleUploads(
    `pairs/${deps.host}/`,
    STALE_UPLOAD_SECONDS,
  );

  await withTransaction(pool, (tx) =>
    appendAudit(tx, {
      action: "system.backup_cleanup",
      actor: { kind: "system", id: null },
      source: "system",
      organizationId: null,
      target: null,
      outcome: "success",
      requestId: null,
      operationId: null,
      details: {
        deleted: result.deleted.length,
        kept: plan.keep.length,
        refused: result.refused.length + result.stillPresent.length,
      },
    }),
  );
  return result;
}
