# Run 5.3 — Archive and reactivate

**Result: DONE on 15 Nov 2026.**

- **Archive** of an environment or a project closes the scope first. It then revokes every machine credential and verifies each one, and only then says archived. From `revoking` on, no change, import or issuance is admitted; humans keep their reads (AC-1.11). A drive that cannot finish leaves the operation `executing`, and the API's tick finishes it.
- **Reactivation** reads OpenBao and changes nothing there. It brings back the resource (and a project's own children) only when the machine policy, the token role, the names and every revocation check out. No token comes back.
- **Every transition** goes through one guarded SECURITY DEFINER function (migration `0014`). `api_runtime` lost its direct `UPDATE` on the state columns.
- **Fault table** (AC-1.11): an archive killed at any of its three points is finished by another process's tick. 50 rounds of issuance against archive leave no usable token. 20 rounds of environment create against project archive never leave an environment under an archived project.
- **Found and fixed:** a deadlock between archive admission and environment create (lock order). Details in the fault table and D-41.
- Decisions: D-41.

FR-1.17 SPIKE_PASS — archive: `tests/integration/lifecycle/archive.test.ts` (10), `tests/integration/lifecycle/transitions.test.ts` (12), `tests/fault/credentials/archive.test.ts` (6).
FR-1.18 SPIKE_PASS — reactivate: `tests/integration/lifecycle/reactivate.test.ts` (8).
AC-1.11 SPIKE_PASS — archive racing creation and issuance: `tests/fault/credentials/archive.test.ts` (the two races, three passes in a row), `docs/evidence/session-5/fault-table.md`.
PO-18 SPIKE_PASS — issuance races and coherent archive under interruption: `tests/fault/credentials/archive.test.ts` (the three kill points; the request and the tick at once), with Runs 5.1–5.2's fault table for issuance and revocation.

The staging proof of archive and reactivation is Run 5.4 (P-102: the machine routes and archive deploy together; `tests/staging/archive.staging.test.ts`).

## What was done

- **Migration `0014_resource_lifecycle`**: `app.lifecycle_transition` with the steps `begin_archive`, `finish_archive` and `reactivate` (D-41). It is EXECUTE for `api_runtime` only. The migration revokes `UPDATE (state, archive_operation_id)` on `app.project` and `UPDATE (state, archive_origin, archive_operation_id)` on `app.environment` from `api_runtime`. Recorded in the privilege matrix and `db-globals-inventory.md`.
- **`@mykey/db`** `repos/lifecycle.ts`: `lifecycleTransition`, `archiveScope`, `closeCredentials`, `openCredentialWork`, `finishArchiveOperation`.
- **Contract** (`contract: archive and reactivate`):
  - archive answers 200 with `result: { state, environments, credentialsRevoked }`, or 202;
  - reactivate answers 200 with `result: { state: "active", environments }`.
- **`@mykey/operations`**:
  - `lifecycle/archive.ts`: `beginArchive`, `driveArchive`, `continueArchives`, with fault points `archive_after_marker`, `archive_after_revoke_sent` and `archive_before_finish_commit`;
  - `lifecycle/reactivate.ts`: `reactivate`.
- **`@mykey/openbao`**: `OpenBaoClient.readMachinePolicy` and `readMachineTokenRole`, used by the issuer session to verify a reactivation.
- **API**:
  - `routes/lifecycle.ts`: the archive and reactivate handlers for the four routes;
  - the tick (`operation-sweep.ts`) runs `continueArchives` and logs `archive_continue`;
  - `server.ts` hands it the issuer and the boot id.
- **Harness**:
  - `tests/harness/lifecycle-fixture.ts`;
  - `api-process.ts` gains `archiveTick` (a child that runs `continueArchives`), passed through `startApiProcess` and `restartSecond`.
- **Docs**: D-41; `machine-credentials.md` gains "Archive and reactivate"; the fault table gains its archive section.

## Commits

- `fddc400` feat(db): lifecycle transitions through one guarded function
- `55edbad` contract: archive and reactivate
- `f5f38e5` feat(api): archive closes first, revokes and verifies, then says archived
- `e8c18c6` feat(api): reactivation verifies the backend and revives no token
- this commit: test(fault): archive under interruption and in races

## Commands and results

| Command                                                                        | Result                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `tests/integration/lifecycle/transitions.test.ts` before `0014`                | RED (12 failed)                                                                  |
| the same after                                                                 | 12 passed; `tests/integration/database` 131 passed; `db:check` ok                |
| `tests/integration/lifecycle/archive.test.ts`                                  | 10 passed (written before the code, first run after it; see "TDD" below)         |
| `tests/integration/lifecycle/reactivate.test.ts` before the handler            | RED (8 failed: the routes answered 404)                                          |
| the same after                                                                 | 8 passed                                                                         |
| mutation: a live accessor treated as revoked, and the digest check skipped     | both verification tests failed; reverted                                         |
| `tests/fault/credentials/archive.test.ts`, first run                           | RED: 5 passed, the create race failed (`503 dependency_unavailable`, a deadlock) |
| the same after the lock-order fix                                              | 6 passed, then three passes in a row (129–134 s each), no unhandled error        |
| `tests/integration/lifecycle` + `tests/integration/api/routes-mounted.test.ts` | 42 passed; after the lock-order change `tests/integration/lifecycle` 30 passed   |
| `pnpm run check`                                                               | exit 0                                                                           |

## TDD

- Task B: `archive.test.ts` was written before the code but first ran after it.
  - Mutation 1: ignoring blocking credentials in the drive survived. The guard of `finish_archive` refuses on its own: defence in depth.
  - Mutation 2: treating an unproven revocation as proven also survived at first. Holding every request broke the issuer login. Changed to `relay.dropAfter(login records + 1)`, the mutation then failed the test.
- Task C: RED first (404). Its reach is proven by the two mutations above.
- Task D: the deadlock was the RED. The race offsets were widened after three green passes showed that the plan's 0–30 ms never reached the issuance's finalize (fault table, "Deviation"). The test now asserts that both orders occurred.

## Deviations (rulings in the ledger)

- `api_runtime` still held `UPDATE` on the state columns from `0001`, although the plan says it "still has no" `UPDATE`; `0014` revokes it.
- A project's `reactivate` moves its own children in the same call.
- Archive admission takes no advisory lock: the environment row lock serializes it with an issuance's finalize.
- Humans keep reveal on a `revoking` environment (AC-1.11 over the plan's "a reveal answers its state code").
- Reactivation inserts and finishes its operation in one transaction: no `executing` row is ever visible.
- An unclear backend answer during verification is `503 dependency_unavailable`; a definite mismatch is `backend_inconsistent`.
- "Reads only" allows the issuer session's own login, `revoke-self` and accessor lookups.
- The race offsets of Task D (above).

## What Run 5.4 must know

- Deploy to staging with migration `0014`, and run `tests/staging/archive.staging.test.ts` (Run 5.4 Task C).
- Machine authentication must refuse a token of a `revoking` or `archived` environment before any OpenBao read. The token is revoked anyway, but the catalog refusal comes first.
- `lockParents` before the target row is now the admission order of both lifecycle routes. Any new admission that touches a project or environment row must keep that order: organization, project, environment.
