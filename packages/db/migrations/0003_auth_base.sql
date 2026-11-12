CREATE TABLE "auth"."account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_provider_account_key" UNIQUE("provider_id","account_id"),
	CONSTRAINT "account_no_provider_tokens_check" CHECK ("auth"."account"."access_token" is null and "auth"."account"."refresh_token" is null and "auth"."account"."id_token" is null),
	CONSTRAINT "account_provider_check" CHECK ("auth"."account"."provider_id" = 'credential')
);
--> statement-breakpoint
CREATE TABLE "auth"."account_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"auth_epoch" bigint DEFAULT 0 NOT NULL,
	"credential_epoch" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_state_state_check" CHECK ("auth"."account_state"."state" in ('enrollment_pending', 'active', 'recovery_pending', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "auth"."recovery_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"verifier" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_session" uuid,
	CONSTRAINT "recovery_code_enrollment_verifier_key" UNIQUE("enrollment_id","verifier")
);
--> statement-breakpoint
CREATE TABLE "auth"."session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase" text DEFAULT 'password_verified' NOT NULL,
	"auth_epoch" bigint DEFAULT 0 NOT NULL,
	"authenticated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_user_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"totp_verified_at" timestamp with time zone,
	"enrollment_id" uuid,
	CONSTRAINT "session_token_unique" UNIQUE("token"),
	CONSTRAINT "session_phase_check" CHECK ("auth"."session"."phase" in ('password_verified', 'enrollment', 'mfa_complete')),
	CONSTRAINT "session_token_verifier_check" CHECK ("auth"."session"."token" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
CREATE TABLE "auth"."totp_enrollment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"seed_jwe" text NOT NULL,
	"key_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "totp_enrollment_state_check" CHECK ("auth"."totp_enrollment"."state" in ('pending', 'active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "auth"."totp_step_used" (
	"enrollment_id" uuid NOT NULL,
	"step" bigint NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "totp_step_used_pkey" PRIMARY KEY("enrollment_id","step")
);
--> statement-breakpoint
CREATE TABLE "auth"."user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth"."verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."account_state" ADD CONSTRAINT "account_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."recovery_code" ADD CONSTRAINT "recovery_code_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "auth"."totp_enrollment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."totp_enrollment" ADD CONSTRAINT "totp_enrollment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."totp_step_used" ADD CONSTRAINT "totp_step_used_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "auth"."totp_enrollment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "auth"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "auth"."session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "totp_enrollment_one_active_idx" ON "auth"."totp_enrollment" USING btree ("user_id") WHERE "auth"."totp_enrollment"."state" = 'active';--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written below this line (Run 2.3). The default privileges of 0001 gave
-- api_runtime SELECT, INSERT, UPDATE, DELETE on every new table in schema auth.
-- UPDATE is narrowed to columns, as in schema app: never id, user_id,
-- created_at, a session's stored verifier or its authenticated_at. A used TOTP
-- step and a recovery code are written once: no DELETE, and for a recovery
-- code UPDATE of the two consumption columns only.
REVOKE UPDATE ON ALL TABLES IN SCHEMA auth FROM api_runtime;--> statement-breakpoint
REVOKE DELETE ON auth.totp_step_used, auth.recovery_code FROM api_runtime;--> statement-breakpoint
GRANT UPDATE (name, email, email_verified, image, updated_at) ON auth."user" TO api_runtime;--> statement-breakpoint
GRANT UPDATE (expires_at, ip_address, user_agent, updated_at, phase, auth_epoch,
              last_user_activity_at, totp_verified_at, enrollment_id)
  ON auth.session TO api_runtime;--> statement-breakpoint
GRANT UPDATE (password, updated_at) ON auth.account TO api_runtime;--> statement-breakpoint
GRANT UPDATE (value, expires_at, updated_at) ON auth.verification TO api_runtime;--> statement-breakpoint
GRANT UPDATE (state, auth_epoch, credential_epoch, updated_at) ON auth.account_state TO api_runtime;--> statement-breakpoint
GRANT UPDATE (seed_jwe, key_id, state, activated_at) ON auth.totp_enrollment TO api_runtime;--> statement-breakpoint
GRANT UPDATE (consumed_at, consumed_by_session) ON auth.recovery_code TO api_runtime;--> statement-breakpoint
-- maintenance reads schema auth and changes nothing in it.
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO maintenance;
