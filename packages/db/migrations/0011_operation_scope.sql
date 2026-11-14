ALTER TABLE "app"."operation" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."operation" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."operation" ADD COLUMN "secret_name" text;--> statement-breakpoint
ALTER TABLE "app"."operation" ADD COLUMN "parent_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."operation" ADD CONSTRAINT "operation_parent_operation_id_operation_id_fk" FOREIGN KEY ("parent_operation_id") REFERENCES "app"."operation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operation_environment_created_idx" ON "app"."operation" USING btree ("environment_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "operation_unresolved_idx" ON "app"."operation" USING btree ("state") WHERE "app"."operation"."state" IN ('accepted', 'executing', 'awaiting_input', 'uncertain');--> statement-breakpoint
ALTER TABLE "app"."operation" ADD CONSTRAINT "operation_secret_name_check" CHECK ("app"."operation"."secret_name" ~ '^[A-Z][A-Z0-9_]{0,127}$');--> statement-breakpoint
-- Hand-written below this line (Run 4.1, P-63, P-65). Existing rows get the
-- scope their target names: an environment id gives both columns, a project id
-- the project.
UPDATE app.operation o SET environment_id = e.id, project_id = e.project_id
  FROM app.environment e WHERE o.environment_id IS NULL AND e.id::text = o.target;--> statement-breakpoint
UPDATE app.operation o SET project_id = p.id
  FROM app.project p WHERE o.project_id IS NULL AND p.id::text = o.target;--> statement-breakpoint
-- Tombstones are written by the operator's expiry (`ops operations-expire`)
-- only: the API keeps the right to read them, not to make or change them.
REVOKE INSERT, UPDATE ON app.operation_tombstone FROM api_runtime;
