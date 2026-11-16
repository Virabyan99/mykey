# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Keep this file current.** The gate run of every session updates the "Where we stand" and "Things already learned" sections. Detail belongs in the session report; this file holds only what every future session needs.

## What this is

MyKey Private is a single-operator secrets service. OpenBao holds secret values and versions; PostgreSQL holds accounts, permissions, operations and audit; a thin CLI starts an application with a complete secret set and no `.env` file. The GitHub repository is `Virabyan99/mykey` (public since 16 Nov 2026).

The project is in **Stage 1**, a 14-day plan of nine sessions.

- **Authority:** `docs/doc_10_…compressed_implementation_plan_v1.0.md` (the stage plan), with Doc 04 (functional specification) and Doc 06 (technical specification). Doc 08 is the older 47-session roadmap that Doc 10 replaces. Never rename or reformat a `docs/doc_*.md` file.
- **Three layers:** the stage plan (Doc 10) → one plan per session (`docs/plans/session-N-plan.md`, written by a planning agent) → execution by another agent. Do not start a session without its plan.
- **Rules that are never traded for speed:** Doc 10 §4.1. Read them before any run that touches secrets, permissions, audit or restore.

## Where we stand

_Last updated: 16 Nov 2026, at the Session 5 gate (pull request `session-5` → `main`, not merged yet)._

| Session | Topic                                                       | State                                |
| ------- | ----------------------------------------------------------- | ------------------------------------ |
| 1       | Foundation                                                  | **Done** (PASS WITH ISSUES), merged  |
| 2       | Infrastructure and make-or-break proofs                     | **Done** (GO, no fallback), merged   |
| 3       | Identity, access and resources                              | **Done** (PASS WITH ISSUES), merged  |
| 4       | Operations engine and secret lifecycle                      | **Done** (PASS WITH ISSUES), merged  |
| 5       | Machine access, CLI and API reference                       | **Done** (PASS WITH ISSUES), PR open |
| 6 ∥ 7   | Audit, limits, backup, recovery, deployment ∥ Web workspace | Not started                          |
| 8       | Security review and controlled-use release                  | Not started                          |
| 9       | Real use, agent experiment, stage exit                      | Not started                          |

What exists after Session 5 (details: `docs/evidence/session-5/report.md`, run notes `run-5.1.md` … `run-5.9.md`, D-40 … D-45; the base: `docs/evidence/session-4/report.md` and `session-3/report.md`):

- **API (`apps/api`):** the Session 3 pipeline (`mountRoute`) with handlers for every route of Sessions 3–5. The Session 4 secret, import, export and operation routes are unchanged. New in Session 5:
  - `credentials.list|issue|revoke`, `projects.archive|reactivate`, `environments.archive|reactivate`;
  - the machine routes `machine.keys|resolve`, authenticated by the bearer's own `lookup-self`;
  - `openapi.get` and `reference.get` (owner and admin; `/v1/reference` is a self-contained Scalar page, D-45).

  The API holds two OpenBao identities: `runtime` (inline AppRole) and `issuer` (short sessions, for issuance and revocation). Machine reads use the presented token itself. Its 30 s sweep also settles stale credential work and drives archives.

