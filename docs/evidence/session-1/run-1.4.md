# Run 1.4 — CI pipeline

## What was done

- `.github/workflows/ci.yml` with jobs `check`, `unit`, `integration`, `secret-scan`, `dependency-scan`, `image-scan`, `scanner-selftest`, `changes` and `cli-matrix`. Top-level `permissions: contents: read`; every Action pinned by commit SHA; checkout with `persist-credentials: false`.
- `scripts/ci-scan.ts` runs gitleaks and Trivy as containers by the digests in `infra/dependencies.lock.json`; the same commands run locally and in CI.
- `.gitleaks.toml` (default rules + `mykey-canary`), `.gitleaksignore` (one reviewed false positive), `.trivyignore` (empty), `.trivyignore.images` (46 reviewed upstream image findings, all expiring 2026-11-20).
- Seeded fixtures: `tests/fixtures/ci/seeded-secret/sample.txt` (synthetic canary), `tests/fixtures/ci/vulnerable-dep/` (lodash 4.17.20, advisory GHSA-35jh-r3h4-6jhm / CVE-2021-23337, HIGH, fixed in 4.17.21 — verified in the GitHub Advisory Database on 2026-11-10).
- First integration test (`tests/integration/toolchain/toolchain.test.ts`): each pinned image reports its pinned version.
- A first real CLI test (`tests/cli/cli.test.ts`, Vitest project `cli`) so the four-platform matrix has something to run; it asserts that each runner really is the target the matrix claims.
- Decision record D-13.

## Commits

- `e8da4a8` ci: check, tests, secret, dependency and image scanning with self-test
- the commit that adds this note

## Commands and results

| Command                                                          | Exit    | Proof line                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test` before `scripts/ci-scan.ts` existed                  | 1       | `Cannot find module '../../../scripts/ci-scan.ts'`                                                                                                                             |
| `pnpm --filter @mykey/cli test` before the CLI constants existed | 1       | `expected undefined to be 'secrets'`                                                                                                                                           |
| `pnpm run test:integration`                                      | 0       | `Tests 5 passed (5)`                                                                                                                                                           |
| `node scripts/ci-scan.ts selftest`                               | 0       | `scanner detected the seeded secret (scanner exit 3)`, `scanner detected the seeded vulnerability (scanner exit 3)`                                                            |
| `node scripts/ci-scan.ts secrets`                                | 0       | `no leaks found`                                                                                                                                                               |
| `node scripts/ci-scan.ts dependencies`                           | 0       | `pnpm-lock.yaml │ pnpm │ 0`                                                                                                                                                    |
| `node scripts/ci-scan.ts images`                                 | 0       | four images scanned, no finding outside the reviewed list                                                                                                                      |
| `pnpm test`, `pnpm run check`                                    | 0       | `Tests 29 passed (29)`, `pins: ok`                                                                                                                                             |
| First CI run on `session-1`                                      | success | <https://github.com/Virabyan99/mykey/actions/runs/42830654946> — all 12 jobs green, including `cli-matrix` on `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15-intel`, `macos-15` |

## Live negative proof (the run's "done when")

| Branch (deleted afterwards, never merged) | Change                                                                         | Result                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci-proof/seeded-secret`                  | a file outside the allowlisted path containing a fresh `MYKEY_CANARY_…` string | <https://github.com/Virabyan99/mykey/actions/runs/42831179061> — `secret-scan` **failed**: `WRN leaks found: 1`, `scan: secrets in Git history reported findings`. Every other job passed.                                                                                                       |
| `ci-proof/seeded-vuln`                    | `lodash@4.17.20` added to the root `devDependencies` and `pnpm-lock.yaml`      | <https://github.com/Virabyan99/mykey/actions/runs/42831197350> — `dependency-scan` **failed**: `Total: 2 (HIGH: 2, CRITICAL: 0)`, `lodash │ CVE-2021-23337 │ HIGH │ fixed │ 4.17.20 │ 4.17.21`. `check` and `unit` also failed, because `pins:verify` rejects a package that is not in the lock. |

Both remote branches were deleted after the runs were read.

## Deviations and decisions

- **Found while testing locally: the dependency scan was scanning nothing.** Trivy skips development dependencies by default; this repository's whole toolchain is development dependencies, so the scan printed "Supported files for scanner(s) not found" and exited 0. Fixed with `--include-dev-deps`, and the job now fails if its report does not list `pnpm-lock.yaml`.
- **Self-test is stricter than the plan.** It passes only when the scanner exits with the "finding" code (3) and names the seeded item, so a scanner that crashes cannot pass it.
- **`.trivyignore.images` is separate from `.trivyignore`.** The pinned PostgreSQL, OpenBao and Restic images carry 46 HIGH/CRITICAL findings that upstream has fixed in source but not yet in the published images (Go standard library inside `gosu`, `bao` and `restic`; Debian `zlib1g`; Alpine `openssh`, `jq`, `musl`, `openssl` in the Restic image). Traefik is clean. They are listed one by one with a reason per group and expire on 2026-11-20, so the scan fails again before the release candidate is frozen. The repository's own dependency scan uses the empty `.trivyignore`.
- **One gitleaks false positive** (`generic-api-key` on a prose table row in specification document 02) is recorded by fingerprint in `.gitleaksignore`; the document itself is untouched.
- **`secret-scan` reads every branch of the remote** (`fetch-depth: 0`). While `ci-proof/seeded-secret` existed, `secret-scan` was red on the other proof branch too. A leaked value on any branch keeps every branch red until it is removed, which is the behaviour wanted.
- **`cli-matrix` is a job inside `ci.yml`** guarded by a small `changes` job (diff against the previous push, the pull-request base, or the merge-base with `main`), because GitHub has no per-job path filter. It also runs on manual dispatch.
- A fourth Vitest project, `cli` (`tests/cli/**`), was added for the CLI test; `pnpm test` still runs only `unit`.
- Runner labels were taken from the `actions/runner-images` README and GitHub's hosted-runner reference on 2026-11-10.

## Open issues

- **The image scan is green only because of the reviewed ignore list.** 46 entries, all expiring 2026-11-20. Run 2.5 (pin review) and Run 8.1 (release freeze) must re-check for rebuilt images: PostgreSQL 18.x, OpenBao 2.7.x, Restic.
- Canaries in test code must be assembled at run time (for example by string concatenation); a literal `MYKEY_CANARY_` + 32 characters anywhere outside `tests/fixtures/ci/seeded-secret/` fails `secret-scan`.
- Trivy downloads its vulnerability database at scan time; that download cannot be pinned by digest.
- Branch protection is still not available on this private repository's plan.
