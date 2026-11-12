// Password sign-in bound to account state and epochs (Run 3.2, Doc 06 §4.2).
//
//   read (state, auth_epoch, credential_epoch) for the e-mail — an unknown
//   e-mail runs one hash verification against a fixed dummy hash, so the work
//   is the same → Better Auth's own sign-in verifies the password and makes a
//   session → one transaction: lock account_state, require the state to be
//   `enrollment_pending` or `active` and both epochs unchanged, bind the
//   session to the current auth epoch (phase `password_verified`, last activity
//   now), audit `auth.sign_in` → commit.
//
// Any failure after the native call deletes the session it made. Every
// failure is the same for the caller; the reason goes to the audit row only.
import { appendAudit, type AuditEvent } from "@mykey/audit";
import { LIMITS, type UserId } from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import type pg from "pg";
import type { Auth } from "./auth.ts";
import { sessionCookie } from "./factors/elevate.ts";
import type { AuthKeys } from "./keys.ts";
import { normalizeEmail } from "./email.ts";
import { sessionVerifierCandidates } from "./session-verifier.ts";

export const SESSION_COOKIE = "__Secure-better-auth.session_token";

export type SignInFailure = "credentials" | "account" | "epoch";

export type SignInResult =
  | { ok: true; setCookie: string; phase: "password_verified"; userId: UserId; sessionId: string }
  | { ok: false; reason: SignInFailure; userId: UserId | null };

export interface SignInDeps {
  auth: Auth;
  /** Logged in as api_runtime. */
  pool: pg.Pool;
  keys: AuthKeys;
  /** Tests only: runs after the password was verified and before the commit. */
  afterVerify?: () => Promise<void>;
}

export interface SignInInput {
  email: string;
  password: string;
  /** The request's headers: Better Auth reads its Origin and user agent. */
  headers: Headers;
  requestId: string | null;
}

const ALLOWED_STATES = new Set(["enrollment_pending", "active"]);

let dummyHash: Promise<string> | undefined;

/** The raw session token of a Set-Cookie list, as Better Auth wrote it (`<token>.<signature>`). */
function tokenOfSetCookie(cookies: readonly string[]): string | null {
  for (const cookie of cookies) {
    const pair = cookie.split(";")[0] ?? "";
    if (!pair.startsWith(`${SESSION_COOKIE}=`)) continue;
    const value = decodeURIComponent(pair.slice(SESSION_COOKIE.length + 1));
    const dot = value.lastIndexOf(".");
    if (dot > 0) return value.slice(0, dot);
  }
  return null;
}

function event(
  outcome: "success" | "failure",
  userId: UserId | null,
  requestId: string | null,
  reason?: SignInFailure,
): AuditEvent {
  return {
    action: "auth.sign_in",
    actor: userId === null ? { kind: "anonymous", id: null } : { kind: "user", id: userId },
    source: "api",
    organizationId: null,
    target: userId === null ? null : { kind: "user", id: userId },
    outcome,
    requestId,
    operationId: null,
    details: reason === undefined ? {} : { reason },
  };
}

export async function signInWithPassword(
  deps: SignInDeps,
  input: SignInInput,
): Promise<SignInResult> {
  const email = normalizeEmail(input.email);
  const fail = async (reason: SignInFailure, userId: UserId | null): Promise<SignInResult> => {
    await appendAudit(deps.pool, event("failure", userId, input.requestId, reason));
    return { ok: false, reason, userId };
  };

  const found = await deps.pool.query<{ id: UserId; auth_epoch: string; credential_epoch: string }>(
    `SELECT u.id, s.auth_epoch, s.credential_epoch
       FROM auth."user" u JOIN auth.account_state s ON s.user_id = u.id
      WHERE u.email = $1`,
    [email],
  );
  const before = found.rows[0];
  const context = await deps.auth.$context;
  if (before === undefined) {
    // The same work as a real check, so the answer takes as long.
    dummyHash ??= context.password.hash("mykey-dummy-password-for-timing");
    await context.password.verify({ hash: await dummyHash, password: input.password });
    return fail("credentials", null);
  }

  let native: Response;
  try {
    native = await deps.auth.api.signInEmail({
      body: { email, password: input.password },
      headers: input.headers,
      asResponse: true,
    });
  } catch {
    return fail("credentials", before.id);
  }
  const token = native.ok ? tokenOfSetCookie(native.headers.getSetCookie()) : null;
  if (token === null) return fail("credentials", before.id);
  const candidates = sessionVerifierCandidates(deps.keys.sessionLookup, token);

  const verdict = await (async (): Promise<SignInResult> => {
    if (deps.afterVerify !== undefined) await deps.afterVerify();
    return withTransaction(deps.pool, async (tx) => {
      const state = await tx.query<{ state: string; auth_epoch: string; credential_epoch: string }>(
        "SELECT state, auth_epoch, credential_epoch FROM auth.account_state WHERE user_id = $1 FOR UPDATE",
        [before.id],
      );
      const row = state.rows[0];
      let reason: SignInFailure | null = null;
      if (row === undefined || !ALLOWED_STATES.has(row.state)) reason = "account";
      else if (
        row.auth_epoch !== before.auth_epoch ||
        row.credential_epoch !== before.credential_epoch
      ) {
        reason = "epoch";
      }
      if (reason !== null) {
        await tx.query("DELETE FROM auth.session WHERE token = ANY ($1::text[])", [candidates]);
        return { ok: false, reason, userId: before.id };
      }
      const bound = await tx.query<{ id: string }>(
        `UPDATE auth.session
            SET auth_epoch = $2, phase = 'password_verified', last_user_activity_at = now()
          WHERE token = ANY ($1::text[]) AND user_id = $3
          RETURNING id`,
        [candidates, before.auth_epoch, before.id],
      );
      const sessionId = bound.rows[0]?.id;
      if (sessionId === undefined) return { ok: false, reason: "credentials", userId: before.id };
      await appendAudit(tx, event("success", before.id, input.requestId));
      return {
        ok: true,
        phase: "password_verified",
        userId: before.id,
        sessionId,
        setCookie: await sessionCookie(
          deps.auth,
          token,
          new Date(Date.now() + LIMITS.session.absoluteSeconds * 1000),
          LIMITS.session.absoluteSeconds,
        ),
      };
    });
  })().catch(async (error: unknown) => {
    // Whatever went wrong after the native call, its session must not survive.
    await deps.pool
      .query("DELETE FROM auth.session WHERE token = ANY ($1::text[])", [candidates])
      .catch(() => undefined);
    throw error;
  });

  if (!verdict.ok) {
    await appendAudit(deps.pool, event("failure", verdict.userId, input.requestId, verdict.reason));
  }
  return verdict;
}
