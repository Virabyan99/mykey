// The workspace's timeline (Run 6.1, P-108, Doc 06 §18.3). The rows of the
// audit view restricted to the product's actions, each with its operation's
// state now and the current name of the project or environment it targets.
// It never groups: the workspace groups by operation id.
import { ACTIVITY_ACTIONS } from "@mykey/audit";
import { operationStates, targetNames } from "@mykey/db";
import {
  ApiError,
  type ApiContext,
  type AppDeps,
  type HandlerResult,
} from "../pipeline/context.ts";
import { auditPage, itemOf, uuidsOf } from "./audit.ts";

export const activityListHandler = async (
  ctx: ApiContext,
  deps: AppDeps,
): Promise<HandlerResult> => {
  if (ctx.scope === null) throw new ApiError("dependency_unavailable");
  const organizationId = ctx.scope.organizationId;
  const { rows, nextCursor, anchor } = await auditPage(ctx, deps, ACTIVITY_ACTIONS);
  const operations = await operationStates(
    deps.pool,
    organizationId,
    uuidsOf(rows.map((row) => row.operationId)),
  );
  const names = await targetNames(
    deps.pool,
    organizationId,
    uuidsOf(rows.map((row) => row.targetId)),
  );
  return {
    status: 200,
    body: {
      items: rows.map((row) => {
        const operation = row.operationId === null ? undefined : operations.get(row.operationId);
        return {
          ...itemOf(ctx, deps, row),
          operation:
            operation === undefined || row.operationId === null
              ? null
              : { id: row.operationId, state: operation.state, action: operation.action },
          targetName: row.targetId === null ? null : (names.get(row.targetId) ?? null),
        };
      }),
      nextCursor,
      anchor,
    },
  };
};
