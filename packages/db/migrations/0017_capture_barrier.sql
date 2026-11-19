CREATE TABLE "app"."backup_invalidation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"txid" bigint NOT NULL,
	CONSTRAINT "backup_invalidation_reason_check" CHECK ("app"."backup_invalidation"."reason" in ('sign_out', 'session_revoke', 'credential_revoke', 'archive'))
);
--> statement-breakpoint
ALTER TABLE "app"."backup_pair" ADD COLUMN "host" text;--> statement-breakpoint
ALTER TABLE "app"."backup_pair" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "app"."backup_pair" ADD COLUMN "manifest_sha256" text;--> statement-breakpoint
ALTER TABLE "app"."backup_pair" ADD COLUMN "invalid_reason" text;--> statement-breakpoint
ALTER TABLE "app"."backup_pair" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."backup_pair" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "backup_invalidation_at_idx" ON "app"."backup_invalidation" USING btree ("at");--> statement-breakpoint
CREATE INDEX "backup_invalidation_txid_idx" ON "app"."backup_invalidation" USING btree ("txid");--> statement-breakpoint
CREATE INDEX "backup_pair_host_status_idx" ON "app"."backup_pair" USING btree ("host","validation_status","capture_started_at");--> statement-breakpoint
-- Run 6.5 (P-118, P-131, D-51). Hand-written from here.
--
-- Before this migration a search for writers of backup_pair and
-- service_control outside infra/backup/pair-spike found none: the six inline
-- capture checks only read the row FOR SHARE.
--
-- The control row: only maintenance (or a superuser) changes it. api_runtime
-- keeps UPDATE (updated_at) for the row lock alone: SELECT ... FOR SHARE needs
-- an UPDATE right on some column, and the guard refuses the UPDATE itself.
REVOKE INSERT ON app.service_control FROM api_runtime;
--> statement-breakpoint
REVOKE UPDATE (capture_mode, epoch, owner, pair_id) ON app.service_control FROM api_runtime;
--> statement-breakpoint
REVOKE INSERT ON app.backup_pair FROM api_runtime;
--> statement-breakpoint
REVOKE UPDATE (capture_started_at, boundary, artifact_hashes, schema_revision, release_commit,
               key_refs, validation_status, eligible_until)
  ON app.backup_pair FROM api_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.backup_invalidation TO maintenance;
--> statement-breakpoint
-- The provisioner reads the mode before it takes a job (P-118).
GRANT SELECT ON app.service_control TO provisioner_runtime;
--> statement-breakpoint
CREATE FUNCTION app.service_control_guard()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF session_user <> 'maintenance'
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'service_control is changed by maintenance only (%)', TG_OP
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.service_control_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER service_control_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON app.service_control FOR EACH STATEMENT EXECUTE FUNCTION app.service_control_guard();
--> statement-breakpoint
-- An action that reduces access (sign-out, session revocation, credential
-- revocation, archive) calls this first in each of its writing transactions.
-- Idle: nothing, false. Otherwise one invalidation row for this transaction,
-- which also lets the barrier pass it: the pass cannot be forged, since only
-- this function writes the table. FOR SHARE: a coordinator changing the mode
-- waits for this transaction, so a reduction is either before the capture or
-- recorded in it.
CREATE FUNCTION app.capture_invalidate(p_reason text)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  mode text;
BEGIN
  SELECT capture_mode INTO mode FROM app.service_control FOR SHARE;
  IF mode = 'idle' THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.backup_invalidation WHERE txid = txid_current()) THEN
    INSERT INTO app.backup_invalidation (id, reason, txid)
    VALUES (gen_random_uuid(), p_reason, txid_current());
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.capture_invalidate(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.capture_invalidate(text) TO api_runtime;
--> statement-breakpoint
-- The barrier: a statement trigger on every table of app and auth but four.
-- While the mode is capturing, a write raises MKC01, unless this transaction
-- recorded an invalidation. It takes the control row FOR SHARE, so the change
-- to capturing waits for every writing transaction in flight.
CREATE FUNCTION app.capture_barrier()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  mode text;
BEGIN
  SELECT capture_mode INTO mode FROM app.service_control FOR SHARE;
  IF mode = 'capturing'
     AND NOT EXISTS (SELECT 1 FROM app.backup_invalidation WHERE txid = txid_current()) THEN
    RAISE EXCEPTION 'writing is closed while a pair is captured (%.%)', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'MKC01';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.capture_barrier() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
     WHERE schemaname IN ('app', 'auth')
       AND (schemaname || '.' || tablename) NOT IN
           ('app.rate_limit', 'app.service_control', 'app.backup_pair', 'app.backup_invalidation')
     ORDER BY 1, 2
  LOOP
    EXECUTE format(
      'CREATE TRIGGER capture_barrier BEFORE INSERT OR UPDATE OR DELETE ON %I.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app.capture_barrier()',
      t.schemaname, t.tablename);
  END LOOP;
END;
$$;
