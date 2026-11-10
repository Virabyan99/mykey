# D-13 — CI uses the Compose stack and container-image scanners

**Date:** 2026-11-10

**Status:** DECIDED by the session planner (P-5, P-6), recorded by the executing agent in Run 1.4

## Decision

1. **CI starts PostgreSQL and OpenBao with the same Docker Compose file as local development** (`infra/compose/dev.compose.yml`, from Run 1.5), not with GitHub Actions `services:` containers. OpenBao needs a mounted configuration file and generated TLS material, and service containers start before the repository is checked out. The integration tests therefore run against the same real containers, from one definition, on the workstation and in CI.
2. **The scanners (gitleaks, Trivy) run as digest-pinned container images**, started by `scripts/ci-scan.ts`, not as third-party Actions. The workflow uses only four Actions (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`, `actions/setup-python` from Run 1.8), each pinned by commit SHA.

## What it changes

- Doc 10 Run 1.4 says "PostgreSQL and OpenBao as service containers". They are real containers either way; only the mechanism that starts them differs.
- The scan commands are identical locally and in CI: `node scripts/ci-scan.ts secrets | dependencies | images | selftest`.

## Details settled in Run 1.4

- **Finding versus crash.** Both scanners are told to exit with code 3 when they report a finding. The self-test passes only on exit 3 **and** when the output names the seeded item (`mykey-canary`, `lodash`). A scanner that crashes or cannot download its database exits 1 and fails the self-test instead of passing it.
- **Development dependencies are scanned.** Trivy skips them by default; in this repository the whole toolchain is development dependencies, so without `--include-dev-deps` the scan read nothing and still exited 0. The dependency scan now also fails if its report does not list `pnpm-lock.yaml`.
- **Two ignore files.** `.trivyignore` covers the repository's own dependencies and is empty. `.trivyignore.images` holds reviewed findings inside upstream images, which cannot be fixed here; it is used only by the image scan, so an image exception can never hide a finding in our own dependencies. Every entry expires on 2026-11-20.
- **gitleaks false positives** are recorded by exact fingerprint in `.gitleaksignore` (one entry: a prose table row in specification document 02). Canaries in test code must be assembled at run time, never written as a literal outside `tests/fixtures/ci/seeded-secret/`.

## Amends

Doc 10 Run 1.4 ("service containers"). Nothing in Documents 04 or 06.
