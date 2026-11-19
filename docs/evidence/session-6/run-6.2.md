# Run 6.2 — Ops image, audit archive and 365-day retention

**Result: DONE on 16 Nov 2026.** Decisions: D-47 (operator jobs on the host), D-48 (the audit archive).

## What was done

- **The ops image (Task A, D-47).** `apps/ops/Dockerfile` and `apps/ops/src/main.ts` run one operator command per container.
  - The table `infra/hosts/ops-jobs.json` names, per job: the command, the database role, the secret files, the writable directories, the plain settings, and the unit and schedule.
  - `infra/hosts/ops-run.sh` is rendered from the table (`node scripts/ops-jobs.ts`).
  - `host.ts <host> ops-secrets` installs the `maintenance` and `backup_reader` passwords and records `MYKEY_HOST_NAME`.
  - `ci-scan` scans the image.
- **Segments, verification, purge (Task B, D-48):**
  - **Migration `0016`:** `audit.archive_segment`; `audit.purge_archived()`; `maintenance` loses `DELETE` on `audit.event`; triggers refuse `UPDATE` and `TRUNCATE` for every role.
  - **`ops audit-archive`:** it builds the chain and handles pending segments, late rows, closed days and rotated files, then runs retention.
  - **`@mykey/backup`:** it now holds the R2 helpers, with an `ObjectStore` over R2 or a local directory.
  - **Lock rules** of `mykey-audit-archive`: `prod/` 365 d, `staging/` 30 d, `probe/` 600 s.
- **OpenBao's file and the job on staging (Task C):**
  - `infra/hosts/checks/bao-audit-rotate.sh` rotates the file;
  - the timers are `mykey-bao-audit-rotate` (01:15 UTC) and `mykey-audit-archive` (01:30 UTC);
  - `host.ts <host> r2-install audit-archive` and `host.ts <host> timers` install them;
  - staging was deployed at `d13dc5749854` (API, provisioner and ops images; migrations `0015` and `0016`).
- **The journey of Run 6.1** now runs the archive: `system.audit_archive` and `system.audit_purge` left `PENDING_WRITERS`, which holds 10 actions.

## Commits

- `9a3fd70` feat(ops): an image and a wrapper for jobs on the host
- `37d7098` feat(ops): audit segments, verified off-host, purged only then
- `d13dc57` feat(hosts): rotate and archive OpenBao's audit file
- this note, D-48, the runbooks and the journey's archive step

## Commands and results

- **P-131 search:** `DELETE FROM audit.event`, `UPDATE audit.event` and `TRUNCATE audit` in `apps/` and `packages/` give **none**. The direct `DELETE` right of `maintenance` was unused before `0016` took it.
- **Unit:**
  - `pnpm exec vitest run --project unit`: 994 passed (after Task B);
  - `tests/unit/hosts`: 179 passed after Task C (`ops-jobs.test.ts` 9, `units.test.ts` 5).
- **Integration:**
  - `tests/integration/archive`: `segments` 5/5, `purge` 7/7, `rotation` 2/2;
  - `tests/integration/database`: 131/131, with the matrix now checking schema `audit`'s functions;
  - `tests/integration/audit/journey.test.ts`: 6/6.
- **Cloud:** `pnpm exec vitest run --project cloud tests/restore/retention/segment.cloud.test.ts` passes 4/4. On R2:
  - a body that does not match its `ChecksumSHA256` answers **400**;
  - an overwrite of a segment under `probe/` within its lock answers **409 `ObjectLockedByBucketPolicy`**;
  - a list returns the manifest and the segment.
