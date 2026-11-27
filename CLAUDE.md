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

_Last updated: 27 Nov 2026: Session 11 (PR #27) and its deploy to production (D-85). Gate F was decided HARDEN (D-74): Stage 1 stays open._

| Session | Topic                                       | State                                             |
| ------- | ------------------------------------------- | ------------------------------------------------- |
| 1       | Foundation                                  | **Done** (PASS WITH ISSUES), merged               |
| 2       | Infrastructure and make-or-break proofs     | **Done** (GO, no fallback), merged                |
| 3       | Identity, access and resources              | **Done** (PASS WITH ISSUES), merged               |
| 4       | Operations engine and secret lifecycle      | **Done** (PASS WITH ISSUES), merged               |
| 5       | Machine access, CLI and API reference       | **Done** (PASS WITH ISSUES), merged               |
| 6       | Audit, limits, backup, recovery, deployment | **Done** (PASS WITH ISSUES), merged               |
| 7       | Web workspace                               | **Done** (PASS WITH ISSUES), merged               |
| 8       | Security review and controlled-use release  | **Done**, Gate R signed (D-67), merged            |
| 9       | Real use, agent experiment, stage exit      | **Done**, Gate F: HARDEN (D-74), merged           |
| 10      | Hardening (D-75)                            | **Done**, merged (25 Nov 2026)                    |
| 11      | Runtime and automation credentials (D-80)   | **Done** (PASS WITH ISSUES), merged (26 Nov 2026) |

Each session's detail is in `docs/evidence/session-N/report.md`. Gate R's document is `docs/evidence/session-8/gate-r.md`, Gate F's is `docs/evidence/session-9/gate-f.md`.

### Session 11 (two new credentials, 25–26 Nov 2026; `session-11/report.md`)

A Stage 1 amendment (D-80) from `docs/mykey-automation-credential-spec.md`. On staging from 26 Nov 2026, and on production from 27 Nov 2026, before W-2, on the owner's word (D-85, `run-11.10.md`).

- **The runtime credential** (D-81): a client secret `mkrc.<id>.<secret>` for one environment, up to 365 days, exchanged at `POST /v1/machine/exchange` for a 900-second token. PostgreSQL keeps a verifier, never the secret. A revocation stops the credential at once; a token already exchanged lives out its 15 minutes in OpenBao.
- **`machine.metadata`:** names, versions and times of an environment, no value, no audit row.
- **The automation credential** (D-82): `mkac.<id>.<secret>`, 1 hour to 365 days, bound to 1 to 8 networks, with up to three rights. Ten `/v1/automation` routes make a project, an environment, secrets and runtime credentials. A credential reaches only what its own chain made (`project.managed_by`); everything else is one 404. It reads no value and deletes nothing.
- **`cli-v0.2.0`** exchanges a client secret by itself; a 30-day token works as before. The published `cli-v0.1.2` given a runtime credential exits 77.
- **The workspace** has an Automation page (owners and admins) and issues a runtime credential beside the token.
- **`host-v0.10.0`** (`5e13f421a4e6`) is on staging (25 staging files green on it) and on production. Its migration `0019` means **no rollback**: a host goes back only by a restore.
- **The manifest** (`--session 11`): 161 PASS (7 `earlier`), 7 NOT YET DUE, 5 NOT PROVEN. `test:consumers` was red once on the candidate (the workstation's memory) and green on its second run.
- **A second agent guide** (D-84, after the merge): `docs/agents/provision-with-automation.md`, for an agent that writes a provisioning script. `llms.txt` links it in a section of its own, and `tests/unit/agents/automation-guide.test.ts` keeps it equal to the contract. No agent has been run from it yet. The README says what Session 11 added.
- **Not proven on staging:** the fleet's 20 seconds (ten servers started in 19.7 s and 21.7 s, D-83), and the new kinds' recovery after a restore (integration only).
- **Run 11.1, the postgres pin, was not done:** no PostgreSQL 18 image without CVE-2026-124851 exists yet. `host-v0.9.3` was never built.

### Session 10 (hardening, 23–24 Nov 2026; `session-10/report.md`)

- **The token step is one command that reads first** (D-76): the same bytes in the panel, both consumer runbooks, `machine-credentials.md` and the agent guide; a pseudo-terminal test (`tests/cli/token-step.test.ts`). F-9.2-1 is closed. macOS's bash 3.2 is not proven (only bash 5 ran there).
- **`host-v0.9.2`** (`0486f24c3b6e`) on both hosts. Production opened through the owner's journey at epoch 11 (23 Nov 18:14Z).
- **The restore re-drill** (D-77): staging restored onto its own reinstalled server, gate open 75.6 min after step 4 (RR-2: 120), 20 of 20 checks. It found a defect, fixed in `scripts/host-restore.ts`: a clean server's provisioner got no organization id.
- **The credential drill** (D-78) places its fault with a trigger on the host. It was caught on its first attempt, so AC-1.18, AC-1.40, AC-1.57 and PO-18 can be PASS.
- **Agent documentation** (D-79): `llms.txt` and `docs/agents/connect-an-application.md`, kept equal to the code by `tests/unit/agents/guide.test.ts`. One real agent connected a staging fixture from `llms.txt` alone (`agent-guide.md`).
- **The field day** never wrote a record before Run 10.5 (`set -f`). Fixed on both hosts, so no record exists for 22 Nov.

### Session 9 (real use, 22 Nov 2026, one day at the owner's request)

- **Production is open** on `host-v0.9.1` (`b19ca6671e14`), epoch 7, opened through the owner's own journey (`run-9.1.md`).
  - consumer-1 is the owner's WSL. It makes names-only starts. Gate F's condition, that no application ran yet, was met on 25 Nov 2026 (below).
  - The real-use clock starts at 22 Nov 2026, 14:27:41 UTC.
- **The workspace was reworked** (D-70). `host-v0.9.0` failed the owner's first look; `host-v0.9.1` passed the seven tasks (`task-test.md`).
- **The manifest** (`session-9/manifest.md`, `--session 9`): 144 PASS (33 `earlier`; 29 of them on `host-v0.8.1` staging results, by the owner's focused pass), 9 NOT PROVEN, 7 NOT YET DUE.
- **Gate F: HARDEN** (D-74), on the owner's word. PR #23 is merged.
- **The agent experiment** (D-71) is not a pass by the plan's rule:
  - the boundary held in every request the agent sent;
  - the model's safeguards declined scenarios 2, 3 and 10.
- **The exit dossier** (`exit-dossier.md`) was corrected after the gate review (`gate-review.md`: 2 High, 8 Medium, all applied).
- **Findings it left open:** both were closed in Session 10. F-9.2-1 by D-76, and the restore changes by the re-drill (D-77) and `hostSysCall`'s test.

### Session 8 (release)

- **The candidate:** `host-v0.8.1` (`9af7051`) with `cli-v0.1.2`, recorded in `docs/evidence/session-8/candidate.json`.
- **The release manifest** (`manifest.md`, built by `scripts/release-manifest.ts`):
  - 144 PASS, 9 of them `earlier`;
  - 9 NOT PROVEN, among them the staging drill of an unknown issuance (AC-1.18, 1.40, 1.57, PO-18), whose fault is proven only on CI;
  - 7 NOT YET DUE (Gate F).
- **Reviews:** six fresh-context reviews, no Critical or High. Their accepted Mediums and Lows are lines in `known-limits.md`.
- **Production** has its own OpenBao and KMS key, closed, with no account. It opens only by `production.md` (`deploy --owner-confirmed`, D-64), after "approved".
- **The owner wants the workspace's UI and UX reworked in Session 9** (first-visit navigation is poor; `walkthrough.md`).

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

- **Staging** runs `host-v0.10.0` (26 Nov 2026, migrations up to `0019`) on its **reinstalled server** (24 Nov 2026), restored from its own pair (D-77): gate open (epoch 26), timers installed, the staging test owner re-established.
  - A new host key, a new WireGuard key, and the seal certificate `staging-seal-3`.
  - The pair signing key is still `k1`, back from custody.
  - Session 2's 16 spike organizations are retired (`failed`, their environments `archived`), so `reviewOpen` is 0.
  - The KMS instance `expiry` was put back, stopped.
- **Production** runs `host-v0.10.0` **open and in service** (epoch 15, opened 27 Nov 2026 07:21:57Z through the owner's journey, D-85; before it `host-v0.9.2` from 23 Nov 2026). From `0019` it goes back only by a restore:
  - its own OpenBao, unsealed by `mykey-prod-seal-1` (KMS domain `mykey-prod-kms`; the seal policy keeps five rights, create refused);
  - custody in `~/.mykey/custody/prod/` and the password manager; backup timers; its first pair eligible;
  - the owner's account and one organization, with the owner's secrets. Their ids, names and the owner's address never go into Git;
  - eight job timers, `mykey-field-day` among them; migrations up to `0019`.
  - No runtime or automation credential has been issued on it yet. consumer-1 keeps its 30-day token and `cli-v0.1.2`, which work on `host-v0.10.0`.

  Production deploys need the owner's permission. Every one is `--stay-closed`, then the owner's journey in the `tunnel verify --browser` window, then `--owner-confirmed` (`production.md`).

- **Evidence registry:** 161 `PASS` (from Session 11's manifest, `--session 11`: 7 of them `earlier`), 20 `SPIKE_PASS`, 10 `OPEN`. The manifest: 161 PASS, 7 NOT YET DUE, 5 NOT PROVEN (AC-1.25, AC-1.26, AC-1.36, AC-1.52, AC-1.55). `--apply` sets PASS and never lowers one.

### Open items

- **Gate F was decided HARDEN** (D-74, 22 Nov 2026). Stage 1 stays open, and Gate F is decided again at W-2 (20 Dec 2026) on 28 days of use. The next session needs its own plan (three layers); Stage 2 does not start.
- **The hardening list** (D-74). Session 10 did three of its four items: the token step (D-76), the re-drill (D-77) and the credential drill (D-78).
  - **The fourth, the owner's, is done:** on 25 Nov 2026 the owner connected a real application to production and reported it working (`docs/evidence/field/real-app.md`, owner-reported; not checked by an agent). Its token is rotated before its 30 days end, then the application restarts.
  - Outside the list: the reviewers' M1 change (R3-1, D-65), in Stage 2.
- **The owner's console step:** delete the KMS certificates `staging-seal-2`, and `drill-seal-1` if it is still listed.
- **Session 11 left open** (`session-11/report.md`):
  - the fleet's 20 seconds on staging (D-83);
  - two fault tests that fail sometimes on CI (above, under "CI and scans");
  - nothing bounds what one automation credential makes, and `machine.metadata` is not audited: the owner's design questions;
  - nine deferred minors of its two reviews.
- **Dated:**
  - **Staging's seal certificate `staging-seal-3` expires on 24 Dec 2026, 10:28:57 UTC.** Replace it by 17 Dec (runbook `kms-and-unseal.md`); `certificate_expiring` opens 10 days before.
  - **The checkpoint `kms-cert-expiry`** is due from 12 Dec 09:57 UTC. Its instance `expiry` (`losstest-1day`) was put back on the reinstalled server, so it keeps its subject.
  - **Production's seal certificate `prod-seal-1` expires on 21 Dec 2026, 07:48 UTC** (issued 21 Nov 2026). Replace it before then, the same way, with production's names (`production.md`).
  - `.trivyignore.images` expires on 14 Dec 2026.
  - **The postgres pin is still to move** (owner, 25 Nov 2026). Session 11 looked on 25 Nov: `18.7` clears the zlib and krb5 entries but still has CVE-2026-124851 (zstd), so it was not moved (`run-11.1.md`). Look again before 14 Dec. It is a runtime image change (D-69): a new host release, staging, then production with the owner's journey.
  - The checkpoint `pair-30-day` is due from 17 Dec 2026 19:00 UTC, before the 05:00 retention of 18 Dec.
  - **consumer-1's token** expires by about 22 Dec 2026: rotate it around 20 Dec, with the one-command form.
  - **W-2,** the 28-day report: 20 Dec 2026 (D-05, D-72). **W-1,** retention ageing: 23 to 26 Dec 2026.
  - **W-2's report covers two releases** (D-85): `host-v0.9.x` until 27 Nov 2026 07:13 UTC, `host-v0.10.0` after. A production fix before W-2 is a new `host-v0.10.x`. consumer-1 moves to `cli-v0.2.0` only if it takes a runtime credential.
  - Weekly from 29 Nov: `host.ts prod field-pull` and `node scripts/field-report.ts prod --week <n>`.

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
MSYS_NO_PATHCONV=1 node scripts/host.ts prod deploy --release <dir> --owner-confirmed   # production with a real owner: after --stay-closed and the owner's journey (D-64)
node scripts/release-candidate.ts --release <dir> --cli cli-vX.Y.Z | --deploy <host> --at <ISO> --epoch <n>   # candidate.json
node scripts/release-manifest.ts [--apply]       # manifest.md from proof-map.json, results.json, candidate.json; --apply sets the registry (no force)
#   both take --session <n> (default 8): that session's evidence folder; an earlier entry may name the staging release it keeps (earlier.release)
node scripts/host.ts <host> tunnel verify --browser   # the owner's journey: a Chrome window of its own at the host's name, through the tunnel
MSYS_NO_PATHCONV=1 node scripts/host.ts prod field-pull   # the day records to ~/.mykey/field/prod/; then:
node scripts/field-report.ts prod --week <n>     # docs/evidence/field/week-<n>.md (week 1 starts at docs/evidence/field/clock.json)
pnpm run test:staging tests/staging/agent-experiment.staging.test.ts   # the agent experiment (needs ~/.mykey/secrets/anthropic/api-key; reseed with agent-runner.staging first)
pnpm run test:staging tests/staging/agent-guide.staging.test.ts        # the agent-guide proof (D-79): one agent from llms.txt alone, then the sweep (same key)
node scripts/probe.ts secrets --host <staging|prod>   # one host's existing heartbeat token and units; no new token, nothing else touched
MYKEY_DRILL_TARGET=staging MYKEY_REDRILL_PHASE=before|lost|restore MYKEY_DRILL_RELEASE=<dir> pnpm run test:staging tests/staging/redrill.staging.test.ts   # the re-drill (D-77); state in ~/.mykey/drill/redrill-state.json
MYKEY_RELEASE_NEW=<dir> MYKEY_RELEASE_PREVIOUS=<dir> pnpm run test:staging tests/staging/deploy.staging.test.ts   # both required
MYKEY_CLI_DIST=<unpacked bundle> MYKEY_CLI_EXPECT=<x.y.z> pnpm run test:staging tests/staging/cli.staging.test.ts   # a published CLI against staging; both required together
node scripts/sweep-ci.ts <file>…                 # counts canary and token shapes in downloaded CI logs and reports
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
  - The route list is frozen (D-15), amended once in Session 11: 57 routes. Since Session 7 no route has a pending body.
  - `WEB_ROUTES` is the table of the workspace's page paths; the API and the page's router both read it.
- **`packages/db`** has five schemas:
  - `app`: 20 tables;
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
- **Machine access has three credentials** (Session 11):
  - the 30-day token (an OpenBao token, shown once);
  - the runtime credential (`mkrc.`, class `machine_exchange`): PostgreSQL keeps a verifier bound to its kind, environment and networks, and the exchange mints a 900-second token that says `meta.exchange`;
  - the automation credential (`mkac.`, class `automation`): its verifier covers its chain, rights and networks. The person's handlers serve its routes with another actor and recheck.

  A request with a dead credential, or from outside its networks, is a miss of its source (`rl:machine-miss`).

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
  - **A job Claude Code "stopped" may still run:** only its wrapper dies. Look for the script and its vitest children (`Win32_Process`) before starting anything, or two staging files overlap (Session 11).
  - `docker desktop stop` between the files that need Docker frees about 4 GB.
  - The WSL VM keeps its memory after a job; quitting Docker Desktop (or `wsl --shutdown`) frees it.
  - After a killed job, find orphan vitest processes by command line (`Win32_Process`) and remove leftover `mykey-t-*` Compose projects.
  - Claude Code also stops background jobs when memory is short while the session is idle. It asks that they are not started again without the owner's word: report, and wait.
- **After the owner has edited files, read every changed line before committing.** Session 8 committed the owner's in-place edit of a runbook (a real staging id), and the secret scan went red.
- **Long or quoted text never goes through the shell.** A heredoc holding `'''`, a regex or non-ASCII text breaks. Write a script file with the editor tools and run that.

### CI and scans

- **When CI runs:** only on pull requests and by hand (`gh workflow run ci --ref <branch>`), never on a plain push.
  - **Two weights (Session 7).** A draft pull request runs `check` (with the unit tests) and the secret scan, about two minutes. A ready pull request, or a run by hand, adds the scans, both integration shards and the `browser` job: about 16 minutes in all. `gh pr ready <n>` starts the full run.
  - A pull request whose changes are all under `docs/` or in `.md` files runs only `check` (with the unit tests) and the secret scan.
  - Integration runs in two shards, about 12 and 14 minutes, each with a 30-minute limit; `browser` takes about 7.
  - Runners cost nothing (the repository is public).
- **Watch CI after every push** (`gh run list --branch <branch>`). Session 3 was red for its whole length unnoticed.
- **Two fault tests were red once on a documents-only commit** (Session 11's gate) and green on `gh run rerun <id> --failed`: `tests/fault/audit/exhaustion.test.ts` ("after space is freed", 503 `quarantined`) and `tests/fault/capture/compete.test.ts` (a 5xx that is not `busy`). The cause is not known.
- **Linux CI sees file ownership; Windows Docker hides it.** Test containers that write into a bind mount run as the caller (`tests/harness/restic.ts`).
- **The image scan** covers the pinned upstream images and the API image. It is green only through `.trivyignore.images`: reviewed upstream CVEs with no fix possible in this repository without moving an image pin, all expiring on 14 Dec 2026.
  - A new upstream CVE can turn it red overnight. Review it, add an entry that gives the reason, and name what is exposed.
- **The secret scan** must see the whole history and at least one commit. A scanner that crashes or scans nothing fails the `scans` self-test. Reviewed false positives go into `.gitleaksignore` by fingerprint, with the reason above them.
- **GitGuardian** flags `-e PGPASSWORD postgres` in `tests/harness/stack.ts` (incident 39994924). It is a false positive that only the owner can dismiss, and it is not a required check.
  - On PR #27 it failed with seven findings, incidents 41121353, 41140388, 41140389, 41141567 and 41141568: the lines `.gitleaksignore` records for Session 11 (a synthetic token literal in `validate.test.ts`, and credential ids in `staging-automation.json` on two commits). No secret; the owner's to dismiss.
  - Read what it found with `gh api repos/Virabyan99/mykey/check-runs/<id>` (`.output.text` lists commit and file), before a merge.
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
  - The credential drill's trigger catches the issuance at its audit record (D-78); it keeps five attempts.
  - A cached failure must never make the decision.
- **A route that just needs to answer:** tests that only need "a product route answers" use `GET /v1/organizations`. `/v1/reference` depends on the Scalar asset and on file order.
- **CLI tests on Windows** run only through `pnpm run test:cli`. Its arguments may hold only letters, digits and `. _ / = -`: use `--testNamePattern=word`.
- **The token sweep** (`token-sweep.staging.test.ts`): tokens are stored nowhere, so each test searches the tokens it holds, with a control per surface.
- **Synthetic users:** sign-in lowercases e-mail, so synthetic users must be stored lower-case.
- **A search needs a needle control** (Session 11): one known string sent as the secrets are, which must be found. It must differ from every argument control of the same `countOnHost` call and be at least 8 bytes, or the count goes wrong.
- **The caller's address is never recorded.** `callerNetwork` (`tests/harness/staging-machine.ts`) reads it under `secretOutput`; no evidence file, message or assertion may hold it.
- **An evidence key with "credential", "token" or "key" in its name turns the secret scan red** when the id beside it has high entropy, so only on some runs. Name such keys `ids.…`.
- **`alerts.staging` takes about 85 minutes.** Plan the pass around it, on mains power.
- **`transport.staging` expects production open** (`/health` 200 on both hosts). It is red during a `--stay-closed` deploy of production.
- **The consumer rehearsal counts only on the candidate's release** (the manifest refuses an older one since Session 11). Run it before the manifest.

- **A bound on the probe is its worst case, never a typical run** (Session 8). Doc 06 §12: a check every minute and a three-minute grace, counted from the last good observation; the evaluation comes a minute later and the cron can run a minute late. `kms_unreachable` opened at 292 and 300 s, and the blackout's `health_failing` at 304 s: the tests now allow 410 s and 360 s. A drill's cause must outlast the window in which its alert is looked for.
- **The deploy staging test deploys releases.** Without its two variables it used to deploy Run 6.9's pair and left staging on `host-v0.6.0` (Session 9). It now refuses to start without them.
- **The agent experiment's `finally` revokes the runner's credential.** Every rerun needs `agent-runner.staging.test.ts` first (a new seed).
- **Claude's safeguards stop adversarial agent prompts** (the classifier ends the session before any tool call). Record such a session as "not exercised", never rephrase to get past it.
- **A one-call window is hit from the host, never over SSH.** A pause sent over SSH lands 2.5 to 3.4 s late (20 misses in Session 8). The credential drill's trigger (`tests/staging/host-scripts/freeze-on-create.sh`, a transient unit via `hostUnit`) follows OpenBao's audit file and writes OpenBao's `cgroup.freeze` about 1 ms after the request record, which comes before the answer (D-78).
- **A staging file that creates an environment proves the provisioner;** the restore's report does not. After Run 10.6's restore, every environment stayed `pending` until `backup`, `machine`, `cli` and `sweep` showed it (the provisioner had no organization id; fixed in `scripts/host-restore.ts`).
- **Home lists 100 projects, ordered by id** (`LIMITS.listing.maxLimit`), and staging's organization holds more, since projects cannot be deleted. A test must not expect a new project on Home (`workspace.staging` goes to the project page when Home says the list is cut).
- **The VPN can drop for minutes during a long staging pass** (twice in Run 10.6). A hook timeout or "does not answer on port 22" is a rerun, after `require-staging-env.ts` answers again.
- **One staging file, one fate.** A red test makes every id that names its file unproven. Keep a probabilistic drill in a file of its own (`credential-drill.staging.test.ts`).
- **`probe.staging`'s blackout darkens staging for 8 minutes** (480 s, restored by a timer). Nothing else may run then, and a unit that runs during it (`mykey-sweep`) fails once.
- **The release manifest (Session 8).** PASS comes only from `scripts/release-manifest.ts --apply`. After an apply the registry holds PASS, so rerun the manifest after any change to `proof-map.json` or `results.json`. Do the claims walk before the freeze: a false text on the page makes a new candidate.

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

- **The owner's journey needs the host's own name.** A browser at `https://127.0.0.1:<port>` meets the listener's own CA and then `origin_rejected`, because the API takes changes only from `MYKEY_BASE_URL`. Use `tunnel verify --browser` (Session 9).
- **Owner commands in Git Bash that read a file on stdin** need `node.exe`, not `node`: winpty refuses it ("stdin is not a tty").
- **The owner pastes whole blocks.** A prompt that wants one value gets a dotenv file, and a hidden-echo step that fails sends the next paste, a token, to the shell. The two first uses (Runs 8.8 and 9.2) both leaked a token into the chat. Give one command per step, reading silently (`read -rs`).

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
- **No rollback across a migration.** `deploy` refuses a release whose last migration is older than the host's (D-57). `host-v0.10.0` holds `0019`: from it a host goes back only by a restore, and `deploy.staging` asserts the refusal.
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

- **A host script under `set -f` cannot use a glob** (Run 10.5: the field day's `chmod "$work"/*` stopped it before its first record). `tests/unit/hosts/noglob.test.ts` refuses that shape.
- **A restore onto a host's own reinstalled server** (Run 10.6, `restore.md`):
  - The reinstalled `host.env` lacks the four OpenBao and KMS settings: set them with `host.ts env` before anything else.
  - Pull the upstream images by digest in a `maint` window: `compose pull` needs `MYKEY_BASE_URL`, which the first `up` writes.
  - After the opening:
    - the signing key `k1` comes back from custody (pairs name no key id), then `backup-init`, `r2-install` ×3, `timers`, and the first pair by hand;
    - `reestablishStagingOwner` for the test owner.
  - A host "declared lost" in a drill must have its backup timer stopped, or it makes the pair `--newest` takes.
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
