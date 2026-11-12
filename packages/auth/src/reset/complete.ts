// Completing an operator reset (FR-1.04, P-51, D-30): POST /v1/auth/reset/complete.
//
//   admit("reset", source) → the token's row by verifier (every key of the
//   ring), FOR UPDATE: unconsumed, not superseded, not expired (database
//   time), its account `recovery_pending` → lock the account.
//   `password`: a factor code is required (`factor` throttle for the user): a
//     TOTP step used once, or a recovery code consumed, of the active
//     enrollment. Right → new hash, credential and auth epochs + 1, account
//     `active`, token consumed, every session deleted, audit → next sign_in.
//     Wrong → the failure is counted and the token stays open.
//   `mfa`: the active enrollment is retired (seed erased) and its codes
//     consumed, new hash, credential epoch + 1, token consumed, every session
//     deleted, one challenge session (phase `enrollment`, reset_token_id) —
//     the account stays `recovery_pending` until activation → next enroll.
//
// Every failure is the same answer for the caller; the reason goes to the
// audit row `auth.reset_failed` only.
import { randomBytes, randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { checkPassword, type UserId } from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import type pg from "pg";
import type { FactorDeps } from "../factors/elevate.ts";
import { sessionCookie } from "../factors/elevate.ts";
import { normalizeRecoveryCode, recoveryVerifier } from "../factors/recovery.ts";
import { decryptSeed } from "../factors/seed.ts";
import { matchStep } from "../factors/totp.ts";
import { resetVerifier } from "./verifier.ts";
import { sessionVerifier } from "../session-verifier.ts";
import type { Throttle } from "../throttle.ts";

export type ResetFailure = "token" | "factor" | "state" | "password";

export type CompleteResult =
  | { ok: true; next: "sign_in" }
  | { ok: true; next: "enroll"; setCookie: string }
  | { ok: false; reason: ResetFailure }
  | { ok: false; reason: "throttled"; retryAfterSeconds: number };

export interface CompleteDeps extends FactorDeps {
  throttle: Throttle;
}

interface TokenRow {
  id: string;
  user_id: UserId;
  kind: "password" | "mfa";
  expires_at: Date;
  usable: boolean;
  account_state: string;
  auth_epoch: string;
}

class Failed extends Error {
  readonly reason: ResetFailure;
  readonly userId: UserId | null;
  constructor(reason: ResetFailure, userId: UserId | null) {
    super(reason);
    this.reason = reason;
    this.userId = userId;
  }
}

/** Checks a TOTP step (used once) or a recovery code (consumed) of the user's active enrollment. */
async function useFactor(
  deps: FactorDeps,
  tx: pg.PoolClient,
  userId: UserId,
  code: string,
  now: Date,
): Promise<boolean> {
  const enrollment = await tx.query<{ id: string; seed_jwe: string }>(
    "SELECT id, seed_jwe FROM auth.totp_enrollment WHERE user_id = $1 AND state = 'active'",
    [userId],
  );
  const active = enrollment.rows[0];
  if (active === undefined) return false;
  const seed = await decryptSeed(deps.keys.seedEncryption, active.seed_jwe, {
    userId,
    enrollmentId: active.id,
  });
  const step = matchStep(seed, code, now);
  if (step !== null) {
    const used = await tx.query(
      "INSERT INTO auth.totp_step_used (enrollment_id, step) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [active.id, step],
    );
    return used.rowCount === 1;
  }
  const normalized = normalizeRecoveryCode(code);
  if (normalized === null) return false;
  const ring = deps.keys.recoveryVerifier;
  const verifiers = Object.keys(ring.keys).map((keyId) =>
    recoveryVerifier(ring, active.id, normalized, keyId),
  );
  const consumed = await tx.query(
    `UPDATE auth.recovery_code SET consumed_at = now()
      WHERE enrollment_id = $1 AND verifier = ANY ($2::bytea[]) AND consumed_at IS NULL`,
    [active.id, verifiers],
  );
  return consumed.rowCount === 1;
}

export async function completeReset(
  deps: CompleteDeps,
  input: {
    token: string;
    newPassword: string;
    code?: string;
    source: string;
    now?: Date;
    requestId: string | null;
  },
): Promise<CompleteResult> {
  const now = input.now ?? new Date();
  const admitted = await deps.throttle.admit("reset", { source: input.source, account: null });
  if (!admitted.allowed) {
    return { ok: false, reason: "throttled", retryAfterSeconds: admitted.retryAfterSeconds };
  }
  const audit = (
    db: pg.Pool | pg.PoolClient,
    outcome: "success" | "failure",
    userId: UserId | null,
    details: Record<string, string>,
  ) =>
    appendAudit(db, {
      action: outcome === "success" ? "auth.reset_complete" : "auth.reset_failed",
      actor: userId === null ? { kind: "anonymous", id: null } : { kind: "user", id: userId },
      source: "api",
      organizationId: null,
      target: userId === null ? null : { kind: "user", id: userId },
      outcome,
      requestId: input.requestId,
      operationId: null,
      details,
    });
  const ring = deps.keys.resetVerifier;
  const candidates = Object.keys(ring.keys).map((keyId) => resetVerifier(ring, input.token, keyId));
  const context = await deps.auth.$context;

  try {
    if (!checkPassword(input.newPassword).ok) throw new Failed("password", null);
    const result = await withTransaction(deps.pool, async (tx): Promise<CompleteResult> => {
      const found = await tx.query<TokenRow>(
        `SELECT t.id, t.user_id, t.kind, t.expires_at,
                (t.consumed_at IS NULL AND t.superseded_at IS NULL AND t.expires_at > now()) AS usable,
                a.state AS account_state, a.auth_epoch
           FROM auth.reset_token t JOIN auth.account_state a ON a.user_id = t.user_id
          WHERE t.verifier = ANY ($1::bytea[])
          FOR UPDATE OF t, a`,
        [candidates],
      );
      const row = found.rows[0];
      if (!row?.usable) throw new Failed("token", row?.user_id ?? null);
      if (row.account_state !== "recovery_pending") throw new Failed("state", row.user_id);
      const userId = row.user_id;

      if (row.kind === "password") {
        if (input.code === undefined) throw new Failed("factor", userId);
        const factor = await deps.throttle.admit("factor", {
          source: input.source,
          account: userId,
        });
        if (!factor.allowed) {
          return { ok: false, reason: "throttled", retryAfterSeconds: factor.retryAfterSeconds };
        }
        if (!(await useFactor(deps, tx, userId, input.code, now))) {
          throw new Failed("factor", userId);
        }
      }

      await tx.query(
        `UPDATE auth.account SET password = $2, updated_at = now()
          WHERE user_id = $1 AND provider_id = 'credential'`,
        [userId, await context.password.hash(input.newPassword)],
      );
      await tx.query(
        "UPDATE auth.reset_token SET consumed_at = now(), verifier = NULL WHERE id = $1",
        [row.id],
      );
      await tx.query("DELETE FROM auth.session WHERE user_id = $1", [userId]);

      if (row.kind === "password") {
        await tx.query(
          `UPDATE auth.account_state
              SET state = 'active', credential_epoch = credential_epoch + 1,
                  auth_epoch = auth_epoch + 1, updated_at = now()
            WHERE user_id = $1`,
          [userId],
        );
        await audit(tx, "success", userId, { kind: "password" });
        return { ok: true, next: "sign_in" };
      }

      // mfa: the old factor is gone; the account stays recovery_pending until activation.
      await tx.query(
        `UPDATE auth.recovery_code SET consumed_at = now()
          WHERE consumed_at IS NULL
            AND enrollment_id IN (SELECT id FROM auth.totp_enrollment WHERE user_id = $1)`,
        [userId],
      );
      await tx.query(
        `UPDATE auth.totp_enrollment SET state = 'retired', seed_jwe = ''
          WHERE user_id = $1 AND state IN ('active', 'pending')`,
        [userId],
      );
      await tx.query(
        `UPDATE auth.account_state SET credential_epoch = credential_epoch + 1, updated_at = now()
          WHERE user_id = $1`,
        [userId],
      );
      const token = randomBytes(24).toString("base64url");
      await tx.query(
        `INSERT INTO auth.session (id, token, user_id, expires_at, phase, auth_epoch, reset_token_id)
         VALUES ($1, $2, $3, $4, 'enrollment', $5, $6)`,
        [
          randomUUID(),
          sessionVerifier(deps.keys.sessionLookup, token),
          userId,
          row.expires_at,
          row.auth_epoch,
          row.id,
        ],
      );
      await audit(tx, "success", userId, { kind: "mfa" });
      return {
        ok: true,
        next: "enroll",
        setCookie: await sessionCookie(deps.auth, token, row.expires_at),
      };
    });
    return result;
  } catch (error) {
    if (!(error instanceof Failed)) throw error;
    if (error.reason === "factor" && error.userId !== null && input.code !== undefined) {
      await deps.throttle.recordFailure("factor", error.userId);
    }
    await audit(deps.pool, "failure", error.userId, { reason: error.reason });
    return { ok: false, reason: error.reason };
  }
}
