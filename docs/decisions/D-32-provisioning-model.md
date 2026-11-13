# D-32 — Provisioning: compare, then act; the operator for organizations, the provisioner for environments

**Date:** 2026-11-13

**Status:** DECIDED in the Session 3 plan (P-54 … P-57), recorded by the executing agent in Run 3.8. Evidence: `tests/integration/provisioning/{organization,environment,drift}.test.ts`, `tests/fault/provisioning/boundaries.test.ts`, `tests/integration/openbao/provisioner.test.ts`, `tests/staging/provisioning.staging.test.ts`, `docs/evidence/session-3/run-3.8.md`.

## Decision

- **Organizations are the operator's** (`ops provision-organization`, root token from workstation custody, `@mykey/operations/operator`). One durable operation per organization (principal `operator`, key = the organization id), an advisory lock against a second run, thirteen recorded steps, a read-back with `config_digest` (SHA-256 of the canonical JSON of the KV mount's type and version, `kv/config`'s three fields and the three policy texts), secret-id rotation to exactly one accessor per role, activation in one transaction. `verify-organization` is the read-only half.
- **Compare, then act; never overwrite** (P-55). Every step reads first: equal → `verified`; absent → write and read back → `written`; different → `mismatch`, the run stops, the scope goes to `needs_review` / `backend_inconsistent` and nothing is overwritten; an unclear answer → `unknown`, retried by running again. One exception, by construction: a KV mount with OpenBao's defaults for a new mount (`cas_required` false, `max_versions` 0) is this command's half-done mount and is configured.
- **Environments are the provisioner's** (`apps/provisioner`, `@mykey/operations/provisioner`, `@mykey/openbao/provisioner`): claim with a 60-second stale rule, compare-then-act for the KV scope, the machine policy and the machine token role, one activating transaction. Lost reach → `provisioning_failed`; an unclear answer → the queue retries, and after the last retry → review.
- **The provisioner identity's reach** (D-17 amendment): it also reads the three organization policies, `sys/mounts/kv` and `kv/config`; it writes only machine policies and token roles.
- **Drift sweep** at start and every `MYKEY_SWEEP_SECONDS`: digest comparison per scope; a difference sends only that scope to review with one `system.drift_detected` row; an unreadable OpenBao changes nothing and is counted in the log.
- **Bound addresses** (P-56): every AppRole has `secret_id_bound_cidrs` and `token_bound_cidrs` — runtime and issuer 10.78.3.3/32, provisioner 10.78.3.4/32 on a host.
- **Alert** (P-57): `status.sh` counts scopes in review (`reviewOpen`) and reports the provisioner's health; the heartbeat carries `reviewOpen`; the probe's `review_open` opens on a count above 0 and resolves at 0.
- **The API holds no provisioner or root credential**; at start it logs in once with the runtime credential and logs `selfcheck` (Run 4.2 decides whether it gates `/health`).
- **The queue's supervisor is the provisioner** (migration `0008_provisioner_jobs`): it holds the data rights pg-boss's failure path and supervisor were seen to use (job rows, version, queue, bam, warning, job dependencies, instance), no DDL (queue statistics stay off); the API keeps its narrow rights.

## What would change this decision

- A host serving more than one organization: `clientFor` and the credential layout become per organization.
- Run 4.5's reconciliation command replaces the superuser step of an environment's reconciliation.
- A job lost for 15 minutes after a provisioner crash (pg-boss's default expiry) proving too slow: the queue's `expireInSeconds` is lowered.
