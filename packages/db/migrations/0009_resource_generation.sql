ALTER TABLE "app"."environment" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."organization" ADD COLUMN "resource_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."project" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Hand-written below this line (Run 3.9, P-59). The API raises the generation
-- with every create; created_at, like every id and key, is never updated.
GRANT UPDATE (resource_generation) ON app.organization TO api_runtime;
