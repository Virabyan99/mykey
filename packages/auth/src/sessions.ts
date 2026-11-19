// Sessions (Run 3.5, D-29): the one validity decision, the activity signal,
// the session list, revocation and clean-up.
//
// `resolveSession` is the only place a session is judged. The raw token comes
// from the signed cookie (its signature checked with Better Auth's own
// signing); everything after that is one SQL statement whose every comparison
// uses the database's `now()`:
//   absolute  authenticated_at + 12 h
//   idle      last_user_activity_at + 30 min   (mfa_complete only)
//   challenge authenticated_at + 10 min        (the other phases)
//   the account's state fits the phase, and the session's auth epoch is the account's.
// A row found past a limit is deleted in the same call. No other file calls
// Better Auth's getSession (a unit test searches for it).
import { timingSafeEqual } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { LIMITS, type UserId } from "@mykey/contracts";
import { invalidateCapture, isCaptureRefusal, withTransaction, type Queryable } from "@mykey/db";
import { makeSignature } from "better-auth/crypto";
import type pg from "pg";
import type { Auth } from "./auth.ts";
import type { AuthKeys } from "./keys.ts";
import { sessionVerifierCandidates } from "./session-verifier.ts";

export const SESSION_COOKIE_NAME = "__Secure-better-auth.session_token";

export type SessionPhase = "password_verified" | "enrollment" | "mfa_complete";

export type SessionVerdict =
  | {
      ok: true;
      session: {
        id: string;
        userId: UserId;
        phase: SessionPhase;
        fresh: boolean;
        token: string;
        /** The challenge session of an `mfa` reset (Run 3.6): it may only enroll, activate and sign out. */
        resetChallenge: boolean;
      };
    }
  | { ok: false; reason: "absent" | "absolute" | "idle" | "challenge" | "account" | "epoch" };

export interface SessionDeps {
  auth: Auth;
  /** api_runtime. */
  pool: Queryable;
  keys: AuthKeys;
}

/** Account states a session of each phase may belong to. */
const STATES_OF_PHASE: Readonly<Record<SessionPhase, readonly string[]>> = {
  mfa_complete: ["active"],
  password_verified: ["enrollment_pending", "active"],
  enrollment: ["enrollment_pending"],
};

/** The session token of the request's cookie, when its signature is Better Auth's. */
export async function tokenOfRequest(auth: Auth, headers: Headers): Promise<string | null> {
  const header = headers.get("cookie");
  if (header === null) return null;
  let value: string | undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) value = rest.join("=");
  }
  if (value === undefined || value === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return null;
  const token = decoded.slice(0, dot);
  const signature = Buffer.from(decoded.slice(dot + 1));
  const expected = Buffer.from(await makeSignature(token, (await auth.$context).secret));
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  return token;
}

interface Judged {
  reset_challenge: boolean;
  reset_expired: boolean;
  id: string;
  user_id: UserId;
  phase: SessionPhase;
  account_state: string;
  epoch_ok: boolean;
  absolute_expired: boolean;
  idle_expired: boolean;
  challenge_expired: boolean;
  fresh: boolean;
}

