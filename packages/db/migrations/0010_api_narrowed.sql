-- Session 3 gate review (Run 3.10). Hand-written.
--
-- The API keeps no right to what only the operator or the provisioner
-- decides: an environment's readiness and policy digest, an organization's
-- configuration digest and provisioning operation, any review reason, and
-- the creation of organizations and memberships (operator only, D-27). A
-- compromised API process could otherwise mark an unprovisioned environment
-- ready or clear a drift review. Archive and reactivate (Run 5.3) grant what
-- they need with their own migration.
REVOKE UPDATE (kv_ready, policy_digest, review_reason) ON app.environment FROM api_runtime;--> statement-breakpoint
REVOKE UPDATE (config_digest, provisioning_operation_id, review_reason) ON app.organization FROM api_runtime;--> statement-breakpoint
REVOKE UPDATE (review_reason) ON app.project FROM api_runtime;--> statement-breakpoint
REVOKE INSERT ON app.organization, app.membership FROM api_runtime;
