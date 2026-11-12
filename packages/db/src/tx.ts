// Transactions. Every multi-statement change of the product runs through this
// one function: READ COMMITTED, one attempt, ROLLBACK on any throw, and the
// client always goes back to the pool.
import type pg from "pg";

/** Something a repository can run a statement on: the pool or a transaction's client. */
export type Queryable = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // A connection that cannot roll back is not given to the next caller.
        broken = true;
      });
      throw error;
    }
  } finally {
    client.release(broken);
  }
}
