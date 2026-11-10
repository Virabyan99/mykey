-- The five database roles. Run by a superuser; safe to run again.
--
-- Roles belong to the whole PostgreSQL server, not to one database, so a
-- per-database dump does not carry them (docs/runbooks/db-globals-inventory.md).
-- This file sets no password: applyRoles() sets each one separately, as a
-- SCRAM verifier, so a plain password never reaches the server or its log.
DO $roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'migration_owner',
    'api_runtime',
    'provisioner_runtime',
    'backup_reader',
    'maintenance'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I', role_name);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION',
      role_name
    );
  END LOOP;
END
$roles$;
