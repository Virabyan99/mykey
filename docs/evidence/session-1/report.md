# Session 1 report — Foundation

**Date:** 10 November 2026 (Day 1); Run 1.9 finished on 11 November 2026 · **Branch:** `session-1`, then `run-1.9-fixture` · **Plan:** `docs/plans/session-1-plan.md`

## Result

**PASS WITH ISSUES.**

All ten runs are complete. Run 1.9 (R2 retention fixture) was finished one day late, on 11 November 2026, when the owner supplied the Cloudflare bootstrap token: the eight tokens exist, the fixture is uploaded and its lock clocks are running. The issues that keep this from a plain PASS are in the table below.

## What works now

A new agent can clone the repository and run three commands. This was done in a fresh clone outside OneDrive (`C:/Users/gmpar/mykey-gate`, commit `b14a616`):

| Command                          | Result                             | What it proves                                                                                                                                            |
| -------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | exit 0, 14.9 s                     | The lockfile is complete; every dependency is an exact pin from `infra/dependencies.lock.json`.                                                           |
| `pnpm run stack:up`              | exit 0, `stack mykey-dev is up`    | Real PostgreSQL 18.6 and OpenBao 2.7.2 start with TLS from a private CA, by image digest.                                                                 |
| `pnpm run test:integration`      | exit 0, 10 files, 267 tests, 106 s | Roles, grants, migrations, tenancy constraints, OpenBao namespaces and KV, the dotenv loaders and the Restic pair builder work against the real services. |

On the same commit: `pnpm run check` exit 0 (format, lint, types, pins, OpenAPI current, schema drift, evidence registry), `pnpm test` 361/361, CI run 42844480904 green (jobs `check`, `unit`, `integration`, `secret-scan`, `dependency-scan`, `image-scan`, `scanner-selftest`, `changes`, `cli-matrix`).

What exists:

- **Run 1.2 — skeleton.** pnpm workspace, strict TypeScript, ESLint, Prettier, Vitest projects `unit`, `integration`, `cli`, `cloud`.
- **Run 1.3 — pins.** One lock file for Node, images, npm packages, Python packages and Actions; `pins:verify` in `check`; two clean builds with the same hash.
- **Run 1.4 — CI.** CI fails on a seeded secret and on a seeded vulnerable dependency, and the self-test fails if a scanner crashes or scans nothing.
- **Run 1.5 — local stack and harness.** `stack:up`, `stack:down`, `stack:status`; the test harness.
- **Run 1.6 — contracts.** Limits, names, ids, 30 error codes, the operation envelope, 41 frozen routes, generated OpenAPI 3.1.
- **Run 1.7 — database base.** 18 `app` tables, `audit.event`, five least-privilege roles, three migrations, a migrator with checksums, a drift check.
- **Run 1.8 — dotenv codec.** Strict parser, canonical writer, loader warnings checked against the pinned `@next/env` and `python-dotenv`.
- **Run 1.9 — R2 retention fixture.** Four buckets, three lock rules, eight scoped tokens; a synthetic fixture of three `pairs/` pairs (locked until 15 Nov 2026), two `probe/` pairs (locked ten minutes) and two unlocked controls; cloud tests that show R2 refusing overwrite, delete and bulk delete of locked objects; a cost sheet.
- **Run 1.10 — registry.** 102 requirements, 60 acceptance criteria and 29 proofs mapped to runs; `evidence:verify` in `check`.

## What failed or was deferred

| Item                                          | State                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run 1.9**                                   | Done on 11 Nov 2026, one day late; see `run-1.9.md`. PO-9, R2-L1 and COST-B1 stay `OPEN` by design: the fixture is started, nothing is passed.                                                    |
| GitHub Actions secrets for the fixture tokens | **Not set.** The agent session was not permitted to write to the secret store. No CI job runs the cloud tests yet, so nothing fails; see `run-1.9.md` for the five secret names.                  |
| Cloud tests after 15 Nov 2026                 | The refusal tests stop with an error once the `pairs/` lock is within an hour of its end, so that they cannot delete the fixture. From then until Run 6.6, `pnpm run test:cloud` fails by design. |
| Image scan                                    | Green only through `.trivyignore.images` (46 upstream image CVEs without a fix), which expires on 20 Nov 2026.                                                                                    |
| Branch protection                             | Not available on a free private repository. Nothing stops a direct push to `main`.                                                                                                                |
| Workstation Node                              | 24.18.0; the pin is 24.22.2 (`engines` allows `>=24.18.0 <25`). CI uses the pin.                                                                                                                  |
| Staging demonstration                         | Not applicable in Session 1 (Doc 10 §4.5 starts in Session 2).                                                                                                                                    |

