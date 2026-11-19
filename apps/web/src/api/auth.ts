// The auth module's routes (docs/auth-route-contract.md). Every function here
// names one path of that document; the page uses no auth client library.
import { z } from "zod";
import { failureFrom, send, type CallResult } from "./client.ts";

const BASE = "/v1/auth";

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

/** GET /v1/auth/get-session: the session of the cookie, or null without one. */
export async function getSession(): Promise<CallResult<SessionView | null>> {
  const answer = await send({ method: "GET", path: `${BASE}/get-session` });
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
