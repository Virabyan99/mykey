# Run 1.9 — R2 buckets and retention clock

**Result: DONE on 11 Nov 2026, one day late.** The fixture is uploaded, its objects are locked and their clocks are recorded; the refused overwrite, delete and bulk delete are saved. The fixture is **started — nothing is passed**: PO-9, R2-L1 and COST-B1 stay `OPEN`.

The run waited one day for a Cloudflare bootstrap token. The Cloudflare API tool of the agent session can configure buckets but is refused when it creates API tokens (HTTP 403, code 9109). The owner saved a user API token to `~/.mykey/secrets/cloudflare/bootstrap-token` on 11 Nov 2026; it was never shown in chat.

## What exists

- **Account:** `ddfa208f3f81d98c16e40b9da208c626` (not a secret). R2 is enabled.
- **Buckets** (created 10 Nov 2026, default jurisdiction, location hint EEUR): `mykey-prod-pairs`, `mykey-staging-pairs`, `mykey-audit-archive`, `mykey-retention-fixture`.
- **Lock rules**, read back by `provision.ts` and by the cloud tests:
  - `mykey-prod-pairs`: `pairs-30d`, prefix `pairs/`, age 2,592,000 s, enabled.
  - `mykey-retention-fixture`: `fixture-pairs-4d`, prefix `pairs/`, age 345,600 s; `fixture-probe-10m`, prefix `probe/`, age 600 s. Both enabled.
  - `mykey-staging-pairs`, `mykey-audit-archive`: no rule (Runs 6.5 and 6.2 own them).
- **Eight tokens** (created 11 Nov 2026, 10:40–10:41 UTC, as user API tokens): `mykey-r2-admin`, `mykey-prod-pairs-upload`, `mykey-prod-pairs-cleanup`, `mykey-staging-pairs-upload`, `mykey-staging-pairs-cleanup`, `mykey-audit-archive-upload`, `mykey-fixture-upload`, `mykey-fixture-cleanup`. Each has a credential file `~/.mykey/secrets/r2/<token name>.json`. See D-16 and the custody list.
- **Fixture objects** in `mykey-retention-fixture`, uploaded 11 Nov 2026, 10:42:18–10:42:23 UTC (the times R2 reports):

  | Objects                                                                | Lock rule           | Lock ends (UTC)          |
  | ---------------------------------------------------------------------- | ------------------- | ------------------------ |
  | `pairs/pair-20261111-1/`, `-2/`, `-3/` (`bundle.tar`, `manifest.json`) | `fixture-pairs-4d`  | 15 Nov 2026, 10:42:18–20 |
  | `probe/probe-20261111-1/`, `-2/`                                       | `fixture-probe-10m` | 11 Nov 2026, 10:52:21–22 |
  | `scratch/control-1.txt`, `scratch/control-2.txt`                       | none                | —                        |

  Capture times are 08:42, 09:42 and 10:42 UTC for the three pairs, so `pair-20261111-1` is the oldest eligible pair. Every object's key, size, ETag, upload time, capture time, rule and lock end is in `docs/evidence/session-1/retention-fixture.json`.

- **Code:** `infra/backup/retention-fixture/{r2.ts,provision.ts,build-pair.ts,upload.ts}`, `scripts/require-cloud-env.ts`, `tests/restore/retention/fixture.cloud.test.ts`, `tests/unit/backup/{r2,provision}.test.ts`, root script `test:cloud`.
- **Cost sheet:** `docs/evidence/cost-sheet.md`.

## What R2 did (findings)

