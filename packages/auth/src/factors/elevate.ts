// The product-owned second factor (P-24, D-19). Every change of factor state
// is one transaction on one connection:
//
//   lock the account_state row, then the session row → check state, epochs and
//   expiry → find the step of the code (−1, 0, +1, in that order, without
//   looking at used steps) → INSERT the used step (a unique violation is a
//   replay) → insert the new mfa_complete session row (new random token, stored
//   as its verifier, same authenticated_at) and delete the old one → COMMIT →
//   only then build the cookie with Better Auth's own signing.
//
// A recovery code does the same with an UPDATE … WHERE consumed_at IS NULL.
import { randomBytes, randomUUID } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import { makeSignature } from "better-auth/crypto";
import pg from "pg";
import type { Auth } from "../auth.ts";
import type { AuthKeys } from "../keys.ts";
import { sessionVerifier, sessionVerifierCandidates } from "../session-verifier.ts";
import {
  formatRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  recoveryVerifier,
} from "./recovery.ts";
import { SEED_BYTES, decryptSeed, encryptSeed } from "./seed.ts";
import { matchStep, otpauthUri } from "./totp.ts";

export interface FactorDeps {
  /** Logged in as api_runtime. */
  pool: pg.Pool;
  keys: AuthKeys;
  auth: Auth;
}

export type FailureReason = "invalid" | "replayed" | "expired" | "wrong_state";
export type ElevateResult = { ok: true; setCookie: string } | { ok: false; reason: FailureReason };

interface SessionRow {
  id: string;
  user_id: string;
  phase: string;
  auth_epoch: string;
  expires_at: Date;
  authenticated_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  enrollment_id: string | null;
}

interface Locked {
  client: pg.PoolClient;
  session: SessionRow;
  state: string;
}

const UNIQUE_VIOLATION = "23505";

class Refused extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Runs `work` in one transaction with the account_state row and the session
 * row of `sessionToken` locked, in that order. A `Refused` rolls back and
 * becomes `{ ok: false }`.
 */
async function withLockedSession<T>(
  deps: FactorDeps,
  sessionToken: string,
  now: Date,
  work: (locked: Locked) => Promise<T>,
): Promise<T | { ok: false; reason: FailureReason }> {
  const candidates = sessionVerifierCandidates(deps.keys.sessionLookup, sessionToken);
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const owner = await client.query<{ user_id: string }>(
        "SELECT user_id FROM auth.session WHERE token = ANY ($1::text[])",
        [candidates],
      );
      const userId = owner.rows[0]?.user_id;
      if (userId === undefined) throw new Refused("expired");
      const account = await client.query<{ state: string; auth_epoch: string }>(
        "SELECT state, auth_epoch FROM auth.account_state WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      const state = account.rows[0];
      if (state === undefined) throw new Refused("wrong_state");
      const found = await client.query<SessionRow>(
        `SELECT id, user_id, phase, auth_epoch, expires_at, authenticated_at, ip_address,
                user_agent, enrollment_id
           FROM auth.session WHERE token = ANY ($1::text[]) FOR UPDATE`,
        [candidates],
      );
      const session = found.rows[0];
      // Gone since the first read: another request rotated it.
      if (session === undefined) throw new Refused("expired");
      if (session.expires_at.getTime() <= now.getTime()) throw new Refused("expired");
      if (session.auth_epoch !== state.auth_epoch) throw new Refused("expired");
      const result = await work({ client, session, state: state.state });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Refused) return { ok: false, reason: error.reason };
      throw error;
    }
  } finally {
    client.release();
  }
}

/** A session that has only passed the password must finish its challenge in time. */
function requireChallengeOpen(session: SessionRow, now: Date): void {
  const deadline =
    session.authenticated_at.getTime() + LIMITS.session.incompleteChallengeSeconds * 1000;
  if (deadline <= now.getTime()) throw new Refused("expired");
}

/** Replaces the session row by an mfa_complete one with a new token; returns the raw token. */
async function rotateToComplete(
  deps: FactorDeps,
  locked: Locked,
  now: Date,
  factor: { enrollmentId: string; totp: boolean },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomBytes(24).toString("base64url");
  const sessionId = randomUUID();
  const old = locked.session;
  await locked.client.query(
    `INSERT INTO auth.session (id, token, user_id, expires_at, ip_address, user_agent, phase,
                               auth_epoch, authenticated_at, last_user_activity_at,
                               totp_verified_at, enrollment_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'mfa_complete', $7, $8, $9, $10, $11, $9, $9)`,
    [
      sessionId,
      sessionVerifier(deps.keys.sessionLookup, token),
      old.user_id,
      old.expires_at,
      old.ip_address,
      old.user_agent,
      old.auth_epoch,
      old.authenticated_at,
      now,
      factor.totp ? now : null,
      factor.enrollmentId,
    ],
  );
  await locked.client.query("DELETE FROM auth.session WHERE id = $1", [old.id]);
  return { token, sessionId, expiresAt: old.expires_at };
}

