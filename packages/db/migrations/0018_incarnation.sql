ALTER TABLE "app"."service_control" ADD COLUMN "backend_incarnation" text;--> statement-breakpoint
ALTER TABLE "app"."service_control" ADD COLUMN "restored_from_pair" uuid;