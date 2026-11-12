// The operator-initiated reset (FR-1.04, P-51, D-30). Only the operator starts
// one — `ops reset-account`, as `maintenance` — and no HTTP route can. One
// transaction:
//
//   lock account_state → `recovery_pending`, auth epoch + 1 → delete every
//   session → supersede every open token → insert the new token's verifier
//   (expires in LIMITS.reset.linkSeconds) → audit `operator.reset_initiate`.
//
// After the commit the throttle locks of the account are cleared, so an owner
// locked out by failures can complete the reset (Review focus 2).
import { randomBytes, randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { LIMITS, type UserId } from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import type pg from "pg";
import { normalizeEmail } from "../email.ts";
import type { AuthKeys } from "../keys.ts";
import { resetVerifier } from "../reset/verifier.ts";
import type { Throttle } from "../throttle.ts";

export { resetVerifier };

export type ResetKind = "password" | "mfa";

export const RESET_POINTS = ["lock", "state", "sessions", "supersede", "token", "audit"] as const;
export type ResetPoint = (typeof RESET_POINTS)[number];

export type InitiateResult =
  | { outcome: "issued"; userId: UserId; token: string; expiresAt: Date }
  | { outcome: "refused"; reason: "no_such_account" | "disabled" };

export interface InitiateDeps {
  /** maintenance. */
  pool: pg.Pool;
  keys: Pick<AuthKeys, "resetVerifier">;
  throttle: Throttle;
  /** Tests only: called after each statement. */
  crashAt?: (point: ResetPoint) => void;
}

/** The link the owner opens: the token travels in the fragment, which never reaches a server. */
export function resetLink(baseUrl: string, token: string, kind: ResetKind): string {
  return `${baseUrl}/reset#t=${token}&k=${kind}`;
}

export async function initiateReset(
  deps: InitiateDeps,
  input: { email: string; kind: ResetKind },
): Promise<InitiateResult> {
  const email = normalizeEmail(input.email);
  const crash = deps.crashAt ?? (() => undefined);
  const token = randomBytes(32).toString("base64url");
  const result = await withTransaction(deps.pool, async (tx): Promise<InitiateResult> => {
    const found = await tx.query<{ id: UserId; state: string }>(
      `SELECT u.id, s.state FROM auth."user" u JOIN auth.account_state s ON s.user_id = u.id
        WHERE u.email = $1 FOR UPDATE OF s`,
      [email],
    );
    crash("lock");
    const account = found.rows[0];
    if (account === undefined) return { outcome: "refused", reason: "no_such_account" };
    if (account.state === "disabled") return { outcome: "refused", reason: "disabled" };
    await tx.query(
      `UPDATE auth.account_state
          SET state = 'recovery_pending', auth_epoch = auth_epoch + 1, updated_at = now()
        WHERE user_id = $1`,
      [account.id],
    );
    crash("state");
    await tx.query("DELETE FROM auth.session WHERE user_id = $1", [account.id]);
    crash("sessions");
    await tx.query(
      `UPDATE auth.reset_token SET superseded_at = now(), verifier = NULL
        WHERE user_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [account.id],
    );
    crash("supersede");
    const issued = await tx.query<{ expires_at: Date }>(
      `INSERT INTO auth.reset_token (id, user_id, verifier, key_id, kind, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
       RETURNING expires_at`,
      [
        randomUUID(),
        account.id,
        resetVerifier(deps.keys.resetVerifier, token),
        deps.keys.resetVerifier.current,
        input.kind,
        LIMITS.reset.linkSeconds,
      ],
    );
    crash("token");
    await appendAudit(tx, {
      action: "operator.reset_initiate",
      actor: { kind: "operator", id: null },
      source: "operator",
      organizationId: null,
      target: { kind: "user", id: account.id },
      outcome: "success",
      requestId: null,
      operationId: null,
      details: { kind: input.kind },
    });
    crash("audit");
    const expiresAt = issued.rows[0]?.expires_at;
    if (expiresAt === undefined) throw new Error("the reset token was not stored");
    return { outcome: "issued", userId: account.id, token, expiresAt };
  });
  if (result.outcome === "issued") {
    await deps.throttle.clearAccount([email, result.userId]);
  }
  return result;
}
