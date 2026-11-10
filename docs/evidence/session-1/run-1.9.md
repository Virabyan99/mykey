# Run 1.9 — R2 buckets and retention clock

**Result: NOT DONE. The fixture is not uploaded and its retention clock has not started.** PO-9, R2-L1 and COST-B1 stay `OPEN`.

The run needs eight scoped R2 tokens. The Cloudflare API tool of the agent session can configure buckets but is refused when it creates API tokens (HTTP 403, code 9109), and no bootstrap token was at `~/.mykey/secrets/cloudflare/bootstrap-token` at any check on 10 Nov 2026. Without tokens there are no S3 credentials, so no upload and no cloud test.

## What was done

- **Account:** `ddfa208f3f81d98c16e40b9da208c626` (not a secret). R2 is enabled.
- **Buckets** (created 2026-11-10T13:52Z through the Cloudflare API tool, default jurisdiction, location hint EEUR): `mykey-prod-pairs`, `mykey-staging-pairs`, `mykey-audit-archive`, `mykey-retention-fixture`.
- **Lock rules**, set with `PUT /accounts/{account_id}/r2/buckets/{bucket}/lock` and read back with `GET`:
  - `mykey-prod-pairs`: `pairs-30d`, prefix `pairs/`, age 2,592,000 s, enabled.
  - `mykey-retention-fixture`: `fixture-pairs-4d`, prefix `pairs/`, age 345,600 s; `fixture-probe-10m`, prefix `probe/`, age 600 s. Both enabled.
  - `mykey-staging-pairs`, `mykey-audit-archive`: no rule (Runs 6.5 and 6.2 own them).
- **Finding — minimum lock age:** R2 accepted a 600-second age rule at the first try. No larger value had to be tried, so 600 s is an upper bound on the minimum, not the minimum itself.
- **`infra/backup/retention-fixture/r2.ts`:** `loadR2Credentials` (environment first, then `~/.mykey/secrets/r2/<token name>.json`; errors name the token and the missing fields, never a value), `s3ClientFor` (the options of Cloudflare's current `aws-sdk-js-v3` example: region `auto`, endpoint `https://<account>.r2.cloudflarestorage.com`, no checksum options), `deleteObjectsChecked` and its pure half `deleteOutcomes`.
- **`scripts/require-cloud-env.ts`** and root script `test:cloud` = `node scripts/require-cloud-env.ts && vitest run --project cloud`.
- **`infra/backup/retention-fixture/build-pair.ts`:** `buildPair`, `ensureResticPassword`, `resticInBundle`. A pair is a new Restic 0.19.1 repository made in the pinned image (network off) with `pg.dump` and `raft.snap` of 1 MiB random bytes and a three-line `globals.sql`; `restic check --read-data`; one `bundle.tar`; `manifest.json` with `{pairId, captureTime, bundleSha256, bundleBytes, resticVersion, synthetic: true}`. The snapshot carries the capture time, not the build time. The password is read by restic from a mounted file and is never a command argument.

## What was not done

| Plan step                                                                                   | State                                                                           |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Eight tokens and their files in `~/.mykey/secrets/r2/`                                      | not created                                                                     |
| `provision.ts`, `upload.ts`, `tests/restore/retention/fixture.cloud.test.ts`                | **not written** — they can only be proven against Cloudflare with the tokens    |
| Upload of three `pairs/`, two `probe/` and two `scratch/` objects; `retention-fixture.json` | not done                                                                        |
| Denied overwrite, denied delete, bulk delete with per-object errors, multipart clean-up     | not observed against R2                                                         |
| `object tokens cannot change the lock rule`                                                 | not observed                                                                    |
| `probe lock expires`                                                                        | not observed                                                                    |
| `gh secret set` for the two fixture tokens; custody list entries                            | not done (nothing exists to list)                                               |
| `docs/evidence/cost-sheet.md`                                                               | not written — it needs counted operations and measured sizes from a real upload |

## Commands and results

| Command                                                                  | Exit | Proof line                                                                                      |
| ------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------- |
| `pnpm test`, tests written, no code yet                                  | 1    | `Cannot find module '../../../infra/backup/retention-fixture/r2.ts'`                            |
| `pnpm test`                                                              | 0    | `Tests 110 passed (110)` (7 new) before the Run 1.8 merge                                       |
| `HOME=<empty dir> USERPROFILE=<empty dir> pnpm run test:cloud`           | 1    | `cloud credentials missing: mykey-fixture-upload, mykey-fixture-cleanup, mykey-r2-admin`        |
| `pnpm run test:cloud` (real home)                                        | 1    | the same line — a missing credential is a failure, not a skip                                   |
| `vitest run --project integration tests/integration/backup`, no code yet | 1    | `Cannot find module '../../../infra/backup/retention-fixture/build-pair.ts'`                    |
| the same, with `build-pair.ts`                                           | 0    | `Tests 8 passed (8)`, 63 s — real Restic in Docker, restore from the bundle compared by SHA-256 |

## What the next agent must know

1. **Owner action first:** save one Cloudflare user API token (template "Create Additional Tokens", plus account-level R2 edit) to `~/.mykey/secrets/cloudflare/bootstrap-token`. Never paste it into chat.
2. **Every day of delay moves the retention checkpoints.** The `pairs/` objects are locked for four days from upload. Run 6.6 wants to clean up expired fixture objects; upload them as early as possible in Session 2.
3. **The admin credential file needs one more field than the plan gives.** The lock configuration is read with the Cloudflare REST API, which takes the token value as a bearer; the S3 secret (SHA-256 of that value) cannot be turned back into it. Either store `apiToken` in `mykey-r2-admin.json` or read the lock rules with the bootstrap token. See D-16.
4. **Checksum options were left at the SDK default** because Cloudflare's example for the pinned SDK shows none. The first real `PutObject` and `DeleteObjects` will confirm or refute that.
5. `buildPair` refuses to overwrite an existing pair directory and removes its staging directory on every path.
