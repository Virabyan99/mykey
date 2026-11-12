// The product-owned password change (P-49, D-29, amends D-19). One
// transaction that locks the account and the session, requires a fresh TOTP
// verification of this session, checks the new password against the rule and
// the current one against the stored hash, stores the new hash, raises the
// credential epoch, deletes every other session of the user and writes the
// audit row. The session keeps its token and its phase. (Better Auth's
// native change-password replaced the session with a password-only one and
// could not be made atomic with the revocation.)
import { appendAudit } from "@mykey/audit";
import type { UserId } from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import type pg from "pg";
import type { Auth } from "./auth.ts";
import { hasFreshTotp } from "./fresh.ts";
import { checkPassword } from "./password-rule.ts";

export type ChangeResult =
  | { ok: true; revoked: number }
  | { ok: false; reason: "not_fresh" | "wrong_password" | "password_rejected" | "absent" };

export interface ChangeDeps {
  auth: Auth;
  /** api_runtime. */
  pool: pg.Pool;
  /** Tests only: runs after every write and before the commit. */
  beforeCommit?: () => Promise<void>;
}

export async function changePassword(
  deps: ChangeDeps,
  input: {
    sessionId: string;
    currentPassword: string;
    newPassword: string;
    requestId: string | null;
  },
): Promise<ChangeResult> {
  const context = await deps.auth.$context;
  return withTransaction(deps.pool, async (tx) => {
    const owner = await tx.query<{ user_id: UserId }>(
      "SELECT user_id FROM auth.session WHERE id = $1",
      [input.sessionId],
    );
    const userId = owner.rows[0]?.user_id;
    if (userId === undefined) return { ok: false, reason: "absent" };
    // Lock order of the auth module: the account, then the session.
    await tx.query("SELECT 1 FROM auth.account_state WHERE user_id = $1 FOR UPDATE", [userId]);
    const locked = await tx.query("SELECT 1 FROM auth.session WHERE id = $1 FOR UPDATE", [
      input.sessionId,
    ]);
    if (locked.rowCount !== 1) return { ok: false, reason: "absent" };
    if (!(await hasFreshTotp(tx, input.sessionId))) return { ok: false, reason: "not_fresh" };
    if (!checkPassword(input.newPassword).ok) return { ok: false, reason: "password_rejected" };
    const stored = await tx.query<{ password: string | null }>(
      "SELECT password FROM auth.account WHERE user_id = $1 AND provider_id = 'credential'",
      [userId],
    );
    const hash = stored.rows[0]?.password ?? null;
    if (
      hash === null ||
      !(await context.password.verify({ hash, password: input.currentPassword }))
    ) {
      return { ok: false, reason: "wrong_password" };
    }
    await tx.query(
      `UPDATE auth.account SET password = $2, updated_at = now()
        WHERE user_id = $1 AND provider_id = 'credential'`,
      [userId, await context.password.hash(input.newPassword)],
    );
    await tx.query(
      `UPDATE auth.account_state SET credential_epoch = credential_epoch + 1, updated_at = now()
        WHERE user_id = $1`,
      [userId],
    );
    const removed = await tx.query("DELETE FROM auth.session WHERE user_id = $1 AND id <> $2", [
      userId,
      input.sessionId,
    ]);
    const revoked = removed.rowCount ?? 0;
    await appendAudit(tx, {
      action: "auth.password_change",
      actor: { kind: "user", id: userId },
      source: "api",
      organizationId: null,
      target: { kind: "user", id: userId },
      outcome: "success",
      requestId: input.requestId,
      operationId: null,
      details: { revokedSessions: revoked },
    });
    if (deps.beforeCommit !== undefined) await deps.beforeCommit();
    return { ok: true, revoked };
  });
}
