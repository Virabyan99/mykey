-- Unresolved secret operations (Run 4.5, P-75; Run 6.4, M-3): uncertain and not
-- closed, or accepted/executing with a heartbeat older than 120 s — what
-- `ops operations` lists. A provisioning operation waits in the job queue,
-- which retries for 600 s: it counts only once it is older than that.
-- Run by status.sh through the PostgreSQL container's socket, and by
-- tests/integration/health/unresolved.test.ts against a fixture database.
BEGIN READ ONLY;
SELECT count(*)
FROM app.operation
WHERE (state = 'uncertain' AND completed_at IS NULL)
   OR (state IN ('accepted', 'executing')
       AND action NOT IN ('environment.provision', 'organization.provision')
       AND heartbeat_at < now() - interval '120 seconds')
   OR (state IN ('accepted', 'executing')
       AND action IN ('environment.provision', 'organization.provision')
       AND created_at < now() - interval '600 seconds'
       AND coalesce(heartbeat_at, created_at) < now() - interval '120 seconds');
COMMIT;
