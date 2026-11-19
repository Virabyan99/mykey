# D-57 — A host release is built once and promoted through the closed gate

**Date:** 2026-11-18

**Status:** DECIDED in Run 6.9 (P-127, P-128, P-131; Doc 06 §14; FR-1.73, FR-1.74; AC-1.32). Evidence:

- `docs/evidence/session-6/run-6.9.md`;
- `tests/unit/release/{schema,host-build,deploy-plan}.test.ts`, `tests/unit/hosts/images.test.ts`;
- `tests/integration/deploy/{failed-migration,previous-release,expire-resume,ops-sweep}.test.ts`;
- `tests/staging/deploy.staging.test.ts`.

## Decision

### Build once

`pnpm run host:release -- --version x.y.z` on a clean clone (outside OneDrive):

1. refuses a dirty tree and a commit that origin does not hold;
2. builds the `api`, `provisioner` and `ops` images with `MYKEY_BUILD` = the commit's first 12 hex;
3. refuses an image that still holds `npm`, `npx` or `corepack` (each final stage removes them; the images run as `1000:1000`, read-only in compose and `ops-run.sh`);
4. saves each image as `<name>.tar`;
5. runs the three scanners: the whole history, the dependencies, and the images over **these archives** (`ci-scan images --archives`);
6. only then writes `release.json` and `SHA256SUMS`.

`release.json` (`mykey-host-release/1`) names the commit, each image by id with its archive's digest, the base image digests from the lock, the last migration, and `scans` whose only possible value is `pass`. The release is published as a GitHub release `host-vX.Y.Z` with the archives, `release.json` and `SHA256SUMS`. Nothing is built on a host.

### Promote

`host.ts <host> deploy --release <dir>` plans, then walks eight steps:

| Step             | What                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `verify_release` | `SHA256SUMS` and each archive's digest                                                                                 |
| `load_images`    | each image loaded by id (skipped when the host has it), `API_IMAGE`, `PROVISIONER_IMAGE`, `OPS_IMAGE` in host.env      |
| `gate_close`     | the gate closed (v2: + `verifying`); the record before is kept for the report                                          |
| `migrate`        | `db-init` (roles, migrations, the incarnation); the incarnation copied into OpenBao where none is                      |
| `start`          | compose up; waits until the API runs the release's build                                                               |
| `journey`        | the owner through the verification listener: sign-in, a reveal compared with the last deploy's digest, a refused write |
| `report`         | `REQUIRED_CHECKS.deploy`; `operator.deploy`                                                                            |
| `gate_open`      | `gate open` with that report                                                                                           |

The plan refuses a release whose last migration is older than the host's (a downgrade), a commit that is neither an ancestor nor a descendant of the running build, and an image id named on the command line that the release does not list. A redeploy of the running build has no `migrate`. `--install-only` ends after `load_images` (a host that will be restored); `--stay-closed` ends after `start` (production without OpenBao or an owner).

A state line on the host (`/var/lib/mykey/deploy-state.json`) records each step done. A deploy that stops leaves the gate closed; `deploy --resume` continues from the next step, and refuses a state of another release.

### Roll back

A rollback is a deploy of the previous release: the same steps, journey and report included. Migrations only go forward, so a previous release must work on today's schema: the API of `45b5c1f3cc3a` works on a database at `0018` (`previous-release.test.ts`). That commit reads only a v1 gate record. Going back to it means writing a v1 record with that commit's own `host.ts` (`deploy.md`); this is rehearsed locally, not on staging.

## Why

An image built on the host, or rebuilt for each host, is not the image that was scanned. A deploy that opens without a fresh report can serve a release nobody verified on this data. A deploy that stops halfway must not serve at all.

## Costs

- Each release uploads three archives over the VPN (parts in parallel, about 40 kB/s per stream).
- The deploy report reads OpenBao with a token that may list namespaces (the custody root token on staging). Once M1 revokes it, deploys need another such identity.
- The first deploy records the journey's secret; only later deploys can prove "the same digest".
