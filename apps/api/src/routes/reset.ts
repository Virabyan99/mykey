// auth.reset.complete (Run 3.6, P-51): the second half of an operator reset.
// The token comes from the link's fragment, which the web client reads and
// clears. Every failure — unknown, expired, superseded or consumed token,
// wrong or missing code, wrong account state — is the same 401.
import { completeReset } from "@mykey/auth";
import { ApiError, type Handler } from "../pipeline/context.ts";

interface Body {
  token: string;
  newPassword: string;
  code?: string;
}

export const resetCompleteHandler: Handler = async (ctx, deps) => {
  const module = deps.auth;
  if (module === undefined) throw new ApiError("dependency_unavailable");
  const body = ctx.body as Body;
  const result = await completeReset(
    { pool: deps.pool, keys: module.keys, auth: module.auth, throttle: module.throttle },
    {
      token: body.token,
      newPassword: body.newPassword,
      ...(body.code === undefined ? {} : { code: body.code }),
      source: ctx.source,
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
      requestId: ctx.requestId,
    },
  );
  if (result.ok) {
    return result.next === "enroll"
      ? { status: 200, body: { next: "enroll" }, headers: { "set-cookie": result.setCookie } }
      : { status: 200, body: { next: "sign_in" } };
  }
  if (result.reason === "throttled") {
    throw new ApiError("rate_limited", undefined, {
      "retry-after": String(result.retryAfterSeconds),
    });
  }
  throw new ApiError("unauthenticated");
};
