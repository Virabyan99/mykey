# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Keep this file current.** The gate run of every session updates "Where we stand" and "Things already learned", and removes what no longer holds. Detail belongs in the session report; this file holds only what every future session needs.

## What this is

MyKey Private is a single-operator secrets service. OpenBao holds secret values and versions; PostgreSQL holds accounts, permissions, operations and audit; a thin CLI starts an application with a complete secret set and no `.env` file. The GitHub repository is `Virabyan99/mykey`, public since 16 Nov 2026.

The project is in **Stage 1**, a 14-day plan of nine sessions.

- **Authority:**
  - `docs/doc_10_…compressed_implementation_plan_v1.0.md` is the stage plan.
  - Doc 04 is the functional specification and Doc 06 the technical specification.
  - Doc 08 is the older 47-session roadmap, replaced by Doc 10.
  - Never rename or reformat a `docs/doc_*.md` file.
- **Three layers:** the stage plan (Doc 10), then one plan per session (`docs/plans/session-N-plan.md`, written by a planning agent), then execution by another agent. Do not start a session without its plan.
- **Rules that are never traded for speed:** Doc 10 §4.1. Read them before any run that touches secrets, permissions, audit or restore.

## Where we stand

_Last updated: 20 Nov 2026, after the Session 7 merge (PR #19) and its two owner answers._

| Session | Topic                                       | State                               |
| ------- | ------------------------------------------- | ----------------------------------- |
| 1       | Foundation                                  | **Done** (PASS WITH ISSUES), merged |
| 2       | Infrastructure and make-or-break proofs     | **Done** (GO, no fallback), merged  |
| 3       | Identity, access and resources              | **Done** (PASS WITH ISSUES), merged |
| 4       | Operations engine and secret lifecycle      | **Done** (PASS WITH ISSUES), merged |
| 5       | Machine access, CLI and API reference       | **Done** (PASS WITH ISSUES), merged |
| 6       | Audit, limits, backup, recovery, deployment | **Done** (PASS WITH ISSUES), merged |
| 7       | Web workspace                               | **Done** (PASS WITH ISSUES), merged |
| 8       | Security review and controlled-use release  | Not started (needs its plan)        |
| 9       | Real use, agent experiment, stage exit      | Not started                         |

Each session's detail is in `docs/evidence/session-N/report.md`. Session 7's report has "What Sessions 8 and 9 must know", and Session 6's has the same for 7, 8 and 9: the Session 8 plan is built on both.

### What the product has now (Session 7)

- **The owner workspace** (`apps/web`), served by the API at the host's own address:
  - sign-in, enrolment, the operator's reset link, password, recovery codes, sessions;
  - the overview, projects and environments;
  - secrets: list, create, edit, reveal, copy, history, delete, undelete, restore;
  - import and export of dotenv files;
  - machine credentials: issue, inventory, revoke;
  - activity, audit, operations, and the summary as three tables.
- **Three routes filled in:** `overview.get`, `credentials.summary`, `metrics.get` (D-61).
- **Proofs:** one owner journey and a canary scan of everything the browser keeps (`tests/browser`), and the same journey on staging (`tests/staging/workspace.staging.test.ts`).

- **Audit:**
  - the audit route and activity timeline;
  - a coverage table, `AUDIT_COVERAGE`: a route without a decision fails `check`;
  - both audit streams archived to R2 as verified, locked segments, whose keys hold the backend incarnation;
  - a purge that never outruns the archive.
- **Limits:** every limit of Doc 06 §11, failing closed:
  - 429 with `retry-after`;
  - 507 from the host's capacity record, which the heartbeat writes each minute (without the record, changes that need space answer 503);
  - `busy` during a capture.
- **Status and alerts:**
  - `host.ts <host> status`;
  - fifteen probe conditions (`CONDITIONS` in `workers/probe/src/evaluate.ts`), each with a section in `docs/runbooks/alerts.md`;
  - the watcher workflow `probe-watch.yml`.
- **Backup:**
  - a nightly pair at 03:00 UTC under a capture barrier;
  - a pair becomes eligible only after read-back, `restic check --read-data`, a scratch restore and a signature;
  - retention at 05:00 never deletes the newest eligible pair.
- **Gate v2 and restore:**
  - the gate record is bound to the host, the backend incarnation, the release and a verification report;
  - `host.ts <host> restore` and `restore-verify` (runbook `restore.md`);
  - a restore resets every account and revokes every token.
- **Releases:** built once with `pnpm run host:release`, promoted through the closed gate by `host.ts <host> deploy --release <dir>`.

### Hosts

- **Staging** runs `host-v0.7.0` (`236083a`), gate open, timers installed. Its host files are those of the Session 7 gate (`host.ts staging push`).
- **Production** (reinstalled 19 Nov 2026) runs `host-v0.6.3` **closed**:
  - a closed v2 gate record;
  - no OpenBao and no owner;
  - migrations up to `0018`;
  - in the probe as `inService: false`, with `checks_unknown` open (no OpenBao to read).
  - its host files are those of the Session 7 gate (`host.ts prod push`, 20 Nov 2026, with the owner's word).

  Production deploys need the owner's permission.

- **Evidence registry:** 172 `SPIKE_PASS`, 19 `OPEN`, nothing `PASS`.

### Open items

- **Session 8:** its plan is written first.
- **Carried to Session 8:**
  - the thirteen Minor findings and two open questions of Session 7's review (its report);
  - the resting custody root token (M1, Blocker candidate);
  - `reconcile-credentials --all`;
  - the OpenBao user lockout;
  - review findings C–I;
  - `CVE-2026-97054` in OpenBao and Traefik (HTTP/1 servers; reviewed into `.trivyignore.images`);
  - the credential drill's fault placement is probabilistic.
- **Dated:**
  - **All KMS certificates expire on 12 Dec 2026** (staging seal at 10:50 UTC). Replace them before then (runbook `kms-and-unseal.md`). The checkpoint `kms-cert-expiry` is due from 12 Dec 09:57 UTC, and `certificate_expiring` opens 10 days before.
  - `.trivyignore.images` expires on 14 Dec 2026.
  - The checkpoint `pair-30-day` is due from 17 Dec 2026 19:00 UTC, before the 05:00 retention of 18 Dec.
- **Owner:** nothing is open. OWN-4 is confirmed (20 Nov 2026): the two files of `~/.mykey/custody/staging/backup/` are also in the owner's password manager.

## Commands

Node 24 (exact version in `.node-version`) and pnpm 10.20.0 through `corepack enable`. Docker with Compose is needed for everything except `check` and the unit tests.

```sh
pnpm install --frozen-lockfile
pnpm run check              # format, lint, types, pins, OpenAPI current, schema drift, authority matrix, auth route contract, evidence registry
pnpm test                   # unit tests
pnpm run test:integration   # own PostgreSQL + OpenBao stack in Docker; whole suite runs on CI (locally only with --maxWorkers=2)
pnpm run test:cloud         # real Cloudflare R2; exits 1 without the credential files in ~/.mykey/secrets/r2/
pnpm run test:staging <file>   # the staging host over the VPN, one file at a time; needs ~/.mykey
pnpm run test:cli           # the CLI in a Linux container (the only way on Windows); --release <dir> tests a downloaded release
pnpm run test:browser       # the workspace and the reference page in Chromium, against a local API with real PostgreSQL and OpenBao (once per workstation: pnpm exec playwright install chromium)
pnpm run test:consumers     # the consumer runbooks rehearsed against staging from clean containers (WSL Ubuntu + Docker; ~17 min)
```

One file or one test:

```sh
pnpm exec vitest run --project unit tests/unit/dotenv/parse.test.ts
pnpm exec vitest run --project integration tests/integration/database -t "second run applies nothing"
pnpm run test:staging tests/staging/status.staging.test.ts   # never `-- <file>`: pnpm passes `--` on and vitest runs every staging file (vitest.config.ts refuses it)
```

Other scripts:

```sh
pnpm run stack:up | stack:down | stack:status   # the dev stack `mykey-dev`, for work by hand
pnpm run contracts:openapi                      # regenerate packages/contracts/openapi after a route change
pnpm run reference:asset                        # copy Scalar's build into apps/api/assets (without it /v1/reference answers 503)
pnpm run web:build                              # build the workspace into apps/web's dist (without it the workspace's paths answer 503; the browser tests build their own)
pnpm run cli:build | cli:release -- --version <v>   # the CLI bundle; a release (version = apps/cli/package.json)
pnpm run db:migrate                             # apply migrations
pnpm run evidence:build                         # rebuild docs/evidence/registry.json after editing registry-overrides.json
node scripts/host.ts <staging|prod> <command>   # operator tool for the hosts (usage: run it without arguments)
node infra/release/build.ts --version <v> --out ~/mykey-release/host-v<v>   # in the clean clone ~/mykey-release/src (deploy.md); then gh release create … --target <branch>
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> deploy --release C:/Users/<you>/mykey-release/host-v<v> [--stay-closed]
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore --source <host> --newest | restore-verify …   # runbook restore.md
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops <command> [--flag v]   # operator commands (apps/ops) as maintenance over a tunnel
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> gate close|status            # a v2 gate opens only through deploy (below)
node scripts/probe.ts deploy | secrets | state <host>   # the probe Worker
node scripts/ci-scan.ts secrets | dependencies | images | selftest   # the CI scanners, locally
```

**Operator commands:**

- The commands are `bootstrap-owner`, `reset-account`, `auth-cleanup`, `provision-organization` and `verify-organization` (runbooks `operator-accounts.md`, `provisioning.md`).
- In tests the provisioner runs as a child process (`startProvisionerProcess` in `tests/harness/api-worker.ts`).
- `tests/integration/provisioning/fixture.ts` sets up tenants with a provisioned organization.

**New migration:**

- Run `node node_modules/drizzle-kit/bin.cjs generate --name <name>` inside `packages/db`. `pnpm run db:generate -- --name x` is rejected.
- Read the generated SQL: drizzle-kit can emit a foreign key before the unique key it needs, and it exits 0 when it crashes.
- `pnpm run db:check` is the proof that schema and migrations agree.

Scripts in `scripts/` and `infra/` are TypeScript run directly by Node (type stripping), so they use erasable syntax only: no enums, no parameter properties.

## Architecture

- **Two stores, one owner per fact.** Secret values and versions live only in OpenBao: one namespace per organization, KV v2. PostgreSQL holds metadata, permissions, operations and audit, and never a secret value or a machine token.
- **`packages/contracts`** is the single source for limits (Doc 06 §11), name rules, ids, error codes (one HTTP status each), the operation envelope and the route table.
  - `openapi.json` is generated from the route table, and `contracts:check` fails when it is stale.
  - The route list is frozen (D-15). Since Session 7 no route has a pending body.
  - `WEB_ROUTES` is the table of the workspace's page paths; the API and the page's router both read it.
- **`packages/db`** has five schemas:
  - `app`: 19 tables;
  - `audit`: `event` and `archive_segment`;
  - `meta`: `schema_migration`;
  - `auth`: Better Auth's tables plus the product's factor and reset tables;
  - `jobs`: pg-boss's queue.

  The roles are `migration_owner`, `api_runtime`, `provisioner_runtime`, `backup_reader` and `maintenance`. Tenancy is enforced by composite foreign keys that carry `organization_id`. `migrate()` refuses a changed, missing or out-of-order migration file.

- **`@mykey/openbao`:**
  - one namespace `org-<organizationId>` per organization, with KV v2 at `kv`;
  - policies and AppRole roles `runtime`, `issuer` and `provisioner`, and token roles `machine-env-<environmentId>`;
  - the runtime authenticates with inline AppRole (D-17), and the provisioner never runs in the API process;
  - a change whose answer is unclear is `unknown`, never a failure.
- **The provisioner's incarnation guard (Run 6.7, Session 6 gate):** before a job or a sweep, the provisioner reads OpenBao's incarnation.
  - A different incarnation blocks, with cause `incarnation`.
  - No answer closes the gate as `unreachable` and is never cached.
  - A denied answer (login or read) proceeds: that client can change nothing, so a job fails into review and the sweep reports the drift.
- **Request pipeline (D-26, D-31, D-33):**
  - every route goes through `mountRoute` from `ROUTES`;
  - authorization reads current rows on every request, and handlers never decide authority;
  - a mutation needs an `Idempotency-Key`, and a completed request is replayed before the state and freshness checks.
- **The workspace (`apps/web`, D-59, D-60):** React, TanStack Query and zod, one esbuild bundle, served by the API itself where its terminal 404 would be: on the paths of `WEB_ROUTES` and for the files of the build's manifest, read into memory at start.
  - **Policy:** `default-src 'none'`, scripts and styles from the own origin only, no framing. So no inline `style` attribute anywhere (bars are `<meter>`).
  - **Secrets in the page:** a route of `SECRET_BEARING` is sent by `callSecret` from an event handler, never through the query cache; its answer lives in `useEphemeral` (30 seconds, gone on tab hide, navigation and sign-out). Nothing is written to any storage. `tests/unit/web/sources.test.ts` keeps these rules.
  - **Errors:** one table (`errors/explain.ts`) gives every code its text; a screen never prints a code or the server's message.
  - **Changes:** every change goes through `useAction`. It keeps the idempotency key while the outcome is open, and turns a 202 into "Not finished yet" unless the screen prints the operation's state itself.
- **`@mykey/operations`** has three entry points: the root (jobs, outbox, gate, replay), `/operator` (organization provisioning, admin authority) and `/provisioner` (environment job, sweep). The API imports only the root, which the skeleton test checks.
- **Shape (Doc 06):**
  - `apps/api` serves the routes;
  - `apps/provisioner` is the only writer to OpenBao;
  - `apps/web` is the owner workspace;
  - `apps/cli` delivers secrets to a process (a thin CLI, not OpenBao Agent: D-24);
  - `apps/ops` holds the operator commands;
  - `workers/probe` watches from outside.
- **Tests:**
  - Vitest projects: `unit`, `integration` (also `tests/fault`), `cli`, `cloud` (`tests/**/*.cloud.test.ts`), `staging` (`tests/staging/*.staging.test.ts`; a dated checkpoint file stays out until it is due), `consumers` and `browser`.
  - The main harness: `tests/harness/stack.ts` (`freshDatabase`, `freshNamespace`, `baoFetch`, `mountKvV2`, `restartService`), `org-fixture.ts`, `tls-relay.ts` (network faults after the handshake) and `staging.ts` (`connectStaging`, `sshExec`, `nextMinute`, `stagingRelease`, `countOnHost`).
  - Mocks are not accepted as proof for anything involving the two stores.
- **Pins:** `infra/dependencies.lock.json` holds every version, and `pins:verify` enforces it:
  - npm packages exact;
  - images by `@sha256:` digest;
  - Actions by 40-hex SHA;
  - release binaries (`okms-cli`) by SHA-256.

  Not allowed: any pre-release dependency, PostgreSQL 19, Redis, a second queue, a workflow engine, an MCP server, or OpenBao Agent as a required component.

## How work is done here

- **Test first.** Write the failing test, watch it fail, make it pass. A suite with no tests fails, a skipped test is not a pass, and a missing credential is a failure, not a skip.
- **Cloud tests describe provider behaviour.** A failure is a finding to record, never something to fix by weakening the assertion.
- **Evidence:**
  - Every run ends with `pnpm run check` green, a commit and a run note `docs/evidence/session-N/run-N.M.md`.
  - Every session ends with a gate run: the full suite, a fresh-context review of the session's diff, and `docs/evidence/session-N/report.md`.
  - Each decision gets one page in `docs/decisions/D-NN-<slug>.md`.
- **The full integration suite runs at the gate only, on CI** (owner, 17 to 19 Nov 2026; D-58).
  - A run proves itself with `pnpm run check`, the test files it adds or changes, and any existing file that exercises what it touched.
  - The session's pull request is opened as a draft at its start. Each run's push then costs about two minutes of CI (below); read it before the next run's first commit.
  - At the gate, mark the pull request ready as soon as the session's code is in: the first full run finds what crosses runs (13 failures at Session 6's gate, 4 files at Session 7's). Run the review and write the report while it runs.
- **Registry statuses:** `OPEN`, `SPIKE_PASS` (proven in isolation), `PASS` (proven on the integrated product), `FAIL`, `WATCH` and `CUT`. A status other than `OPEN` needs an evidence file that states the id and the status on one line; `CUT` needs a decision record.
- **Git:** never commit on `main`. Work on a branch, open a pull request, and merge only when the owner says so. `main` has no branch protection, so nothing else stops a direct push.
- **The repository is public.** Everything committed, history included, is visible.
  - **Synthetic data only** until Gate R is signed.
  - Never write a literal `MYKEY_CANARY_` followed by 32 characters outside `tests/fixtures/ci/seeded-secret/`; tests assemble canaries at run time.
  - Host addresses appear in run notes; the hosts are protected by the VPN and the firewall.
- **Credentials:**
  - They live on the owner's workstation under `~/.mykey/`, outside the repository and outside OneDrive.
  - `docs/runbooks/credential-custody.md` lists names and locations, never values.
  - No value may appear in Git, logs, evidence files or chat; scripts print token names and ids only.
  - A secret crosses only on stdin.
- **Owner and agent duties (D-11):**
  - The owner buys OVHcloud resources, creates root credentials when asked, reinstalls servers in the OVH console, and restarts the WireGuard tunnel (admin PowerShell: `Restart-Service 'WireGuardTunnel$mykey-ops'`).
  - Agents handle GitHub and Cloudflare. Setting a GitHub repository secret is the owner's step: the agent's permission check refuses it.

## Things already learned

### Workstation (Windows, Git Bash, repository inside OneDrive)

- **Shell text:** backslashes are halved or eaten in `node -e '…'` strings and heredoc-fed scripts. Edit any text with regexes or escapes with the editor tools, never through the shell.
- **Python edit scripts:** Python writes CRLF in text mode, so open files with `newline=""`.
- **Where heavy work goes:** worktrees, clones and heavy temporary work go outside OneDrive. `nul.*` is a Windows device name; no file may be called that.
- **Node:** the workstation runs Node 24.18.0; the pin is 24.22.2, and CI uses the pin.
- **`host.ts` paths:** use `MSYS_NO_PATHCONV=1` before `host.ts` commands that take remote absolute paths. With it, `$HOME` is not converted either, so pass `C:/Users/…` paths.
- **One heavy job at a time.** Two suites, or a suite and a Docker build at once, exhaust the memory: workers fail to start (`0xC0000142`) and Claude Code stops background jobs.
  - The WSL VM keeps its memory after a job; quitting Docker Desktop (or `wsl --shutdown`) frees it.
  - After a killed job, find orphan vitest processes by command line (`Win32_Process`) and remove leftover `mykey-t-*` Compose projects.
  - Claude Code also stops background jobs when memory is short while the session is idle. It asks that they are not started again without the owner's word: report, and wait.
- **Long or quoted text never goes through the shell.** A heredoc holding `'''`, a regex or non-ASCII text breaks. Write a script file with the editor tools and run that.

### CI and scans

- **When CI runs:** only on pull requests and by hand (`gh workflow run ci --ref <branch>`), never on a plain push.
  - **Two weights (Session 7).** A draft pull request runs `check` (with the unit tests) and the secret scan, about two minutes. A ready pull request, or a run by hand, adds the scans, both integration shards and the `browser` job: about 16 minutes in all. `gh pr ready <n>` starts the full run.
  - A pull request whose changes are all under `docs/` or in `.md` files runs only `check` (with the unit tests) and the secret scan.
  - Integration runs in two shards, about 12 and 14 minutes, each with a 30-minute limit; `browser` takes about 7.
  - Runners cost nothing (the repository is public).
- **Watch CI after every push** (`gh run list --branch <branch>`). Session 3 was red for its whole length unnoticed.
- **Linux CI sees file ownership; Windows Docker hides it.** Test containers that write into a bind mount run as the caller (`tests/harness/restic.ts`).
- **The image scan** covers the pinned upstream images and the API image. It is green only through `.trivyignore.images`: 53 reviewed upstream CVEs with no fix possible in this repository, all expiring on 14 Dec 2026.
  - A new upstream CVE can turn it red overnight. Review it, add an entry that gives the reason, and name what is exposed.
- **The secret scan** must see the whole history and at least one commit. A scanner that crashes or scans nothing fails the `scans` self-test. Reviewed false positives go into `.gitleaksignore` by fingerprint, with the reason above them.
- **GitGuardian** flags `-e PGPASSWORD postgres` in `tests/harness/stack.ts` (incident 39994924). It is a false positive that only the owner can dismiss, and it is not a required check.
- **`cli-matrix`** runs only by hand, at a gate that changed the CLI: `gh workflow run ci --ref <branch> -f jobs=cli-matrix -f cli_release=cli-vX.Y.Z` (about 5 minutes).
  - A CLI release is never changed: a fix is a new version (bump `apps/cli/package.json`).
  - macOS has BSD tools, so the terminal test uses Python's `pty.spawn` there (`MYKEY_TEST_PTY=python` takes that path on Linux).

### Tests

- **Staging files run one at a time, and every one of them at every gate.** Session 6's gate skipped seven; Session 7's then found a defect of Session 6 (below) and five stale tests in them.
  - Staging tests go stale: a route that gains a handler, a container added to a host, a moved credential, a new limit, or a new gate format breaks a test written earlier.
  - A staging run rewrites committed evidence files of earlier runs; restore them before committing.
  - A staging test that changes state must undo it in `finally`.
- **Run 6.3's limits apply to staging tests** (fixed 60 s windows of database time): five sign-ins a minute per source, five issuances a minute per person, and 120 requests a minute per session. A test that needs its budget starts in a fresh minute (`nextMinute`).
- **Timing decides some outcomes, and then a test accepts every right one.**
  - An unknown issuance is `needs_review` (it blocks the next issuance) or `revoking` (it blocks nothing).
  - A sweep with OpenBao stopped either counts the organization unread or is skipped as `unreachable`.
  - The credential drill catches a mid-flight issuance only sometimes, so it tries up to 10 times.
  - A cached failure must never make the decision.
- **A route that just needs to answer:** tests that only need "a product route answers" use `GET /v1/organizations`. `/v1/reference` depends on the Scalar asset and on file order.
- **CLI tests on Windows** run only through `pnpm run test:cli`. Its arguments may hold only letters, digits and `. _ / = -`: use `--testNamePattern=word`.
- **The token sweep** (`token-sweep.staging.test.ts`): tokens are stored nowhere, so each test searches the tokens it holds, with a control per surface.
- **Synthetic users:** sign-in lowercases e-mail, so synthetic users must be stored lower-case.

### Browser tests (`tests/browser`, harness `tests/harness/web.ts`)

- **The harness:** `startWebWithStores()` gives a built workspace, a test API with real stores, the tenants and Chromium mapped to the test origin. Every request to another origin is aborted and counted.
- **No DOM types in the tests' TypeScript.** Use a string `page.evaluate<T>("…")`, or a callback whose element is `unknown` with a cast.
- **A seeded answer:** `page.route` with `route.fulfill` and the contract's envelope. `route.fetch` cannot resolve the test host.
- **A page of another origin** (the framing test) must be a real local server. A made-up public name is stopped by Chromium before it reaches the local API.
- **Clocks:** `page.clock.install()` before the page loads.
- **One-time codes:** a code works once per step. Take codes from `authenticator()` (`tests/harness/journey.ts`), which never gives a step twice; two tests of a file must not use the same user's codes at the same time.
- **A history walk** crosses document loads: use `page.goBack()` and wait, not `history.back()` inside `evaluate`.
- **Two React lessons:**
  - a `<dialog>` must be closed in a layout effect, while it is still in the document, or the focus goes to nobody;
  - a dialog that is a form (the step-up) is never nested in another form.
- **One CSS lesson:** an absolutely positioned element inside a scrolling frame needs `position: relative` on the frame, or it widens the page.
- **A runbook never names a generated directory in backticks** (the workspace's dist): the links test wants every such path to exist, and CI has no build.

### Database

- **Lock order:** take an update lock before any share lock on the same row. A share lock later raised to an update deadlocks two concurrent requests.
- **pg-boss** needs data rights on more of schema `jobs` than its happy path suggests. With too few, a failing job stays `active` for ever and the error is swallowed.
- **A text alias hides an ORDER BY.** `SELECT sequence::text AS sequence … ORDER BY sequence` sorts the text (1, 10, 2): that stopped staging's archive at segment 10. Name the column (`table.sequence`).
- **Roles are cluster-wide:** never run `applyRoles` against a host's real database from a test (`stagingDatabase` exists for that).
- **`pg_dump` on a host** works only on the socket with the superuser password, inside the container; TCP on loopback is refused by `pg_hba`.

### OpenBao

- **A new KV v2 mount** answers 400 "Upgrading" for a moment; `mountKvV2` waits for it.
- **Bound CIDRs:** OpenBao 2.7.2 reads `token_bound_cidrs` with a `/32` back as the bare address, and `secret_id_bound_cidrs` as written.
- **Reaching it:** a container reaches OpenBao by the name in its certificate (`openbao`), never by address.
- **The KMIP seal:**
  - When the KMS is unreachable at start, OpenBao waits about 130 s, exits and is restarted by Docker.
  - A refused certificate makes it exit at once.
  - A KMS outage does not seal a running OpenBao.
  - A console KMS certificate is valid for 30 days only, and the console names it by ID.
- **The audit device on staging is about 500 MB.** Search it on the host with `countOnHost` (values on fd 3, only counts come back). Never use `producer | grep -f /dev/stdin`: inside a pipeline, grep's stdin is the producer.
- **Never signal a container with `docker kill --signal`.** Docker marks a container it signalled as stopped by hand, and `unless-stopped` then starts it neither after an exit nor at boot. The nightly audit rotation did that to OpenBao until the Session 7 gate; it now runs `kill -HUP 1` inside the container (`tests/unit/hosts/signals.test.ts`). A container that is `exited` after a reboot is started with `host.ts <host> up`.
- **User lockout:** about 15 minutes of failed AppRole logins lock the role id out, even for the right secret id (`known-limits.md`).

### Cloudflare R2 (D-16)

- **Locked objects:** a refused overwrite or delete answers HTTP 409 `ObjectLockedByBucketPolicy`. A bulk delete answers **HTTP 200** and lists the refusal per object, so use `deleteObjectsChecked`.
- **Multipart ids:** R2 reports the id of one multipart upload as a different string every time. Ids cannot be compared, but each of them aborts the upload.
- **Credentials:** the S3 credentials of an R2 token are the token id (access key) and the SHA-256 hex of the token value (secret). Lock rules go through the Cloudflare REST API, which needs the token value itself.
- **The fixture scripts:**
  - `infra/backup/retention-fixture/provision.ts` (which also sets the `pairs-30d` rule) never weakens a live lock rule, and rolls a token only with `--roll <name>`. It needs a new bootstrap token at `~/.mykey/secrets/cloudflare/bootstrap-token`.
  - `upload.ts` refuses to run when a fixture is already recorded.
- **Other buckets:** the Cloudflare account holds buckets that are not MyKey's. Touch only the four `mykey-*` buckets.

### Hosts and releases (`docs/runbooks/network.md`, `deploy.md`, `kms-and-unseal.md`)

- **Access:**
  - Reach hosts only over the VPN through `scripts/host.ts <staging|prod> <command>` and the harness `sshExec`.
  - A command that names `/etc/mykey/secrets` or `/root/mykey-custody` must pass `secretOutput`. Never print a host secret.
- **Firewall and SSH changes** go through `host.ts … apply` (an automatic revert unless `confirm` comes from a new connection). Never reboot with a revert pending.
- **Container networks:** egress uses per-purpose address sets, and a container bridge reaches only its own row. Docker's resolver answers public names only on `mk-pub` and `mk-kms`.
- **Compose and Node permissions:**
  - An environment variable whose name contains KEY or SECRET fails the compose secret check.
  - Node's permission model does not cover files in a directory created after start; grant `<dir>/*`.
- **Releases:**
  - Build them from the clean clone `~/mykey-release/src`; the API image needs its `MYKEY_BUILD`, which the release build sets.
  - `gh release create` needs `--target <branch>` (a bare SHA is refused).
  - A release is never changed: a fix is a new version.
- **A v2 gate opens only with a verification report.** A bare `gate open` is refused; to reopen (after `quiesce` + `resume`, or anything else), redeploy the running release. A v1 record reads as closed (cause `version`): never write one to a v2 host.
- **After a reinstall:**
  - The `ubuntu` password is expired, and the owner changes it in a terminal.
  - A changed host key is taken only right after a reinstall the owner has just confirmed.
  - `bootstrap` gives the host a new WireGuard key, so the owner restarts the tunnel afterwards.
- **A fresh production host** (no OpenBao), in this order:
  1. `up` (it writes `host.env`);
  2. in a `maint` window, plain `docker pull` of postgres and traefik by digest (`compose pull` fails on the provisioner's unset OpenBao address);
  3. `up`, `db-init`, then `deploy --stay-closed`;
  4. `keys init` (the API refuses to start without key rings);
  5. `acme production` + `up`, then `probe.ts secrets`.

  A clean host for a restore needs `restore.md`'s whole "Before".

- **Host files reach a host only by `host.ts <host> push`.** A release holds images; `deploy` does not carry `infra/hosts`.
- **An edge outage of more than three minutes also opens `checks_unknown`:** the host reads its public certificate as the edge serves it.
- **`probe.ts secrets` makes a new read token.** The owner must then set the repository secret `PROBE_READ_TOKEN` again (runbook `probe.md`); without it `probe-watch` fails and alerts "state route did not answer".
- **The `provisioner_runtime` password** lives only on the host (`/etc/mykey/secrets/provisioner/db-password`).

### Product facts worth knowing

- **Auth** (Better Auth 1.7.19, D-19):
  - sign-up is refused, and the first account is created through the operator path;
  - change-password with `revokeOtherSessions` drops the session to `password_verified`;
  - two-factor is product-owned (the stock plugin fails the contract).
- **Dotenv:**
  - import is limited to 1 MiB while an environment holds up to 8 MiB, so a large export cannot be re-imported;
  - `@next/env` can lose a key in one case, which is an export warning.
- **TypeScript** is pinned at 6.0.3, not 7, because of the linter's peer range (D-12).
