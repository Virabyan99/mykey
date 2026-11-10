// Schema `audit`: the append-only event log. Runtime roles may insert and
// (the API only) read; only `maintenance` may delete, for retention.
import { index, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const auditSchema = pgSchema("audit");

export const auditEvent = auditSchema.table(
  "event",
  {
    id: uuid("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id"),
    sourceCategory: text("source_category"),
    organizationId: uuid("organization_id"),
    action: text("action").notNull(),
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    outcome: text("outcome").notNull(),
    requestId: text("request_id"),
    operationId: uuid("operation_id"),
    details: jsonb("details"),
  },
  (t) => [index("event_organization_occurred_idx").on(t.organizationId, t.occurredAt, t.id)],
);
