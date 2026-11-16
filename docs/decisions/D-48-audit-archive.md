# D-48 — The audit archive: segments verified off-host, purged only then

**Date:** 2026-11-16

**Status:** DECIDED in Run 6.2 (P-110, P-112, P-131). Evidence:

- `docs/evidence/session-6/run-6.2.md`;
- `tests/integration/archive/{segments,purge,rotation}.test.ts`;
- `tests/restore/retention/segment.cloud.test.ts`;
- `tests/staging/audit.staging.test.ts`.

## Decision

Both audit trails leave the host as **segments** in the R2 bucket `mykey-audit-archive`. A row of `audit.event` leaves PostgreSQL only after its segment was read back from R2 and compared, and only when it is 365 days old (FR-1.81, Doc 06 §12).

- **One chain per host.** `audit.archive_segment` numbers the segments of both streams from 1 without a gap. Each row holds:
  - its interval;
  - its row count;
  - the sha256 of the object, and `previous_sha256`, the sha256 of the segment before;
  - the object key;
  - `uploaded_at`, `verified_at` and `purged_at`;
  - for OpenBao, `source`, the rotated file's name.

  A gap, a repeat or a wrong link stops the job with exit 1 before it writes anything.

- **Stream `app`.** One segment per closed UTC day, cut 15 minutes after the day ended. The body is a gzip of NDJSON, one event per line in `(occurred_at, id)` order, and the manifest is `mykey-audit-segment/1`. Every run first recounts the archived intervals that are not purged. A row committed late into an interval becomes a supplementary segment of the same interval. It holds exactly the ids that no earlier segment holds, read back from those segments' own objects, so a late row is archived once.
- **Stream `openbao`.** `bao-audit-rotate.sh` (01:15 UTC):
  1. renames `audit.log` inside the container;
  2. sends `SIGHUP`;
  3. waits until OpenBao has reopened the path and the old file is still;
  4. checks that its last line is complete;
  5. copies the file out to `/var/lib/mykey/bao-audit/rotated/`, and only then removes it from the volume.

  The archive job makes one segment of each rotated file. It deletes the local file only after `verified_at`.

- **Order of one segment:**
  1. record the row (sha256 known);
  2. put the body, with the SHA-256 checksum header, so R2 refuses a body that differs;
  3. put the manifest;
  4. set `uploaded_at`;
  5. read both back and compare;
  6. set `verified_at`, with one `system.audit_archive` row in the same transaction.

  When a run stops in between, the next run rebuilds the recorded segment from its rows or its file. If the rebuild has the recorded sha256, it uploads what is absent and verifies; otherwise the job stops.

- **Retention.** `audit.purge_archived(before)` is the only way a row leaves `audit.event`:
  - It is `SECURITY DEFINER` and executable by `maintenance` only.
  - It refuses a `before` later than 365 days ago.
  - It deletes whole `app` intervals that ended before `before`, and only where every segment of the interval is verified and the rows present equal the rows archived. A row committed into such an interval during the call makes the delete larger than the count, and the call rolls back.
  - It writes `system.audit_purge` in the same transaction, also when nothing was purged.

  `maintenance` loses its `DELETE`; no released code used it. Statement triggers refuse `UPDATE` and `TRUNCATE` on `audit.event` for every role, the owner and the superuser included.

- **The bucket's lock rules:**
  - `prod/`: 365 days;
  - `staging/`: 30 days (synthetic rows; a year would hold the bucket for nothing);
  - `probe/`: 600 s, for the cloud test.

  They were set with `provision.ts --locks-only` through the account-wide R2 token, because the Cloudflare bootstrap token is revoked. The job's token reaches objects of this one bucket only.

## Alternatives rejected

- **Upload first, record after.** A crash between the two leaves an object under a sequence the database does not know. The next run would reuse the number, and the lock refuses the overwrite (409).
- **Purge by row age, not by interval.** A purge in the middle of a day could remove a row that a later supplementary segment was meant to hold.
- **One file per write on OpenBao's side (`log_raw`, a socket device).** It is more moving parts for the same guarantee. The file device and `SIGHUP` were proven to lose nothing under load (`rotation.test.ts`).

## Consequences

- A failed archive run is a failed unit. Run 6.4 makes that an alert (`audit_failing`).
- Staging's archive runs every night and its objects live 30 days. Production's objects will live a year from its first night in service.
- A restore (Run 6.7) brings back a database whose chain ends earlier than the bucket. The next run continues the chain from the database: sequence numbers repeat in the bucket under new objects, and the run note of the restore says so.
