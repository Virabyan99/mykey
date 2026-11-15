# D-41 — Archive and reactivate

**Date:** 2026-11-15

**Status:** DECIDED in the Session 5 plan (P-91, P-92), recorded by the executing agent in Run 5.3. Evidence: `tests/integration/lifecycle/{transitions,archive,reactivate}.test.ts`, `tests/fault/credentials/archive.test.ts`, `tests/integration/database/privileges.test.ts`, `docs/evidence/session-5/{run-5.3,fault-table}.md`. The staging proof is Run 5.4's `tests/staging/archive.staging.test.ts`.

## One guarded function for every transition

- Migration `0014` adds `app.lifecycle_transition(kind, organization_id, id, operation_id, step, origin)`. It is SECURITY DEFINER with `search_path = pg_catalog, pg_temp`, and only `api_runtime` may execute it. `api_runtime` lost `UPDATE` on `project.state`, `project.archive_operation_id`, `environment.state`, `environment.archive_origin` and `environment.archive_operation_id`, so this function is the only way it can move those columns.
- Steps:
  - `begin_archive`: `active → revoking`. An environment with origin `project` needs its project `revoking` under the same operation.
  - `finish_archive`: `revoking → archived` under this operation. No credential of the scope may be in any state other than `revoked`. For a project it also moves the environments that are `revoking` under this operation.
  - `reactivate`: `archived → active`, clearing origin and operation. An environment needs origin `self` and its project `active`. A project also brings back the environments archived with origin `project` under its own archive operation.
- Each guard is one statement, so a concurrent caller sees `false`. An unknown kind, step or origin raises `22023`.

## Archive

- **Admission is one transaction.** It inserts the operation as `executing`. It needs capture idle, the gate open, and the caller's authority re-read. It locks the rows in the order every admission uses: organization (share), project, environment, the target FOR UPDATE. The target must be `active`; a target already `revoking` answers `409 state_conflict` with its operation id. No environment of the scope may be `pending`, and no effect slot may be held. Then `begin_archive` runs for the target and for each active environment of a project (origin `project`). Every `active` or `expired` credential of the scope becomes `revoking`, and an `intent` audit row is written.
- Admission takes **no advisory lock**. The environment row's lock serializes it with an issuance's finalize, which re-reads the environment and withdraws.
- **The drive (`driveArchive`)** reads everything from rows and is safe to run again and from two processes at once. For each environment, under its advisory lock (busy → later):
  - any credential that became active meanwhile becomes `revoking`;
  - one issuer session revokes each `revoking` credential, then verifies it by a lookup that answers 400;
  - a credential that is not proven gone stays `revoking`.
    When no credential of the scope is outside `revoked`, one transaction runs `finish_archive`, sets the operation `succeeded` with `{state: "archived", environments, credentialsRevoked}`, and writes the `success` audit row.
- The request drives as far as it can: **200** when it finished, **202** with the envelope otherwise. Whatever stops it leaves the operation `executing` and leaves the heartbeat alone. The API's 30 s tick (`continueArchives`) drives every archive whose heartbeat is older than the stuck-alert time. Until the archive finishes, `operations_unresolved` stays up. An archive operation is never `uncertain`: every backend change is an idempotent revocation verified by absence.
- A credential in `needs_review` blocks the end, not the closing. `reconcile-credentials` settles it; the next tick then finishes the archive.
- The machine policy, the token role and the stored values stay in OpenBao. Humans keep their reads (AC-1.11): reveal and the complete read are admitted on a `revoking` or `archived` environment. Every change and every issuance answers `409 state_conflict`.

## Reactivate

- **Reads, then one transaction. No marker.** Nothing is sent that changes OpenBao. The issuer session's own login and `revoke-self` are the only writes, and they touch only that session's token.
- **Verification**, for each environment it brings back (the target, or the project's children archived with it):
  - the machine policy and token role exist, and `policyDigest(policy, role)` equals `environment.policy_digest` (issuer session);
  - the names OpenBao lists equal the index's names, and no index row is in `needs_review` (runtime identity);
  - every credential is `revoked`, and each stored accessor answers 400.
- The transaction inserts the operation and finishes it before commit, so no `executing` reactivation is ever visible. A crash leaves nothing, and the same key verifies again. It re-locks the rows in admission order, re-reads authority, and requires the states and the archive operation it verified. Then it calls `reactivate`, sets `succeeded` with `{state: "active", environments}`, and writes the audit row.
- **A failed verification changes nothing.** The operation is recorded `rejected` with an audit `failure` row, and the resource stays `archived`. A definite mismatch, absence or refusal answers `503 backend_inconsistent`. An answer that says nothing (unknown, sealed, no credential in this process) answers `503 dependency_unavailable`.
- **Reactivation never creates, renews or re-activates a credential.** An old token stays dead, and new access needs a new issuance.

## Why

- Archiving is a revocation of every token of the scope. It is said only when every revocation is proven, so "archived" can be relied on.
- Reads-only reactivation means it cannot leave the backend half-changed. If it finds drift, the operator reconciles first.
- The lock order matters. The first fault run deadlocked: archive locked the project and then the organization, while a create updates the organization and then the project. Both lifecycle admissions now lock in the common order.