| Observation                                                                                    | Result                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overwrite of a locked `pairs/` object with the upload token                                    | HTTP 409 `ObjectLockedByBucketPolicy`; ETag unchanged                                                                                                                                                          |
| Delete of a locked `pairs/` object with the clean-up token                                     | HTTP 409 `ObjectLockedByBucketPolicy`; HEAD still 200                                                                                                                                                          |
| Bulk delete of one locked and one unlocked object                                              | **HTTP 200**, the locked key under `Errors` with `ObjectLockedByBucketPolicy`, the other under `Deleted`; a HEAD confirmed each                                                                                |
| Delete of a `probe/` object 2 seconds after upload                                             | HTTP 409 `ObjectLockedByBucketPolicy` (made by `upload.ts`)                                                                                                                                                    |
| Delete of the `probe-20261111-1` objects after the lock ended (10:52:21; test ran 10:52:45–51) | accepted; HEAD 404. A `pairs/` object uploaded in the same minute was still refused                                                                                                                            |
| Each of the seven object tokens sends the lock rules of its own bucket back unchanged          | HTTP 403, code 10000, seven times; each token was reported active just before                                                                                                                                  |
| A multipart upload that is never completed                                                     | listed by `ListMultipartUploads`; aborted; no longer listed; no object at the key                                                                                                                              |
| **Upload ids**                                                                                 | R2 writes the id of one upload as a different 343-character string each time it reports it (create, list, list again). Ids cannot be compared; each of them aborts the upload. A second abort is also accepted |
| Minimum lock age                                                                               | 600 s was accepted at the first try, so 600 s is an upper bound on the minimum, not the minimum itself                                                                                                         |
| Checksums                                                                                      | `PutObject` and `DeleteObjects` work with the default options of `@aws-sdk/client-s3` 3.1165.0; no checksum option is set                                                                                      |
| `LastModified`                                                                                 | whole seconds through `HeadObject`; the lock ends are therefore known to the second                                                                                                                            |

## Commands and results