/** The Set-Cookie value for a session token, signed and named as Better Auth does it. */
export async function sessionCookie(auth: Auth, token: string, expiresAt: Date): Promise<string> {
  const context = await auth.$context;
  const cookie = context.authCookies.sessionToken;
  const value = encodeURIComponent(`${token}.${await makeSignature(token, context.secret)}`);
  const attributes = cookie.attributes as {
    path?: string;
    domain?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  };
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${cookie.name}=${value}`,
    `Max-Age=${maxAge}`,
    `Path=${attributes.path ?? "/"}`,
    ...(attributes.domain === undefined ? [] : [`Domain=${attributes.domain}`]),
    ...(attributes.httpOnly === false ? [] : ["HttpOnly"]),
    ...(attributes.secure === true ? ["Secure"] : []),
    `SameSite=${(attributes.sameSite ?? "lax").replace(/^./, (c) => c.toUpperCase())}`,
  ].join("; ");
}

async function activeEnrollment(
  deps: FactorDeps,
  locked: Locked,
): Promise<{ id: string; seed: Uint8Array }> {
  const found = await locked.client.query<{ id: string; seed_jwe: string }>(
    "SELECT id, seed_jwe FROM auth.totp_enrollment WHERE user_id = $1 AND state = 'active'",
    [locked.session.user_id],
  );
  const row = found.rows[0];
  if (row === undefined) throw new Refused("wrong_state");
  const seed = await decryptSeed(deps.keys.seedEncryption, row.seed_jwe, {
    userId: locked.session.user_id,
    enrollmentId: row.id,
  });
  return { id: row.id, seed };
}

/** Records the step as used; a second use of the same step is a replay. */
async function useStep(locked: Locked, enrollmentId: string, step: number): Promise<void> {
  try {
    await locked.client.query(
      "INSERT INTO auth.totp_step_used (enrollment_id, step) VALUES ($1, $2)",
      [enrollmentId, step],
    );
  } catch (error) {
    if (error instanceof pg.DatabaseError && error.code === UNIQUE_VIOLATION) {
      throw new Refused("replayed");
    }
    throw error;
  }
}

async function storeRecoveryCodes(
  deps: FactorDeps,
  locked: Locked,
  enrollmentId: string,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const ring = deps.keys.recoveryVerifier;
  for (const code of codes) {
    await locked.client.query(
      "INSERT INTO auth.recovery_code (id, enrollment_id, verifier, key_id) VALUES ($1, $2, $3, $4)",
      [randomUUID(), enrollmentId, recoveryVerifier(ring, enrollmentId, code), ring.current],
    );
  }
  return codes.map(formatRecoveryCode);
}

// --------------------------------------------------------------- elevation

export async function elevateWithTotp(
  deps: FactorDeps,
  input: { sessionToken: string; code: string; now?: Date },
): Promise<ElevateResult> {
  const now = input.now ?? new Date();
  const result = await withLockedSession(deps, input.sessionToken, now, async (locked) => {
    if (locked.state !== "active" || locked.session.phase !== "password_verified") {
      throw new Refused("wrong_state");
    }
    requireChallengeOpen(locked.session, now);
    const enrollment = await activeEnrollment(deps, locked);
    const step = matchStep(enrollment.seed, input.code, now);
    if (step === null) throw new Refused("invalid");
    await useStep(locked, enrollment.id, step);
    return rotateToComplete(deps, locked, now, { enrollmentId: enrollment.id, totp: true });
  });
  if ("ok" in result) return result;
  return { ok: true, setCookie: await sessionCookie(deps.auth, result.token, result.expiresAt) };
}

export async function elevateWithRecoveryCode(
  deps: FactorDeps,
  input: { sessionToken: string; code: string; now?: Date },
): Promise<ElevateResult> {
  const now = input.now ?? new Date();
  const code = normalizeRecoveryCode(input.code);
  if (code === null) return { ok: false, reason: "invalid" };
  const result = await withLockedSession(deps, input.sessionToken, now, async (locked) => {
    if (locked.state !== "active" || locked.session.phase !== "password_verified") {
      throw new Refused("wrong_state");
    }
    requireChallengeOpen(locked.session, now);
    const enrollment = await activeEnrollment(deps, locked);
    const ring = deps.keys.recoveryVerifier;
    const verifiers = Object.keys(ring.keys).map((keyId) =>
      recoveryVerifier(ring, enrollment.id, code, keyId),
    );
    const rotated = await rotateToComplete(deps, locked, now, {
      enrollmentId: enrollment.id,
      totp: false,
    });
    const consumed = await locked.client.query(
      `UPDATE auth.recovery_code SET consumed_at = $3, consumed_by_session = $4
        WHERE enrollment_id = $1 AND verifier = ANY ($2::bytea[]) AND consumed_at IS NULL
        RETURNING id`,
      [enrollment.id, verifiers, now, rotated.sessionId],
    );
    if (consumed.rowCount !== 1) throw new Refused("invalid");
    return rotated;
  });
  if ("ok" in result) return result;
  return { ok: true, setCookie: await sessionCookie(deps.auth, result.token, result.expiresAt) };
}

// --------------------------------------------------------------- enrollment

export type EnrollResult =
  | { ok: true; enrollmentId: string; secret: string; uri: string }
  | { ok: false; reason: FailureReason };

/** Starts an enrollment for an account waiting for one; the seed is shown once. */
export async function enrollTotp(
  deps: FactorDeps,
  input: { sessionToken: string; now?: Date },
): Promise<EnrollResult> {
  const now = input.now ?? new Date();
  return withLockedSession(deps, input.sessionToken, now, async (locked) => {
    if (
      locked.state !== "enrollment_pending" ||
      !["password_verified", "enrollment"].includes(locked.session.phase)
    ) {
      throw new Refused("wrong_state");
    }
    requireChallengeOpen(locked.session, now);
    const userId = locked.session.user_id;
    await locked.client.query(
      "DELETE FROM auth.totp_enrollment WHERE user_id = $1 AND state = 'pending'",
      [userId],
    );
    const enrollmentId = randomUUID();
    const seed = new Uint8Array(randomBytes(SEED_BYTES));
    await locked.client.query(
      `INSERT INTO auth.totp_enrollment (id, user_id, seed_jwe, key_id, state, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [
        enrollmentId,
        userId,
        await encryptSeed(deps.keys.seedEncryption, seed, { userId, enrollmentId }),
        deps.keys.seedEncryption.current,
        now,
      ],
    );
    await locked.client.query(
      "UPDATE auth.session SET phase = 'enrollment', enrollment_id = $2, updated_at = $3 WHERE id = $1",
      [locked.session.id, enrollmentId, now],
    );
    const email = await locked.client.query<{ email: string }>(
      'SELECT email FROM auth."user" WHERE id = $1',
      [userId],
    );
    return { ok: true as const, enrollmentId, ...otpauthUri(seed, email.rows[0]?.email ?? userId) };
  });
}

