# D-55 — A restore invalidates by class and stays closed until a report says open

**Date:** 2026-11-18

**Status:** DECIDED in Run 6.7 (P-124; Doc 06 §14, nine steps; FR-1.67–1.69, FR-1.86, FR-1.87; D-18; D-54). Proven locally; the host path is first run whole by the drill (Run 6.8). Evidence:

- `docs/evidence/session-6/run-6.7.md`;
- `tests/integration/restore/{invalidate,verify,full}.test.ts`, `tests/fault/restore/interrupted.test.ts`, `tests/integration/openbao/admin-restore.test.ts`;
- `tests/unit/backup/{restore,restore-steps}.test.ts`, `tests/unit/hosts/host-restore.test.ts`, `tests/unit/ops/restore-measurements.test.ts`.

## Decision

### The steps

`restoreToVerifying(target)` (`@mykey/ops`) runs steps 1–7 against a `RestoreTarget`: a host over SSH (`scripts/host-restore.ts`) or, in tests, a second local cluster and a fresh scratch OpenBao (`tests/harness/restore-target.ts`). Each step writes a state line; a restore that stops is started again from step 1. Only the "target holds data" refusal is skipped for the same pair.

1. Refuse a target with an open gate or with data.
2. Fetch: `eligible.json` verified against `infra/hosts/backup/trust/`, the bundle's digest, `restic check --read-data`, every artifact's digest. Refuse a pair whose KMS key this host cannot use.
3. PostgreSQL: `globals.sql` compared with the inventory and **never executed** (an unknown role stops the restore with its name); `applyRoles` with **new** passwords; `applyDatabaseAccess`; `pg_restore`.
4. OpenBao: the snapshot on the same seal; the restore mints its own orphan root token (2 h) from the pair's root token. `sys/generate-root` needs the recovery keys of the instance the snapshot came from, so it is not used.
5. Invalidate by class (`restoreInvalidate`):
   - every `auth.session`, `auth.reset_token` and `auth.verification` row deleted; `auth.totp_step_used` kept;
   - every account not `disabled` becomes `recovery_pending` with `auth_epoch + 1`;
   - every `machine_credential` not `revoked` becomes `revoked`;
   - every operation `accepted`, `executing` or `awaiting_input` becomes `uncertain`;
   - in the root and in **every namespace of `LIST sys/namespaces`** (not the catalog's list, D-18), every token accessor but the restore's own is revoked;
   - the secret ids of `runtime`, `issuer`, `provisioner` and `backup` are destroyed and issued anew, delivered where their services read them.
6. The control row `idle` with a new incarnation and `restored_from_pair`, in the same transaction as the deletes; the incarnation copied to each namespace last. Running it again changes nothing.
7. Start closed + `verifying` with a new host instance id.

Then the operator issues the owner's reset (`ops reset-account`), the owner completes it and enrols through the verification listener, and `restore-verify` writes the report (8). `gate open` with that report (9) re-checks, opens, and the restore's root token is revoked.

### What the report checks

`REQUIRED_CHECKS.restore`: the pair's signature and digests, schema revision, OpenBao readable, no session, every account `recovery_pending` unless it was reset after the restore began, no reset token or verification older than the restore, no accessor but the restore's own in any namespace, every credential revoked, AppRole secret ids rotated, root tokens revoked, control row idle, the incarnation equal in three places, no operation executing, the catalog equal to the backend, the members confirmed by the operator (`--confirm-members <count>`), the owner's journey, and the old credentials refused.

### What a restore measures

Capture time, the pair's age at restore, the restore's elapsed time and, with the report, the revalidation time and the result (`restoreMeasurements`, FR-1.69). Measured values, never a target.

## Why

A pair is days old. It holds the session signed out since, a replaced TOTP secret, a used reset link, a revoked machine token, the lost host's AppRole secret ids and a root token. A list of what to invalidate misses what the list forgot; a class does not. Nothing of the old world is trusted until the owner proves a fresh path through a reset, and the gate cannot open while one check is not `ok`.

## Costs

- Every person and every machine needs a new credential after a restore: an owner's reset, new machine tokens (`ops reconcile-credentials` per environment).
- Operations in flight at the capture end `uncertain` and need review.
- On a host the restore's 2 h root token waits on the workstation (`~/.mykey/secrets/hosts/<host>/restore-root-token`, 0600) between `restore` and `restore-verify --open`.
- A restore onto a host reuses its PostgreSQL cluster and drops the product schemas; cluster-level leftovers are covered only by the globals comparison.