Open issues carried forward:

- **Database:** `api_runtime` can update columns of `secret_version_event`, `membership.user_id` and `effect_slot.operation_id`; database-level `REVOKE`/`GRANT CONNECT` must be applied again after a restore without `--create` (`docs/runbooks/db-globals-inventory.md`).
- **Dotenv:** an export can be larger than the 1 MiB import limit (8 MiB of values, escaping can double a value); `serializeDotenv` does not refuse it. The `@next/env` key-loss case is a warning today; whether the export screen should do more is a product decision.
- **Contracts:** 21 routes have pending bodies (list below).

## Decisions taken

- **D-12** Node 24 LTS and toolchain pins (TypeScript 6.0.3, not 7.0.2, because of the linter's peer range).
- **D-13** CI uses the same Compose stack as the workstation.
- **D-14** Error code list (30 codes, one HTTP status each).
- **D-15** Route list frozen (41 routes).
- **D-16** R2 token model (decided; tokens created 11 Nov 2026; the admin credential file also holds the API token).
- No pre-authorised fallback of D-09 was used.
- D-01 … D-11 are still "ASSUMED — awaiting owner".

The executing agent's own rulings (deviations from the plan) are listed in the final chat message of the session and summarised in each run note.

## Pins

| Component       | Version                                  |
| --------------- | ---------------------------------------- |
| Node            | 24.22.2 (line 24 LTS)                    |
| pnpm            | 10.20.0                                  |
| PostgreSQL      | 18.6 (image by digest)                   |
| OpenBao         | 2.7.2 (image by digest)                  |
| Traefik         | 3.7.17 (image by digest; not run yet)    |
| Better Auth     | 1.7.19 (catalog only; not installed yet) |
| Restic          | 0.19.1 (image by digest)                 |
| Drizzle ORM     | 0.45.4 (drizzle-kit 0.31.11)             |
| Zod             | 4.6.7                                    |
| TypeScript      | 6.0.3                                    |
| Vitest          | 5.1.0                                    |
| gitleaks, Trivy | v8.30.1, 0.76.2 (images by digest)       |

`infra/dependencies.lock.json` SHA-256 at the reviewed commit `b14a616`: `db3c60dd718615af036bd174ad7d9e9c41acc0c50d855615be94b444e2c144a1`.

## Reviewer findings

One fresh-context reviewer (most capable model) read `git diff origin/main...session-1` at `b14a616` in the fresh clone, ran `check`, the unit and integration suites and the scanners, and probed the contracts by hand. **No critical finding. Six important findings, all fixed test-first in one pass** (commits `a8c98a3`, `9492d28`, `2118131`, `694787b`); after the pass `check` exits 0, `pnpm test` is 374/374 and `pnpm run test:integration` is 270/270.

### Fixed

| Finding                                                                                                                                                | Fix                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The secret scan was green with `0 commits scanned` (gitleaks exits 0 outside a Git repository) and would be on a shallow checkout.                     | `ci-scan.ts secrets` now fails on a shallow history, on a git or gitleaks error line, and when no commit was read. A test pins `fetch-depth: 0` in the CI job.                |
| The dependency coverage guard accepted a lockfile row marked "not scanned" (graded minor by the reviewer, raised to important here: same false green). | The guard needs a count on the `pnpm-lock.yaml` row.                                                                                                                          |
| The scanner self-test used its own gitleaks config, so it said nothing about `.gitleaks.toml`.                                                         | A test requires the self-test config to equal `.gitleaks.toml` minus its allowlist, and the allowlist to be exactly the seeded-fixture path. Widening it makes the test fail. |
| Three tables accepted rows across tenants: `machine_credential.project_id`, `secret_version_event`, `import_preview` (Doc 06 §3).                      | Migration `0002_ancestry_foreign_keys.sql` adds composite foreign keys; three new tenancy tests.                                                                              |
| `evidence:verify` accepted any existing file as evidence.                                                                                              | Evidence must sit under `docs/evidence/` or `docs/decisions/` and state the item id and the status on one line; `CUT` needs a decision record.                                |
| `quarantined` was missing from seven routes, among them `/v1/version` (Doc 06 §9: "gate still applies").                                               | Every route except `health.get` lists it; OpenAPI regenerated.                                                                                                                |
| A project or credential name sent in NFD passed the contract unchanged and would have failed the database check.                                       | The contract returns the NFC form.                                                                                                                                            |

### Open (minor, deferred to the owner's judgement)

1. `serializeDotenv` does not bound total size; an export over 1 MiB is refused by `parseDotenv`.
2. `.trivyignore.images` ignores 46 CVE ids across all four images instead of per image.
3. `migrate()` does not check that it runs as `migration_owner`, accepts an empty migrations directory, and waits for its advisory lock without a timeout.
4. `api_runtime` can update `secret_version_event` columns, `membership.user_id` and `effect_slot.operation_id`.
5. `PUBLIC` keeps `CONNECT`/`TEMP` on the `postgres` and `template1` databases; the globals inventory does not list them.
6. `roles.ts` builds `ALTER ROLE … PASSWORD` by string (inputs are constants and a validated verifier).
7. Dotenv issues echo a valid-shaped name; a secret pasted as a name reaches diagnostics. By design, but the runbook does not say so.
8. A zero-width-only project name passes `checkProjectName`.
9. The error envelope requires a UUID `requestId`; the plan says string.
10. `RouteDef.request` has no schema for path parameters.
11. `pins-verify` matches only block-style `image:` and `uses:` lines; `ci.yml` pins Python as `3.12` (floating patch).
12. `deleteObjectsChecked` does not split more than 1,000 keys and has never run against R2. (Update: it ran against R2 in the cloud tests on 11 Nov 2026; the 1,000-key limit is still open.)
13. Weak tests: the CLI target assertion runs only when `MYKEY_EXPECT_TARGET` is set; the "recorded" delete answer is hand-written; the wrong-password test accepts any restic failure; the pending-route snapshot cannot enforce "only shrink"; the "no secret column" test checks four exact names; the dotenv no-leak test places canaries only in invalid names and in values.

### Not judged by the reviewer

The authenticity of pinned digests, action SHAs and wheel hashes and the status of the 46 ignored CVEs; Cloudflare state and R2 behaviour; and these files, which the reviewer did not read: the stack and toolchain tests, the limits and names tests, the registry test, `contracts-openapi.ts`, the Drizzle schema source (the generated SQL was read instead), run notes 1.1–1.3, 1.5 and 1.6, D-12, D-13 and two runbooks.

Found sound, with no false pass: the privilege matrix (exact SQLSTATE `42501`, catalog sweep of 20 tables × 5 grantees × 8 privileges), the tenancy tests, the migrator tests, the dotenv rejected-construct and fixture tests, the loader test (fails, not skips, without Python), the pin tests and the OpenAPI tests.

## What Session 2 must know

- **Harness** (`tests/harness/stack.ts`): `startStack(opts?)`, `getSharedStack()`, `freshDatabase(…)`, `freshNamespace(…)`, `baoFetch(stack, path, init?)`, `mountKvV2(stack, namespace, mount?)`, `restartService(stack, "postgres" | "openbao")`, `stackDirectory(project)`, `DEV_PROJECT = "mykey-dev"`. A new KV v2 mount answers 400 "Upgrading" for a moment; `mountKvV2` waits for it.
- **Roles:** `migration_owner`, `api_runtime`, `provisioner_runtime`, `backup_reader`, `maintenance`. `applyRoles(superuser, passwords)` creates them without passwords from `packages/db/roles/roles.sql`, then sets each password as a SCRAM-SHA-256 verifier computed on the client (at least 16 printable ASCII characters), and makes `migration_owner` the database owner — all in one transaction that locks `pg_authid`. The plain password never appears in a statement.
- **Schemas:** `app` (18 tables), `audit` (`event`), `meta` (`schema_migration`, created by the migrator), `auth` and `jobs` (empty, reserved for Better Auth and the job queue).
- **Migrations:** `pnpm run db:generate` (Drizzle), hand-written files with `drizzle-kit generate --custom`; `migrate()` refuses a changed, missing or out-of-order file. `drizzle-kit` exits 0 when it crashes — `db:check` looks for its completion message.
- **CI jobs:** `check`, `unit`, `integration`, `secret-scan`, `dependency-scan`, `image-scan`, `scanner-selftest`, `changes`, `cli-matrix`.
- **Credentials:** on the owner's workstation under `~/.mykey/` (outside the repository and OneDrive): SSH key `~/.mykey/ssh/`, eight R2 token files `~/.mykey/secrets/r2/<token name>.json`, Cloudflare bootstrap token `~/.mykey/secrets/cloudflare/bootstrap-token`, Restic fixture password `~/.mykey/secrets/retention-fixture/restic-password`. The custody list is `docs/runbooks/credential-custody.md`.
- **Retention fixture:** uploaded on 11 Nov 2026 at 10:42 UTC to `mykey-retention-fixture`. Every object, its upload time as R2 reports it and its `lockExpiresAt` are in `docs/evidence/session-1/retention-fixture.json`. The `pairs/` lock ends on **15 Nov 2026 at 10:42 UTC**. Checkpoints: `pairs-lock-session-gate` (first session gate on or after that time) and `run-6.6-cleanup-and-restore`. One probe pair (`probe-20261111-2`) and two `scratch/` controls are left for Run 6.6 to clean up. `pnpm run test:cloud` needs the workstation's credential files.
- **R2 findings:** a refused overwrite or delete answers HTTP 409 `ObjectLockedByBucketPolicy`; a bulk delete answers HTTP 200 and lists the refusal per object; R2 writes the id of one multipart upload as a different string every time it reports it, so ids cannot be compared, but each of them aborts the upload; a 600-second lock rule is accepted.
- **Canaries:** never write a literal `MYKEY_CANARY_` followed by 32 characters outside `tests/fixtures/ci/seeded-secret/`; tests assemble canaries at run time.
- **Pending routes (21):** `version.get`, `organizations.list`, `projects.list`, `environments.list`, `secrets.list`, `secrets.history`, `secrets.reveal`, `import.preview`, `credentials.list`, `credentials.issue` (201 body), `operations.list`, `audit.list`, `activity.list`, `overview.get`, `credentials.summary`, `metrics.get`, `session.activity`, `auth.reset.complete`, `reference.get`, `openapi.get`, `machine.keys`. The owning run fills each in with a commit titled `contract: …`.
- **Idle memory of the stack:** PostgreSQL 37.5 MiB, OpenBao 22.1 MiB.
- **Server sizing verdict:** 4 vCPU / 8 GB RAM / 80 GB SSD per host is enough (OVHcloud C3-8 or nearest).
- **Windows notes:** `nul.*` is a device name — no fixture may be called that; the repository sits in OneDrive, so worktrees and clones for heavy work go outside it.

## Owner actions pending

| Action                                                                                                                                                                            | Needed by                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Optional: store the two fixture tokens as GitHub Actions secrets (command in `run-1.9.md`), and revoke the Cloudflare bootstrap token once no token needs to be created or rolled | before a CI job runs the cloud tests |
| **OWN-1:** confirm D-01 … D-11 (D-04 and D-05 need an explicit yes); the domain for production and staging and whether Cloudflare manages it; where alerts go                     | domain by Run 2.5, alerts by Run 2.6 |
| **OWN-2:** two OVHcloud instances (`mykey-prod`, `mykey-staging`, 4 vCPU / 8 GB / ≥ 80 GB, Ubuntu 24.04, one region that offers KMS, the `mykey-ops` public key)                  | start of Run 2.5 (Day 2, midday)     |
| **OWN-3:** OVHcloud KMS activated in the same region                                                                                                                              | Run 2.7 (Day 3)                      |
| Optional: update the workstation's Node to 24.22.2                                                                                                                                | any time                             |
