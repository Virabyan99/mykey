CREATE TABLE "auth"."reset_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"verifier" "bytea",
	"key_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "reset_token_verifier_key" UNIQUE("verifier"),
	CONSTRAINT "reset_token_kind_check" CHECK ("auth"."reset_token"."kind" in ('password', 'mfa'))
);
--> statement-breakpoint
ALTER TABLE "auth"."session" ADD COLUMN "reset_token_id" uuid;--> statement-breakpoint
ALTER TABLE "auth"."reset_token" ADD CONSTRAINT "reset_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reset_token_user_id_idx" ON "auth"."reset_token" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_reset_token_id_reset_token_id_fk" FOREIGN KEY ("reset_token_id") REFERENCES "auth"."reset_token"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written below this line (Run 3.6, D-30). The default privileges of 0001
-- gave api_runtime SELECT, INSERT, UPDATE, DELETE on the new table: it keeps
-- SELECT and may only consume a token (verifier, consumed_at). Only the
-- operator (maintenance) issues and supersedes tokens. maintenance also gets
-- the two DELETE rights of the factor clean-up (Run 3.5, ops auth-cleanup).
REVOKE INSERT, UPDATE, DELETE ON auth.reset_token FROM api_runtime;--> statement-breakpoint
GRANT UPDATE (verifier, consumed_at) ON auth.reset_token TO api_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON auth.reset_token TO maintenance;--> statement-breakpoint
GRANT UPDATE (verifier, superseded_at) ON auth.reset_token TO maintenance;--> statement-breakpoint
GRANT DELETE ON auth.totp_step_used, auth.recovery_code TO maintenance;
