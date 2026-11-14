// Import routes (Run 4.7, P-76, Doc 06 §8 "Import"). The preview classifies a
// dotenv file against the index and stores no value; apply and resume write it
// entry by entry through the mutation protocol. Every one of them runs inside
// the process's large-request gate. A handler maps the outcome to an answer.
import { decide } from "@mykey/contracts";
import type { EnvironmentScope } from "@mykey/db";
import { previewImport } from "@mykey/operations";
import type { LargeGate } from "../large.ts";
import { ApiError, type Handler } from "../pipeline/context.ts";
import { readDeps, recheckOf, refusedOf } from "./secrets.ts";

/** import.preview: 200 with the classification, or a refusal; nothing is written to the backend. */
export function importPreviewHandler(large: LargeGate): Handler {
  return (ctx, deps) =>
    large.run(async () => {
      const scope = ctx.scope as EnvironmentScope | null;
      const principal = ctx.principal;
      const ring = deps.auth?.keys.replayFingerprint;
      if (scope === null || principal === null || ring === undefined) {
        throw new ApiError("dependency_unavailable");
      }
      const target = { projectId: scope.projectId, environmentId: scope.environmentId };
      const outcome = await previewImport(
        { ...readDeps(deps), ring },
        {
          scope,
          userId: principal.userId,
          mayRead: decide(ctx.authority, target, "secrets.read") === "allow",
          bytes: ctx.body as Uint8Array,
          requestId: ctx.requestId,
          recheck: recheckOf(ctx, principal.userId, scope),
        },
      );
      if (outcome.kind === "refused") refusedOf(outcome);
      return { status: 200, body: outcome.body };
    });
}
