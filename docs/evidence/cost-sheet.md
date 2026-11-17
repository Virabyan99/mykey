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

## What is still missing for COST-B1

- The size of a PostgreSQL dump and an OpenBao snapshot of a used product (Run 6.5); the staging pair above is nearly empty.
- Whether large bundles need multipart upload, which adds Class A operations per part.
- The monthly figure on a Cloudflare invoice, to compare with this sheet.
