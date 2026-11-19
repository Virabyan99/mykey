# Cost sheet — R2 backup storage

**Started in Run 1.9 (11 Nov 2026). COST-B1 stays `OPEN`:** the sizes below come from a synthetic fixture, not from a real backup. Every projected figure is marked **estimated**.

## Measured sizes (synthetic fixture)

A fixture pair is one Restic 0.19.1 repository holding two files of 1 MiB random bytes and a three-line SQL file, packed into one `bundle.tar`, plus a `manifest.json`.

| Pair               | `bundle.tar` bytes | `manifest.json` bytes |
| ------------------ | ------------------ | --------------------- |
| `pair-20261111-1`  | 2,238,976          | 241                   |
| `pair-20261111-2`  | 2,239,488          | 241                   |
| `pair-20261111-3`  | 2,240,000          | 241                   |
| `probe-20261111-1` | 2,238,976          | 242                   |
| `probe-20261111-2` | 2,240,000          | 242                   |

Restic adds about 6.8% to 2 MiB of incompressible data (2,097,152 bytes in, about 2,239,500 bytes out). A real pair will be larger and will compress; its size is not known before Run 6.5.

## Counted operations

Counted by `upload.ts` (recorded in `docs/evidence/session-1/retention-fixture.json`, field `upload.operations`) and read from the source of `provision.ts` and the cloud tests. Class A and Class B are Cloudflare's billing classes; deletes and aborts are free.

| Activity                                                | Class A                                                                                | Class B                                 | Free                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| One pair upload                                         | 2 `PutObject`                                                                          | 2 `HeadObject`                          | —                                              |
| One verification download                               | —                                                                                      | 1 `GetObject`                           | —                                              |
| Whole fixture upload (5 pairs, 2 controls), 11 Nov 2026 | 13 (12 `PutObject`, 1 `ListObjectsV2`)                                                 | 13 (12 `HeadObject`, 1 `GetObject`)     | 1 refused `DeleteObject`                       |
| One run of `pnpm run test:cloud`                        | 7 (3 `PutObject`, 1 `CreateMultipartUpload`, 1 `UploadPart`, 2 `ListMultipartUploads`) | about 12 `HeadObject`                   | 2 `DeleteObjects`, 2 `DeleteObject`, 1 abort   |
| Provisioning, second and later runs                     | —                                                                                      | —                                       | 8 REST calls (4 bucket look-ups, 4 lock reads) |
| Provisioning, first run (10 Nov 2026)                   | 4 bucket creations, 2 lock-rule writes                                                 | their read-backs (not counted that day) | —                                              |

The class of the bucket-configuration calls made through the Cloudflare REST API (bucket look-up, lock read, lock write) is **estimated**: the pricing page lists the S3 operations, not these.

## Published rates

Looked up on **11 Nov 2026** at `https://developers.cloudflare.com/r2/pricing/` (page last updated 30 Oct 2026), Standard storage:

| Item                    | Rate                | Included each month |
| ----------------------- | ------------------- | ------------------- |
| Storage                 | $0.015 per GB-month | 10 GB-month         |
| Class A operations      | $4.50 per million   | 1 million           |
| Class B operations      | $0.36 per million   | 10 million          |
| Egress                  | free                | —                   |
| Delete, abort multipart | free                | —                   |

Cloudflare rounds usage up to the next billing unit (1.1 GB-month is billed as 2). The included amounts are for the whole account, and this account holds other buckets, so the projections below also show the cost with no included amount left.

## Projection for 30 pairs (estimated)

| Case                                           | Stored   | Storage per month, included amount available | Storage per month, none available |
| ---------------------------------------------- | -------- | -------------------------------------------- | --------------------------------- |
| 30 pairs of fixture size (2.24 MB) — estimated | 0.067 GB | $0.00                                        | $0.015 (rounded up to 1 GB-month) |
| 30 pairs of 1 GB each — estimated              | 30 GB    | $0.30                                        | $0.45                             |
| 30 pairs of 5 GB each — estimated              | 150 GB   | $2.10                                        | $2.25                             |

Operations for 30 pairs a month — 60 Class A and about 90 Class B with one verification download per pair — cost less than $0.001 at the published rates (**estimated**).

The fixture itself holds 11.2 MB for four days: below one billing unit.

## Measured: one paired backup of staging (Run 2.9, 12 Nov 2026)

A pair of the integrated stores — `pg_dump` of the staging database, its globals and an OpenBao Raft snapshot — sealed in one Restic repository (`docs/evidence/session-2/pair-spike.json`). Staging held two synthetic organizations with about 60 secrets, so this is the size of a nearly empty product, not of a used one.

| Item                                          | Bytes                              |
| --------------------------------------------- | ---------------------------------- |
| `postgres.dump` (custom format)               | 145,471                            |
| `globals.sql`                                 | 1,204                              |
| `openbao.snap`                                | 158,755                            |
| `repo.tar` (Restic, compressed and encrypted) | 297,000 to 338,000 over five pairs |
| `manifest.json`                               | 1,460                              |

Operations per pair: 2 `PutObject` (Class A) for the capture; 2 `GetObject` (Class B) for each restore. The Run 2.9 tests made 5 pairs and about 20 restore downloads: 10 Class A, about 40 Class B. Bucket `mykey-staging-pairs` holds 11 objects, 1.77 MB, on 12 Nov 2026.