- **Lock rules:** `node infra/backup/retention-fixture/provision.ts --account <id> --locks-only` sets `mykey-audit-archive` with 3 rules; the other buckets are unchanged. The rules read back are in `docs/evidence/session-1/retention-fixture.json`.
- **Images:** `node scripts/ci-scan.ts images` is green with the ops image (Trivy: 0 findings in its language packages).
- **Staging, Task A:** `host.ts staging image ops`, `push` and `ops-secrets` ran. On the host, `ops-run.sh status-check -- operations --organization e2350312-…` printed `none`, the same as `host.ts staging ops operations --organization e2350312-…` through the tunnel.
- **Staging deploy:** `push`, `image api|provisioner|ops`, `db-init` (applied `0015_audit_view.sql`, `0016_audit_archive.sql`), `up`, `r2-install audit-archive`, `timers`. Afterwards: gate open, unsealed (KMIP, KMS reachable), `reviewOpen: 0`, `operationsUnresolved: 0`, provisioner healthy.
- **`pnpm exec vitest run --project staging tests/staging/audit.staging.test.ts`:** 5/5 in 140 s. The test project is `s6-audit-…` (projects cannot be deleted).
- **First rotation and archive on staging, by hand through the units:**

  | Step                             | Duration | Result                                                                                 |
  | -------------------------------- | -------- | -------------------------------------------------------------------------------------- |
  | `mykey-bao-audit-rotate.service` | 35 s     | `audit-20261116T170941Z.log`, **1,867,111,323 bytes** (the plan expected about 500 MB) |
  | `mykey-audit-archive.service`    | 57 s     | `segments 5 late 0 rotated 1 purged 0`                                                 |

  The segments, all verified, chained, and present in R2 under `staging/`:

  | Seq | Stream  | Interval                    | Rows            | Compressed bytes |
  | --- | ------- | --------------------------- | --------------- | ---------------- |
  | 1   | app     | 12 Nov                      | 388             | 24,052           |
  | 2   | app     | 13 Nov                      | 974             | 61,583           |
  | 3   | app     | 14 Nov                      | 11,675          | 580,065          |
  | 4   | app     | 15 Nov                      | 885             | 59,402           |
  | 5   | openbao | 12 Nov 09:55 – 16 Nov 17:09 | 1,070,491 lines | 77,030,843       |

  The canary written by the test was in no segment written since the test started. The control (the test project's id) was in the OpenBao segment.

- `pnpm run check` is green.

### Registry

FR-1.81 SPIKE_PASS — the audit trail is retained 365 days and archived off-host before any deletion. Closed UTC days and rotated OpenBao files become chained segments in R2; each is read back and compared before `verified_at`, and rows committed late are archived once in a supplementary segment. Rows leave only through `audit.purge_archived()`: whole verified, fully counted days at least 365 days old, with a `system.audit_purge` row. Nobody deletes, updates or truncates directly. Proven locally and on staging (`tests/integration/archive/*`, `tests/restore/retention/segment.cloud.test.ts`, `tests/staging/audit.staging.test.ts`).

FR-1.57 stays `OPEN` until the alert of Run 6.4.

## Deviations and decisions

- **`ops-run.sh` is rendered from the table**, not read with `jq` on the host. The workstation and CI have no `jq`, and the rendered script is tested dry anywhere, showing every mount.
- **A job's host secrets are one level deep** (`/etc/mykey/secrets/r2-audit-archive/<file>`, not `r2/audit-archive/`). `secretInstallCommand` allows `<service>/<name>` only.
- **`archive_segment` has two more columns than the plan:** `source` (the rotated file's name) and `purged_at`. Without them the table cannot say which file a segment holds or which interval was purged.
- **There is one chain per host over both streams.** The table's primary key `sequence` allows nothing else.
- **The purge removes whole `app` days** that ended at least 365 days ago. The function itself enforces the 365 days. It writes `system.audit_purge` itself, also with 0 rows, in the same transaction as the delete.
- **The order is record, put, read back, verify** (not put first). A put-first crash would leave an object whose sequence the database does not know, and the lock refuses its overwrite.
- **The rotation works through `docker exec` and `docker cp`**, so the same script runs on a host and against the local test stack with no path of the volume. It renames inside the volume (OpenBao keeps the inode) and copies out only after the reopen is proven.
- **The Cloudflare bootstrap token is revoked** (HTTP 401). The lock rules were set with the account-wide R2 token `mykey-r2-admin` through a new `provision.ts --locks-only`; no token administration was needed.
- **`units.test.ts` was written in Task C**, with the units it checks.
- **`system.audit_archive` and `system.audit_purge` left `PENDING_WRITERS`.** The journey runs the archive over a local store, with one row two days old so that a closed day exists.

## Open issues

- **Disk during a rotation:** the file exists twice until the copy is checked (1.87 GB on the first run). Daily files are far smaller now, but Run 6.3's capacity thresholds must count the rotated directory, and Run 6.4 should alert on a rotated file older than a day.
- **A restore (Run 6.7)** brings back a chain that ends earlier than the bucket. Sequence numbers will repeat under new object keys, and the restore's run note must say so.
- **Production** has no ops image, timers or R2 credentials yet (Run 6.9 deploys them).
- **Dated items:** the KMS certificates expire on 12 Dec 2026; `.trivyignore.images` expires on 14 Dec 2026; `test:cloud`'s fixture guard is red until Run 6.6.
