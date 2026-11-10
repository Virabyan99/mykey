# Run 1.3 — Version pins (G-PINS spike, PO-24)

## What was done

- Chose exact versions for Node, pnpm, 23 npm packages, 6 container images (by digest), 4 GitHub Actions (by commit SHA) and python-dotenv (by wheel hash); recorded them in `infra/dependencies.lock.json`.
- Runtime packages are in the pnpm `catalog:`; `.node-version` is 24.22.2.
- `scripts/pins-verify.ts` (script `pins:verify`, now part of `check`) and its guard tests in `tests/unit/pins/pins.test.ts`.
- `scripts/repro-build.ts`: clean clone outside OneDrive, frozen install, build, one hash over every `dist/` file and both lock files.
- Decision record D-12.

## Commits

- `chore: pin toolchain, images and actions (G-PINS spike)` and the follow-up commit that adds this note and D-12.

## Commands and results

| Command                                                       | Exit | Proof line                                                                                             |
| ------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `pnpm test` before `scripts/pins-verify.ts` existed           | 1    | `Cannot find module '../../../scripts/pins-verify.ts'`                                                 |
| `pnpm test` before `scripts/repro-build.ts` existed           | 1    | `Cannot find module '../../../scripts/repro-build.ts'`                                                 |
| `node scripts/pins-verify.ts`                                 | 0    | `pins: ok` (no flag, no type-stripping warning on Node 24)                                             |
| `pnpm test`                                                   | 0    | `Tests 18 passed (18)`                                                                                 |
| `pnpm install --frozen-lockfile`, `pnpm run check`            | 0    | `pins: ok`                                                                                             |
| `node scripts/repro-build.ts --twice`                         | 0    | `BUILD_HASH=0f6b198b613f1a098ebeee6675bfa8b9c4ce146751d14b6c7a8ad50e0119c0c5` printed twice, identical |
| `z.toJSONSchema(…, { target: "draft-2020-12" })` on zod 4.6.7 | 0    | returns a `https://json-schema.org/draft/2020-12/schema` document                                      |

## Pins chosen

| Component                                                                | Pin                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Node                                                                     | 24.22.2 (24 LTS)                                                                               |
| pnpm                                                                     | 10.20.0                                                                                        |
| PostgreSQL                                                               | `postgres:18.6` `sha256:e3d24f69…0ddf3c42`                                                     |
| OpenBao                                                                  | `openbao/openbao:2.7.2` `sha256:50469110…9b90561f`                                             |
| Traefik                                                                  | `traefik:3.7.17` `sha256:f4bb143d…d2a86f5a`                                                    |
| Restic                                                                   | `restic/restic:0.19.1` `sha256:136600b6…c9a4d510`                                              |
| gitleaks                                                                 | `zricethezav/gitleaks:v8.30.1` `sha256:c00b6bd0…c8abbb7f`                                      |
| Trivy                                                                    | `aquasec/trivy:0.76.2` `sha256:8f6bb947…499768fb`                                              |
| Better Auth                                                              | 1.7.19                                                                                         |
| Zod / Hono / Drizzle ORM / Drizzle Kit                                   | 4.6.7 / 4.13.17 / 0.45.4 / 0.31.11                                                             |
| pg / pg-boss                                                             | 8.23.1 / 12.38.1                                                                               |
| React / TanStack Query / Scalar reference / Scalar parser                | 19.3.1 / 5.107.1 / 1.77.0 / 0.29.20                                                            |
| AWS SDK S3 / @next/env / python-dotenv                                   | 3.1165.0 / 16.4.6 / 1.2.4                                                                      |
| TypeScript / Vitest / fast-check / ESLint / typescript-eslint / Prettier | 6.0.3 / 5.1.0 / 4.10.2 / 10.14.0 / 8.72.2 / 3.9.10                                             |
| Actions                                                                  | checkout v7.0.1, setup-node v7.1.0, pnpm/action-setup v6.1.1, setup-python v7.1.0 (all by SHA) |

Full digests and SHAs are in `infra/dependencies.lock.json`. No pre-release is pinned.

## Server sizing for OWN-2 (estimate from Doc 06 §11)

Peak memory on one host, all figures estimated:

| Consumer                                     | Basis                                                                                                                                   | Estimate             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| API, 2 processes                             | Node baseline ~150 MB each; up to 2 large responses per process, 48 MiB body each, held about twice (assembled set + serialized buffer) | 2 × ~350 MB = 0.7 GB |
| Provisioner                                  | one Node process, 2 concurrent jobs                                                                                                     | 0.2 GB               |
| PostgreSQL 18                                | `max_connections` 100 (pools 20 + 20 + 6 + 4 used), ~10 MB per backend, 1 GB shared buffers                                             | 2.0 GB               |
| OpenBao                                      | Raft with a small data set (8 MiB of live values per environment, 20 versions)                                                          | 0.5 GB               |
| Traefik                                      | one router, TLS                                                                                                                         | 0.1 GB               |
| Backup capture                               | `pg_dump`, Raft snapshot, Restic pack of one pair (transient)                                                                           | 0.4 GB               |
| OS, Docker, WireGuard, logs, probe heartbeat | Ubuntu 24.04                                                                                                                            | 0.8 GB               |
| **Total at peak**                            |                                                                                                                                         | **≈ 4.7 GB of 8 GB** |

- **CPU:** 4 vCPU covers two API processes, PostgreSQL, OpenBao and one backup or password-hash burst at the same time.
- **Disk:** OS and images ~12 GB; PostgreSQL including 365 days of audit < 5 GB; OpenBao Raft < 2 GB; local staging for one full pair (dump + snapshot + Restic repository + bundle) ~3 GB; audit reserve 2 GiB; logs ~5 GB; the 15 % / 2 GiB free-space floor ~12 GB. About 41 GB of 80 GB.

**Verdict: 4 vCPU / 8 GB / 80 GB confirmed.** OVHcloud C3-8 (4 vCPU / 8 GB / 100 GB NVMe) fits. Run 1.5 adds the measured idle memory of PostgreSQL and OpenBao as a cross-check.

## Deviations and decisions

- D-12 records the Node line, the tool choices and the TypeScript 6 decision.
- `engines.node` is a range (`>=24.18.0 <25`) while `.node-version` is exact, so the owner's workstation (24.18.0) keeps working. The workstation is two security releases behind the pin.
- The "forbidden components" check is a plain substring search of `pnpm-lock.yaml`, as the plan words it; it is deliberately strict.

## Open issues

- Owner: update Node on the workstation to 24.22.2 (24.18.1 and 24.22.1 were security releases).
- Traefik 3.7.18 to be reviewed when its image is published (Run 2.5 pin check).
- Registry note for Run 1.10: PO-24 becomes `SPIKE_PASS` with this note as evidence.
