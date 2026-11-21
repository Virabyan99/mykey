# Run 8.1 — Freeze the release candidate

_20 Nov 2026. Plan: `docs/plans/session-8-plan.md`, Run 8.1 (D08-S45, P-145)._

## What was done

**Task A — production gets its OpenBao** (21 Nov 2026, after the freeze; P-146, with the owner's yes of 20 Nov).

1. **Host files (Step 1).** Production's files were pushed at the freeze (`c46bac6`). Nothing under `infra/hosts` or `infra/compose` changed between `b659200` and the start of this task.
2. **KMS (Step 2).**
   - Owner, sitting 1: domain `mykey-prod-kms` (`edafd078-1db6-41a0-8431-ad65eb03ea8d`, `us-east-vin`), user `mykey-prod-seal`, policy `mykey-prod-kms-seal` with the seven actions, and the certificate for the CSR `prod-seal-1` (made on the host in Run 8.0 Task B).
   - The downloaded certificate's public key equals the CSR's (SHA-256 of both: the same). It is `CN=prod-seal-1`, issued by `us-east-vin KMS user ECC CA`, valid from 21 Nov 07:48 to **21 Dec 2026, 07:48 UTC**.
   - `kms-cert`, `kms-use`; `env MYKEY_KMS_HOST`; the restic and OpenBao images by digest in two `maint` windows; `kmip locate`: the domain is empty.
   - `kmip create symmetric` (AES-256, `--extractable=false --sensitive`), then `kmip activate`. The key is `mykey-prod-seal-1`, id `eb5e0572-a9a6-435f-9d84-6c1155596004`. Its attributes: `State Active`, `Extractable false`, `Never Extractable true`, `Sensitive true`, `Always Sensitive true`.
   - `env` for `MYKEY_KMS_SEAL_KEY_ID`, `MYKEY_OPENBAO=1` and `MYKEY_BAO_URL=https://openbao:8200`.
   - **Sitting 2**: the owner removed `create` and `activate`, then confirmed. Read back:
     - `kmip create` answers `Operation is not authorized`;
     - `kmip locate` still lists only `mykey-prod-seal-1`, `Active`;
     - `docker restart mykey-openbao-1` brings `post-unseal setup complete` in 0.25 s, with `status` at `sealed false` and `kmsReachable true`, and the probe has nothing open.
3. **OpenBao and the rest (Step 3).**
   - `up`: `openbao.hcl` rendered; OpenBao started with the KMIP seal and waited for its init. The API (closed) and the provisioner started; the provisioner is healthy.
   - `bao-init`: initialised; the recovery key was printed as `[redacted]`; the custody copy is in `~/.mykey/custody/prod/openbao-init.json`; audit headers and the root-namespace policy backup written.
   - `ops-secrets`, `backup-init` (trust anchor `infra/hosts/backup/trust/prod-k1.pub`, committed), `backup-custody` (`~/.mykey/custody/prod/backup/`).
   - `r2-install` for `audit-archive`, `pairs` and `pairs-cleanup`: production's pair tokens (`mykey-prod-pairs-upload`, `-cleanup`, made in Session 1) and the shared audit-archive token were already in workstation custody. No Cloudflare token was made, and only `mykey-*` buckets are involved.
   - `timers`: seven job timers, with `MYKEY_BACKUP_EXPECTED=yes`.
   - **The first pair at once**, rather than at 03:00: `systemctl start mykey-backup.service` → `eligible 543e2b7a-983f-40ed-9484-c9963a7ba07e` (uploaded, read back, checked, signed).
   - `status`: `sealed false`, `sealType kmip`, `kmsReachable true`, the provisioner healthy, backup fresh, `kms-client` until 21 Dec. `gate closed` is the only line not ok, on purpose.
   - `probe.ts state prod`: `open` is empty. **`checks_unknown` closed** with the first heartbeat that read OpenBao, and production stays `inService: false`.
   - No `bootstrap-owner` and no `provision-organization`: production holds no account, organization or data.
4. **Custody (Step 4).** `custody-map.md` has a production table, and `credential-custody.md` has the `prod-seal-1` key and production's init answer (names and places only). The owner is asked to copy `~/.mykey/custody/prod/` into the password manager. CLAUDE.md's dated items name the new certificate's end.
5. **What broke (Step 5).** Three gaps of `production.md`, none in the tool:
   - `MYKEY_KMS_HOST` must be set **before** the first `kms … --` command (`okms.sh` reads it), not after the key is made.
   - `okms` runs in the pinned restic image, which a fresh production lacks: the first `kms` command failed on the closed registry egress. The restic image is now pulled in a `maint` window first.
   - `MYKEY_BAO_URL` was not in the runbook. Without it, `up` stops on the provisioner's required variable.

   `production.md` now has the order that ran, with the readings to expect. `candidate.json` gets one `tooling` line (the trust anchor); everything else is documentation (P-145).

**Task B — the freeze.**

1. **The full suite (Step 1).**
   - The first run (`44773584898`, at `100c516`) failed in two jobs.
     - **`scans`: the API image did not build.** Since Run 8.0 Task C, `help.tsx` bundles `docs/runbooks/known-limits.md`. The image's web stage did not copy that file, and `.dockerignore` kept it out of the build context. Draft runs never build the image, so this was first seen here.
       - Fixed test first in `b659200`: `tests/unit/web/image-sources.test.ts` failed, naming the file.
       - The stage and the build context now let it in. The web stage was built locally to confirm.
     - **`integration (1)`: `tests/integration/ops/reset.test.ts` was stale since R1-1.** `recordFailure` no longer counts a failure; `admit` does. Repaired as a test.
   - The second run (`44778164563`, at `b659200`) was **green in every job**: check, secret scan, scans, both integration shards and browser.
2. **Pins and advisories (Step 2, G-PINS).**
   - The registry digests of `postgres:18.6`, `openbao/openbao:2.7.2`, `traefik:3.7.17`, `restic/restic:0.19.1` and `node:24.22.2-alpine` equal the pins (`docker buildx imagetools inspect`). No image of a pinned version carries a fix, so every entry of `.trivyignore.images` stays, with the exposure text reviewer 6 read.
   - `pins:verify` ok.
   - `apps/cli` changed since `main`, so the CLI is `cli-v0.1.2`. It was built in the clean clone at `b659200` and published, tagged at `b659200`:
     - `mykey-cli-0.1.2.tgz` `2646f60feb6314cccb1e6bac635a0974e23772449a2614554a9fe09c32bd8518`;
     - `install.sh` `f35199658274617817a709fc221343dec8a10d1cbf5bdad5280a79fea3538221`.
   - The consumer runbooks name `cli-v0.1.2`.
3. **One release (Step 3).**
   - `host-v0.8.0` was built in the clean clone at `b659200`, with all three scans passing.
   - The images are:
     - api `sha256:b0ebb2e9683cc32d7ae87c471f2ec3e9b538d33a6a8ae974aff69adc03797a94`;
     - provisioner `sha256:2ea5b5dfc760e94245ef9cbde4fe76225d910157f2fed79b703be42fa2c64487`;
     - ops `sha256:c0fb784ad9ad028f355340002a88e29fb05e6d2f8c2bc387dacf48154abaeaef`.
   - Published with `--target session-8`; the tag is at `b659200`.
   - The first build attempt was stopped by Claude Code for low memory on the workstation. Its orphaned build process and scan container were stopped, and the build ran again on the owner's word.
4. **`candidate.json` (Step 4).**
   - Written by the new `scripts/release-candidate.ts` from `release.json` and the repository at the release's commit. Test first: `tests/unit/release/candidate.test.ts`, "every field of P-145 is present, and a release whose commit is not an ancestor of HEAD is refused".
   - The source commit is `b659200`, the last migration `0018_incarnation`, and the host files are of `c46bac6`.
5. **Staging (Step 5).**
   - `push`, `up` (OpenBao rendered and running), then `deploy --release host-v0.8.0`. The gate went closed (epoch 310), through migrate (nothing applied), start, journey and report, to open: epoch 312, 17:52:32 UTC.
   - `status`: every line ok. The probe shows nothing open.
   - No OpenBao policy or role changed in this session (`packages/openbao` is untouched since `main`), so there was no new `provision-organization`.
6. **Production (Step 6).**
   - `push`, then `deploy --release host-v0.8.0 --stay-closed`, with the owner's yes of the session start. The gate is closed at epoch 2 (17:57:22 UTC, phase `verifying`), and no migration was applied.
   - Read back: the API runs `sha256:b0ebb2e9…`, the release's. There is no provisioner, because there is no OpenBao.
   - `checks_unknown` stays open, as stated in `known-limits.md`.
7. **`candidate.json` (Step 7)** holds both deploys.

## Commits

- `cee4646` feat(evidence): candidate.json is written from the release and the repository
- `542a20b` test(ops): the reset test counts failures as the routes do since R1-1
- `b659200` fix(web): the image's web stage copies the known limits Help bundles
- this note, `candidate.json` and the runbooks: docs: the release candidate host-v0.8.0

## Commands and results

- `gh workflow run ci --ref session-8`: first failure (above), then `44778164563` green.
- `pnpm exec vitest run --project integration tests/integration/ops/reset.test.ts`: 9/9.
- `pnpm exec vitest run --project unit tests/unit/web/image-sources.test.ts`:
  - red on `docs/runbooks/known-limits.md`, for both the stage and the build context;
  - green after the fix;
  - `docker build --target web` succeeded.
- `pnpm test`: 1471/1471. `pnpm run check`: green.
- `pnpm run cli:release -- --version 0.1.2` and `node infra/release/build.ts --version 0.8.0`, both in `~/mykey-release/src` at `b659200`; then `gh release create` for both.
- `host.ts staging push | up | deploy`, `host.ts prod push | deploy --stay-closed`, both `status`; `probe.ts state staging`.

## Deviations and decisions

- **The freeze came before Task A.** The owner's KMS sitting is not answered yet. Task A changes host files and OpenBao on production only, which P-145 rates as tooling: it builds nothing.
- **`candidate.json` lists every image of `infra/dependencies.lock.json`,** the CI and test images included. Each is marked by its name.
- **The image defect is not security-relevant.** A public runbook enters the build context. So it went to no reviewer.
- **Lesson:** a change to what the workspace imports must build the image before it is pushed. `image-sources.test.ts` now catches it in the unit suite.

## Open issues

- Task A, owner: done (sitting 2 and `~/.mykey/custody/prod/` into the password manager, confirmed in one line on 21 Nov 2026).
- Task A: `infra/hosts/backup/trust/prod-k1.pub` reaches staging at its next `push` (the drill and restore checks read the trust directory). Production got it by `push` after the commit.
- The candidate's CLI proofs (`cli-matrix`, `cli.staging`, `test:consumers`) and the one pass belong to Run 8.7 Task B (P-145).
- Staging is ready for the owner's hour (Run 8.8).
