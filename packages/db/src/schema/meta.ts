// Schema `meta`: the migration history. The migrator creates this schema and
// table itself, before the first migration, so this file is not given to
// drizzle-kit (see drizzle.config.ts). It exists for typed queries only.
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const metaSchema = pgSchema("meta");

export const schemaMigration = metaSchema.table("schema_migration", {
  name: text("name").primaryKey(),
  sha256: text("sha256").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  appliedBy: text("applied_by").notNull(),
});
