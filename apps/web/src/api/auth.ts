// The auth module's routes (docs/auth-route-contract.md). Every function here
// names one path of that document; the page uses no auth client library.
// None of these goes through the query cache: several of them carry a
// password, a code, a key or recovery codes.
import { z } from "zod";
import { failureFrom, send, type CallResult } from "./client.ts";

const BASE = "/v1/auth";

async function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<CallResult<T>> {
  const answer = await send({ method: "POST", path: `${BASE}${path}`, body });
  if (answer?.status !== 200) return { ok: false, failure: failureFrom(answer) };
  const parsed = schema.safeParse(answer.json);
  if (!parsed.success) return { ok: false, failure: { kind: "transport", status: 200 } };
  return { ok: true, status: 200, body: parsed.data, requestId: answer.requestId };
}

export interface SessionView {
  sessionId: string;
  userId: string;
  email: string;
  /** `password_verified`, `enrollment` or `mfa_complete`. */
  phase: string;
}

const sessionSchema = z
  .looseObject({
    session: z.looseObject({ id: z.string().min(1), phase: z.string().min(1) }),
    user: z.looseObject({ id: z.string().min(1), email: z.string().min(1) }),
  })
  .nullable();

/**
 * GET /v1/auth/get-session: the session of the cookie, or null without one.
 * A reset's own session is answered 401: for the page that is no session too.
 */
export async function getSession(): Promise<CallResult<SessionView | null>> {
  const answer = await send({ method: "GET", path: `${BASE}/get-session` });
  if (answer?.status === 401) return { ok: true, status: 401, body: null, requestId: null };
  if (answer?.status !== 200) return { ok: false, failure: failureFrom(answer) };
  const parsed = sessionSchema.safeParse(answer.json ?? null);
  if (!parsed.success) return { ok: false, failure: { kind: "transport", status: 200 } };
  const body =
    parsed.data === null
      ? null
      : {
          sessionId: parsed.data.session.id,
          userId: parsed.data.user.id,
          email: parsed.data.user.email,
          phase: parsed.data.session.phase,
        };
  return { ok: true, status: 200, body, requestId: answer.requestId };
}

const phase = z.looseObject({ phase: z.string().min(1) });
const anything = z.unknown();
const recoveryCodes = z.looseObject({ recoveryCodes: z.array(z.string().min(1)).min(1) });

/** POST /v1/auth/sign-in/email */
export const signIn = (email: string, password: string) =>
  post("/sign-in/email", { email, password }, phase);

/** POST /v1/auth/sign-out */
export const signOut = () => post("/sign-out", {}, anything);

/** POST /v1/auth/totp/verify */
export const verifyTotp = (code: string) => post("/totp/verify", { code }, phase);

/** POST /v1/auth/recovery/verify */
export const verifyRecovery = (code: string) => post("/recovery/verify", { code }, phase);

/** POST /v1/auth/totp/enroll: the key, shown once. */
export const enrollTotp = () =>
  post(
    "/totp/enroll",
    {},
    z.looseObject({ secret: z.string().min(1), uri: z.string().startsWith("otpauth://") }),
  );

/** POST /v1/auth/totp/activate: the recovery codes, shown once. */
export const activateTotp = (code: string) => post("/totp/activate", { code }, recoveryCodes);

/** POST /v1/auth/totp/step-up */
export const stepUp = (code: string) =>
  post("/totp/step-up", { code }, z.looseObject({ fresh: z.literal(true) }));

/** POST /v1/auth/recovery/regenerate: new codes, shown once; needs a fresh code. */
export const regenerateRecovery = () => post("/recovery/regenerate", {}, recoveryCodes);

/** POST /v1/auth/change-password: needs a fresh code. */
export const changePassword = (currentPassword: string, newPassword: string) =>
  post(
    "/change-password",
    { currentPassword, newPassword },
    z.looseObject({ revokedSessions: z.number().int().nonnegative() }),
  );

const sessionRow = z.looseObject({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  lastActivityAt: z.string().min(1),
  client: z.string().nullable(),
  current: z.boolean(),
});
export type SessionRow = z.infer<typeof sessionRow>;
const sessionList = z.looseObject({ sessions: z.array(sessionRow) });

/** GET /v1/auth/sessions */
export async function listSessions(): Promise<CallResult<SessionRow[]>> {
  const answer = await send({ method: "GET", path: `${BASE}/sessions` });
  if (answer?.status !== 200) return { ok: false, failure: failureFrom(answer) };
  const parsed = sessionList.safeParse(answer.json);
  if (!parsed.success) return { ok: false, failure: { kind: "transport", status: 200 } };
  return { ok: true, status: 200, body: parsed.data.sessions, requestId: answer.requestId };
}

/** POST /v1/auth/sessions/revoke */
export const revokeSession = (sessionId: string) =>
  post("/sessions/revoke", { sessionId }, anything);

/** POST /v1/auth/revoke-sessions: every session of the account, this one included. */
export const revokeSessions = () => post("/revoke-sessions", {}, anything);
