// Who a handler acts for (Session 11, Run 11.5). A mutation is a person's or
// an automation credential's; the protocols of @mykey/operations take either
// as an `Actor`, and a handler written once serves both classes. Which of
// the two a request is was decided by the pipeline, never here.
import type { Actor, Intent } from "@mykey/operations";
import type { ApiContext } from "./context.ts";
import { intentFor } from "./route.ts";

/** The request's actor: the session's user, or the automation credential as a machine actor. */
export function actorOf(ctx: ApiContext): Actor | null {
  if (ctx.principal !== null) return { kind: "user", id: ctx.principal.userId };
  if (ctx.automation !== null) return { kind: "machine", id: ctx.automation.credentialId };
  return null;
}

/**
 * The mutation's intent, as the pipeline computed it for the replay lookup:
 * an automation route names no organization in its path, so the process's
 * own stands in for `:org`.
 */
export function intentOfCaller(ctx: ApiContext, actor: Actor): Intent {
  const params =
    ctx.automation === null ? ctx.params : { ...ctx.params, org: ctx.automation.organizationId };
  return intentFor(ctx.route, params, actor, ctx.body);
}
