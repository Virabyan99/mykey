# D-25 — Paired backup format (spike)

**Date:** 2026-11-12

**Status:** DECIDED by the executing agent in Run 2.9 for the spike; Session 6 writes the real format. Evidence: `tests/unit/backup/{manifest,host-steps}.test.ts`, `tests/integration/backup/pair-rehearsal.test.ts`, `tests/integration/database/access.test.ts`, `tests/staging/pair.staging.test.ts`, `docs/evidence/session-2/{pair-staging.txt,pair-spike.json,run-2.9.md}`.

## Decision

- **One pair = three artifacts taken at one boundary**: `postgres.dump` (`pg_dump --format=custom` as `backup_reader`), `globals.sql` (`pg_dumpall --globals-only --no-role-passwords` as the superuser), `openbao.snap` (`GET /v1/sys/storage/raft/snapshot` with a 600 s token of the root-namespace AppRole `backup`, policy `backup` only). Both dumps run from the pinned PostgreSQL image on `mk-db` with `sslmode=verify-full`.
- **Manifest `mykey-pair-spike/1`** (`infra/backup/pair-spike/manifest.ts`): pair id, capture start and end, the freeze epoch, the release commit, the last migration and its checksum, the image versions, the seal (`kmip` and the key id), the namespaces, the boundary (last operation id, zero executing operations, zero held slots — `buildManifest` refuses anything else), each artifact's SHA-256 and size, the checksum of `roles.sql`. `verifyDigests` rejects a changed, missing or extra artifact before anything is restored. The manifest holds no value, token or password (checked).
- **The freeze** (P-36, `freeze.ts`), as `maintenance`, one transaction: lock `service_control`, refuse unless `idle`, set `draining`, epoch + 1, the pair id; then wait (≤ 30 s) until no effect slot and no `accepted`/`executing` operation; an `uncertain` operation makes the pair impossible; then `capturing`. The executor refuses to admit while the mode is not `idle` (`busy`, HTTP 503). The pair row is written `candidate` right after the freeze (R72), the artifacts and the manifest under it, then the release — **before** encryption and upload.
- **Measured freeze: 40 s** on staging (drain 7 s, dumps 6 s, snapshot 2.4 s, the rest manifest, row updates and the test's row count over the SSH tunnel). Every write that both began and ended inside it was refused `busy`; writes succeed again within a second of the release.
- **Sealing**: a new Restic 0.19.1 repository per pair inside a root-only tmpfs `/run/mykey-pair/<pairId>/`, password = 32 random bytes made on the workstation, kept at `~/.mykey/custody/staging/pair-<pairId>.key` and on the host only in the tmpfs (R63); `restic check --read-data`, then one `repo.tar`. Upload with `curl --aws-sigv4` from the host through the egress set `r2` (it reaches R2 directly), the credential in a root-only curl configuration inside the tmpfs: `pairs/<pairId>/repo.tar` and `pairs/<pairId>/manifest.json`. The bundle holds none of the 40 canaries.
- **Restore, from the bucket only**: download both objects, `restic restore`, `verifyDigests`; then
  - PostgreSQL into a **new cluster** (container on `mk-db` at 10.78.2.5, the host's server certificate, R64): `applyRoles` with the source's role passwords, `applyDatabaseAccess`, `pg_restore --exit-on-error` with owners kept;
  - OpenBao into a **new instance on the same seal key** (`host-kms-spike.compose.yml` on `mk-kms`): init, then `POST sys/storage/raft/snapshot` with its own root token — **the plain restore was accepted (HTTP 204)**; `snapshot-force` was not needed. Afterwards the source's tokens, policies, token roles and namespaces apply.
- **Eligibility**: a pair becomes `eligible` only after its own restore passed every check (row counts at the boundary, migrations, privilege matrix, globals, `api_runtime` over TLS; all 40 secrets with the source runtime identity, every envelope's operation in the restored database, policies, token roles, namespaces, a machine token from before the capture works and one from after does not exist; `secret_index` equals the KV metadata). Anything else leaves it `candidate` or sets `ineligible`. Nothing here is a backup of real data.

## Measured

`pair-spike.json`: `postgres.dump` 145,471 bytes, `globals.sql` 1,204, `openbao.snap` 158,755, `repo.tar` 317,440. Capture: freeze 7.1 s (drain), dump 6.2, snapshot 2.4, Restic 13.6, upload 5.7. Restore: download 5.5, Restic 5.7, PostgreSQL 21.1, OpenBao 24.2 seconds.

## Bad paths (all held)

| Case                               | Observed                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| An unresolved effect               | capture refused at `drain` (still running at the deadline), mode back to `idle`, no eligible row; after `reconcile` the next capture worked |
| A capture that dies after the dump | mode stays `capturing`, writes refused `busy`, pair `candidate`; only `abortCapture` returns to `idle` and sets it `ineligible`             |
| A swapped manifest                 | refused before anything was restored                                                                                                        |
| A role missing from `roles.sql`    | restore refused: `role "backup_reader" does not exist`                                                                                      |
| `applyDatabaseAccess` skipped      | the matrix reports `CREATE or TEMP on the database` for every runtime role                                                                  |
| A different seal key (L-C)         | plain restore 400, forced restore accepted, the instance seals itself, the secret unreadable (ties the pair to KMS-L1)                      |

## Findings for Session 6

- **`backup_reader` cannot write the control rows** (`service_control`, `backup_pair`); the spike used `maintenance`. Who owns the freeze and the pair row in the product needs a decision (a dedicated role, or the backup service through the API).
- **The manifest needs a signature**: today anyone who can write to the bucket can replace it; `verifyDigests` only proves the bundle and the manifest agree.
- **The Restic password needs a custody design**: one random password per pair on the operator's workstation does not scale and is lost with the workstation.
- **The plain snapshot restore works into a fresh instance on the same seal key**; `snapshot-force` is the fallback, and on another key it is accepted and then seals the instance: a restore must check readability, not the HTTP status.
- **A 40 s freeze over SSH**; on the host itself (no tunnel) the freeze would be the drain plus about 10 s. The freeze alert (`LIMITS.backup.freezeAlertSeconds`) is Run 6.4.
- The Doc 10 §8.1 fallback (another archive format) was not needed.