export async function resolveSession(deps: SessionDeps, headers: Headers): Promise<SessionVerdict> {
  const token = await tokenOfRequest(deps.auth, headers);
  if (token === null) return { ok: false, reason: "absent" };
  const limits = LIMITS.session;
  const found = await deps.pool.query<Judged>(
    `SELECT s.id, s.user_id, s.phase, a.state AS account_state,
            s.auth_epoch = a.auth_epoch AS epoch_ok,
            s.authenticated_at + make_interval(secs => $2) <= now() AS absolute_expired,
            (s.phase = 'mfa_complete'
              AND s.last_user_activity_at + make_interval(secs => $3) <= now()) AS idle_expired,
            (s.phase <> 'mfa_complete'
              AND s.authenticated_at + make_interval(secs => $4) <= now()) AS challenge_expired,
            coalesce(s.totp_verified_at > now() - make_interval(secs => $5)
                     AND e.state = 'active' AND e.user_id = s.user_id, false) AS fresh,
            s.reset_token_id IS NOT NULL AS reset_challenge,
            coalesce(r.expires_at <= now(), false) AS reset_expired
       FROM auth.session s
       JOIN auth.account_state a ON a.user_id = s.user_id
       LEFT JOIN auth.totp_enrollment e ON e.id = s.enrollment_id
       LEFT JOIN auth.reset_token r ON r.id = s.reset_token_id
      WHERE s.token = ANY ($1::text[])`,
    [
      sessionVerifierCandidates(deps.keys.sessionLookup, token),
      limits.absoluteSeconds,
      limits.idleSeconds,
      limits.incompleteChallengeSeconds,
      limits.freshTotpSeconds,
    ],
  );
  const row = found.rows[0];
  if (row === undefined) return { ok: false, reason: "absent" };
  const expired = row.absolute_expired
    ? "absolute"
    : row.idle_expired
      ? "idle"
      : row.challenge_expired || row.reset_expired
        ? "challenge"
        : null;
  if (expired !== null) {
    // P-118: while a pair is captured the tidy-up is refused; the session is denied all the same.
    await deps.pool
      .query("DELETE FROM auth.session WHERE id = $1", [row.id])
      .catch((error: unknown) => {
        if (!isCaptureRefusal(error)) throw error;
      });
    return { ok: false, reason: expired };
  }
  // A reset challenge lives while its account waits for the new factor (P-51).
  const allowed = row.reset_challenge
    ? row.phase === "enrollment" && row.account_state === "recovery_pending"
    : STATES_OF_PHASE[row.phase].includes(row.account_state);
  if (!allowed) return { ok: false, reason: "account" };
  if (!row.epoch_ok) return { ok: false, reason: "epoch" };
  return {
    ok: true,
    session: {
      id: row.id,
      userId: row.user_id,
      phase: row.phase,
      fresh: row.fresh,
      token,
      resetChallenge: row.reset_challenge,
    },
  };
}

/** Better Auth's own get-session answer (the user and session without the token are relayed). */
export function nativeSessionResponse(auth: Auth, headers: Headers): Promise<Response> {
  return auth.api.getSession({ headers, asResponse: true });
}

/**
 * The activity signal (Run 3.5): moves `last_user_activity_at` to now, at most
 * one write a minute per session. Only a real user action calls it: sign-in,
 * factor completion, step-up and `POST /v1/session/activity`.
 */
export async function touchActivity(db: Queryable, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE auth.session SET last_user_activity_at = now()
      WHERE id = $1 AND last_user_activity_at < now() - interval '60 seconds'`,
    [sessionId],
  );
}

/** When the session ends without further activity, and at the latest (database time). */
export async function sessionExpiries(
  db: Queryable,
  sessionId: string,
): Promise<{ idleExpiresAt: Date; absoluteExpiresAt: Date } | null> {
  const result = await db.query<{ idle: Date; absolute: Date }>(
    `SELECT last_user_activity_at + make_interval(secs => $2) AS idle,
            authenticated_at + make_interval(secs => $3) AS absolute
       FROM auth.session WHERE id = $1`,
    [sessionId, LIMITS.session.idleSeconds, LIMITS.session.absoluteSeconds],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { idleExpiresAt: row.idle, absoluteExpiresAt: row.absolute };
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  /** The stored user agent, cut to 120 printable ASCII characters. */
  client: string;
  current: boolean;
}

const printable = (text: string | null): string =>
  (text ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 120);

/** The user's sessions, oldest first; no token or verifier leaves this function. */
export async function listSessions(
  db: Queryable,
  userId: UserId,
  currentSessionId: string,
): Promise<SessionInfo[]> {
  const result = await db.query<{
    id: string;
    created_at: Date;
    last_user_activity_at: Date;
    user_agent: string | null;
  }>(
    `SELECT id, created_at, last_user_activity_at, user_agent
       FROM auth.session WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_user_activity_at.toISOString(),
    client: printable(row.user_agent),
    current: row.id === currentSessionId,
  }));
}

