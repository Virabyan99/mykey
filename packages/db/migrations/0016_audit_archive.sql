CREATE TABLE "audit"."archive_segment" (
	"sequence" bigint PRIMARY KEY NOT NULL,
	"stream" text NOT NULL,
	"host" text NOT NULL,
	"source" text,
	"from_at" timestamp (6) with time zone NOT NULL,
	"to_at" timestamp (6) with time zone NOT NULL,
	"row_count" bigint NOT NULL,
	"sha256" text NOT NULL,
	"previous_sha256" text,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "archive_segment_stream_check" CHECK ("audit"."archive_segment"."stream" IN ('app', 'openbao')),
	CONSTRAINT "archive_segment_sequence_check" CHECK ("audit"."archive_segment"."sequence" > 0),
	CONSTRAINT "archive_segment_sha256_check" CHECK ("audit"."archive_segment"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "archive_segment_previous_check" CHECK ("audit"."archive_segment"."previous_sha256" IS NULL OR "audit"."archive_segment"."previous_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "archive_segment_interval_check" CHECK ("audit"."archive_segment"."from_at" <= "audit"."archive_segment"."to_at"),
	CONSTRAINT "archive_segment_rows_check" CHECK ("audit"."archive_segment"."row_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "archive_segment_object_key_key" ON "audit"."archive_segment" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "archive_segment_interval_idx" ON "audit"."archive_segment" USING btree ("stream","from_at","to_at");--> statement-breakpoint
-- Run 6.2 (P-112, P-131, D-48). Hand-written from here.
--
-- The archive job runs as maintenance: it records a segment, then sets
-- uploaded_at and verified_at; nothing else of a segment changes. The purge
-- function (below) is the only way rows leave audit.event: maintenance loses
-- its direct DELETE (no released code uses it: the search of Run 6.2 found
-- none), and a trigger refuses UPDATE and TRUNCATE for every role, the owner
-- included.
GRANT SELECT, INSERT ON audit.archive_segment TO maintenance;
--> statement-breakpoint
GRANT UPDATE (uploaded_at, verified_at) ON audit.archive_segment TO maintenance;
--> statement-breakpoint
REVOKE DELETE ON audit.event FROM maintenance;
--> statement-breakpoint
CREATE FUNCTION audit.refuse_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'audit.event is append-only: % refused', TG_OP USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.refuse_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER event_refuse_update BEFORE UPDATE ON audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
--> statement-breakpoint
CREATE TRIGGER event_refuse_truncate BEFORE TRUNCATE ON audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
--> statement-breakpoint
-- Retention (FR-1.81, Doc 06 §12): deletes the rows of whole `app` intervals
-- that ended before p_before (at least 365 days ago), only where every
-- segment of the interval is verified and the rows present are exactly the
-- rows the segments hold. A row committed into such an interval since the
-- count makes the delete larger than the count, and the whole call rolls
-- back. Writes system.audit_purge in the same transaction, also when nothing
-- was purged. One call at a time, and never beside an archive run (the same
-- advisory key).
CREATE FUNCTION audit.purge_archived(p_before timestamptz)
  RETURNS TABLE (purged_rows bigint, purged_intervals integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  candidate record;
  present bigint;
  deleted bigint;
  total bigint := 0;
  intervals integer := 0;
BEGIN
  IF p_before IS NULL OR p_before > now() - interval '365 days' THEN
    RAISE EXCEPTION 'purge_archived: before must be at least 365 days ago' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('mykey.audit_archive'));
  FOR candidate IN
    SELECT s.from_at, s.to_at, sum(s.row_count) AS archived
      FROM audit.archive_segment s
     WHERE s.stream = 'app' AND s.purged_at IS NULL AND s.to_at <= p_before
     GROUP BY s.from_at, s.to_at
    HAVING bool_and(s.verified_at IS NOT NULL)
     ORDER BY s.from_at
  LOOP
    SELECT count(*) INTO present
      FROM audit.event e
     WHERE e.occurred_at >= candidate.from_at AND e.occurred_at < candidate.to_at;
    CONTINUE WHEN present <> candidate.archived;
    DELETE FROM audit.event e
     WHERE e.occurred_at >= candidate.from_at AND e.occurred_at < candidate.to_at;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    IF deleted <> present THEN
      RAISE EXCEPTION 'purge_archived: the interval from % changed during the purge', candidate.from_at
        USING ERRCODE = '40001';
    END IF;
    UPDATE audit.archive_segment s SET purged_at = now()
     WHERE s.stream = 'app' AND s.from_at = candidate.from_at AND s.to_at = candidate.to_at;
    total := total + deleted;
    intervals := intervals + 1;
  END LOOP;
  INSERT INTO audit.event (id, actor_kind, actor_id, source_category, organization_id, action,
                           target_kind, target_id, outcome, request_id, operation_id, details)
  VALUES (gen_random_uuid(), 'system', NULL, 'system', NULL, 'system.audit_purge',
          NULL, NULL, 'success', NULL, NULL,
          jsonb_build_object('rows', total, 'intervals', intervals));
  RETURN QUERY SELECT total, intervals;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.purge_archived(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit.purge_archived(timestamptz) TO maintenance;
