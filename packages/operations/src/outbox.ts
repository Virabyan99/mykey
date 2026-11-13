// The outbox dispatcher: one transaction per row — claim it, send its job in
// the same transaction, mark it delivered, commit. A crash before the commit
// leaves the row pending and no job; the next pass delivers it.
import { claimOutbox, markOutboxDelivered, withTransaction } from "@mykey/db";
import type pg from "pg";
import { JOB_KINDS, type JobKind, type JobSender } from "./jobs.ts";

export interface DispatchDeps {
  /** Tests only: runs after the row is marked and before the commit. */
  beforeCommit?: () => Promise<void>;
}

function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

/** One pass over the pending rows. Returns how many were delivered. */
export async function dispatchOutbox(
  pool: pg.Pool,
  sender: JobSender,
  deps: DispatchDeps = {},
): Promise<number> {
  let delivered = 0;
  for (;;) {
    const done = await withTransaction(pool, async (tx) => {
      const [row] = await claimOutbox(tx, 1);
      if (row === undefined) return false;
      if (!isJobKind(row.jobKind)) throw new Error(`outbox row ${row.id} has an unknown job kind`);
      await sender.send(row.jobKind, row.operationId, { tx });
      await markOutboxDelivered(tx, row.id);
      if (deps.beforeCommit !== undefined) await deps.beforeCommit();
      return true;
    });
    if (!done) return delivered;
    delivered += 1;
  }
}
