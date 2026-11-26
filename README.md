# MyKey Private

MyKey Private is a single-operator secrets service. It replaces an application's `.env` file:

- the application's secrets are kept in [OpenBao](https://openbao.org/), one namespace per organization;
- the owner manages them in a web workspace;
- a thin CLI, `secrets`, starts the application with the **complete** set of one environment as environment variables, or starts nothing.

The application keeps reading `process.env` or `os.environ` as before, and no value lands on the disk of the machine that runs it.

```sh
secrets-launch.sh -- npm start      # the application starts with its secrets, no .env file
```

**Working with an AI coding agent?** Give it [`llms.txt`](llms.txt). It leads to one guide, [`docs/agents/connect-an-application.md`](docs/agents/connect-an-application.md), which the agent follows on its own. The machine token and every secret value stay with you. An agent that writes a provisioning script has a second guide, [`docs/agents/provision-with-automation.md`](docs/agents/provision-with-automation.md).

## Contents

- [What it does](#what-it-does)
- [Where the project stands](#where-the-project-stands)
- [How to use it](#how-to-use-it)
  - [For people](#for-people)
  - [For AI coding agents](#for-ai-coding-agents)
  - [For the operator](#for-the-operator)
- [How it is built](#how-it-is-built)
- [Development](#development)
- [Documentation map](#documentation-map)
- [Rules of this repository](#rules-of-this-repository)

## What it does

- **Secrets in one place.** Organizations, projects and environments (`development`, `production`, …). Each environment holds up to 1,000 secrets. Every write keeps a version, with history, delete, undelete and restore.
- **A web workspace for the owner:**
  - sign-in with a password and an authenticator app, recovery codes and sessions;
  - secrets: create, edit, reveal (30 seconds, never stored by the page), copy, history;
  - import and export of dotenv files, with a preview before anything is written;
  - machine credentials of both kinds: issue, list, revoke;
  - automation credentials, for the owner and admins: issue, list, revoke;
  - activity and audit.
- **Machine credentials, two kinds.** Both read one environment and nothing else, and both are shown once at issue.
  - **A machine token** lives at most 30 days. It is stored in a file only its user can read (`~/.config/mykey/machine-token`).
  - **A runtime credential** is for a server that must start by itself: it lives at most 365 days. The server keeps its client secret, and at each start the CLI exchanges it for a token of 15 minutes. A revocation stops the credential at once.
- **Automation.** A script that holds an automation credential creates projects, environments, secrets and runtime credentials through ten routes, with no person at the keyboard. The credential carries only the rights it was given, is bound to source networks, and reaches only the projects its own chain made. It reads no value and deletes nothing.
- **The CLI.** `secrets` reads the whole environment at start. If the set cannot be read completely, nothing starts, and the CLI exits with one documented code (`denied`, `unavailable`, …). It takes a machine token or a runtime credential's client secret in the same place. Linux and macOS; WSL on Windows.
- **Audit.** Every change and every reveal is recorded. Both audit streams are archived to Cloudflare R2 as verified, locked segments.
- **Backup and restore:**
  - a nightly backup pair, which becomes eligible only after read-back, a full check, a scratch restore and a signature;
  - a rehearsed restore onto a clean server, which resets every account and revokes every token.
- **Limits and alerts.** Every limit fails closed (429, 507, 503). An outside probe watches fifteen conditions, each with a runbook section.

What it does **not** do is listed honestly in [`docs/runbooks/known-limits.md`](docs/runbooks/known-limits.md).

## Where the project stands

The project is in **Stage 1**: nine planned sessions, a tenth for hardening after Gate F, and an eleventh that added two credentials. All eleven are done and merged.

- **Session 8:** the security review and the controlled-use release. Gate R was signed (D-67).
- **Session 9:** production opened for real use on 22 Nov 2026. Gate F was decided **HARDEN** (D-74).
- **Session 10:** the hardening:
  - a safer one-command token step;
  - a restore re-drill onto a reinstalled server;
  - the credential drill on staging;
  - the documentation for AI agents.
- **Since 25 Nov 2026:** a first real application runs on production.
- **Session 11** (D-80): the runtime credential with its exchange, the automation credential with its ten routes, and the CLI `cli-v0.2.0`.
  - It is released as `host-v0.10.0` and runs on **staging**.
  - **Production does not have it yet.** It still serves the release before it, so an automation credential or a runtime credential cannot be issued there. Production gets it after W-2.

Gate F is decided again at **W-2, 20 Dec 2026**, on the record of 28 days of use. Each session's result is in `docs/evidence/session-<n>/report.md`; the latest is [`docs/evidence/session-11/report.md`](docs/evidence/session-11/report.md).

**One operator, no sign-up.** MyKey serves one owner on one host, and no one can sign up. The first account is made by the operator's bootstrap. The runbooks below describe this service's own hosts. Running your own copy is possible from them, but it has not been rehearsed for anyone else.

## How to use it

### For people

The owner's path, in order:

| Step | What                                                                                                                                   | Document                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | The first sign-in, the authenticator and the recovery codes; the workspace's first screens                                             | [`start-here.md`](docs/runbooks/start-here.md)                   |
| 2    | The workspace: what each screen does and what to do when it refuses                                                                    | [`workspace.md`](docs/runbooks/workspace.md)                     |
| 3    | Issue a machine credential (a 30-day token, or a runtime credential for a server), store it with the one command, rotate it, revoke it | [`machine-credentials.md`](docs/runbooks/machine-credentials.md) |
| 4    | Connect an application on your own machine (Linux, macOS or WSL)                                                                       | [`consumer-local.md`](docs/runbooks/consumer-local.md)           |
| 5    | Run it in a container on a server                                                                                                      | [`consumer-deploy.md`](docs/runbooks/consumer-deploy.md)         |
| —    | Let a script create projects, secrets and runtime credentials                                                                          | [`automation.md`](docs/runbooks/automation.md)                   |
| —    | The dotenv format that import and export use                                                                                           | [`dotenv-format-v1.md`](docs/runbooks/dotenv-format-v1.md)       |
| —    | What the service does not do                                                                                                           | [`known-limits.md`](docs/runbooks/known-limits.md)               |

Each environment's **Connect an application** page in the workspace shows the commands of steps 4 and 5 with the service's address, the project's id and the environment's name filled in. It never fills in the token.

The short version for a local application:

1. In the workspace, create the project and enter its secrets, or import the `.env` file on the environment's Import screen.
2. Install the CLI `cli-v0.2.0` and the launcher (`consumer-local.md` §1–4).
3. Set `SECRETS_API_URL`, `SECRETS_PROJECT` (the project's id) and `SECRETS_ENVIRONMENT` (its name). None of them is a secret.
4. Issue a machine credential, and store its token with the one command shown. Paste only at the prompt `Paste the token, then press Enter:`.
5. Start the application with `secrets-launch.sh -- <the start command>`.
6. Delete the `.env` files.

### For AI coding agents

| File                                                                                   | What it is                                                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`llms.txt`](llms.txt)                                                                 | The entry point for an agent: the rule, and the link to the guide                                                                                       |
| [`docs/agents/connect-an-application.md`](docs/agents/connect-an-application.md)       | The guide for the usual job: make an application start from MyKey. It stands alone: install, find the names, change the start, check it, the exit codes |
| [`docs/agents/provision-with-automation.md`](docs/agents/provision-with-automation.md) | The guide for another job: write or run a script that creates projects, secrets and runtime credentials with an automation credential                   |
| [`tests/fixtures/consumers/next-app/`](tests/fixtures/consumers/next-app/)             | A small Next.js application that runs on MyKey                                                                                                          |
| [`tests/fixtures/consumers/fastapi-app/`](tests/fixtures/consumers/fastapi-app/)       | A small FastAPI application that runs on MyKey                                                                                                          |

**The rule:** an agent never reads, prints, copies or asks for a machine token or a secret value. Four steps are the human's, and the guide hands each one over with exact text:

- `put-secrets`: enter the values in the workspace;
- `store-token`: store the token with the one command;
- `remove-dotenv`: delete the `.env` files;
- `replace-token`: issue a new token when the old one expires or is revoked.

This is a rule the agent keeps, not a barrier the service enforces: the agent runs as your user.

The second guide has the same rule for an automation secret, with two steps of its own: `store-automation-secret` and `replace-automation-secret`. The agent writes the script that carries secrets; it never sees one.

To use it, put one line in your project's agent instructions (`CLAUDE.md`, `AGENTS.md`, …):

```text
Before touching secrets or environment variables, read https://raw.githubusercontent.com/Virabyan99/mykey/main/llms.txt and follow the guide it links to.
```

A guide that says so first matters: in the proof run, the agent opened `.env` before it read the guide.

**What has been proven:**

- One Claude Code agent connected a fixture application on staging from `llms.txt` alone (`docs/evidence/session-10/agent-guide.md`). No secret value was found anywhere the run left a trace.
- `tests/unit/agents/guide.test.ts` keeps every command and exit code in the guide equal to the code and the runbooks.
- `tests/unit/agents/automation-guide.test.ts` does the same for the second guide: its routes, rights and limits are the contract's.
- **No agent has yet been run from the second guide.** Its client rules are proven by the reference client (`tests/fixtures/automation/tenant-provisioner.ts`) at integration and on staging, not by an agent that read the guide.
- Other agents have not been tested.

### For the operator

| Task                                                    | Runbook                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts: bootstrap, reset of a lost password or factor | [`operator-accounts.md`](docs/runbooks/operator-accounts.md)                                                                           |
| Organizations                                           | [`provisioning.md`](docs/runbooks/provisioning.md)                                                                                     |
| Production: first opening, later deploys                | [`production.md`](docs/runbooks/production.md)                                                                                         |
| Releases and deploys                                    | [`deploy.md`](docs/runbooks/deploy.md), [`service-gate.md`](docs/runbooks/service-gate.md)                                             |
| Hosts, network, VPN and firewall                        | [`network.md`](docs/runbooks/network.md)                                                                                               |
| The seal and its KMS certificates                       | [`kms-and-unseal.md`](docs/runbooks/kms-and-unseal.md)                                                                                 |
| Status and alerts                                       | [`operator-status.md`](docs/runbooks/operator-status.md), [`alerts.md`](docs/runbooks/alerts.md), [`probe.md`](docs/runbooks/probe.md) |
| Backup and restore                                      | [`backup.md`](docs/runbooks/backup.md), [`restore.md`](docs/runbooks/restore.md)                                                       |
| Audit                                                   | [`audit.md`](docs/runbooks/audit.md)                                                                                                   |
| Where each credential lives (names, never values)       | [`credential-custody.md`](docs/runbooks/credential-custody.md), [`custody-map.md`](docs/runbooks/custody-map.md)                       |
| Real use: day records and weekly reports                | [`field-use.md`](docs/runbooks/field-use.md)                                                                                           |
| Limits                                                  | [`limits.md`](docs/runbooks/limits.md)                                                                                                 |

All runbooks are in [`docs/runbooks/`](docs/runbooks/). The operator tool is `node scripts/host.ts <staging|prod> <command>`; run it without arguments for its usage.

## How it is built

```text
 owner's browser ──▶ API (apps/api) ──▶ PostgreSQL: accounts, permissions, operations, audit
                     serves the            (never a secret value or a machine token)
                     workspace (apps/web)
                          │
 application ◀── secrets CLI (apps/cli) ──▶ API ──▶ OpenBao: secret values and versions
 (no .env)        reads the token file                 written only by the provisioner (apps/provisioner)

 outside: the probe (workers/probe, a Cloudflare Worker) · backups and audit archives in Cloudflare R2
```

- **Two stores, one owner per fact.** Secret values live only in OpenBao (KV v2, one namespace per organization). PostgreSQL holds the rest, and never a value or a token.
- **One contract.** `packages/contracts` is the single source for limits, names, error codes and the route table; `openapi.json` is generated from it.
- **Authority on every request.** Every route reads current rows; no handler decides authority. Every change needs an idempotency key.
- **Credentials for machines are verified, not stored.** A machine token is OpenBao's own. For a runtime or an automation credential PostgreSQL keeps a keyed digest, which also covers what the credential is bound to, and never the secret.
- **Pinned.** Every dependency is pinned exactly, every image by digest and every GitHub Action by commit (`infra/dependencies.lock.json`, enforced by `check`).

The full design is in Doc 06, the technical specification, in `docs/`.

## Development

Prerequisites:

- Node.js, the exact version in `.node-version`;
- pnpm, the version in `package.json`'s `packageManager` (`corepack enable` picks it up);
- Docker with Compose, for everything except `check` and the unit tests.

```sh
pnpm install --frozen-lockfile
pnpm run check              # format, lint, types, pins, OpenAPI, schema drift, authority matrix, evidence registry
pnpm test                   # unit tests
pnpm run test:integration   # real PostgreSQL and OpenBao in Docker
pnpm run test:browser       # the workspace in Chromium against a local API with real stores
pnpm run test:cli           # the CLI in a Linux container
pnpm run stack:up           # a local development stack
```

A suite with no tests fails, a skipped test is not a pass, and mocks are not accepted as proof for anything that touches the two stores. More commands, and what this project has learned the hard way, are in [`CLAUDE.md`](CLAUDE.md).

```text
apps/       api, provisioner, web (the workspace), cli, ops (operator commands)
packages/   contracts, db, auth, openbao, operations, audit
workers/    probe
infra/      compose, hosts, traefik, openbao, backup, recovery, release
tests/      unit, integration, browser, cli, fault, restore, staging, consumers
scripts/    repository and operator scripts (TypeScript, run directly by Node)
docs/       specification, plans, decisions, evidence, runbooks, agents
```

## Documentation map

| Where                                | What                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/doc_*.md`                      | The specification: north star, stage breakdown, functional (Doc 04) and technical (Doc 06) specifications, the Stage 1 plan (Doc 10) |
| [`docs/plans/`](docs/plans/)         | One plan per session                                                                                                                 |
| [`docs/decisions/`](docs/decisions/) | One page per decision (`D-NN`)                                                                                                       |
| [`docs/evidence/`](docs/evidence/)   | Run notes, session reports, release manifests, and the evidence registry (`registry.json`)                                           |
| [`docs/runbooks/`](docs/runbooks/)   | How to operate and use the service                                                                                                   |
| [`docs/agents/`](docs/agents/)       | The two guides for AI coding agents                                                                                                  |

## Rules of this repository

- The repository is public, history included. It holds **synthetic data only**: no real secret, token, password or production id belongs anywhere in it.
- Credentials live on the operator's workstation under `~/.mykey/`; the runbooks name them, never their values.
- Work happens on branches, through pull requests, and is merged on the owner's word.
