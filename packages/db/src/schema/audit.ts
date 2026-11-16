// Schema `audit`: the append-only event log. Runtime roles may insert and
// (the API only) read; only `maintenance` may delete, for retention.
import { sql } from "drizzle-orm";
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
    /**
     * Run 6.1 (P-106): the user an account row belongs to — the actor when it
     * is a user, else the target when it is a user. The organization's view
     * serves account rows whose subject is its member now.
     */
    subjectUserId: text("subject_user_id").generatedAlwaysAs(
      sql`CASE WHEN actor_kind = 'user' THEN actor_id WHEN target_kind = 'user' THEN target_id END`,
    ),
  },
  (t) => [
    index("event_organization_occurred_idx").on(t.organizationId, t.occurredAt, t.id),
    index("event_subject_occurred_idx")
      .on(t.subjectUserId, t.occurredAt, t.id)
      .where(sql`organization_id IS NULL`),
  ],
);
