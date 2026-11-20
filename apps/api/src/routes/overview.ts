// The organization's overview (Run 7.3, P-139, FR-1.90). The route's action
// (owner and admin) is decided by the pipeline before this runs, so
// everything counted here is something the caller may list. A count that was
// not made is null: an environment that is pending or under review has no
// count the page could trust.
import { LIMITS } from "@mykey/contracts";
import { AuditReadTimeout, readOverview } from "@mykey/db";
import { ApiError, type Handler } from "../pipeline/context.ts";

/** States in which the index is not a statement about the environment. */
const NOT_COUNTED = new Set(["pending", "needs_review"]);

export const overviewGetHandler: Handler = async (ctx, deps) => {
  if (ctx.scope === null) throw new ApiError("dependency_unavailable");
  let overview;
  try {
    overview = await readOverview(deps.pool, ctx.scope.organizationId, LIMITS.listing.maxLimit);
  } catch (error) {
    if (error instanceof AuditReadTimeout) throw new ApiError("busy", "overview_read_timeout");
    throw error;
  }
  return {
    status: 200,
    body: {
      observedAt: overview.observedAt.toISOString(),
      source: "index",
      projects: overview.projects.map((project) => ({
        id: project.id,
        name: project.name,
        state: project.state,
        reviewReason: project.reviewReason,
        environments: project.environments.map((environment) => {
          const counted = !NOT_COUNTED.has(environment.state);
          return {
            id: environment.id,
            name: environment.name,
            state: environment.state,
            reviewReason: environment.reviewReason,
            kvReady: environment.kvReady,
            changedAt:
              counted && environment.changedAt !== null
                ? environment.changedAt.toISOString()
                : null,
            keys: counted
              ? {
                  live: environment.live,
                  deleted: environment.deleted,
                  needsReview: environment.needsReview,
                }
              : null,
          };
        }),
      })),
      truncated: overview.truncated,
    },
  };
};
