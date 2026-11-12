# Run 2.9 — Paired backup spike

**Result: DONE on 12 Nov 2026.** A pair of the integrated stores was captured on staging under a freeze, sealed with Restic, stored in R2, restored from the bucket into a new PostgreSQL cluster and a new OpenBao instance on the same KMS seal key, checked half by half and against each other, and marked eligible. Every planned bad path held. Decision record: D-25.

PO-13 SPIKE_PASS — a paired backup taken at one boundary (zero executing operations, zero held slots), freeze 40 s with every write inside it refused `busy`, restored into new stores and checked (`tests/staging/pair.staging.test.ts`, `pair-staging.txt`).
PO-21 SPIKE_PASS — the bucket holds ciphertext only: `repo.tar` contains none of the 40 canaries, the manifest no value, token or password; a swapped manifest is refused before anything is restored.
DB-G1 SPIKE_PASS — the database globals are re-created from `roles.sql` (`applyRoles`) plus `applyDatabaseAccess`: the privilege matrix passes on the restored database, its globals equal the captured ones, a missing role or skipped access is detected (`db-globals-inventory.md`).

## What was done

- **Step 1** (local rehearsal, commit 6b91ce1): `manifest.ts`, `freeze.ts`, `applyDatabaseAccess`, the extracted privilege matrix, `pair-rehearsal.test.ts`, `access.test.ts`.
- **Host steps** (`infra/backup/pair-spike/host-steps.ts`): pure builders for the pair tmpfs, the dumps, Restic, the R2 transfer, the restore cluster and the restored globals; a de-risk drive on staging before OpenBao existed.
- **Orchestration** (`capture.ts`): `capturePair`, `abortCapture`, `restorePair`, `cleanupRestore`, the root-namespace AppRole `backup`.
- **Staging**: the API image and the migrations brought current (`0003_auth_base.sql`), `tests/harness/staging-db.ts` (the real database with the real role passwords, never `applyRoles`), `effectsFixture(stack, { db })`.
- **Step 2–4** in `tests/staging/pair.staging.test.ts`: two organizations, 40 canary secrets through `executeWrite`, two machine tokens, a background writer; six good-path and six bad-path tests.
- **Step 5**: `pair-spike.json`, `cost-sheet.md` section "Measured: one paired backup of staging".
- **Step 6**: nothing is left on the host but the expiry instance of Run 2.7 (tmpfs, restore cluster and instances removed by the tests; the R2 credential and Restic passwords only ever lived in the tmpfs). `db-globals-inventory.md` updated.

## Commits

- 6b91ce1 feat(backup): pair-spike manifest, database access function and local rehearsal
- 01296e1 feat(backup): host-side steps of a paired backup in a root-only tmpfs
- this commit: test(backup): one paired backup captured on staging and restored into new stores

## Commands and results

| Command                                                 | Exit | Proof line                                                                                                                                                           |
| ------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scratch de-risk drive on staging (no OpenBao)           | 0    | dump, Restic, R2 PUT/GET, restore cluster, `pg_restore`: digests identical; matrix showed staging still at migration 0002 → `db-init`                                |
| `host.ts staging image api …`, `db-init`, `up`          | 0    | `applied 0003_auth_base.sql`, `/health` 200                                                                                                                          |
| `pnpm exec vitest run --project unit tests/unit/backup` | 0    | 33/33 (restoreGlobalsCommand RED → GREEN)                                                                                                                            |
| `pair.staging.test.ts`, first run                       | 1    | 10/12; capture: one "inside" write succeeded; missing role: not detected as such                                                                                     |
| second run                                              | 1    | 10/12; evidence showed both were test faults: attempts take ~4 s (start time ≠ admission time), and the missing role failed `applyDatabaseAccess` with a plain error |
| `-t "capture produces\|missing role"` after the fixes   | 0    | 2/2: inside the freeze `{"rejected/busy":7}`; `restore refused at postgres: role "backup_reader" does not exist`                                                     |
| `pnpm run check`                                        | 0    | —                                                                                                                                                                    |

## Pair objects left in `mykey-staging-pairs` (for Run 6.6)

Listed through the Cloudflare API on 12 Nov 2026 (11 objects, 1.77 MB). Restic passwords: `~/.mykey/custody/staging/pair-<id>.key`.

- `pairs/08d8fd15-27a2-4324-8a06-c9f8eb79fc96/repo.tar` — de-risk drive, password discarded (undecryptable), no manifest
- `pairs/fa6225e4-cb4c-4b7b-b75d-48dd0e4f0436/{repo.tar,manifest.json}` — run 1, eligible
- `pairs/42cca813-e5ee-40b3-a192-6d5b63a15d9b/{repo.tar,manifest.json}` — run 1, the capture after `reconcile`
- `pairs/0e2e593e-b5f6-4f45-b3db-2a9e132ae156/{repo.tar,manifest.json}` — run 2, eligible (`pair-spike.json`)
- `pairs/0d1b8876-a801-4f73-ae7e-253e7277989e/{repo.tar,manifest.json}` — run 2, the capture after `reconcile`
- `pairs/5d71b716-e339-4d18-a7a4-37ed9ef45db8/{repo.tar,manifest.json}` — run 3

## Deviations and decisions

- **R63** the Restic password and the R2 credential live only in the pair's tmpfs on the host.
- **R64** the restore cluster reuses the host's PostgreSQL certificate, reached as `postgres` through `--add-host`.
- **R71** `capturePair`/`restorePair` take a `PairContext` (pools, passwords, R2 credential).
- **R72** the pair row is written `candidate` right after the freeze.
- **R73** "no backend write newer than the boundary" is checked on the restored pair: every KV envelope's operation id is an operation of the restored database.
- **R74** the unresolved effect is a `hangAfterSend` executor child, without a delayed relay.
- **R75** row counts are taken inside the freeze; `app.operation` is compared on rows created before the freeze (refused writes insert `rejected` operations).
- The missing role is simulated by renaming it away after `applyRoles` (a `DROP` right after it can fail on dependencies); any failure of the PostgreSQL half is reported as `RestoreRefused`.
- `maintenance`, not `backup_reader`, writes the freeze and the pair row (D-25 finding).
- The registry is not edited in this run (ruling R6).

## Open issues

- Session 6: the manifest signature, the Restic password custody, who owns the control rows, the freeze alert (Run 6.4), a pair of a used product for COST-B1.
- The full `pair.staging.test.ts` passed in pieces (10 + 2); the gate runs it whole.

Verdict: GO
