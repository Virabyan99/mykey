ALTER TABLE "app"."environment" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "app"."organization" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "app"."project" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "app"."environment" ADD CONSTRAINT "environment_review_reason_state_check" CHECK ("app"."environment"."review_reason" is null or "app"."environment"."state" = 'needs_review');--> statement-breakpoint
ALTER TABLE "app"."environment" ADD CONSTRAINT "environment_review_reason_check" CHECK ("app"."environment"."review_reason" ~ '^[a-z][a-z_]{0,63}$');--> statement-breakpoint
ALTER TABLE "app"."organization" ADD CONSTRAINT "organization_review_reason_state_check" CHECK ("app"."organization"."review_reason" is null or "app"."organization"."state" = 'needs_review');--> statement-breakpoint
ALTER TABLE "app"."organization" ADD CONSTRAINT "organization_review_reason_check" CHECK ("app"."organization"."review_reason" ~ '^[a-z][a-z_]{0,63}$');--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_review_reason_state_check" CHECK ("app"."project"."review_reason" is null or "app"."project"."state" = 'needs_review');--> statement-breakpoint
ALTER TABLE "app"."project" ADD CONSTRAINT "project_review_reason_check" CHECK ("app"."project"."review_reason" ~ '^[a-z][a-z_]{0,63}$');--> statement-breakpoint
-- Hand-written below this line (Run 3.7, P-53). The provisioner sets and
-- clears the reason with the state. The API keeps the rule of 0001 (every
-- column but ids and keys): a state change it makes away from needs_review
-- must clear the reason in the same statement, or the check refuses it.
GRANT UPDATE (review_reason) ON app.organization, app.project, app.environment TO api_runtime;--> statement-breakpoint
GRANT UPDATE (review_reason) ON app.organization TO provisioner_runtime;--> statement-breakpoint
GRANT UPDATE (review_reason) ON app.environment TO provisioner_runtime;--> statement-breakpoint
GRANT UPDATE (state, review_reason) ON app.project TO provisioner_runtime;
