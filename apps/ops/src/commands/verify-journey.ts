// Run 6.7 Task C (P-124 step 7, D-55): the journey of a restore, through the
// private verification listener while the gate is closed + verifying. The
// owner completes the operator's mfa reset (a new password, then a new TOTP
// factor), one secret of the capture is revealed and compared by its SHA-256
// only, and one write is presented and must be quarantined. On production the
// owner does this in a browser through the tunnel and the operator confirms it
// with --owner-confirmed (runbook restore.md); here a test or the local restore
// does it with the factor's code function. The journey signs out at its end:
// the report requires that no session exists.
import { createHash, randomUUID } from "node:crypto";
import type { CheckAnswer, JourneyResult } from "./restore-verify.ts";

export interface JourneyRequest {
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

export interface JourneyDeps {
  /** One request to the verification listener (origin headers included by the caller). */
  request: (method: string, path: string, init: JourneyRequest) => Promise<Response>;
  /** The session cookie a response sets, or null. */
  cookieOf: (response: Response) => string | null;
  owner: { email: string; resetToken: string; newPassword: string };
  /**
   * A code of the TOTP secret (base32) as the owner's authenticator shows it:
   * attempt 0 activates the factor, attempt 1 signs in, at a later step (a
   * step is used once). `headers` go with the request that sends the code.
   */
  totp: (
    secret: string,
    attempt: 0 | 1,
  ) => Promise<{ code: string; headers?: Record<string, string> }>;
  /** A secret of the capture: its reveal path and the SHA-256 of its value. */
  reveal: { path: string; sha256: string };
  /** A write that must answer quarantined while the gate is closed. */
  mutation: { method: string; path: string; body: unknown };
}

const ok = (observed: string): CheckAnswer => ({ state: "ok", observed });
const failed = (observed: string): CheckAnswer => ({ state: "failed", observed });

async function codeOf(response: Response): Promise<string> {
  try {
    return ((await response.json()) as { error?: { code?: string } }).error?.code ?? "";
  } catch {
    return "";
  }
}

export async function verifyJourney(
  deps: JourneyDeps,
): Promise<JourneyResult & { cookie: string | null }> {
  const checks: JourneyResult["checks"] = {};
  let cookie: string | null = null;
  try {
    const completed = await deps.request("POST", "/v1/auth/reset/complete", {
      body: { token: deps.owner.resetToken, newPassword: deps.owner.newPassword },
    });
    const challenge = deps.cookieOf(completed);
    if (completed.status !== 200 || challenge === null) {
      checks.journey_owner_enrolled = failed(
        `reset completion answered ${String(completed.status)}`,
      );
    } else {
      const enrolled = await deps.request("POST", "/v1/auth/totp/enroll", {
        body: {},
        cookie: challenge,
      });
      const { secret } = (await enrolled.json()) as { secret?: string };
      let activated: Response | null = null;
      if (secret !== undefined) {
        const first = await deps.totp(secret, 0);
        activated = await deps.request("POST", "/v1/auth/totp/activate", {
          body: { code: first.code },
          cookie: challenge,
          ...(first.headers === undefined ? {} : { headers: first.headers }),
        });
      }
      // The reset's challenge session only enrols: the owner then signs in as always.
      if (secret !== undefined && activated?.status === 200) {
        const signedIn = await deps.request("POST", "/v1/auth/sign-in/email", {
          body: { email: deps.owner.email, password: deps.owner.newPassword },
        });
        const password = deps.cookieOf(signedIn);
        const second = await deps.totp(secret, 1);
        const verified =
          password === null
            ? null
            : await deps.request("POST", "/v1/auth/totp/verify", {
                body: { code: second.code },
                cookie: password,
                ...(second.headers === undefined ? {} : { headers: second.headers }),
              });
        cookie = verified?.status === 200 ? deps.cookieOf(verified) : null;
      }
      checks.journey_owner_enrolled =
        cookie !== null
          ? ok("reset completed, factor enrolled, signed in")
          : failed(
              `enrolment answered ${String(enrolled.status)}/${String(activated?.status ?? 0)}`,
            );
    }
  } catch (error) {
    checks.journey_owner_enrolled = {
      state: "unknown",
      observed: error instanceof Error ? error.constructor.name : "error",
    };
  }
  if (cookie === null) return { checks, cookie };

  const revealed = await deps.request("POST", deps.reveal.path, { body: {}, cookie });
  if (revealed.status === 200) {
    const { value } = (await revealed.json()) as { value?: string };
    const digest = createHash("sha256")
      .update(value ?? "", "utf8")
      .digest("hex");
    checks.journey_reveal_digest =
      digest === deps.reveal.sha256 ? ok("the digest of the capture") : failed("another digest");
  } else {
    checks.journey_reveal_digest = failed(`reveal answered ${String(revealed.status)}`);
  }

  const written = await deps.request(deps.mutation.method, deps.mutation.path, {
    body: deps.mutation.body,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
  const code = await codeOf(written);
  checks.journey_mutation_refused =
    written.status === 503 && code === "quarantined"
      ? ok("quarantined")
      : failed(`answered ${String(written.status)} ${code}`);
  // The report requires no session (sessions_none): the journey's own ends here;
  // the owner signs in again once the gate is open.
  await deps.request("POST", "/v1/auth/sign-out", { body: {}, cookie });
  return { checks, cookie: null };
}
