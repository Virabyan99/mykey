-- Run 5.3 (P-91, P-92, D-41). Hand-written.
--
-- Archive and reactivation move a project's or an environment's state through
-- one function with a closed transition table, so the API needs no write of
-- its own on the state and archive columns. Each step is one guarded update
-- (a concurrent caller sees false); none ever moves a row out of needs_review.
--
--   begin_archive   active → revoking, with the operation (an environment's
--                   origin `self`, or `project` when its project is revoking
--                   under the same operation)
--   finish_archive  revoking → archived, same operation, and no credential of
--                   the scope outside `revoked`; a project also moves its
--                   environments revoking under that operation
--   reactivate      archived → active, origin and operation cleared; an
--                   environment needs origin `self` and its project active; a
--                   project also moves its environments archived with origin
--                   `project` under its own archive operation
--
-- SECURITY DEFINER with a fixed search_path, owned by migration_owner; only
-- api_runtime may execute it. api_runtime loses its UPDATE on the columns the
-- function writes (granted by 0001).
CREATE FUNCTION app.lifecycle_transition(
  p_kind text,
  p_organization_id uuid,
  p_id uuid,
  p_operation_id uuid,
  p_step text,
  p_origin text DEFAULT NULL
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  moved integer;
  archive_op uuid;
BEGIN
  IF p_kind NOT IN ('project', 'environment') THEN
    RAISE EXCEPTION 'lifecycle_transition: unknown kind %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_step NOT IN ('begin_archive', 'finish_archive', 'reactivate') THEN
    RAISE EXCEPTION 'lifecycle_transition: unknown step %', p_step USING ERRCODE = '22023';
  END IF;
  IF p_origin IS NOT NULL AND p_origin NOT IN ('self', 'project') THEN
    RAISE EXCEPTION 'lifecycle_transition: unknown origin %', p_origin USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'project' AND p_step = 'begin_archive' THEN
    UPDATE app.project SET state = 'revoking', archive_operation_id = p_operation_id
     WHERE organization_id = p_organization_id AND id = p_id AND state = 'active';
    GET DIAGNOSTICS moved = ROW_COUNT;

  ELSIF p_kind = 'environment' AND p_step = 'begin_archive' THEN
    UPDATE app.environment e
       SET state = 'revoking', archive_origin = coalesce(p_origin, 'self'),
           archive_operation_id = p_operation_id
     WHERE e.organization_id = p_organization_id AND e.id = p_id AND e.state = 'active'
       AND (coalesce(p_origin, 'self') = 'self'
            OR EXISTS (SELECT 1 FROM app.project p
                        WHERE p.organization_id = e.organization_id AND p.id = e.project_id
                          AND p.state = 'revoking' AND p.archive_operation_id = p_operation_id));
    GET DIAGNOSTICS moved = ROW_COUNT;

  ELSIF p_kind = 'project' AND p_step = 'finish_archive' THEN
    UPDATE app.project p SET state = 'archived'
     WHERE p.organization_id = p_organization_id AND p.id = p_id AND p.state = 'revoking'
       AND p.archive_operation_id = p_operation_id
       AND NOT EXISTS (SELECT 1 FROM app.machine_credential c
                        WHERE c.organization_id = p.organization_id AND c.project_id = p.id
                          AND c.state <> 'revoked');
    GET DIAGNOSTICS moved = ROW_COUNT;
    IF moved = 1 THEN
      UPDATE app.environment SET state = 'archived'
       WHERE organization_id = p_organization_id AND project_id = p_id AND state = 'revoking'
         AND archive_operation_id = p_operation_id;
    END IF;

  ELSIF p_kind = 'environment' AND p_step = 'finish_archive' THEN
    UPDATE app.environment e SET state = 'archived'
     WHERE e.organization_id = p_organization_id AND e.id = p_id AND e.state = 'revoking'
       AND e.archive_operation_id = p_operation_id
       AND NOT EXISTS (SELECT 1 FROM app.machine_credential c
                        WHERE c.organization_id = e.organization_id AND c.environment_id = e.id
                          AND c.state <> 'revoked');
    GET DIAGNOSTICS moved = ROW_COUNT;

  ELSIF p_kind = 'project' AND p_step = 'reactivate' THEN
    SELECT archive_operation_id INTO archive_op FROM app.project
     WHERE organization_id = p_organization_id AND id = p_id AND state = 'archived'
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    UPDATE app.project SET state = 'active', archive_operation_id = NULL
     WHERE organization_id = p_organization_id AND id = p_id AND state = 'archived';
    GET DIAGNOSTICS moved = ROW_COUNT;
    UPDATE app.environment SET state = 'active', archive_origin = NULL, archive_operation_id = NULL
     WHERE organization_id = p_organization_id AND project_id = p_id AND state = 'archived'
       AND archive_origin = 'project' AND archive_operation_id IS NOT DISTINCT FROM archive_op;

  ELSE -- environment, reactivate
    UPDATE app.environment e SET state = 'active', archive_origin = NULL, archive_operation_id = NULL
     WHERE e.organization_id = p_organization_id AND e.id = p_id AND e.state = 'archived'
       AND e.archive_origin = 'self'
       AND EXISTS (SELECT 1 FROM app.project p
                    WHERE p.organization_id = e.organization_id AND p.id = e.project_id
                      AND p.state = 'active');
    GET DIAGNOSTICS moved = ROW_COUNT;
  END IF;

  RETURN moved = 1;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lifecycle_transition(text, uuid, uuid, uuid, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lifecycle_transition(text, uuid, uuid, uuid, text, text) TO api_runtime;--> statement-breakpoint
REVOKE UPDATE (state, archive_operation_id) ON app.project FROM api_runtime;--> statement-breakpoint
REVOKE UPDATE (state, archive_origin, archive_operation_id) ON app.environment FROM api_runtime;
