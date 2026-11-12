// session.activity (Run 3.5): the activity signal. Only a real user action of
// the web client sends it; it moves the idle limit (at most one write a
// minute) and never the absolute one. An expired session gets the pipeline's
// 401 before this handler and cannot revive itself.
import { sessionExpiries, touchActivity } from "@mykey/auth";
import { ApiError, type Handler } from "../pipeline/context.ts";

export const sessionActivityHandler: Handler = async (ctx, deps) => {
  const principal = ctx.principal;
  if (principal === null) throw new ApiError("unauthenticated");
  await touchActivity(deps.pool, principal.sessionId);
  const expiries = await sessionExpiries(deps.pool, principal.sessionId);
  if (expiries === null) throw new ApiError("unauthenticated");
  return {
    status: 200,
    body: {
      idleExpiresAt: expiries.idleExpiresAt.toISOString(),
      absoluteExpiresAt: expiries.absoluteExpiresAt.toISOString(),
    },
  };
};
