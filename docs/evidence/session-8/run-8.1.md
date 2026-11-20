# Run 8.1 — Freeze the release candidate

_20 Nov 2026. Plan: `docs/plans/session-8-plan.md`, Run 8.1 (D08-S45, P-145)._

## What was done

**Task A** (production's OpenBao) has not started yet. It waits for the owner's KMS sitting (`owner-requests.md`, item 2). Under P-145 its host-file and tooling changes build nothing, so it can follow the freeze. The candidate was deployed to production closed and without OpenBao, as the plan's Step 6 allows.

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

- Task A: production's KMS, OpenBao, custody, backup and timers. It waits for "prod KMS done".
- The candidate's CLI proofs (`cli-matrix`, `cli.staging`, `test:consumers`) and the one pass belong to Run 8.7 Task B (P-145).
- Staging is ready for the owner's hour (Run 8.8).
