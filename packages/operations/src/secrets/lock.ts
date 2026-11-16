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

/** The class of the one-at-a-time locks (P-114). */
const EXCLUSIVE_CLASS = "mykey.one-at-a-time";
/** The class of the environments' read cool-downs (P-114, D-49). */
const COOLDOWN_CLASS = "mykey.read-cooldown";

/**
 * D-49's fairness rule: longer than the second a person's client waits between
 * two attempts of a write, shorter than the lock wait of the next read.
 */
export const READ_COOLDOWN_MS = 1500;

export async function withEnvironmentLock<T>(
  lockPool: pg.Pool,
  lockKey: bigint,
  fn: (locked: Locked) => Promise<T>,
  waitMs: number = LIMITS.deadlines.advisoryLockMs,
  opts: {
    /**
     * Run 6.3 (P-114): one holder at a time for this key (a machine
     * credential), tried without waiting before the environment's lock; taken
     * → Busy at once. A two-key lock: never the same lock as an environment's.
     */
    exclusive?: string;
    /**
     * Run 6.3 (P-114, D-49, the fairness rule): a complete read waits for the
     * environment's read cool-down before its lock, and leaves one of
     * `cooldownMs` behind when it releases the lock, so a writer between two
     * reads finds the environment free. The answer is not delayed: the
     * cool-down ends on a timer, holding this connection until then.
     */
    cooldownMs?: number;
  } = {},
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
  let exclusiveHeld = false;
  let reusable = true;
  try {
    await client.query(`SET lock_timeout = ${String(waitMs)}`);
    if (opts.exclusive !== undefined) {
      const tried = await client.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext('${EXCLUSIVE_CLASS}'), hashtext($1)) AS ok`,
        [opts.exclusive],
      );
      if (tried.rows[0]?.ok !== true) throw new Busy();
      exclusiveHeld = true;
    }
    try {
      if (opts.cooldownMs !== undefined) {
        // Wait out the previous read's cool-down; writers do not.
        await client.query(`SELECT pg_advisory_lock(hashtext('${COOLDOWN_CLASS}'), hashtext($1))`, [
          lockKey.toString(),
        ]);
        await client.query(
          `SELECT pg_advisory_unlock(hashtext('${COOLDOWN_CLASS}'), hashtext($1))`,
          [lockKey.toString()],
        );
      }
      await client.query("SELECT pg_advisory_lock($1)", [lockKey.toString()]);
    } catch (error) {
      if (isLockTimeout(error)) throw new Busy();
      throw error;
    }
    held = true;
    return await fn({ client, lost: () => session.lost });
  } finally {
    if (session.lost) reusable = false;
    if (reusable && exclusiveHeld) {
      const released = await client
        .query<{ unlocked: boolean }>(
          `SELECT pg_advisory_unlock(hashtext('${EXCLUSIVE_CLASS}'), hashtext($1)) AS unlocked`,
          [opts.exclusive],
        )
        .then((result) => result.rows[0]?.unlocked === true)
        .catch(() => false);
      if (!released) reusable = false;
    }
    let cooling = false;
    if (reusable && held && opts.cooldownMs !== undefined) {
      cooling = await client
        .query<{ ok: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext('${COOLDOWN_CLASS}'), hashtext($1)) AS ok`,
          [lockKey.toString()],
        )
        .then((result) => result.rows[0]?.ok === true)
        .catch(() => false);
    }
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
    const finish = (): void => {
      if (reusable) {
        client.removeListener("error", onError);
        client.release();
      } else {
        client.release(true);
      }
    };
    if (cooling && reusable) {
      setTimeout(() => {
        void client
          .query(`SELECT pg_advisory_unlock(hashtext('${COOLDOWN_CLASS}'), hashtext($1))`, [
            lockKey.toString(),
          ])
          .catch(() => {
            reusable = false;
          })
          .finally(finish);
      }, opts.cooldownMs).unref();
    } else {
      finish();
    }
  }
}

/** One transaction on a held connection (the lock's): BEGIN, `fn`, COMMIT; ROLLBACK on a throw. */
export async function inTransaction<T>(
  client: pg.PoolClient,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // A connection that cannot roll back is destroyed by the lock's release.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