| Command                                                                      | Exit | Proof line                                                                                                      |
| ---------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm test`, tests written, no code yet (10 Nov)                             | 1    | `Cannot find module '../../../infra/backup/retention-fixture/r2.ts'`                                            |
| `HOME=<empty dir> USERPROFILE=<empty dir> pnpm run test:cloud` (10 Nov)      | 1    | `cloud credentials missing: mykey-fixture-upload, mykey-fixture-cleanup, mykey-r2-admin`                        |
| `vitest run --project integration tests/integration/backup` (10 Nov)         | 0    | `Tests 8 passed (8)` — real Restic in Docker, restore from the bundle compared by SHA-256                       |
| `vitest run --project unit tests/unit/backup/provision.test.ts`, no code yet | 1    | `Cannot find module` (the scripts did not exist)                                                                |
| `pnpm run test:cloud`, before provisioning                                   | 1    | `cloud credentials missing: …` — a failure, not a skip                                                          |
| `node infra/backup/retention-fixture/provision.ts --account <id>`            | 0    | 4 × `lock rules unchanged`, 8 × `created`, 7 × `lock change denied (HTTP 403, active true)`                     |
| `node infra/backup/retention-fixture/upload.ts`                              | 0    | 12 × `uploaded …`, `delete of probe/probe-20261111-1/manifest.json inside its lock: ObjectLockedByBucketPolicy` |
| `pnpm run test:cloud` at 10:42 UTC                                           | 1    | 6 passed; `probe lock expires` not yet due; the multipart test failed on the upload-id finding above            |
| `pnpm run test:cloud` at 10:43 UTC                                           | 1    | `Tests 1 failed \| 7 passed (8)` — only `the probe lock has not ended yet`                                      |
| `pnpm run test:cloud` at 10:52:45 UTC                                        | 0    | `Tests 8 passed (8)`                                                                                            |
| `provision.ts` again, after the review fixes                                 | 0    | 4 × `unchanged`, 8 × `kept` — nothing created, rolled or changed                                                |
| `pnpm run test:cloud` at 10:53 UTC                                           | 0    | `Tests 8 passed (8)`                                                                                            |

## Review

One independent review of this run's code, by a fresh agent that did not run anything against Cloudflare. No Critical finding. Four Important findings, each fixed with a test that failed first (`tests/unit/backup/provision.test.ts`, "provision review fixes"):

1. A bootstrap file with two lines made the runtime quote the whole token in an error message. Now a token that is not one line of token characters is refused with a message that holds no value, and a failed request never passes its cause on.
2. A second run could replace lock rules it did not know, or shorten one. Now `provision.ts` stops when a live rule is missing from the plan, or the plan would shorten, disable or move it.
3. A token whose credential file was not on the workstation was rolled without being asked. Now a token is rolled only with `--roll <token name>`; otherwise it is left alone and reported.
4. A failure half way through lost the recorded lock-change attempts. Now the evidence file is written after every attempt, and a run ends with an error if an object token has no recorded attempt.

Minor findings, not fixed:

- `upload.ts` writes the evidence once, at the end; a failure after the first upload would leave locked objects without recorded clocks.
- The one-hour guard of the refusal tests compares the workstation clock with R2's; a workstation clock more than an hour slow after 15 Nov could let them delete the newest pair.
- The probe-expiry checkpoint was set to `observed` by hand from the test run's times; the test prints the deletions but does not write them.
- `scratch/test-*` objects stay behind if a bulk-delete assertion fails between the upload and the delete.
- `credentialFileComplete` accepts an empty secret and does not check a token's status or policies.
- A run with another `--account` would overwrite the account id in the evidence but keep the old objects.
- `resticVersion` in the evidence is a constant, not read from the manifest; refused calls and retries are counted like accepted ones.
- The keep / create / roll loop itself has no unit test, because the Cloudflare client cannot be replaced in a test.
- `require-cloud-env.ts` checks the admin token's S3 credentials, while the tests need its API token; a missing one still fails loudly when the test file loads.
- The plan's step-up for a refused 600-second rule (3,600 s, then 86,400 s) is not coded; it was not needed.

## Not done

- **GitHub Actions secrets for the two fixture tokens.** The agent session was not permitted to write to the secret store. No CI job runs the cloud tests today, so nothing depends on them yet. The five names the code reads are `MYKEY_R2_ACCOUNT_ID`, `MYKEY_FIXTURE_UPLOAD_ACCESS_KEY_ID`, `MYKEY_FIXTURE_UPLOAD_SECRET_ACCESS_KEY`, `MYKEY_FIXTURE_CLEANUP_ACCESS_KEY_ID`, `MYKEY_FIXTURE_CLEANUP_SECRET_ACCESS_KEY`. The cloud tests also need `MYKEY_R2_ADMIN_API_TOKEN` and the admin S3 pair, which D-16 keeps off CI; a CI job would need the lock-rule tests split out first.
- The integration suite was not run again for this run: none of its code changed after the Session 1 gate.

## Checkpoints

In `retention-fixture.json`, field `checkpoints`:

1. `probe-expiry` — **observed** on 11 Nov 2026, 10:52:45–51 UTC.
2. `pairs-lock-session-gate` — at the first session gate on or after **15 Nov 2026, 10:42:20 UTC**: before that time, run `pnpm run test:cloud` and record the refused delete again; after it, record that the lock has ended.
3. `run-6.6-cleanup-and-restore` — Run 6.6 cleans up the expired fixture objects and restores the oldest eligible pair (`pair-20261111-1`).

## What the next agent must know

1. **From one hour before the `pairs/` lock ends, the refusal tests stop with an error** instead of touching the fixture. `pnpm run test:cloud` then fails by design until Run 6.6 has cleaned up and a new fixture is uploaded.
2. `upload.ts` refuses to run when the evidence file already lists objects or the bucket is not empty: the clocks must not be restarted without a decision.
3. `provision.ts` is safe to run again: it changes nothing that already matches, never weakens a lock rule and never rolls a token unless `--roll <token name>` says so. Rolling ends the old credentials at once.
4. The Restic password of the fixture is `~/.mykey/secrets/retention-fixture/restic-password`. Without it the pairs cannot be restored in Run 6.6.
5. One probe pair (`probe-20261111-2`) and two `scratch/` controls are left in the bucket on purpose, as expired and unlocked objects for the Run 6.6 clean-up.
6. The account holds other buckets that are not part of MyKey. The scripts name the four MyKey buckets and touch no other.