Projected for one pair a day at this size (**estimated**): 30 pairs ≈ 10 MB stored, 60 Class A and 60 Class B operations a month — below every billing unit; $0.015 a month if no included amount were left.

## Measured: the product's bundle through the pair job's token (Run 6.5, 17 Nov 2026)

`tests/restore/retention/cleanup.cloud.test.ts` packs a real pair of an empty local stack (its own Restic repository, `bundle.tar`) and puts it into `mykey-staging-pairs` under `probe/` with `mykey-staging-pairs-upload`, the token the pair job uses. It reads it back, compares it and deletes it (`docs/evidence/session-6/run-6.5-pair-cloud.json`).

| Item                       | Measured      |
| -------------------------- | ------------- |
| `bundle.tar`               | 155,136 bytes |
| Upload, one `PutObject`    | 803 ms        |
| Read back, one `GetObject` | equal digest  |

Operations per pair in the product (P-119): 2 `PutObject` (`bundle.tar`, `eligible.json`) and 1 `GetObject` (the verification's read-back), so 60 Class A and 30 Class B a month for one pair a day: below every billing unit (**estimated**). The staging figure after Task D, from pairs the unit takes, replaces the empty stack's.

## Measured: the used staging pair (Run 6.6, 17 Nov 2026)

Three pairs taken by `mykey-backup.service` on staging, after the journeys of Sessions 4 and 5. Staging then held **6,784 secrets** (`app.secret_index`) and 18,731 audit events. Sizes are read from each pair's signed `eligible.json` and the bucket listing (`.superpowers/cost-figures.ts`, names and sizes only).

| Pair (17 Nov 2026) | `bundle.tar`     | `postgres.dump` | `globals.sql` | `openbao.snap`   | `eligible.json` |
| ------------------ | ---------------- | --------------- | ------------- | ---------------- | --------------- |
| `1591f04a`, 16:38  | 44,226,560 bytes | 4,346,069 bytes | 1,204 bytes   | 43,941,679 bytes | 1,807 bytes     |
| `c568b60e`, 16:49  | 44,236,800 bytes | 4,351,830 bytes | 1,204 bytes   | 43,944,239 bytes | 1,807 bytes     |
| `fc7e95cd`, 16:51  | 44,267,520 bytes | 4,361,235 bytes | 1,204 bytes   | 43,957,551 bytes | 1,807 bytes     |

The OpenBao snapshot is nine tenths of a pair. Restic's compression keeps the bundle about 8 % below the sum of the artifacts.

**Upload.** `r2Store.put` sends one `PutObject`, which R2 accepts up to 5 GiB. A pair is a hundred times smaller than that, so it needs no multipart upload and no Class A operation per part. `backup.staging.test.ts` checks that no object under `pairs/` reaches 5 GiB.

## Measured: the audit archive (Run 6.2 to 6.6)

`mykey-audit-archive`, staging, as listed on 17 Nov 2026:

| Stream  | Objects                    | Bytes      | Covers                                             | Per day (**estimated**)        |
| ------- | -------------------------- | ---------- | -------------------------------------------------- | ------------------------------ |
| app     | 10 (5 segments, manifests) | 1,000,899  | 12–16 Nov 2026, 18,649 events                      | about 200 KB                   |
| openbao | 4 (2 rotated files)        | 87,964,798 | the OpenBao audit device of Sessions 2–6 (staging) | about 15 MB under test traffic |

Staging's traffic is test traffic, much heavier than one person's use; the OpenBao figure is an upper bound.

## Projection for one host (Run 6.6, **estimated** from the measured sizes)

Retention (D-53) keeps a pair 30 days, plus up to two hours until its bucket lock ends, plus a day until the 05:00 run. With one pair a night, at most 32 pairs exist at once.

| Item                                     | Per month                                                                                   | Cost at the rates of 11 Nov 2026                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Pairs stored (32 × 44.3 MB)              | 1.42 GB-month                                                                               | $0.00 inside the included 10 GB; $0.03 without it (rounded to 2) |
| Pairs on a bad night (one more, crossed) | up to 2.8 GB-month                                                                          | $0.045 without the included amount                               |
| Audit archive, app stream                | about 6 MB more each month (kept 365 days: about 73 MB a year)                              | $0.00                                                            |
| Audit archive, OpenBao stream            | up to 450 MB more each month under test traffic                                             | $0.00 inside the included amount; $0.015 a GB-month beyond it    |
| Class A                                  | 120: per night 2 `PutObject`; per retention run 1 `ListObjectsV2`, 1 `ListMultipartUploads` | below $0.001                                                     |
| Class B                                  | 90: per night 1 `GetObject` (read-back); per deleted pair 2 `HeadObject`                    | below $0.001                                                     |
| Deletes                                  | per deleted pair 2 `DeleteObjects`                                                          | free                                                             |

A production host with a person's real use should be smaller than staging on every line except the snapshot's fixed part.

**No invoice figure yet.** The first Cloudflare invoice that covers a whole month of daily pairs (December 2026) is to be compared with this sheet at Stage 1's exit (Run 9.x).