/**
 * The user's own ending of sessions (Run 6.1, P-105): the audit row is in the
 * transaction that deletes them, so a row that cannot be written leaves every
 * session in place and the caller answers `audit_unavailable`.
 */
async function auditEnded(
  tx: Queryable,
  userId: UserId,
  requestId: string,
  ended: { kind: "sign_out" } | { kind: "revoke"; count: number },
): Promise<void> {
  await appendAudit(tx, {
    action: ended.kind === "sign_out" ? "auth.sign_out" : "auth.session_revoke",
    actor: { kind: "user", id: userId },
    source: "api",
    organizationId: null,
    target: { kind: "user", id: userId },
    outcome: "success",
    requestId,
    operationId: null,
    details: ended.kind === "sign_out" ? {} : { revokedSessions: ended.count },
  });
}

/** Ends one session of this user; false when the id is not one of theirs (or none at all). */
export async function revokeSession(
  pool: pg.Pool,
  userId: UserId,
  sessionId: string,
  requestId: string,
): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    await invalidateCapture(tx, "session_revoke");
    const result = await tx.query("DELETE FROM auth.session WHERE id = $1 AND user_id = $2", [
      sessionId,
      userId,
    ]);
    if (result.rowCount !== 1) return false;
    await auditEnded(tx, userId, requestId, { kind: "revoke", count: 1 });
    return true;
  });
}

/** Ends every session of this user, the caller's included; answers how many. */
export async function revokeAllSessions(
  pool: pg.Pool,
  userId: UserId,
  requestId: string,
): Promise<number> {
  return withTransaction(pool, async (tx) => {
    await invalidateCapture(tx, "session_revoke");
    const result = await tx.query("DELETE FROM auth.session WHERE user_id = $1", [userId]);
    const count = result.rowCount ?? 0;
    await auditEnded(tx, userId, requestId, { kind: "revoke", count });
    return count;
  });
}

/**
 * Ends the session whose raw token the request's cookie carries, whatever its
 * state; false when no row has that token (nothing to end, nothing recorded).
 */
export async function signOutSession(
  deps: { pool: pg.Pool; keys: AuthKeys },
  token: string,
  requestId: string,
): Promise<boolean> {
  return withTransaction(deps.pool, async (tx) => {
    await invalidateCapture(tx, "sign_out");
    const result = await tx.query<{ user_id: UserId }>(
      "DELETE FROM auth.session WHERE token = ANY ($1::text[]) RETURNING user_id",
      [sessionVerifierCandidates(deps.keys.sessionLookup, token)],
    );
    const userId = result.rows[0]?.user_id;
    if (userId === undefined) return false;
    await auditEnded(tx, userId, requestId, { kind: "sign_out" });
    return true;
  });
}

/**
 * Deletes every session past either limit or past the challenge limit
 * (database time); returns how many. The API runs it at start and hourly.
 */
export async function cleanUpSessions(db: Queryable): Promise<number> {
  const limits = LIMITS.session;
  const result = await db.query(
    `DELETE FROM auth.session
      WHERE authenticated_at + make_interval(secs => $1) <= now()
         OR (phase = 'mfa_complete' AND last_user_activity_at + make_interval(secs => $2) <= now())
         OR (phase <> 'mfa_complete' AND authenticated_at + make_interval(secs => $3) <= now())`,
    [limits.absoluteSeconds, limits.idleSeconds, limits.incompleteChallengeSeconds],
  );
  // An expired reset link keeps its row, without a verifier (Doc 04 §2.1).
  await db.query(
    "UPDATE auth.reset_token SET verifier = NULL WHERE expires_at <= now() AND verifier IS NOT NULL",
  );
  return result.rowCount ?? 0;
}
