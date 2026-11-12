// Authentication of a human request (Run 3.4). A product route answers only a
// session that completed the second factor, whose account is `active` and
// whose auth epoch is the account's current one — read from the database on
// every request (Doc 10 §4.1 rule 5), decided by `resolveSession` (Run 3.5).
import { resolveSession } from "@mykey/auth";
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
  const verdict = await resolveSession(
    { auth: module.auth, pool: deps.pool, keys: module.keys },
    headers,
  );
  if (!verdict.ok) throw new ApiError("unauthenticated");
  const session = verdict.session;
  if (session.phase !== "mfa_complete") throw new ApiError("mfa_incomplete");
  return {
    kind: "user",
    userId: session.userId,
    sessionId: session.id,
    fresh: session.fresh,
  };
}
