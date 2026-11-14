-- Run 4.2 (P-72, D-36). Hand-written.
--
-- The API sends an environment to review when OpenBao refuses its runtime
-- identity or disagrees with the index. Migration 0010 took review_reason from
-- the API on purpose, so this one narrow function does exactly that and
-- nothing else: pending or active becomes needs_review with the reason
-- backend_inconsistent. It never clears a review (the operator does,
-- `ops reconcile-environment`). SECURITY DEFINER with a fixed search_path,
-- owned by migration_owner; only api_runtime may execute it.
CREATE FUNCTION app.mark_environment_review(p_organization_id uuid, p_environment_id uuid)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE app.environment
     SET state = 'needs_review', review_reason = 'backend_inconsistent'
   WHERE organization_id = p_organization_id
     AND id = p_environment_id
     AND state IN ('pending', 'active');
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.mark_environment_review(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.mark_environment_review(uuid, uuid) TO api_runtime;
