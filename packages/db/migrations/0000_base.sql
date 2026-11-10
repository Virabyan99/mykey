CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE SCHEMA "auth";
--> statement-breakpoint
CREATE SCHEMA "jobs";
--> statement-breakpoint
CREATE SEQUENCE "app"."environment_lock_key_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "app"."access_grant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"role" text NOT NULL,
	CONSTRAINT "access_grant_role_check" CHECK ("app"."access_grant"."role" in ('reader', 'editor')),
	CONSTRAINT "access_grant_one_target_check" CHECK (num_nonnulls("app"."access_grant"."project_id", "app"."access_grant"."environment_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "app"."backup_pair" (
	"id" uuid PRIMARY KEY NOT NULL,
	"capture_started_at" timestamp with time zone NOT NULL,
	"boundary" jsonb NOT NULL,
	"artifact_hashes" jsonb NOT NULL,
	"schema_revision" text NOT NULL,
	"release_commit" text NOT NULL,
	"key_refs" jsonb NOT NULL,
	"validation_status" text NOT NULL,
	"eligible_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_pair_validation_status_check" CHECK ("app"."backup_pair"."validation_status" in ('candidate', 'eligible', 'ineligible', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "app"."effect_slot" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"step_id" uuid,
	"generation" bigint NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."environment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"kv_ready" boolean DEFAULT false NOT NULL,
	"policy_digest" text,
	"metadata_generation" bigint DEFAULT 0 NOT NULL,
	"live_value_bytes" bigint DEFAULT 0 NOT NULL,
	"lock_key" bigint DEFAULT nextval('app.environment_lock_key_seq') NOT NULL,
	"archive_origin" text,
	"archive_operation_id" uuid,
	CONSTRAINT "environment_lock_key_key" UNIQUE("lock_key"),
	CONSTRAINT "environment_project_name_key" UNIQUE("project_id","name"),
	CONSTRAINT "environment_organization_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "environment_name_check" CHECK ("app"."environment"."name" ~ '^[a-z][a-z0-9-]{0,62}$'),
	CONSTRAINT "environment_state_check" CHECK ("app"."environment"."state" in ('pending', 'active', 'revoking', 'archived', 'needs_review')),
	CONSTRAINT "environment_live_value_bytes_check" CHECK ("app"."environment"."live_value_bytes" between 0 and 8388608),
	CONSTRAINT "environment_archive_origin_check" CHECK ("app"."environment"."archive_origin" in ('self', 'project'))
);
--> statement-breakpoint
CREATE TABLE "app"."import_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_operation_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"name" text NOT NULL,
	"classification" text NOT NULL,
	"expected_version" integer,
	"expected_state_tag" text,
	"child_operation_id" uuid,
	"outcome" text,
	CONSTRAINT "import_entry_parent_ordinal_key" UNIQUE("parent_operation_id","ordinal"),
	CONSTRAINT "import_entry_parent_name_key" UNIQUE("parent_operation_id","name"),
	CONSTRAINT "import_entry_classification_check" CHECK ("app"."import_entry"."classification" in ('create', 'update', 'unchanged', 'invalid', 'duplicate', 'conflict')),
	CONSTRAINT "import_entry_outcome_check" CHECK ("app"."import_entry"."outcome" in ('created', 'updated', 'unchanged', 'conflict', 'rejected', 'uncertain', 'not_attempted'))
);
--> statement-breakpoint
CREATE TABLE "app"."import_preview" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"file_hmac" "bytea" NOT NULL,
	"hmac_key_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"entries" jsonb NOT NULL,
	"claimed_by_operation_id" uuid,
	CONSTRAINT "import_preview_claimed_by_operation_key" UNIQUE("claimed_by_operation_id")
);
--> statement-breakpoint
CREATE TABLE "app"."machine_credential" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"issuance_operation_id" uuid NOT NULL,
	"accessor" text,
	"requested_expires_at" timestamp with time zone NOT NULL,
	"effective_expires_at" timestamp with time zone,
	"state" text NOT NULL,
	"issued_by" uuid NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "machine_credential_organization_accessor_key" UNIQUE("organization_id","accessor"),
	CONSTRAINT "machine_credential_state_check" CHECK ("app"."machine_credential"."state" in ('issuing', 'active', 'revoking', 'revoked', 'expired', 'needs_review'))
);
--> statement-breakpoint
CREATE TABLE "app"."membership" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"state" text NOT NULL,
	CONSTRAINT "membership_organization_user_key" UNIQUE("organization_id","user_id"),
	CONSTRAINT "membership_role_check" CHECK ("app"."membership"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "membership_state_check" CHECK ("app"."membership"."state" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "app"."operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"fingerprint" "bytea",
	"fingerprint_key_id" text,
	"expected" jsonb,
	"state" text NOT NULL,
	"executor_boot_id" uuid,
	"dispatched_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"result" jsonb,
	"error_code" text,
	"replay_expires_at" timestamp with time zone,
	"audit_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "operation_idempotency_key" UNIQUE("principal_kind","principal_id","action","target","idempotency_key"),
	CONSTRAINT "operation_principal_kind_check" CHECK ("app"."operation"."principal_kind" in ('user', 'machine', 'operator', 'system')),
	CONSTRAINT "operation_state_check" CHECK ("app"."operation"."state" in ('accepted', 'executing', 'awaiting_input', 'uncertain', 'succeeded', 'partial', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "app"."operation_step" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"target" text NOT NULL,
	"before_state" jsonb,
	"dispatch_attempt_id" uuid,
	"outcome" text,
	"backend_ref" text,
	CONSTRAINT "operation_step_operation_ordinal_key" UNIQUE("operation_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "app"."operation_tombstone" (
	"principal_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"expired_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operation_tombstone_pkey" PRIMARY KEY("principal_kind","principal_id","action","target","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "app"."organization" (
	"id" uuid PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"state" text NOT NULL,
	"config_digest" text,
	"provisioning_operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_namespace_unique" UNIQUE("namespace"),
	CONSTRAINT "organization_state_check" CHECK ("app"."organization"."state" in ('provisioning', 'active', 'failed', 'needs_review'))
);
--> statement-breakpoint
CREATE TABLE "app"."outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"job_kind" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "outbox_operation_job_kind_key" UNIQUE("operation_id","job_kind"),
	CONSTRAINT "outbox_state_check" CHECK ("app"."outbox"."state" in ('pending', 'delivered'))
);
--> statement-breakpoint
CREATE TABLE "app"."project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"archive_operation_id" uuid,
	CONSTRAINT "project_organization_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "project_organization_id_key" UNIQUE("organization_id","id"),
	CONSTRAINT "project_name_length_check" CHECK (char_length("app"."project"."name") between 1 and 64),
	CONSTRAINT "project_name_nfc_check" CHECK ("app"."project"."name" = normalize("app"."project"."name", NFC)),
	CONSTRAINT "project_state_check" CHECK ("app"."project"."state" in ('pending', 'active', 'revoking', 'archived', 'needs_review'))
);
--> statement-breakpoint
CREATE TABLE "app"."rate_limit" (
	"scope" text NOT NULL,
	"key_digest" "bytea" NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limit_pkey" PRIMARY KEY("scope","key_digest","window_start"),
	CONSTRAINT "rate_limit_count_check" CHECK ("app"."rate_limit"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."secret_index" (
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"current_version" integer,
	"state_tag" text NOT NULL,
	"state" text NOT NULL,
	"live_value_bytes" integer DEFAULT 0 NOT NULL,
	"last_changed_at" timestamp with time zone NOT NULL,
	"last_operation_id" uuid,
	CONSTRAINT "secret_index_pkey" PRIMARY KEY("environment_id","name"),
	CONSTRAINT "secret_index_name_check" CHECK ("app"."secret_index"."name" ~ '^[A-Z][A-Z0-9_]{0,127}$'),
	CONSTRAINT "secret_index_state_check" CHECK ("app"."secret_index"."state" in ('live', 'deleted', 'needs_review')),
	CONSTRAINT "secret_index_live_value_bytes_check" CHECK ("app"."secret_index"."live_value_bytes" between 0 and 65536)
);
--> statement-breakpoint
CREATE TABLE "app"."secret_version_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"operation_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "secret_version_event_actor_kind_check" CHECK ("app"."secret_version_event"."actor_kind" in ('user', 'operator', 'system', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "app"."service_control" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"capture_mode" text DEFAULT 'idle' NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"owner" text,
	"pair_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_control_single_row_check" CHECK ("app"."service_control"."id"),
	CONSTRAINT "service_control_capture_mode_check" CHECK ("app"."service_control"."capture_mode" in ('idle', 'draining', 'capturing'))
);
--> statement-breakpoint
CREATE TABLE "audit"."event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"source_category" text,
	"organization_id" uuid,
	"action" text NOT NULL,
	"target_kind" text,
	"target_id" text,
	"outcome" text NOT NULL,
	"request_id" text,
	"operation_id" uuid,
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "app"."access_grant" ADD CONSTRAINT "access_grant_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "app"."membership"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grant" ADD CONSTRAINT "access_grant_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "app"."project"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grant" ADD CONSTRAINT "access_grant_environment_fk" FOREIGN KEY ("organization_id","environment_id") REFERENCES "app"."environment"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."effect_slot" ADD CONSTRAINT "effect_slot_operation_id_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "app"."operation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."environment" ADD CONSTRAINT "environment_organization_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "app"."project"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_entry" ADD CONSTRAINT "import_entry_parent_operation_id_operation_id_fk" FOREIGN KEY ("parent_operation_id") REFERENCES "app"."operation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."machine_credential" ADD CONSTRAINT "machine_credential_environment_fk" FOREIGN KEY ("organization_id","environment_id") REFERENCES "app"."environment"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."operation_step" ADD CONSTRAINT "operation_step_operation_id_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "app"."operation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD CONSTRAINT "outbox_operation_id_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "app"."operation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."secret_index" ADD CONSTRAINT "secret_index_environment_fk" FOREIGN KEY ("organization_id","environment_id") REFERENCES "app"."environment"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_version_event_name_version_idx" ON "app"."secret_version_event" USING btree ("environment_id","name","version");--> statement-breakpoint
CREATE INDEX "event_organization_occurred_idx" ON "audit"."event" USING btree ("organization_id","occurred_at","id");