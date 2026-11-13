// Rate-limit windows are cut on database time (P-48). A test that counts
// attempts "inside one window" must not straddle a window's end: it waits,
// before it starts, until the current window has at least `needSeconds` left.
import { setTimeout as sleep } from "node:timers/promises";
import type { Queryable } from "@mykey/db";

export async function awaitFreshWindow(
  db: Queryable,
  windowSeconds = 60,
  needSeconds = 20,
): Promise<void> {
  const result = await db.query<{ into: number }>(
    "SELECT (extract(epoch FROM now()) - floor(extract(epoch FROM now()) / $1) * $1)::float8 AS into",
    [windowSeconds],
  );
  const into = result.rows[0]?.into ?? 0;
  const left = windowSeconds - into;
  if (left < needSeconds) await sleep(Math.ceil((left + 0.5) * 1000));
}
