// The environment's advisory lock (P-66, Doc 06 §6.1). One dedicated
// connection holds `pg_advisory_lock(environment.lock_key)` for the whole of a
// secret action; every transaction of the action runs on that connection. A
// connection whose session may still hold the lock — it broke, or the unlock
// failed — is destroyed, never returned to the pool.
import { LIMITS } from "@mykey/contracts";
import type pg from "pg";

export interface Locked {
  client: pg.PoolClient;
  /** True once the lock's session reported an error: the lock may be gone. */
  lost(): boolean;
}

/** The lock or a connection for it could not be had in time: the answer is `busy`. */
export class Busy extends Error {
  constructor() {
    super("the environment is busy");
    this.name = "Busy";
  }
}

const LOCK_NOT_AVAILABLE = "55P03";

/** A connection from `pool` within `waitMs`; one that arrives later goes straight back. */
async function connectWithin(pool: pg.Pool, waitMs: number): Promise<pg.PoolClient> {
  const pending = pool.connect();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, waitMs);
  });
  const first = await Promise.race([pending, timeout]).finally(() => {
    clearTimeout(timer);
  });
  if (first !== null) return first;
  void pending.then(
    (late) => {
      late.release();
    },
    () => undefined,
  );
  throw new Busy();
}

export const isLockTimeout = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE;

export async function withEnvironmentLock<T>(
  lockPool: pg.Pool,
  lockKey: bigint,
  fn: (locked: Locked) => Promise<T>,
  waitMs: number = LIMITS.deadlines.advisoryLockMs,
): Promise<T> {
  if (!Number.isSafeInteger(waitMs) || waitMs <= 0) throw new Error("invalid lock wait");
  const client = await connectWithin(lockPool, LIMITS.deadlines.poolAcquireMs).catch(
    (error: unknown) => {
      throw error instanceof Busy ? error : new Busy();
    },
  );
  const session = { lost: false };
  // Stays attached until the connection is gone: an error with no listener would end the process.
  const onError = (): void => {
    session.lost = true;
  };
  client.on("error", onError);
  let held = false;
  let reusable = true;
  try {
    await client.query(`SET lock_timeout = ${String(waitMs)}`);
    try {
      await client.query("SELECT pg_advisory_lock($1)", [lockKey.toString()]);
    } catch (error) {
      if (isLockTimeout(error)) throw new Busy();
      throw error;
    }
    held = true;
    return await fn({ client, lost: () => session.lost });
  } finally {
    if (session.lost) reusable = false;
    if (reusable && held) {
      const unlocked = await client
        .query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1) AS unlocked", [
          lockKey.toString(),
        ])
        .then((result) => result.rows[0]?.unlocked === true)
        .catch(() => false);
      if (!unlocked) reusable = false;
    }
    if (reusable) {
      await client.query("RESET lock_timeout").catch(() => {
        reusable = false;
      });
    }
    if (reusable) {
      client.removeListener("error", onError);
      client.release();
    } else {
      client.release(true);
    }
  }
}