- **Operations (`@mykey/operations`):**
  - Session 4's engine;
  - credential issuance and revocation with markers, and their sweep (D-40);
  - archive (close first, revoke and verify, then archived) and reactivation (D-41, migration `0014`'s guarded transition function);
  - the complete read with a machine reader, with the admission rechecked at commit (D-42).

  `/operator` adds `reconcileCredentials`, run as `ops reconcile-credentials` (runbooks `machine-credentials.md`, `reconciliation.md`). Migrations up to `0014`.

- **CLI (`apps/cli`):**
  - `secrets keys | run | export`: one esbuild bundle on the pinned Node, released as `cli-v0.1.1` with `install.sh` (D-43, D-44);
  - consumer runbooks `consumer-local.md` and `consumer-deploy.md`, with the launch wrapper `tests/fixtures/consumers/secrets-launch.sh`.

  Proven from the release on Linux x64 and arm64 and macOS x64 and arm64 (`cli-matrix.md`, run 43857539084).

- **Staging** runs API `45b5c1f3cc3a` and the matching provisioner, gate open, nothing in review or unresolved. The staging owner is `owner@mykey-staging.invalid` (credentials in `~/.mykey/secrets/hosts/staging/`), with organization `e2350312-…`. **Production** runs the same API with migrations up to `0014` and no gate file (every route `quarantined`; no OpenBao, provisioner or owner there). Production deploys need the owner's permission.
- **Evidence registry:** 116 `SPIKE_PASS`, 75 `OPEN`, nothing `PASS`.

Before Sessions 6 ∥ 7 can start:

- **Merged and answered:** PR #12 is merged, production is updated, and the macOS matrix passed (16 Nov 2026).
- **Plans:** each session needs its plan (`docs/plans/session-6-plan.md`, `session-7-plan.md`) built on the report's "What Sessions 6 and 7 must know". In short:
  - the new audit actions and the machine actor;
  - every rate limit, including unauthenticated machine requests (Run 6.3);
  - `ops reconcile-credentials` for every environment after a restore;
  - host timers for the sweeps (Run 6.9);
  - the workspace's credential, archive and reference screens (Session 7).
- **Dated items:**
  - The R2 fixture guard: `test:cloud` fails on purpose from 15 Nov 2026 09:42 UTC until Run 6.6.
  - `.trivyignore.images` expires on 14 Dec 2026.
  - **All KMS certificates expire on 12 Dec 2026** (staging seal 10:50 UTC); replace them before then (runbook `kms-and-unseal.md`). Checkpoint `kms-cert-expiry` from 12 Dec 2026 09:57 UTC.

## Commands

Node 24 (exact version in `.node-version`) and pnpm 10.20.0 through `corepack enable`. Docker with Compose is needed for everything except `check` and the unit tests.

```sh
pnpm install --frozen-lockfile
pnpm run check              # format, lint, types, pins, OpenAPI current, schema drift, authority matrix, auth route contract, evidence registry
pnpm test                   # unit tests
pnpm run test:integration   # starts its own PostgreSQL + OpenBao stack in Docker, removes it afterwards
pnpm run test:cloud         # real Cloudflare R2; exits 1 without the credential files in ~/.mykey/secrets/r2/
pnpm run test:staging       # the staging host over the VPN (about 1.5 h with drills; reboots staging); needs ~/.mykey
pnpm run test:cli           # project cli in a Linux container (the only way on Windows); --release <dir> tests a downloaded release
pnpm run test:browser       # the reference page in Chromium (once per workstation: pnpm exec playwright install chromium)
pnpm run test:consumers     # the consumer runbooks rehearsed against staging from clean containers (WSL Ubuntu + Docker; ~17 min)
```

One file or one test:

```sh
pnpm exec vitest run --project unit tests/unit/dotenv/parse.test.ts
pnpm exec vitest run --project integration tests/integration/database -t "second run applies nothing"
```

Other scripts:

```sh
pnpm run stack:up | stack:down | stack:status   # the dev stack `mykey-dev`, for work by hand
pnpm run contracts:openapi                      # regenerate packages/contracts/openapi after a route change
pnpm run reference:asset                        # copy Scalar's build into apps/api/assets (without it /v1/reference answers 503)
pnpm run cli:build | cli:release -- --version <v>   # the CLI bundle; a release (version = apps/cli/package.json)
pnpm run db:migrate                             # apply migrations
pnpm run evidence:build                         # rebuild docs/evidence/registry.json after editing registry-overrides.json
node scripts/host.ts <staging|prod> <command>   # operator tool for the hosts (usage: run it without arguments)
node scripts/probe.ts deploy | secrets | state <host>   # the probe Worker
node scripts/ci-scan.ts secrets | dependencies | images | selftest   # the CI scanners, locally
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops <command> [--flag v]   # operator commands (apps/ops) as maintenance over a tunnel
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> gate open|close|status       # the external service gate
```

Operator commands: `bootstrap-owner`, `reset-account`, `auth-cleanup`, `provision-organization`, `verify-organization` (runbooks `operator-accounts.md`, `provisioning.md`). In tests the provisioner runs as a child process (`startProvisionerProcess` in `tests/harness/api-worker.ts`; `tests/integration/provisioning/fixture.ts` sets up tenants with a provisioned organization).

New migration: run `node node_modules/drizzle-kit/bin.cjs generate --name <name>` inside `packages/db` (`pnpm run db:generate -- --name x` is rejected). Read the generated SQL: drizzle-kit can emit a foreign key before the unique key it needs, and it exits 0 when it crashes. `pnpm run db:check` is the proof that schema and migrations agree.

Scripts in `scripts/` and `infra/` are TypeScript run directly by Node (type stripping), so they use erasable syntax only: no enums, no parameter properties.

## Architecture

- **Two stores, one owner per fact.** Secret values and versions live only in OpenBao (one namespace per organization, KV v2). PostgreSQL holds metadata, permissions, operations and audit, and never a secret value or a machine token.
- **`packages/contracts`** is the single source for limits (Doc 06 §11), name rules, ids, error codes (one HTTP status each), the operation envelope and the route table. `openapi.json` is generated from the route table and `contracts:check` fails when it is stale. The route list is frozen (D-15); 21 routes still have pending bodies, and the run that owns a route fills it in with a commit titled `contract: …`.
- **`packages/db`**: schemas `app` (18 tables), `audit` (`event`), `meta` (`schema_migration`), `auth` (Better Auth's 8 tables, migration `0003`) and `jobs` (empty, reserved for the job queue). Roles: `migration_owner`, `api_runtime`, `provisioner_runtime`, `backup_reader`, `maintenance`. Tenancy is enforced by composite foreign keys that carry `organization_id`. `migrate()` refuses a changed, missing or out-of-order migration file.
- **`@mykey/openbao`:** one namespace `org-<organizationId>` per organization, KV v2 at `kv`; policies and AppRole roles `runtime`, `issuer`, `provisioner`; token roles `machine-env-<environmentId>`. Runtime authenticates with inline AppRole (D-17); the provisioner never runs in the API process. A change whose answer is unclear is `unknown`, never a failure.
- **Request pipeline (D-26, D-31, D-33):** every route goes through `mountRoute` from `ROUTES`; authorization reads current rows on every request; a mutation needs an `Idempotency-Key` and replays a completed request before state and freshness checks. Handlers never decide authority. `@mykey/operations` has three entry points: root (jobs, outbox, gate, replay), `/operator` (organization provisioning, admin authority) and `/provisioner` (environment job, sweep); the API imports only the root (skeleton test).
- **Shape (Doc 06):** `apps/api` serves the routes, `apps/provisioner` is the only writer to OpenBao, `apps/web` is the owner workspace, `apps/cli` delivers secrets to a process (a thin CLI, not OpenBao Agent: D-24), `apps/ops` holds operator commands; `workers/probe` (built in Session 2) watches from outside.
- **Tests:** Vitest projects `unit`, `integration` (also `tests/fault`), `cli`, `cloud` (`tests/**/*.cloud.test.ts`), `staging` (`tests/staging/*.staging.test.ts`, one file at a time; a dated checkpoint file stays out until due). Harness: `tests/harness/stack.ts` (local stack: `freshDatabase`, `freshNamespace`, `baoFetch`, `mountKvV2`, `restartService`), `org-fixture.ts` (`createOrgFixture`), `tls-relay.ts` (network faults after the handshake), `staging.ts` (`connectStaging`, `sshExec`), `staging-db.ts`, `kms-spike.ts`. Mocks are not accepted as proof for anything involving the two stores.
- **Pins:** `infra/dependencies.lock.json` holds every version: npm packages exact, images by `@sha256:` digest, Actions by 40-hex SHA, release binaries (`okms-cli`) by SHA-256. `pins:verify` enforces it. No pre-release dependency, PostgreSQL 19, Redis, second queue, workflow engine, MCP server, or OpenBao Agent as a required component.

## How work is done here

- **Test first.** Write the failing test, watch it fail, make it pass. A suite with no tests fails; a skipped test is not a pass; a missing credential is a failure, not a skip.
- **Cloud tests describe provider behaviour.** A failure is a finding to record, never something to fix by weakening the assertion.
- **Evidence.** Every run ends with `pnpm run check` green, a commit and a run note `docs/evidence/session-N/run-N.M.md`. Every session ends with a gate run: full suite, a fresh-context review of the session's diff, and `docs/evidence/session-N/report.md`. Decisions get one page in `docs/decisions/D-NN-<slug>.md`.
- **Registry statuses:** `OPEN`, `SPIKE_PASS` (proven in isolation), `PASS` (proven on the integrated product), `FAIL`, `WATCH`, `CUT`. A status other than `OPEN` needs an evidence file that states the id and the status on one line; `CUT` needs a decision record.
- **Git:** never commit on `main`. Work on a branch, open a pull request, and merge only when the owner says so. `main` has no branch protection, so nothing else stops a direct push.
- **Synthetic data only** until Gate R is signed. Never write a literal `MYKEY_CANARY_` followed by 32 characters outside `tests/fixtures/ci/seeded-secret/`; tests assemble canaries at run time.
- **Credentials** live on the owner's workstation under `~/.mykey/`, outside the repository and outside OneDrive. `docs/runbooks/credential-custody.md` lists names and locations, never values. No value may appear in Git, logs, evidence files or chat; scripts print token names and ids only.
- **Owner and agent duties (D-11):** the owner buys OVHcloud resources and creates root credentials when asked; agents handle GitHub and Cloudflare.

## Things already learned

Workstation (Windows, Git Bash, repository inside OneDrive):

- Backslashes are halved or eaten in `node -e '…'` strings and heredoc-fed patch scripts. Edit any text with regexes or escapes with the editor tools, never through the shell.
- Worktrees, clones and heavy temporary work go outside OneDrive.
- `nul.*` is a Windows device name; no file may be called that.
- The workstation runs Node 24.18.0; the pin is 24.22.2 and CI uses the pin.

Tooling:

- TypeScript is pinned at 6.0.3, not 7, because of the linter's peer range (D-12).
- A new OpenBao KV v2 mount answers 400 "Upgrading" for a moment; `mountKvV2` waits for it.
- The image scan covers the pinned upstream images and the API image built from the repository (its own dependencies only). It is green only through `.trivyignore.images` (52 upstream CVEs without a fix), which **expires on 14 Dec 2026**.
- The secret scan must see the whole history and at least one commit; a scanner that crashes or scans nothing fails the self-test step of the `scans` job. Reviewed false positives go into `.gitleaksignore` by fingerprint, with the reason above them.
- GitGuardian (an external app on the repository) flags `-e PGPASSWORD postgres` in `tests/harness/stack.ts` as a password (incident 39994924). It is a false positive: the value is the stack's random password from the environment, and `postgres` is the Compose service name. Only the owner can dismiss it in the dashboard; it is not a required check.

Dotenv codec:

- Import is limited to 1 MiB, but an environment may hold 8 MiB of values, so a large export cannot be re-imported today.
- `@next/env` can lose a key in one case; today that is an export warning.

Cloudflare R2 (D-16, `docs/evidence/session-1/run-1.9.md`):

- A refused overwrite or delete of a locked object answers HTTP 409 `ObjectLockedByBucketPolicy`. A bulk delete answers **HTTP 200** and lists the refusal per object, so use `deleteObjectsChecked`, which never trusts the status.
- R2 writes the id of one multipart upload as a different string every time it reports it. Ids cannot be compared; each of them aborts the upload.
- S3 credentials of an R2 token: access key = token id, secret = SHA-256 hex of the token value. Lock rules are read and set through the Cloudflare REST API, which needs the token value itself.
- `infra/backup/retention-fixture/provision.ts` is safe to run again: it never weakens a live lock rule and rolls a token only with `--roll <token name>`. It needs a new bootstrap token at `~/.mykey/secrets/cloudflare/bootstrap-token`; the first one is revoked.
- `upload.ts` refuses to run when a fixture is already recorded: the lock clocks must not be restarted without a decision.
- The Cloudflare account holds other buckets that are not part of MyKey. Touch only the four `mykey-*` buckets.

Hosts (Session 2, `docs/runbooks/network.md`, `kms-and-unseal.md`):

- Reach hosts only over the VPN through `scripts/host.ts <staging|prod> <command>` and the harness `sshExec`. A secret crosses only on stdin; a command that names `/etc/mykey/secrets` or `/root/mykey-custody` must pass `secretOutput` (its output is then redacted). Never print a host secret.
- Every firewall or SSH change goes through `host.ts … apply` (timed automatic revert, confirmed from a new connection with `confirm`); a revert returns to the rules loaded before. Never reboot with a revert pending.
- `MSYS_NO_PATHCONV=1` before `host.ts` commands that take remote absolute paths in Git Bash.
- `docker save <name>:<tag>` (one tag): `host.ts image` refuses an archive with several images.
- Egress is per-purpose address sets; a container bridge reaches only its row of the table. The host itself reaches the `kms` set on 5696 (okms runs with the host network). Docker's resolver answers public names only on `mk-pub` and `mk-kms`.
- OpenBao with the KMIP seal: when the KMS is unreachable at start it waits on the connection (about 130 s with dropped traffic), exits and is restarted by Docker; a refused certificate makes it exit at once. A KMS outage does not seal a running OpenBao. A console KMS certificate is valid for 30 days only.
- `roles` are cluster-wide: never run `applyRoles` against a host's real database from a test (`stagingDatabase` exists for that).
- Production deploys need the owner's permission in this environment.

Auth (Better Auth 1.7.19, confirmed by test, D-19): sign-up is refused; a first account is created through the operator path; change-password with `revokeOtherSessions` drops the session to `password_verified`; the stock two-factor plugin fails the contract, factors are product-owned.

Session 3 (details in its run notes):

- **Watch CI after every push to a pull request** (`gh run list --branch <branch>`). It was red for the whole of Session 3 (heap of the typed lint, a gitleaks false positive, dev tooling in the API image) and nobody noticed until the gate.
- Python on Windows writes CRLF in text mode: open files with `newline=""` in edit scripts (migrations are prettier-ignored and keep the CRLF otherwise).
- Lock order in a transaction: take an update lock before any share lock on the same row; a share lock later raised to an update deadlocks two concurrent requests.
- pg-boss needs data rights on more of schema `jobs` than its happy path suggests (failure path, supervisor): with too few, a failing job stays `active` for ever and the error is swallowed. Our adapter must pass multi-statement results through.
- OpenBao 2.7.2 reads `token_bound_cidrs` with a `/32` back as the bare address; `secret_id_bound_cidrs` as written. A container reaches OpenBao by the name in its certificate (`openbao`), never by address.
- Node's permission model: a grant for a directory that does not exist at start does not cover files created in it; use `<dir>/*`.
- An environment variable whose name contains KEY or SECRET fails the compose secret check; name directories `…_DIR` without those words.
- A staging test that changes state must undo it in `finally`; two drills that stopped early left a review open and kept the probe alert up.
- Sign-in normalizes e-mail to lower case: synthetic users must be stored lower-case.

Session 4 (details in its run notes and report):

- **One heavy job at a time on the workstation.** Two of the integration suite, the staging suite and a Docker build at once exhaust its memory. Workers then fail to start (`0xC0000142`) and suites starve or die. A killed shell can leave vitest processes behind: find them by command line (`Win32_Process`) before starting again.
- **The API image needs `--build-arg MYKEY_BUILD=$(git rev-parse --short=12 HEAD)`.** Without it the API logs `startup_refused` and restarts in a loop. The probe then raises `health_failing`.
- **CI's integration job runs in two shards** (`--shard=N/2`, about 16 and 21 min). One job hit the 30-minute limit.
- **CI cost:** since 16 Nov 2026 the repository is public, so standard GitHub-hosted runners cost no Actions minutes. Before that, the private repository's 2,000 minutes a month ran out at the Session 5 gate: GitHub refused every job ("spending limit"). A full run takes about 50 minutes of wall time, almost all of it the integration suite.
  - CI runs only on pull requests and by hand (`gh workflow run ci --ref <branch>`), never on a plain push. A pull request whose changes are all under `docs/` or in `.md` files runs only `check` (with the unit tests) and the secret scan.
  - Still prove each run locally and open the pull request at the gate: a red CI found late costs a session's time, not money.
  - `cli-matrix` runs only by hand, at a gate that changed the CLI.
- **The repository is public.** Everything committed, history included, is visible: never commit a host secret, a credential or a real value (the rules above are unchanged). Host addresses appear in run notes and runbooks; the hosts are protected by the VPN and the firewall, not by the addresses being unknown.
- **Staging tests go stale.** A route that gains a handler, a container added to a host or a moved credential breaks a staging test written earlier. Run the staging files one at a time. A staging run also rewrites committed evidence files of earlier runs (host scans, drill JSON): restore them before committing.
- **OpenBao's audit device on staging is about 500 MB**, too large to download in a test. Search it on the host with `countOnHost` (`tests/harness/staging.ts`): the values go on fd 3 and only counts come back, and its controls must be found. Never use `producer | grep -f /dev/stdin`: inside a pipeline grep's stdin is the producer, so the search finds nothing.
- **PostgreSQL on a host** accepts `pg_dump` only on its socket with the superuser password (`PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"` inside the container); TCP on loopback is refused by `pg_hba`.
- **The `provisioner_runtime` password lives only on the host** (`/etc/mykey/secrets/provisioner/db-password`); the workstation copies were shredded.
- **Throughput:** an import entry costs about 150–220 ms on the workstation's Docker and 76 ms on staging. The complete read of 1,000 × 8 KiB takes 5.3 s locally; a 7 MB export takes at most 23.5 s on staging.

Session 5 (details in its run notes and report):

- **The CLI is tested from Windows only through `pnpm run test:cli`** (a Linux container; about two minutes). Its arguments may hold only letters, digits and `. _ / = -`: use `--testNamePattern=word`, not `-t "two words"`. `--release <dir>` tests a downloaded release with the installed launcher.
- **A CLI matrix run takes about 5 minutes** (four targets; free since the repository is public) and runs only by hand: `gh workflow run ci --ref <branch> -f jobs=cli-matrix -f cli_release=cli-vX.Y.Z`. A release is never changed: a CLI fix is a new version (bump `apps/cli/package.json`, the bundle compiles it in).
- **Claude Code stops background jobs when memory runs low.** It stopped the gate's suite (beside a review agent) and a consumer rehearsal. Run one heavy job at a time with no agent beside it. The WSL VM keeps its memory after a job: quitting Docker Desktop (or `wsl --shutdown`) frees it. Find orphans by command line afterwards: a stopped shell leaves vitest and fixture containers running.
- **Tests that only need "a product route answers" use `GET /v1/organizations`** (no action, no scope). `/v1/reference` needs the process organization and the Scalar asset, and `page.test.ts` copies the asset into `apps/api/assets`, so its answer depends on file order.
- **An unknown issuance has two states.** `needs_review` (no token proven) blocks the next issuance; `revoking` (OpenBao made the token, its withdrawal is unproven) blocks nothing. Where a fault lands decides which; a test must accept both.
- **macOS has BSD tools.** BSD `script` needs its own stdin to be a terminal and refuses a Node-spawned socket. The CLI's terminal test uses Python's `pty.spawn` on macOS (`MYKEY_TEST_PTY=python` takes that path on Linux). A matrix failure without output is first made to say why, then fixed.
- **The token sweep** is `tests/staging/token-sweep.staging.test.ts`. Tokens are stored nowhere, so each test searches the tokens it holds, with a control per surface (the provisioner's log names operation ids, not environment ids).

Open issues carried into Sessions 6 ∥ 7 are listed in `docs/evidence/session-5/report.md` ("What Sessions 6 and 7 must know").