export type ActivateResult =
  { ok: true; setCookie: string; recoveryCodes: string[] } | { ok: false; reason: FailureReason };

/** Proves the authenticator with one code, activates it, elevates the session and returns the recovery codes once. */
export async function activateTotp(
  deps: FactorDeps,
  input: { sessionToken: string; code: string; now?: Date },
): Promise<ActivateResult> {
  const now = input.now ?? new Date();
  const result = await withLockedSession(deps, input.sessionToken, now, async (locked) => {
    const enrollmentId = locked.session.enrollment_id;
    if (
      locked.state !== "enrollment_pending" ||
      locked.session.phase !== "enrollment" ||
      enrollmentId === null
    ) {
      throw new Refused("wrong_state");
    }
    requireChallengeOpen(locked.session, now);
    const userId = locked.session.user_id;
    const pending = await locked.client.query<{ seed_jwe: string }>(
      "SELECT seed_jwe FROM auth.totp_enrollment WHERE id = $1 AND user_id = $2 AND state = 'pending' FOR UPDATE",
      [enrollmentId, userId],
    );
    const row = pending.rows[0];
    if (row === undefined) throw new Refused("wrong_state");
    const seed = await decryptSeed(deps.keys.seedEncryption, row.seed_jwe, {
      userId,
      enrollmentId,
    });
    const step = matchStep(seed, input.code, now);
    if (step === null) throw new Refused("invalid");
    await useStep(locked, enrollmentId, step);
    await locked.client.query(
      "UPDATE auth.totp_enrollment SET state = 'active', activated_at = $2 WHERE id = $1",
      [enrollmentId, now],
    );
    await locked.client.query(
      "UPDATE auth.account_state SET state = 'active', updated_at = $2 WHERE user_id = $1",
      [userId, now],
    );
    const recoveryCodes = await storeRecoveryCodes(deps, locked, enrollmentId);
    const rotated = await rotateToComplete(deps, locked, now, { enrollmentId, totp: true });
    return { ...rotated, recoveryCodes };
  });
  if ("ok" in result) return result;
  return {
    ok: true,
    setCookie: await sessionCookie(deps.auth, result.token, result.expiresAt),
    recoveryCodes: result.recoveryCodes,
  };
}

export type RegenerateResult =
  { ok: true; recoveryCodes: string[] } | { ok: false; reason: FailureReason };

/** Invalidates every unused code, then returns ten new ones; both in one transaction. */
export async function regenerateRecoveryCodes(
  deps: FactorDeps,
  input: { sessionToken: string; now?: Date },
): Promise<RegenerateResult> {
  const now = input.now ?? new Date();
  return withLockedSession(deps, input.sessionToken, now, async (locked) => {
    if (locked.state !== "active" || locked.session.phase !== "mfa_complete") {
      throw new Refused("wrong_state");
    }
    const enrollment = await activeEnrollment(deps, locked);
    await locked.client.query(
      `UPDATE auth.recovery_code SET consumed_at = $2, consumed_by_session = $3
        WHERE enrollment_id = $1 AND consumed_at IS NULL`,
      [enrollment.id, now, locked.session.id],
    );
    return {
      ok: true as const,
      recoveryCodes: await storeRecoveryCodes(deps, locked, enrollment.id),
    };
  });
}
