-- Privileges for the four runtime roles, and the single service_control row.
-- Hand-written. Run by migration_owner, which owns the database, the schemas
-- and every object. The roles themselves come from packages/db/roles/roles.sql.
--
-- Rule: a role gets a right only when a line below grants it. Nothing is
-- granted to PUBLIC, on any object.

-- ------------------------------------------------------------------ PUBLIC
DO $database$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO api_runtime, provisioner_runtime, backup_reader, maintenance',
    current_database()
  );
END
$database$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- PostgreSQL lets everyone execute a new function unless this default is removed.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ------------------------------------------------------- the single state row
INSERT INTO app.service_control (id) VALUES (true);

-- -------------------------------------------------------------- api_runtime
GRANT USAGE ON SCHEMA app, audit, auth TO api_runtime;

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA app TO api_runtime;
GRANT USAGE ON SEQUENCE app.environment_lock_key_seq TO api_runtime;

-- UPDATE is granted column by column. Never updatable: primary-key columns,
-- id, organization_id, project_id, environment_id, namespace, lock_key,
-- created_at, and the five columns of an operation's idempotency key.
GRANT UPDATE (state, config_digest, provisioning_operation_id)
  ON app.organization TO api_runtime;
GRANT UPDATE (user_id, role, state)
  ON app.membership TO api_runtime;
GRANT UPDATE (name, state, archive_operation_id)
  ON app.project TO api_runtime;
GRANT UPDATE (name, state, kv_ready, policy_digest, metadata_generation, live_value_bytes,
              archive_origin, archive_operation_id)
  ON app.environment TO api_runtime;
GRANT UPDATE (user_id, role)
  ON app.access_grant TO api_runtime;
GRANT UPDATE (current_version, state_tag, state, live_value_bytes, last_changed_at,
              last_operation_id)
  ON app.secret_index TO api_runtime;
GRANT UPDATE (name, version, operation_id, actor_kind, actor_id, action, occurred_at)
  ON app.secret_version_event TO api_runtime;
GRANT UPDATE (name, issuance_operation_id, accessor, requested_expires_at, effective_expires_at,
              state, issued_by, last_used_at)
  ON app.machine_credential TO api_runtime;
GRANT UPDATE (fingerprint, fingerprint_key_id, expected, state, executor_boot_id, dispatched_at,
              heartbeat_at, result, error_code, replay_expires_at, audit_event_id, completed_at)
  ON app.operation TO api_runtime;
GRANT UPDATE (expired_at)
  ON app.operation_tombstone TO api_runtime;
GRANT UPDATE (operation_id, ordinal, target, before_state, dispatch_attempt_id, outcome,
              backend_ref)
  ON app.operation_step TO api_runtime;
GRANT UPDATE (operation_id, step_id, generation, acquired_at)
  ON app.effect_slot TO api_runtime;
GRANT UPDATE (operation_id, job_kind, state, delivered_at)
  ON app.outbox TO api_runtime;
GRANT UPDATE (owner_user_id, file_hmac, hmac_key_id, expires_at, entries,
              claimed_by_operation_id)
  ON app.import_preview TO api_runtime;
GRANT UPDATE (parent_operation_id, ordinal, name, classification, expected_version,
              expected_state_tag, child_operation_id, outcome)
  ON app.import_entry TO api_runtime;
GRANT UPDATE (capture_mode, epoch, owner, pair_id, updated_at)
  ON app.service_control TO api_runtime;
GRANT UPDATE (capture_started_at, boundary, artifact_hashes, schema_revision, release_commit,
              key_refs, validation_status, eligible_until)
  ON app.backup_pair TO api_runtime;
GRANT UPDATE (count)
  ON app.rate_limit TO api_runtime;

GRANT DELETE ON app.effect_slot, app.import_preview, app.rate_limit TO api_runtime;

-- The audit log is append-only for the API: no UPDATE, DELETE or TRUNCATE.
GRANT SELECT, INSERT ON audit.event TO api_runtime;

-- Session-library tables arrive in schema auth in a later migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO api_runtime;

-- ------------------------------------------------------ provisioner_runtime
GRANT USAGE ON SCHEMA app, audit TO provisioner_runtime;

GRANT SELECT ON app.organization, app.project, app.environment TO provisioner_runtime;
GRANT UPDATE (state, config_digest, provisioning_operation_id)
  ON app.organization TO provisioner_runtime;
GRANT UPDATE (state, kv_ready, policy_digest)
  ON app.environment TO provisioner_runtime;
GRANT SELECT, INSERT, UPDATE ON app.operation, app.operation_step, app.outbox
  TO provisioner_runtime;
GRANT SELECT, INSERT, DELETE ON app.effect_slot TO provisioner_runtime;

-- The provisioner writes audit events and cannot read them.
GRANT INSERT ON audit.event TO provisioner_runtime;

-- ------------------------------------------------------------ backup_reader
-- Read everything, write nothing.
GRANT USAGE ON SCHEMA app, audit, auth, jobs, meta TO backup_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA app, audit, auth, jobs, meta TO backup_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA app, audit, auth, jobs, meta TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA app, audit, auth, jobs, meta
  GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA app, audit, auth, jobs, meta
  GRANT SELECT ON SEQUENCES TO backup_reader;

-- -------------------------------------------------------------- maintenance
-- For an operator during planned maintenance. Data changes only, no DDL.
GRANT USAGE ON SCHEMA app, audit, auth, jobs, meta TO maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO maintenance;
GRANT USAGE ON SEQUENCE app.environment_lock_key_seq TO maintenance;
GRANT SELECT, DELETE ON audit.event TO maintenance;
GRANT SELECT ON meta.schema_migration TO maintenance;
