# Run 11.1 — The postgres pin: not moved (the fixed image does not exist yet)

**Date:** 25 Nov 2026. **Branch:** `session-11`. **Real time:** about 35 min (box 1.5 h). P-184.

## What was done

- **Task A, Step 1 (see it red).** The pinned image (`postgres` 18.6, `sha256:e3d24f69…`) was scanned with the pinned Trivy and **no ignore file**: 42 findings of HIGH or CRITICAL with a fix. They are 26 in `gosu`'s Go standard library, 14 in the krb5 libraries, one in zlib (CVE-2026-85091) and one in zstd (CVE-2026-124851).
- **Task A, Step 2 (find the image).** The newest PostgreSQL 18 image on Docker Hub is `18.7`, rebuilt on 24 Nov 2026 (`sha256:c6993038…`). The same scan of it reports 27 findings:
  - **cleared:** the 14 krb5 entries and the zlib entry (`libkrb5-3 1.21.3-5+deb13u2`, `zlib1g …+deb13u1` are in the image);
  - **not cleared: CVE-2026-124851.** The image still holds `libzstd1` and `zstd` at `1.5.7+dfsg-1`; Debian's fix is `1.5.7+dfsg-1+deb13u1`;
  - unchanged: the 26 `gosu` entries.
- **The ruling.** The pin is **not moved in this run**. The plan's step asks for "the newest PostgreSQL 18 image whose scan no longer reports them", and no such image exists today. Moving to `18.7` now would cost a production database restart and the owner's journey, and the zstd entry, which is the one the owner named, would stay ignored and need a second move.
- Tasks B and C (the release `host-v0.9.3`, staging, production) did not run. Nothing was deployed. No host was touched.

## Commits

This note's commit only. `infra/dependencies.lock.json` is unchanged. `.trivyignore.images` gained one dated review line under the zstd entry.

## Commands and results

| Command                                                                  | Result                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Trivy `image --severity HIGH,CRITICAL --ignore-unfixed` on the old pin   | 42 findings                                               |
| the same on `postgres@sha256:c6993038…` (18.7, 24 Nov 2026)              | 27 findings; CVE-2026-124851 among them                   |
| `dpkg-query -W libzstd1 zstd zlib1g libkrb5-3 postgresql-18` in that one | zstd `1.5.7+dfsg-1`; krb5 and zlib fixed; `18.7-1.pgdg13` |
| `pnpm run check`                                                         | green                                                     |

## Deviations and decisions

- **F-11.1-1: the plan's premise was wrong.** CLAUDE.md says the three groups "are fixed in Debian, not yet in the pinned image". Two of them are fixed in the newest image; zstd is not.
- **Decision 8 is therefore not carried out as answered.** It stays the owner's: (a) wait for an official image with the zstd fix and move the pin once (the ruling here); or (b) move to `18.7` now, which clears 15 of the 16 entries and takes PostgreSQL's own 18.7 fixes, with a second move later.
- A pin that moves later is cut from the `host-v0.9.x` line (`main` at `472cda4` plus the pin), as D-80 says for any production change before W-2. The session's product release (`host-v0.10.0`) then carries whatever pin `main` has.
- `CVE-2026-76844` (zlib) is in `.trivyignore.images` and is no longer reported on either image. The entry is stale and harmless; it leaves with the others when the pin moves.

## Open issues

- **Dated, unchanged:** `.trivyignore.images` expires on 14 Dec 2026. Look for a rebuilt image at the freeze (Run 11.8) and again before 10 Dec.
- A pin move touches more than the lock: both dev compose files, `host.compose.yml`, `host-kms-spike.compose.yml`, `infra/hosts/checks/status.sh`, the generated `infra/hosts/backup/backup.sh` (`node infra/hosts/backup/steps.ts render`), `tests/integration/capture/pair.test.ts` and `tests/staging/identity.staging.test.ts`. On a host the image arrives by `host.ts <host> push`, a `maint` pull by digest and `up` (runbook `network.md`), not inside a release.
