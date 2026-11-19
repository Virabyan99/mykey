// Schema `audit`: the append-only event log. Runtime roles may insert and
// (the API only) read. Since Run 6.2 (migration 0016) nobody deletes a row
// directly: retention goes through audit.purge_archived(), and a trigger
// refuses UPDATE and TRUNCATE for every role.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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

/**
 * Run 6.2 (P-112, migration 0016): one row per audit segment shipped off the
 * host. One chain per host over both streams: `sequence` counts from 1 without
 * a gap and `previous_sha256` is the sha256 of the segment before. `app`
 * segments cover one UTC day of audit.event (a later segment of the same day
 * holds rows committed late); an `openbao` segment is one rotated audit file
 * (`source` is its name). `verified_at` is set only after the object and its
 * manifest were read back and compared; `purged_at` when retention removed the
 * interval's rows.
 */
export const auditArchiveSegment = auditSchema.table(
  "archive_segment",
  {
    sequence: bigint("sequence", { mode: "bigint" }).primaryKey(),
    stream: text("stream").notNull(),
    host: text("host").notNull(),
    source: text("source"),
    fromAt: timestamp("from_at", { withTimezone: true, precision: 6 }).notNull(),
    toAt: timestamp("to_at", { withTimezone: true, precision: 6 }).notNull(),
    rowCount: bigint("row_count", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    previousSha256: text("previous_sha256"),
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (t) => [
    check("archive_segment_stream_check", sql`${t.stream} IN ('app', 'openbao')`),
    check("archive_segment_sequence_check", sql`${t.sequence} > 0`),
    check("archive_segment_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "archive_segment_previous_check",
      sql`${t.previousSha256} IS NULL OR ${t.previousSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check("archive_segment_interval_check", sql`${t.fromAt} <= ${t.toAt}`),
    check("archive_segment_rows_check", sql`${t.rowCount} >= 0`),
    uniqueIndex("archive_segment_object_key_key").on(t.objectKey),
    index("archive_segment_interval_idx").on(t.stream, t.fromAt, t.toAt),
  ],
);
