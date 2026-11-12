// Authentication of a human request (Run 3.4). A product route answers only a
// session that completed the second factor, whose account is `active` and
// whose auth epoch is the account's current one — read from the database on
// every request (Doc 10 §4.1 rule 5). Run 3.5 swaps the decision for
// `resolveSession` without changing the answers.
import { currentSession, hasFreshTotp } from "@mykey/auth";
import type { UserId } from "@mykey/contracts";
import { ApiError, type AppDeps } from "./context.ts";

export interface Principal {
  kind: "user";
  userId: UserId;
  sessionId: string;
  fresh: boolean;
}

export async function authenticateHuman(deps: AppDeps, headers: Headers): Promise<Principal> {
  const module = deps.auth;
  if (module === undefined) throw new ApiError("unauthenticated");
  const session = await currentSession(module.auth, headers);
  if (session === null) throw new ApiError("unauthenticated");
  if (session.phase !== "mfa_complete") throw new ApiError("mfa_incomplete");
  const account = await deps.pool.query<{ state: string; auth_epoch: string }>(
    "SELECT state, auth_epoch FROM auth.account_state WHERE user_id = $1",
    [session.userId],
  );
  const row = account.rows[0];
  if (row?.state !== "active" || Number(row.auth_epoch) !== session.authEpoch) {
    throw new ApiError("unauthenticated");
  }
  return {
    kind: "user",
    userId: session.userId as UserId,
    sessionId: session.id,
    fresh: await hasFreshTotp(deps.pool, session.id),
  };
}
