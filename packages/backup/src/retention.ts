// Run 6.6 (P-121, D-53; FR-1.78, AC-1.36): which pairs a host deletes. Pure:
// the caller passes the rows and the bucket's listing.
//
// - The host's newest eligible pair is never deleted, even when it is expired
//   and even when it is the only pair.
// - The bucket locks every object under pairs/ for 30 days from its upload,
//   and an upload comes at most two hours after the capture, so a pair's
//   objects are released at capture + 30 days + 2 hours at the latest.
// - An eligible pair is deleted once it has expired and its lock has ended;
//   an ineligible or expired one once its lock has ended.
// - A candidate past its two hours is expired (ineligible, deadline) first.
// - An object prefix without a row is an orphan: reported, never deleted here.
import { ELIGIBLE_DAYS } from "./manifest.ts";

export const CANDIDATE_DEADLINE_MS = 2 * 3_600_000;
const DAY_MS = 86_400_000;
const PREFIX = /^(pairs\/[^/]+\/[^/]+\/)/;
const PAIR_PREFIX = /^pairs\/[^/]+\/\d{8}T\d{6}Z-([0-9a-f-]{36})\//;

/** The fields of a pair row the plan reads (`PairRow` of @mykey/db has them). */
export interface RetainedPair {
  id: string;
  host: string;
  captureStartedAt: Date;
  status: "candidate" | "eligible" | "ineligible" | "expired";
  eligibleUntil: Date | null;
  deletedAt: Date | null;
}

export type KeepReason = "newest_eligible" | "not_expired" | "candidate_in_deadline" | "locked";

export interface RetentionPlan<P extends RetainedPair = RetainedPair> {
  /** Candidates past their deadline: marked ineligible (deadline) before anything else. */
  expire: P[];
  /** In order of capture; `keys` lists eligible.json first. A row with no objects left is closed. */
  delete: { pair: P; keys: string[] }[];
  keep: { pair: P; why: KeepReason }[];
  /** Object prefixes under pairs/<host>/ without a row. */
  orphans: string[];
}

/** When the bucket's lock on a pair's objects has ended at the latest. */
export function lockEndsAt(pair: Pick<RetainedPair, "captureStartedAt">): Date {
  return new Date(pair.captureStartedAt.getTime() + ELIGIBLE_DAYS * DAY_MS + CANDIDATE_DEADLINE_MS);
}

/** The pair id in an object key `pairs/<host>/<captureUtc>-<pairId>/…`, or null. */
export function pairIdOf(key: string): string | null {
  return PAIR_PREFIX.exec(key)?.[1] ?? null;
}

export function planRetention<P extends RetainedPair>(
  rows: readonly P[],
  objects: readonly { key: string }[],
  host: string,
  now: Date,
): RetentionPlan<P> {
  const mine = rows
    .filter((row) => row.host === host)
    .sort((a, b) => a.captureStartedAt.getTime() - b.captureStartedAt.getTime());
  const ids = new Set(mine.map((row) => row.id));
  const keysById = new Map<string, string[]>();
  const orphans = new Set<string>();
  for (const { key } of objects) {
    if (!key.startsWith(`pairs/${host}/`)) continue;
    const id = pairIdOf(key);
    if (id !== null && ids.has(id)) {
      keysById.set(id, [...(keysById.get(id) ?? []), key]);
    } else {
      orphans.add(PREFIX.exec(key)?.[1] ?? key);
    }
  }
  const eligible = mine.filter((row) => row.status === "eligible" && row.deletedAt === null);
  const newest = eligible.at(-1);

  const plan: RetentionPlan<P> = { expire: [], delete: [], keep: [], orphans: [...orphans].sort() };
  for (const row of mine) {
    const keys = (keysById.get(row.id) ?? []).sort((a, b) => {
      const first = (k: string): number => (k.endsWith("/eligible.json") ? 0 : 1);
      return first(a) - first(b) || a.localeCompare(b);
    });
    const released = now.getTime() >= lockEndsAt(row).getTime();
    if (row.deletedAt !== null) {
      // Closed earlier; what a refusal left behind is tried again.
      if (keys.length > 0) plan.delete.push({ pair: row, keys });
      continue;
    }
    if (row === newest) {
      plan.keep.push({ pair: row, why: "newest_eligible" });
    } else if (row.status === "candidate") {
      if (now.getTime() - row.captureStartedAt.getTime() > CANDIDATE_DEADLINE_MS) {
        plan.expire.push(row);
      } else {
        plan.keep.push({ pair: row, why: "candidate_in_deadline" });
      }
    } else if (row.status === "eligible" && (row.eligibleUntil?.getTime() ?? 0) > now.getTime()) {
      plan.keep.push({ pair: row, why: "not_expired" });
    } else if (!released) {
      plan.keep.push({ pair: row, why: "locked" });
    } else {
      plan.delete.push({ pair: row, keys });
    }
  }
  return plan;
}

/**
 * Whether a pair's KMS key can still be used. The restore refuses a pair whose
 * key is gone (Run 6.7); a probe that throws counts as "not readable".
 */
export async function keyReadable(
  kmsKeyId: string,
  probe: (keyId: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    return await probe(kmsKeyId);
  } catch {
    return false;
  }
}
