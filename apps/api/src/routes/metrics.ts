// The organization's summary (Run 7.8, P-139, FR-1.94). The route's action
// (owner and admin) is decided by the pipeline before this runs, and every
// number is a count of rows the caller can list: the outcomes of the
// product's actions are rows of activity.list, the denials rows of
// audit.list. A day before the organization's first row was not measured:
// its counts are null, never zero.
import { ACTIVITY_ACTIONS, type AuditAction } from "@mykey/audit";
import { AuditReadTimeout, readMetrics } from "@mykey/db";
import { ApiError, type Handler } from "../pipeline/context.ts";

const DENIED: AuditAction = "access.denied";
const DAY_MS = 86_400_000;
const dayOf = (moment: Date): string => moment.toISOString().slice(0, 10);

export const metricsGetHandler: Handler = async (ctx, deps) => {
  if (ctx.scope === null) throw new ApiError("dependency_unavailable");
  const { days } = ctx.query as { days: number };
  let read;
  try {
    read = await readMetrics(deps.pool, ctx.scope.organizationId, days, ACTIVITY_ACTIONS, DENIED);
  } catch (error) {
    if (error instanceof AuditReadTimeout) throw new ApiError("busy", "metrics_read_timeout");
    throw error;
  }
  const firstDay = read.measuredFrom === null ? null : dayOf(read.measuredFrom);
  return {
    status: 200,
    body: {
      observedAt: read.observedAt.toISOString(),
      source: "audit.event",
      window: { from: read.from.toISOString(), to: read.observedAt.toISOString() },
      measuredFrom: read.measuredFrom === null ? null : read.measuredFrom.toISOString(),
      days: Array.from({ length: days }, (_, index) => {
        const day = dayOf(new Date(read.from.getTime() + index * DAY_MS));
        return {
          day,
          counts:
            firstDay === null || day < firstDay
              ? null
              : (read.days.get(day) ?? { success: 0, failure: 0, unknown: 0, denied: 0 }),
        };
      }),
      operations: read.operations,
    },
  };
};
