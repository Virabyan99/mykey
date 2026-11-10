# MyKey Stage 1 — Session 1 (Foundation) Execution Plan

> **For the executing agent:** carry this plan out run by run, in the order given in "Run order". If you have the superpowers skills, use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking. You do not re-decide anything in Doc 10 §3 / §8 or in the "Planner decisions" table below; if one proves wrong, write a one-paragraph decision record and continue (Doc 10 §1).

**Goal:** By the end of Day 1, a new agent can clone the repository, run one command, and have a tested TypeScript skeleton with real PostgreSQL 18 and OpenBao underneath, CI that fails on a seeded secret and a seeded vulnerable dependency, the database base with five least-privilege roles, a strict dotenv codec, an ageing R2 retention fixture, and an owner who knows what to buy and by when.

**Architecture:** A pnpm monorepo laid out as Doc 06 §2 prescribes. `packages/contracts` is the single source of limits, names, error codes, the frozen route list, the dotenv codec and the generated OpenAPI 3.1 document. `packages/db` owns Drizzle schemas, reviewed SQL migrations, a checksum-verifying single migrator and the cluster roles. A Docker Compose stack (PostgreSQL 18 with TLS; OpenBao with Raft, TLS and a development static seal) backs every integration test through one harness.

**Tech stack:** Node LTS, pnpm 10, TypeScript (strict, erasable syntax only), Vitest, fast-check, ESLint + typescript-eslint, Prettier, Zod, Drizzle ORM/Kit, `pg`, Docker Compose, GitHub Actions, gitleaks, Trivy, Restic, Cloudflare R2. Exact versions are chosen in Run 1.3, not here.

**Spec:** `docs/doc_10_mykey_stage_1_compressed_implementation_plan_v1.0.md` §1–§5, §7 "Session 1", §8, §9. Behaviour: Doc 04 §5, §8.1. Design: Doc 06 §1.1, §2, §3, §8 "Import", §9, §11, §13.2. Old runbooks for ideas only: D08-S01, S02, S04, S09, S22.

---

## Global constraints

Every run's requirements include this section.

- **Synthetic data only.** No real secret, token or password anywhere. Nothing secret in Git, logs, CI artifacts, evidence files or the agent transcript (Doc 10 §4.1 rules 2 and 10).
- **Real stores for proof.** Integration tests run against real PostgreSQL and real OpenBao in Docker. Mocks prove nothing about the two stores (§4.3).
- **A skipped test is not a pass.** Suites exit non-zero on zero tests, on a missing fixture, and on missing cloud credentials.
- **No pre-release dependency, no PostgreSQL 19, no Redis, no second queue, no workflow engine, no MCP server, no OpenBao Agent as a required component** (§4.2).
- **Pins:** npm packages at exact versions, container images by `@sha256:` digest, GitHub Actions by 40-hex commit SHA. No floating tag anywhere.
- **Limits live once**, in `packages/contracts/src/limits.ts` (re-exported as `@mykey/contracts`). No other file hard-codes a Doc 06 §11 number.
- **Fixed values:** secret name `^[A-Z][A-Z0-9_]{0,127}$`, prefix `SECRETS_` reserved; value ≤ 65,536 UTF-8 bytes; environment name `^[a-z][a-z0-9-]{0,62}$`; project name 1–64 code points, NFC; 20 versions; dotenv file ≤ 1 MiB and ≤ 1,000 entries.
- **Owner's machine:** Windows 11, PowerShell and Git Bash, Docker Desktop, WSL2. The repository path contains a space (`All projects`) and sits inside OneDrive. Every repo script is TypeScript run by `node`; no Bash script runs on the host. Shell scripts exist only inside containers and are stored with LF endings. Quote every path.
- **Every run ends with:** `pnpm run check` green, the run's tests green, a commit on branch `session-1`, and a run note `docs/evidence/session-1/run-1.N.md` (template in Run 1.1).
- **Evidence layout** is Doc 10 §4.4, not Document 08's (`docs/evidence/session-N/…`, one `registry.json`).

## Review focus

The five conditions the specs imply but do not spell out, most likely to bite first. Each has a test pinned in the run named.

1. **CRLF from a Windows checkout** corrupts dotenv fixtures, breaks container shell scripts and changes build hashes. → `.gitattributes` in Run 1.2; fixture line-ending test in Run 1.8; the stack is started from the Windows checkout in Run 1.5.
2. **A scanner or cloud suite that silently does nothing shows green.** → scanner self-test job in Run 1.4; `test:cloud` refuses to start without credentials in Run 1.9; `passWithNoTests: false` in Run 1.2.
3. **Ordinary dotenv files people actually have:** no trailing newline, CRLF endings, a lone CR, a BOM, an empty file, whitespace-only lines, `=` inside a value, `A=` versus `A=""`. → explicit cases in Run 1.8.
4. **The test stack collides with something already running** (a fixed port in use, a crashed run's leftover containers). → unique project names and ephemeral ports, two-stacks-at-once test and a sweep command in Run 1.5.
5. **A table added later is reachable by a role nobody reviewed.** → Run 1.7's privilege test reads the catalog and fails on any table missing from the expected-grants matrix, and on any privilege held by `PUBLIC`.

## Planner decisions

Settled here so the executor does not have to choose. Each one marked **DR** gets a decision record in the run shown.

| # | Decision | Why | Run |
| --- | --- | --- | --- |
| P-1 | Lint/format/test tools: ESLint + typescript-eslint, Prettier, Vitest, fast-check. | Conservative, stable; Vite+ stays a candidate only (Doc 06 §10). | 1.2 |
| P-2 | Repo scripts are `.ts` files run directly by `node` (native type stripping); TypeScript uses `erasableSyntaxOnly`. If the pinned Node cannot do this cleanly, add `tsx` in Run 1.3. | One language, works on Windows. | 1.2 |
| P-3 | Default Node choice is **24 LTS** (already installed). Run 1.3 moves to 26 only if a pinned dependency requires it. **DR D-12.** | Node 26 needs `libatomic` on Linux hosts (Doc 06 §1.1); nothing here needs 26. | 1.3 |
| P-4 | Not-yet-used runtime dependencies (Hono, Better Auth, pg-boss, React, TanStack, Scalar) are pinned in the pnpm `catalog:` and in `infra/dependencies.lock.json` now; packages adopt them with `catalog:` later. | Pins exist before any feature depends on them. | 1.3 |
| P-5 | CI starts PostgreSQL and OpenBao with the **same Compose file as local development**, not with `services:` containers. **DR D-13.** | OpenBao needs mounted config and generated TLS material; service containers start before checkout. Same real containers, one definition. | 1.4, 1.5 |
| P-6 | Scanners (gitleaks, Trivy) run as digest-pinned container images, not third-party Actions. | Smallest Actions supply chain. | 1.4 |
| P-7 | The four-platform CLI matrix job runs only when `apps/cli/**` changes or on manual dispatch. | macOS minutes are billed at a multiple on private repos. | 1.4 |
| P-8 | The local OpenBao uses `seal "static"` with a generated 32-byte key file as the "development seal". | Auto-unseals on restart with Raft storage, no dev-mode in-memory server. | 1.5 |
| P-9 | OpenAPI 3.1 is built by a small in-house builder over Zod's own JSON Schema output (`z.toJSONSchema`, draft 2020-12). Fallback if the pinned Zod lacks it: `zod-openapi`. | No Hono dependency inside `contracts`; CLI and web import it too. | 1.6 |
| P-10 | Error codes not named by Doc 04/06 are assigned in Run 1.6's table. **DR D-14.** | The specs name ten codes and describe the rest only by HTTP class. | 1.6 |
| P-11 | The single operation-status route is `GET /v1/operations/:operation`; `/v1/operations/:id/status` is a denied alias. The four Doc 06 §18.3 route families are frozen in the same list. **DR D-15** (amends Doc 06 §9 and §18.3). | Doc 10 Run 1.6; Doc 06 §9 "route-contract freeze". | 1.6 |
| P-12 | Migrations are applied by our own thin migrator (file checksums, advisory lock), not Drizzle's. Drizzle Kit only generates SQL for review. | Drizzle's migrator does not detect an edited applied migration. | 1.7 |
| P-13 | Audit append-only is enforced by **insert-only grants** (no security-definer function). | Simplest option Doc 06 §3 allows. | 1.7 |
| P-14 | `auth.*` tables and the pg-boss `jobs.*` tables are **not** created in Session 1; only their schemas and default privileges are. `membership.user_id` has no foreign key yet. | Better Auth's schema is proven in Run 2.3; pg-boss migrates in Run 3.1. | 1.7 |
| P-15 | R2 has no delete-only permission: "Object Read & Write" also permits delete. Upload and clean-up use **separate tokens with the same permission**; the bucket lock is what denies deletion. **DR D-16.** | Doc 06 §13.2 requires the real permissions to be documented, not implied. | 1.9 |
| P-16 | Fixture lock: `pairs/` 345,600 s (4 days); `probe/` 600 s (10 minutes) to see a full lock-expire-delete cycle on Day 1 and to find R2's minimum. | Doc 10 Run 1.9 "target 3–5 days; confirm the minimum". | 1.9 |
| P-17 | Agent-held credentials for this stage live outside the repository and outside OneDrive in `~/.mykey/secrets/` on the workstation; CI-needed copies go to GitHub Actions secrets. A custody list (names and locations, never values) is kept in `docs/runbooks/credential-custody.md`. | Keeps secrets out of Git and out of a synced folder. | 1.1, 1.9 |
| P-18 | Servers for OWN-2: Ubuntu 24.04 LTS, flavour **C3-8** (4 vCPU / 8 GB / 100 GB NVMe) or the nearest with ≥ 4 vCPU, 8 GB, 80 GB. | Matches Doc 10 §5 indicative size; Run 1.3 confirms. | 1.1 |

## Run order

```text
1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 → 1.7 → 1.10
                 └→ 1.9 (parallel worktree; start as soon as 1.3 is merged — its clock matters most)
                             └→ 1.8 (parallel worktree; start once Run 1.6 Task A is merged)
```

Run 1.8 uses `LIMITS` and `checkSecretName` from Run 1.6 Task A, so it is parallel with the rest of 1.6 and with 1.7, not with all of 1.6. Parallel runs work in `git worktree` checkouts **outside OneDrive** and merge into `session-1` by fast-forward or rebase.

## File map

```text
.gitattributes  .gitignore  .editorconfig  .npmrc  .node-version  .prettierrc.json  .prettierignore
package.json  pnpm-workspace.yaml  tsconfig.base.json  tsconfig.json  eslint.config.js  vitest.config.ts
.gitleaks.toml  .trivyignore  README.md
.github/workflows/ci.yml
apps/{api,provisioner,web,cli,ops}/           package.json, tsconfig.json, src/index.ts      (empty entry points)
packages/contracts/src/                       limits.ts names.ts ids.ts errors.ts operation.ts routes.ts openapi.ts index.ts
packages/contracts/src/dotenv/                parse.ts serialize.ts warnings.ts index.ts
packages/contracts/openapi/openapi.json       generated, committed
packages/db/src/                              schema/*.ts migrate.ts roles.ts pool.ts index.ts
packages/db/migrations/                       NNNN_*.sql + meta/ (Drizzle Kit journal)
packages/db/roles/roles.sql                   cluster roles, no passwords
packages/{auth,openbao,operations,audit}/     package.json, tsconfig.json, src/index.ts      (empty)
workers/probe/                                package.json, src/index.ts                     (empty)
infra/dependencies.lock.json
infra/compose/dev.compose.yml  infra/compose/dev/{pki-init.sh,openbao.hcl,postgresql.conf,pg_hba.conf}
infra/backup/retention-fixture/               r2.ts build-pair.ts provision.ts upload.ts
infra/{hosts,traefik,openbao,backup,recovery,release}/.gitkeep
scripts/                                      stack.ts repro-build.ts pins-verify.ts contracts-openapi.ts
                                              require-cloud-env.ts registry-build.ts registry-verify.ts
tests/package.json  tests/harness/{stack.ts,global-setup.ts}
tests/unit/{skeleton,pins,contracts,dotenv,registry}/…
tests/integration/{toolchain,stack,database}/…
tests/restore/retention/fixture.cloud.test.ts
tests/fixtures/{ci,dotenv,dotenv-loaders,migrations}/…
docs/decisions/D-01…D-16-*.md
docs/evidence/registry.json  docs/evidence/cost-sheet.md
docs/evidence/session-1/{run-1.1 … run-1.10}.md  report.md  retention-fixture.json
docs/runbooks/{credential-custody,db-globals-inventory,local-stack,dotenv-format-v1}.md
```

---

## Run 1.1 — Decisions and owner kick-off · OWNER (OWN-1; announces OWN-2, OWN-3)

**Files:** create `docs/decisions/D-01-…` to `D-11-…`, `docs/runbooks/credential-custody.md`, `docs/evidence/session-1/run-1.1.md`.

**Produces:** a Git repository on branch `session-1`; the run-note template used by every later run; the SSH public key the owner installs on the OVH servers.

- [ ] **Step 1 — Create the repository locally.** `git init -b main`; add a minimal `.gitignore` (`node_modules/`, `dist/`, `.stack/`, `.secrets/`, `.env*`, `*.tsbuildinfo`, `coverage/`) and `.gitattributes` (`* text=auto eol=lf`, `tests/fixtures/** -text`, `*.sh text eol=lf`); commit the existing `docs/` unchanged as `docs: import specification documents 01-10 and session 1 plan`; `git switch -c session-1`. Do not rename or reformat any `docs/doc_*.md`.
- [ ] **Step 2 — Write the eleven decision records.** One file per row of Doc 10 §3, named `D-NN-<slug>.md` with these slugs: `fourteen-day-timebox`, `baseline-without-p-records`, `ac-1-42-synthetic-rehearsal`, `short-lock-retention-fixture`, `stage-exit-on-day-14`, `agent-as-independent-reviewer`, `reduced-process-evidence`, `cli-named-secrets`, `pre-authorized-fallbacks`, `scope-valves`, `owner-and-agent-duties`. Each file has exactly these headings: `# D-NN — <title>`, `**Date**`, `**Status**` (`ASSUMED — awaiting owner` now; `CONFIRMED by owner on <date>` after the reply), `## Decision` (the §3 text, verbatim), `## What it changes` (the §3 text, verbatim), `## Amends` (for D-03: AC-1.42; D-04: AC-1.36, AC-1.44, Doc 06 §13.3; D-05: FR-1.100, AC-1.58; others: the document sections replaced). D-01 also records the absolute calendar date of Day 1.
- [ ] **Step 3 — Generate the operations SSH key.** `ssh-keygen -t ed25519 -C mykey-ops -f ~/.mykey/ssh/mykey_ops_ed25519` with no passphrase prompt shown in the transcript (`-N ""`). Only the `.pub` content may appear in chat. Start `docs/runbooks/credential-custody.md` as a table `Name | Purpose | Location | Who can read | Created in run | Off-host copy needed`, first row: this key.
- [ ] **Step 4 — Send the owner one message** containing all of the following, then continue with Run 1.2 without waiting:
  - **Confirm** D-01…D-11, calling out D-04 and D-05 by name (they move two calendar-bound checks out of the 14 days).
  - **Answer:** (1) Which domain for production and staging hostnames, and is it managed in Cloudflare? (2) Where should alerts go (email, Telegram, …)? (3) Do records P-01/P-02/P-03 exist anywhere? (default: no) (4) Repository name? (default: `mykey`, private) (5) Is R2 enabled on the Cloudflare account? (It must be switched on once in the dashboard, with billing, before any bucket or token can be created — needed today for Run 1.9.)
  - **OWN-2, needed by the start of Run 2.5 (Day 2, midday at the latest):** two OVHcloud Public Cloud instances in **one region where OVHcloud KMS is also offered** (check the KMS order page for that region before buying), named `mykey-prod` and `mykey-staging`, flavour C3-8 or nearest ≥ 4 vCPU / 8 GB RAM / 80 GB SSD, x64, Ubuntu 24.04 LTS, hourly billing, with the public key from Step 3 as the instance SSH key. Reply with the two IPv4 addresses and the region.
  - **OWN-3, needed by Run 2.7 (Day 3):** activate OVHcloud KMS in that same region. Exact steps (seal key, one disposable key, KMIP access certificate placed directly on the staging host) come with the Session 2 plan; nothing to create yet beyond activating the service.
  - **Defaults if no reply by the end of Run 1.2:** repository `mykey`; P-records absent; all decisions assumed. The domain and alert destination have no default and are first needed in Runs 2.5 and 2.6.
- [ ] **Step 5 — Run note and commit.** Write `run-1.1.md` using this template (reused by every run): `# Run 1.N — <title>`, `## What was done`, `## Commits` (SHAs), `## Commands and results` (command, exit code, the one line that proves it), `## Deviations and decisions`, `## Open issues`. Commit `docs: decision records D-01..D-11 and owner kick-off`.
- [ ] **When the owner replies** (any later run): update each record's Status, record the answers in D-11, commit.

**Done when:** records committed; the owner has replied or the defaults are recorded as assumed.

---

## Run 1.2 — Repository and toolchain

**Files:** root config files in the file map; a `package.json`, `tsconfig.json` and `src/index.ts` in each of `apps/{api,provisioner,web,cli,ops}`, `packages/{contracts,db,auth,openbao,operations,audit}`, `workers/probe`; `tests/package.json`; `tests/unit/skeleton/skeleton.test.ts`; `README.md`.

**Produces:** workspace package names `@mykey/<dir>` (`@mykey/contracts`, `@mykey/db`, `@mykey/api`, `@mykey/probe`, `@mykey/tests`, …); root scripts `check`, `format`, `format:check`, `lint`, `typecheck`, `build`, `test`, `test:integration`, `test:cloud`.

- [ ] **Step 1 — Check the working folder.** The repository is inside OneDrive. Run `pnpm install` once the workspace exists (Step 3); if it fails with file-lock or junction errors, stop and ask the owner to move the folder outside OneDrive (for example `C:\dev\mykey`). Do not move it yourself.
- [ ] **Step 2 — Write the failing skeleton test** `tests/unit/skeleton/skeleton.test.ts`:
  - `every Doc 06 §2 workspace exists with the expected package name` — for each of the twelve directories above, `package.json` exists, `name === "@mykey/<dir>"`, `private === true`, `type === "module"`.
  - `infra and test folders exist` — `infra/{compose,hosts,traefik,openbao,backup,recovery,release}` and `tests/{unit,integration,browser,cli,fault,restore}`.
  - `operator code is not reachable from the public API` — `apps/api/package.json` has no dependency on `@mykey/ops`.
  - `spec documents are untouched` — the ten `docs/doc_*.md` files exist.
- [ ] **Step 3 — Create the workspace.** `pnpm-workspace.yaml` packages: `apps/*`, `packages/*`, `workers/*`, `tests`. Root `package.json`: `private`, `type: module`, `packageManager` (pnpm exact version with hash, via `corepack use pnpm@<installed>`), `engines.node` matching `.node-version`. `.npmrc`: `engine-strict=true`, `save-exact=true`. Install dev tools with `pnpm add -Dw -E`: `typescript`, `vitest`, `fast-check`, `eslint`, `typescript-eslint`, `prettier`, `@types/node`.
- [ ] **Step 4 — TypeScript.** `tsconfig.base.json`: `target es2024`, `module nodenext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`, `isolatedModules`, `composite`, `outDir dist`. Each workspace `tsconfig.json` extends it; root `tsconfig.json` lists project references. Relative imports carry the `.ts` extension. Each workspace `package.json` exports `./src/index.ts`; each `src/index.ts` is `export {};`.
- [ ] **Step 5 — Vitest.** `vitest.config.ts` with three projects and `passWithNoTests: false`: `unit` = `tests/unit/**/*.test.ts`; `integration` = `tests/integration/**/*.test.ts` and `tests/fault/**/*.test.ts`; `cloud` = `tests/**/*.cloud.test.ts` (excluded from the other two).
- [ ] **Step 6 — Root scripts.** `format` / `format:check` (Prettier; `.prettierignore` lists `docs/doc_*.md`, `pnpm-lock.yaml`, `packages/contracts/openapi/`, `packages/db/migrations/`, `tests/fixtures/`), `lint` (ESLint flat config with typescript-eslint strict type-checked), `typecheck` (`tsc -b`), `build` (`tsc -b`), `test` (`vitest run --project unit`), `test:integration` (`vitest run --project integration`), `test:cloud` (added in Run 1.9), `check` = `format:check && lint && typecheck`. Later runs append to `check`; a sub-script is added to `check` only in the run that creates it.
- [ ] **Step 7 — Verify.** Run `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test`. Expected: all exit 0; skeleton test file passes 4 tests. Then prove the zero-test guard: `pnpm exec vitest run --project integration` exits non-zero ("No test files found").
- [ ] **Step 8 — Create the GitHub repository.** `gh repo create <name> --private --source . --remote origin` (name from OWN-1, default `mykey`), `git push -u origin main session-1`. Branch protection is not available for private repositories on the free plan; note that in the run note rather than working around it.
- [ ] **Step 9 — README, run note, commit.** README: prerequisites and the three commands. Commit `chore: pnpm monorepo skeleton with strict TypeScript, lint, format, tests`.

**Done when:** `pnpm install --frozen-lockfile`, `pnpm run check` and `pnpm test` pass on the skeleton.

---

## Run 1.3 — Version pins (G-PINS spike, PO-24)

**Files:** `infra/dependencies.lock.json`, `pnpm-workspace.yaml` (catalog), `.node-version`, `scripts/pins-verify.ts`, `scripts/repro-build.ts`, `tests/unit/pins/pins.test.ts`, `docs/decisions/D-12-node-and-toolchain-pins.md`.

**Produces:** `infra/dependencies.lock.json` with this shape, read by Runs 1.4, 1.5, 1.9 and by `pins-verify`:

```json
{
  "reviewedAt": "YYYY-MM-DD",
  "node": { "version": "x.y.z", "line": "24-lts" },
  "pnpm": { "version": "x.y.z" },
  "images": { "<key>": { "image": "registry/name", "tag": "x.y.z", "digest": "sha256:…", "releaseUrl": "…", "advisoriesChecked": "YYYY-MM-DD" } },
  "npm": { "<package>": { "version": "x.y.z", "advisoriesChecked": "YYYY-MM-DD", "note": "" } },
  "python": { "python-dotenv": { "version": "x.y.z", "sha256": "…" } },
  "actions": { "<owner/repo>": { "sha": "<40 hex>", "tag": "vX.Y.Z" } }
}
```

Required keys — `images`: `postgres` (18.x), `openbao` (2.7.x), `traefik` (3.7.x OSS), `restic`, `gitleaks`, `trivy`. `npm`: `typescript`, `vitest`, `fast-check`, `eslint`, `typescript-eslint`, `prettier`, `zod`, `hono`, `drizzle-orm`, `drizzle-kit`, `pg`, `pg-boss`, `better-auth` (1.7.x), `react`, `react-dom`, `@tanstack/react-query`, `@scalar/api-reference`, `@scalar/openapi-parser`, `@aws-sdk/client-s3`, `@next/env`. `actions`: `actions/checkout`, `actions/setup-node`, `pnpm/action-setup`, `actions/setup-python`.

- [ ] **Step 1 — Write the failing guard test** `tests/unit/pins/pins.test.ts` (it calls the functions exported by `scripts/pins-verify.ts`):
  - `lock file has every required key` (the lists above).
  - `no pre-release version is pinned` — no version in `dependencies.lock.json`, any `package.json`, or the pnpm catalog matches `/-(alpha|beta|rc|next|canary|pre|dev)/i` or is a range (`^`, `~`, `*`, `latest`).
  - `PostgreSQL is major 18` and `OpenBao is 2.7.x`, `Traefik is 3.7.x`, `better-auth is 1.7.x`.
  - `every image digest is sha256 with 64 hex characters`; `every action sha is 40 hex characters`.
  - `every image reference in infra/compose/**/*.yml uses a digest present in the lock` and `every uses: in .github/workflows/*.yml is a SHA present in the lock` (both pass vacuously today and bite from Runs 1.4/1.5).
  - `forbidden components are absent` — `pnpm-lock.yaml` contains none of `redis`, `ioredis`, `bullmq`, `temporalio`, `@modelcontextprotocol/`.
- [ ] **Step 2 — Choose versions.** For each npm package take the newest stable release, check it supports the chosen Node line, and check advisories with `pnpm audit` and `gh api "/advisories?ecosystem=npm&affects=<name>@<version>"`. For each image read the upstream release notes and security advisories, then resolve the multi-arch digest with `docker buildx imagetools inspect <image>:<tag>`. For each Action take the commit SHA of the latest release tag (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`), and read the repository's security advisories first. Use Context7 or official documentation rather than memory for anything version-specific. Doc 06 §1.1 names OpenBao 2.7.2, Traefik 3.7.17 and Better Auth 1.7.18 as candidates as of 7 November 2026; take a newer patch only if it is a stable release.
- [ ] **Step 3 — Node line.** Apply P-3. Confirm that `node scripts/<any>.ts` runs without a flag on the chosen version and that `z.toJSONSchema` exists in the pinned Zod (needed by P-9). Write `.node-version` and D-12 (Node choice, tool choices P-1/P-2, any fallback taken).
- [ ] **Step 4 — Record the pins.** Write `dependencies.lock.json`; put all runtime packages in the `catalog:` section of `pnpm-workspace.yaml`; add `pins:verify` (`node scripts/pins-verify.ts`) to root scripts and to `check`.
- [ ] **Step 5 — Reproducible build.** Implement `scripts/repro-build.ts`: clone the current commit into a fresh temporary directory outside OneDrive, run `pnpm install --frozen-lockfile` and `pnpm run build`, then print `BUILD_HASH=<sha256>` computed over the sorted list of `(relative path, sha256)` for every file under every `dist/`, plus the sha256 of `pnpm-lock.yaml` and of `dependencies.lock.json`. Run it twice. Expected: two identical `BUILD_HASH` lines.
- [ ] **Step 6 — Confirm server sizing for OWN-2.** From Doc 06 §11 (two API processes, up to two buffered 48 MiB responses each, PostgreSQL with 100 connections, OpenBao, Traefik, a local staging area for one full pair) write a half-page estimate in the run note and state either "4 vCPU / 8 GB / 80 GB confirmed" or the changed size. If it changes, tell the owner at once.
- [ ] **Step 7 — Verify and commit.** `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test` (pins tests pass). Commit `chore: pin toolchain, images and actions (G-PINS spike)`. Registry note for Run 1.10: PO-24 becomes `SPIKE_PASS`.

**Done when:** a clean build from the lock files succeeds twice with identical hashes; no pre-release is pinned.

---

## Run 1.4 — CI pipeline

**Files:** `.github/workflows/ci.yml`, `.gitleaks.toml`, `.trivyignore`, `tests/fixtures/ci/seeded-secret/sample.txt`, `tests/fixtures/ci/gitleaks-selftest.toml`, `tests/fixtures/ci/vulnerable-dep/{package.json,package-lock.json}`, `tests/integration/toolchain/toolchain.test.ts`, `docs/decisions/D-13-ci-uses-compose-stack.md`.

**Consumes:** image digests and Action SHAs from `infra/dependencies.lock.json`.

**Produces:** CI job names later runs extend: `check`, `unit`, `integration`, `secret-scan`, `dependency-scan`, `image-scan`, `scanner-selftest`, `cli-matrix`.

- [ ] **Step 1 — Write the integration test** `tests/integration/toolchain/toolchain.test.ts`: `docker daemon is reachable`; for `postgres`, `openbao`, `traefik`, `restic` in the lock, `docker run --rm <image>@<digest> <version command>` reports the pinned version. Run `pnpm run test:integration`: expected PASS locally (this is the first integration test, so the project is no longer empty).
- [ ] **Step 2 — Secret-scan configuration.** `.gitleaks.toml` extends the default rules and adds rule `mykey-canary` with regex `MYKEY_CANARY_[A-Z0-9]{32}`; allowlist path `tests/fixtures/ci/seeded-secret/`. `sample.txt` holds one such canary (random, synthetic). `gitleaks-selftest.toml` is the same rule set with no allowlist.
- [ ] **Step 3 — Vulnerable-dependency fixture.** In `tests/fixtures/ci/vulnerable-dep/`, a `package.json` and lock file depending on one package version that has a published HIGH or CRITICAL advisory with a fix available (verify the advisory exists today; record its ID in the run note). This directory is not a workspace member.
- [ ] **Step 4 — Write `ci.yml`.** Triggers: `push` (all branches), `pull_request`, `workflow_dispatch`. Top-level `permissions: contents: read`. Every `uses:` is `owner/repo@<sha> # vX.Y.Z` from the lock; checkout uses `persist-credentials: false`. Jobs:
  - `check` — setup Node from `.node-version`, pnpm, `pnpm install --frozen-lockfile`, `pnpm run check`.
  - `unit` — `pnpm test`.
  - `integration` — `pnpm run test:integration` on `ubuntu-24.04` (Docker is preinstalled). Run 1.5 makes the harness start the stack; the job definition does not change.
  - `secret-scan` — checkout with `fetch-depth: 0`; run the pinned gitleaks image over the full history with `.gitleaks.toml`; any finding fails the job.
  - `dependency-scan` — pinned Trivy image, `fs` mode on the repository, `--scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --skip-dirs tests/fixtures/ci`, honouring `.trivyignore`.
  - `image-scan` — the same Trivy image in `image` mode for each of `postgres`, `openbao`, `traefik`, `restic` by digest, same severity flags.
  - `scanner-selftest` — runs gitleaks on `tests/fixtures/ci/seeded-secret` with `gitleaks-selftest.toml` and Trivy on `tests/fixtures/ci/vulnerable-dep`; the job **passes only if both scanners exit non-zero** and fails with `scanner did not detect the seeded <secret|vulnerability>` otherwise.
  - `cli-matrix` — matrix over Linux x64, Linux arm64, macOS x64, macOS arm64 runner labels (take the current labels from GitHub's runner documentation; do not guess); runs `pnpm --filter @mykey/cli test`; guarded by `paths: apps/cli/**` or manual dispatch (P-7). Add one trivial real test in `apps/cli` so the job has something to run, and dispatch it once by hand.
  - `.trivyignore` entries need a comment with the reason and an expiry date (`exp:YYYY-MM-DD`); start with none unless an unfixable upstream finding forces one.
- [ ] **Step 5 — Push and read the result.** `git push`; `gh run watch`. Expected: every job green except those skipped by path filter.
- [ ] **Step 6 — Live negative proof (the run's "done when").** (a) Branch `ci-proof/seeded-secret`: commit a file outside the allowlisted path containing a fresh `MYKEY_CANARY_…` string; push; expected `secret-scan` fails. (b) Branch `ci-proof/seeded-vuln`: add the Step 3 vulnerable package to the root `devDependencies` and lock file; push; expected `dependency-scan` fails. Record both run URLs and the failing job output line in the run note, then delete both remote branches. Neither branch is ever merged.
- [ ] **Step 7 — D-13, run note, commit.** D-13 records P-5 and P-6. Commit `ci: check, tests, secret, dependency and image scanning with self-test`.

**Covers:** early part of FR-1.73, AC-1.32. **Done when:** a seeded fake secret and a seeded vulnerable dependency each fail the pipeline.

---

## Run 1.5 — Local development stack

**Files:** `infra/compose/dev.compose.yml`, `infra/compose/dev/{pki-init.sh,openbao.hcl,postgresql.conf,pg_hba.conf}`, `scripts/stack.ts`, `tests/harness/stack.ts`, `tests/harness/global-setup.ts`, `tests/integration/stack/{postgres,openbao,isolation}.test.ts`, `docs/runbooks/local-stack.md`; modify `vitest.config.ts` (integration project `globalSetup`), root `package.json` (scripts `stack:up`, `stack:down`, `stack:status`).

**Produces** (`tests/harness/stack.ts`, used by every later integration and fault test):

```ts
export interface Stack {
  project: string;                                   // Compose project name, unique per stack
  pg: { host: string; port: number; database: string;
        superuser: { user: string; password: string }; caCertPath: string };
  bao: { url: string; caCertPath: string; rootToken: string };
  stop(): Promise<void>;                             // docker compose down -v, removes .stack/<project>
}
export function startStack(opts?: { project?: string; fixedPorts?: boolean }): Promise<Stack>;
export function getSharedStack(): Promise<Stack>;    // the stack started by global-setup for this test run
export function freshDatabase(stack: Stack): Promise<{ database: string; drop(): Promise<void> }>;
export function freshNamespace(stack: Stack): Promise<{ path: string; drop(): Promise<void> }>;
export function baoFetch(stack: Stack, path: string,
  init?: { method?: string; body?: unknown; namespace?: string; token?: string }): Promise<Response>;
export function restartService(stack: Stack, service: "postgres" | "openbao"): Promise<void>;
```

Design fixed here:

- **Services:** `pki-init` (one-shot, the pinned PostgreSQL image, which contains `openssl`), `postgres`, `openbao`. All images by digest. No bind mounts of host files that need Unix permissions: `pki-init` writes into a named volume `pki`, which the other two mount read-only. Configuration files are mounted read-only from `infra/compose/dev/`.
- **`pki-init.sh`** (LF endings; idempotent — exits early if the CA exists): creates a development CA; server certificates for `postgres` and `openbao` with SANs `<service>`, `localhost`, `127.0.0.1`; a 32-byte `openbao-static-seal.key` (`openssl rand -out … 32`); sets ownership and mode `0600` for each key to the UID the consuming image actually runs as (read it with `docker run --rm <image> id`, do not assume).
- **PostgreSQL:** `ssl = on` with the generated certificate; `pg_hba.conf` allows only `hostssl … scram-sha-256` for TCP; superuser password supplied through a Compose secret file generated into `.stack/<project>/`, never a literal in YAML.
- **OpenBao configuration** (`openbao.hcl`):

  ```hcl
  ui            = false
  disable_mlock = true
  api_addr      = "https://openbao:8200"
  cluster_addr  = "https://openbao:8201"
  storage "raft" { path = "/openbao/file"  node_id = "dev-1" }
  listener "tcp" {
    address         = "0.0.0.0:8200"
    cluster_address = "0.0.0.0:8201"
    tls_cert_file   = "/pki/openbao.crt"
    tls_key_file    = "/pki/openbao.key"
  }
  seal "static" { current_key_id = "dev-1"  current_key = "file:///pki/openbao-static-seal.key" }
  ```

- **Initialisation:** after the container is healthy, the harness calls `PUT /v1/sys/init` with `{"recovery_shares":1,"recovery_threshold":1}` if `GET /v1/sys/init` says uninitialised, and keeps the root token.
- **Ports and names:** `startStack()` uses project `mykey-t-<8 hex>` and host port `0` (ephemeral), then reads the real ports with `docker compose port`. `pnpm run stack:up` uses project `mykey-dev` and fixed ports 54320 (PostgreSQL) and 8200 (OpenBao).
- **State on disk:** `.stack/<project>/stack.json` (ports, CA path, superuser password, root token) and `ca.crt` copied out with `docker compose cp`. `.stack/` is git-ignored. These are development-only synthetic credentials; they still never go to logs or evidence.
- **Clean stack per suite:** `global-setup.ts` starts one stack per test run and stops it afterwards; a suite isolates itself with `freshDatabase()` and `freshNamespace()`. A suite that must restart or break a service calls `startStack()` for its own stack.
- **`scripts/stack.ts`:** `up`, `down`, `status`, and `down --all` (removes every Compose project whose name starts with `mykey-t-` or equals `mykey-dev`).

Steps:

- [ ] **Step 1 — Write the failing tests.**
  - `postgres.test.ts`: `server is PostgreSQL 18` (`SHOW server_version_num` starts with `18`); `TLS with CA verification succeeds`; `a connection without TLS is refused`; `freshDatabase gives an empty database and drop removes it`.
  - `openbao.test.ts`: `status is initialised, unsealed, raft` (`GET /v1/sys/seal-status` → `initialized: true`, `sealed: false`, `storage_type: "raft"`, seal type `static`); `namespace + KV v2 round trip` — `freshNamespace()`, mount `kv` with `{"type":"kv","options":{"version":"2"}}` under header `X-Vault-Namespace`, set `kv/config` to `{"cas_required":true,"max_versions":20}`, write `kv/data/SMOKE` with `{"options":{"cas":0},"data":{"value":"synthetic-1"}}`, read it back and expect version `1` and the same value; `a write without cas is rejected`; `the same path in a second namespace is absent`; `plain HTTP is refused`.
  - `isolation.test.ts` (own stacks): `two stacks run at the same time on different ports`; `restart keeps data and auto-unseals` — write a value, `restartService(stack, "openbao")`, read it back; `stop() leaves no container, volume or .stack directory`.
- [ ] **Step 2 — Run them.** `pnpm run test:integration` → expected FAIL (`startStack is not a function`).
- [ ] **Step 3 — Implement** the Compose file, `pki-init.sh`, configuration files, `tests/harness/stack.ts`, `global-setup.ts`, `scripts/stack.ts`. Health checks: `pg_isready` for PostgreSQL; `GET /v1/sys/health?uninitcode=200&sealedcode=200` over TLS for OpenBao.
- [ ] **Step 4 — Run them again**, from the Windows checkout. Expected: all PASS. Then `pnpm run stack:up`, `pnpm run stack:status` (both services healthy), `pnpm run stack:down`.
- [ ] **Step 5 — CI.** Push; confirm the `integration` job starts the stack and passes on `ubuntu-24.04`. Add a final `if: always()` step running `node scripts/stack.ts down --all`.
- [ ] **Step 6 — Runbook, measurements, commit.** `docs/runbooks/local-stack.md`: the commands, where state lives, how to reset. Record `docker stats --no-stream` idle memory of both services in the run note (input to the sizing estimate). Commit `feat(infra): local PostgreSQL 18 + OpenBao stack with TLS, Raft, static seal and test harness`.

**Done when:** one command brings the stack up; an integration test creates a namespace and writes and reads a KV v2 secret.

---

## Run 1.6 — Contracts foundation

**Files:** `packages/contracts/src/{limits,names,ids,errors,operation,routes,openapi,index}.ts`, `packages/contracts/openapi/openapi.json`, `scripts/contracts-openapi.ts`, `tests/unit/contracts/{limits,names,errors,routes,openapi}.test.ts`, `docs/decisions/D-14-error-code-list.md`, `docs/decisions/D-15-route-freeze.md`.

**Produces** (imported as `@mykey/contracts` by every later run):

```ts
// limits.ts
export const LIMITS: { /* exactly the object below */ };
// names.ts
export const SECRET_NAME_PATTERN: RegExp;       // /^[A-Z][A-Z0-9_]{0,127}$/
export const ENVIRONMENT_NAME_PATTERN: RegExp;  // /^[a-z][a-z0-9-]{0,62}$/
export type NameCheck<R extends string> = { ok: true; value: string } | { ok: false; rule: R };
export function checkSecretName(input: string): NameCheck<"pattern" | "reserved_prefix">;
export function checkEnvironmentName(input: string): NameCheck<"pattern">;
export function checkProjectName(input: string): NameCheck<"length" | "control_character" | "whitespace_only">; // value is NFC
export function checkSecretValue(value: string):
  { ok: true; byteLength: number } | { ok: false; rule: "too_large" | "nul" | "ill_formed" };
// ids.ts — branded UUID strings + Zod schemas
export type OrganizationId; export type ProjectId; export type EnvironmentId; export type CredentialId;
export type OperationId;    export type UserId;    export type RequestId;
// errors.ts
export const ERROR_CODES: Record<ErrorCode, { status: 400|401|403|404|409|422|429|503|507 }>;
export const errorEnvelopeSchema: z.ZodType<{ error: { code: ErrorCode; message: string; requestId: string;
                                              operationId?: string; details?: Record<string, unknown> } }>;
// operation.ts
export const OPERATION_STATES: readonly ["accepted","executing","awaiting_input","uncertain","succeeded","partial","rejected"];
export const operationResponseSchema: z.ZodType; // {operationId,state,statusUrl,replayExpiresAt: string|null,result?}
// routes.ts
export type AuthClass = "public" | "human" | "human_fresh_totp" | "machine" | "reset_flow";
export interface RouteDef {
  id: string; method: "GET" | "POST" | "PATCH"; path: string; auth: AuthClass; idempotent: boolean;
  request: { params?: z.ZodType; query?: z.ZodType; body?: z.ZodType | "raw-dotenv" };
  responses: Record<number, z.ZodType | "dotenv-attachment">;
  errors: readonly ErrorCode[]; ownerRun: string; pending: boolean;
}
export const ROUTES: readonly RouteDef[];
export const DENIED_ALIASES: readonly { method: string; path: string }[];
// openapi.ts
export function buildOpenApiDocument(routes: readonly RouteDef[]): object; // OpenAPI 3.1, deterministic key order
```

### Task A — limits, names, IDs (Run 1.8 may start when this is merged)

- [ ] **Step 1 — Failing tests.** `limits.test.ts`: deep-equals the object below (one assertion, so a changed number fails loudly). `names.test.ts` boundary cases:
  - secret name: 128 characters ok, 129 `pattern`; lowercase, leading digit, leading underscore, hyphen, empty → `pattern`; `SECRETS_X` → `reserved_prefix`; `SECRETS` and `MY_SECRETS_X` ok.
  - environment name: 63 characters ok, 64 `pattern`; leading digit, uppercase, underscore, empty → `pattern`; `a` and `a-` ok.
  - project name: 64 astral code points (128 UTF-16 units) ok; 65 code points `length`; empty `length`; `"   "` `whitespace_only`; a name containing U+0007 `control_character`; `"e\u0301"` returns value `"\u00e9"`; interior and trailing spaces preserved.
  - secret value: empty ok with `byteLength 0`; 65,536 ASCII bytes ok; 65,537 `too_large`; 21,845 × `"€"` + `"a"` (65,536 bytes) ok and one more byte `too_large`; a NUL `nul`; a lone surrogate `ill_formed`; a multi-line value ok.
- [ ] **Step 2 — Run:** `pnpm test -- tests/unit/contracts` → FAIL (module not found).
- [ ] **Step 3 — Implement.** `limits.ts` is exactly:

  ```ts
  export const LIMITS = {
    session: { idleSeconds: 1800, absoluteSeconds: 43200, freshTotpSeconds: 600, incompleteChallengeSeconds: 600 },
    totp: { digits: 6, stepSeconds: 30, skewSteps: 1 },
    recovery: { codeCount: 10 },
    reset: { linkSeconds: 900 },
    secret: { nameMaxLength: 128, valueMaxBytes: 65536, versionsKept: 20, reservedPrefix: "SECRETS_" },
    project: { nameMinCodePoints: 1, nameMaxCodePoints: 64 },
    environment: { nameMaxLength: 63, maxNames: 1000, maxLiveValueBytes: 8388608 },
    body: { jsonMaxBytes: 524288, jsonMaxDepth: 16, dotenvMaxBytes: 1048576, dotenvMaxEntries: 1000,
            authMaxBytes: 16384, headersMaxBytes: 16384, bearerMaxBytes: 4096, passwordMaxBytes: 1024 },
    importPreview: { ttlSeconds: 900 },
    completeResponse: { maxBodyBytes: 50331648, metadataAllowanceBytes: 1048576 },
    listing: { defaultLimit: 50, maxLimit: 100, filterMaxLength: 128 },
    rate: { perSourcePerMinute: 300, perSessionPerMinute: 120, perMachineCredentialPerMinute: 60,
            revealPerMinute: 30, importExportPerMinute: 5, authAttemptsPerMinute: 5,
            authFailuresPerAccount: 5, authFailureWindowSeconds: 900, authDelaySeconds: 900 },
    concurrency: { httpPerProcess: 64, largePerProcess: 2, apiProcesses: 2, provisionerJobs: 2 },
    db: { apiPool: 20, provisionerPool: 6, opsPool: 4, maxConnections: 100 },
    deadlines: { poolAcquireMs: 2000, advisoryLockMs: 2000, backendCallMs: 5000, requestMs: 30000, largeRequestMs: 120000 },
    operation: { heartbeatSeconds: 15, stuckAlertSeconds: 120, terminalRetentionDays: 30 },
    machineToken: { defaultTtlSeconds: 2592000, maxTtlSeconds: 2592000, expiryWarningSeconds: 604800, issuerSessionSeconds: 60 },
    disk: { minFreeBytesPercent: 15, minFreeInodesPercent: 10, minFreeBytes: 2147483648, auditReserveBytes: 2147483648 },
    backup: { dailyAtUtc: "03:00", maxAgeAlertSeconds: 93600, eligibilityDays: 30, uploadDeadlineSeconds: 7200,
              freezeAlertSeconds: 600, cleanupLagTargetSeconds: 172800 },
    audit: { retentionDays: 365 },
    monitoring: { probeIntervalSeconds: 60, heartbeatGraceSeconds: 180, kmipCertWarningDays: 30 },
    reveal: { displayMaxSeconds: 30 },
  } as const;
  ```

  `checkProjectName` normalises to NFC first, counts code points, rejects `\p{Cc}` and whitespace-only. `checkSecretValue` uses `isWellFormed()` and `TextEncoder`. Validators never include the input in any returned or thrown text.
- [ ] **Step 4 — Run:** PASS. Commit `feat(contracts): limits, name and value validators, id types`.

### Task B — error envelope and codes

- [ ] **Step 1 — Failing test** `errors.test.ts`: the code set equals the table below exactly; each of the ten spec-named codes (marked ★) has its exact status; `errorEnvelopeSchema` accepts `{error:{code,message,requestId}}`, rejects an unknown code, a missing `requestId`, and an extra top-level key.
- [ ] **Step 2 — Implement** `errors.ts` from this table, and write D-14 (the codes without ★ are planner-assigned names for cases Doc 04 §8.1 describes only by HTTP class):

  | HTTP | Codes |
  | --- | --- |
  | 400 | `malformed_request`, `forbidden_selector`, `mixed_authentication`, `unsupported_history_parameter` |
  | 401 | `unauthenticated`, `mfa_incomplete` |
  | 403 | `action_denied`, `origin_rejected`, `fresh_verification_required` ★ |
  | 404 | `not_found` ★ |
  | 409 | `version_conflict`, `already_exists`, `state_conflict`, `key_under_review`, `environment_changed` ★, `listing_changed` ★, `idempotency_conflict` ★, `replay_expired` ★, `credential_not_replayable` ★ |
  | 422 | `validation_failed`, `precondition_required` |
  | 429 | `rate_limited` |
  | 503 | `busy` ★, `outcome_unknown` ★, `backend_inconsistent` ★, `backend_sealed`, `quarantined`, `audit_unavailable`, `dependency_unavailable` |
  | 507 | `capacity_exceeded` |

- [ ] **Step 3 — Run:** PASS. Commit `feat(contracts): error envelope and code list`.

### Task C — frozen route list and OpenAPI

`E` = `/v1/organizations/:org/projects/:project/environments/:env`, `P` = `/v1/organizations/:org/projects/:project`, `O` = `/v1/organizations/:org`. "Idem" = requires `Idempotency-Key`.

| id | Method and path | Auth | Idem | Body (Doc 06 §9) | Owner run |
| --- | --- | --- | --- | --- | --- |
| `health.get` | GET `/health` | public | – | – | 2.5 |
| `version.get` | GET `/v1/version` | public | – | – | 3.1 |
| `organizations.list` | GET `/v1/organizations` | human | – | – | 3.7 |
| `projects.list` | GET `O/projects` | human | – | – | 3.9 |
| `projects.create` | POST `O/projects` | human | yes | `{name}` | 3.9 |
| `projects.rename` | PATCH `P` | human | yes | `{name}` | 3.9 |
| `projects.archive` | POST `P/archive` | human | yes | `{confirmed:true}` | 5.3 |
| `projects.reactivate` | POST `P/reactivate` | human | yes | `{confirmed:true}` | 5.3 |
| `environments.list` | GET `P/environments` | human | – | – | 3.9 |
| `environments.create` | POST `P/environments` | human | yes | `{name}` | 3.9 |
| `environments.rename` | PATCH `E` | human | yes | `{name}` | 3.9 |
| `environments.archive` | POST `E/archive` | human | yes | `{confirmed:true}` | 5.3 |
| `environments.reactivate` | POST `E/reactivate` | human | yes | `{confirmed:true}` | 5.3 |
| `secrets.list` | GET `E/secrets` | human | – | query `prefix`, `limit`, `cursor` | 4.3 |
| `secrets.history` | GET `E/secrets/:name/history` | human | – | – | 4.3 |
| `secrets.reveal` | POST `E/secrets/:name/reveal` | human | no | `{version?}` | 4.3 |
| `secrets.create` | POST `E/secrets` | human | yes | `{name,value}` | 4.2 |
| `secrets.update` | PATCH `E/secrets/:name` | human | yes | `{value,expectedVersion,expectedStateTag}` | 4.2 |
| `secrets.delete` | POST `E/secrets/:name/delete` | human | yes | `{expectedVersion,expectedStateTag,confirmed:true}` | 4.4 |
| `secrets.undelete` | POST `E/secrets/:name/undelete` | human | yes | same as delete | 4.4 |
| `secrets.restore` | POST `E/secrets/:name/restore` | human | yes | `{sourceVersion,expectedVersion,expectedStateTag,confirmed:true}` | 4.4 |
| `import.preview` | POST `E/import/preview` | human | no | raw dotenv | 4.7 |
| `import.apply` | POST `E/import/:preview/apply` | human | yes | raw dotenv | 4.7 |
| `import.resume` | POST `E/import-operations/:operation/resume` | human | no | raw dotenv | 4.7 |
| `export.create` | POST `E/export` | human_fresh_totp | no | `{confirmed:true}` | 4.9 |
| `credentials.list` | GET `E/credentials` | human | – | – | 5.1 |
| `credentials.issue` | POST `E/credentials` | human_fresh_totp | yes | `{name,ttlSeconds}` | 5.1 |
| `credentials.revoke` | POST `E/credentials/:credential/revoke` | human | yes | `{confirmed:true}` | 5.2 |
| `operations.get` | GET `/v1/operations/:operation` | human | – | – | 4.1 |
| `operations.list` | GET `E/operations` | human | – | – | 4.1 |
| `audit.list` | GET `O/audit` | human | – | filters, cursor | 6.1 |
| `activity.list` | GET `O/activity` | human | – | cursor | 6.1 |
| `overview.get` | GET `O/overview` | human | – | – | 7.3 |
| `credentials.summary` | GET `O/credentials/summary` | human | – | – | 7.7 |
| `metrics.get` | GET `O/metrics` | human | – | – | 7.8 |
| `session.activity` | POST `/v1/session/activity` | human | no | – | 3.5 |
| `auth.reset.complete` | POST `/v1/auth/reset/complete` | reset_flow | no | reset body (Run 3.6) | 3.6 |
| `reference.get` | GET `/v1/reference` | human | – | – | 5.9 |
| `openapi.get` | GET `/v1/openapi.json` | human | – | – | 5.9 |
| `machine.keys` | GET `/v1/machine/projects/:project/environments/:envName/keys` | machine | – | – | 5.4 |
| `machine.resolve` | POST `/v1/machine/projects/:project/environments/:envName/resolve` | machine | no | empty | 5.4 |

`DENIED_ALIASES`: `GET /v1/operations/:id/status`. Better Auth's native routes are not in this list; Run 2.3 inventories them.

Schemas written now (the spec fixes them): every request body in the table, with `name` fields using the Task A validators and `ttlSeconds` as a positive integer ≤ `LIMITS.machineToken.maxTtlSeconds` defaulting to it; `health.get` → `{status: "up" | "down"}` on 200 and 503; every operation-bearing response → `operationResponseSchema`; `machine.resolve` 200 → `{apiMajor, environmentId, generation, count, entries: [{name, value}], complete: true}` (strict); every route's error responses → `errorEnvelopeSchema`. Any other response body is `pending: true` with an empty-object schema carrying `x-mykey-pending: true`; the owning run replaces it in a commit titled `contract: …`.

- [ ] **Step 1 — Failing tests.** `routes.test.ts`: `ROUTES` has 41 entries; ids unique; method+path unique; every row of the table matches (`id`, method, path, auth, idempotent, ownerRun) — encode the table as the test's expected data; every POST/PATCH has `idempotent: true` except the seven marked "no"; no route path equals a denied alias; `secrets.update` body rejects a missing `expectedStateTag` and an unknown key; `credentials.issue` rejects `ttlSeconds` of 0, −1 and 2,592,001 and accepts 2,592,000; the list of pending route ids equals a committed snapshot (it may only shrink). `openapi.test.ts`: the document passes `@scalar/openapi-parser` validation as OpenAPI 3.1; contains all 41 operations with `operationId` = route id and `:param` rendered as `{param}`; contains no denied alias; two builds are byte-identical; `packages/contracts/openapi/openapi.json` equals a fresh build.
- [ ] **Step 2 — Run:** FAIL.
- [ ] **Step 3 — Implement** `routes.ts`, `operation.ts`, `openapi.ts` (P-9: `z.toJSONSchema(schema, { target: "draft-2020-12" })` per schema, assembled into `paths`; `raw-dotenv` → `text/plain` request body with `maxLength` from limits; `dotenv-attachment` → `text/plain` response) and `scripts/contracts-openapi.ts` (`--check` exits 1 when the committed file differs). Add root scripts `contracts:openapi` and `contracts:check`; append `contracts:check` to `check`.
- [ ] **Step 4 — Run:** PASS; `pnpm run check` green.
- [ ] **Step 5 — D-15, run note, commit** `feat(contracts): frozen route list and generated OpenAPI 3.1`.

**Done when:** OpenAPI 3.1 is generated from the Zod schemas; boundary tests for every name rule and limit pass.

---

## Run 1.7 — Database base (D08-S04)

**Files:** `packages/db/src/schema/{app,audit,meta}.ts`, `packages/db/src/{migrate,roles,pool,index}.ts`, `packages/db/roles/roles.sql`, `packages/db/migrations/0000_*.sql` (generated tables) and `0001_grants.sql` (hand-written), `packages/db/drizzle.config.ts`, `tests/integration/database/{migrate,privileges,tenancy,constraints}.test.ts`, `tests/fixtures/migrations/{broken,tampered}/…`, `docs/runbooks/db-globals-inventory.md`.

**Consumes:** `freshDatabase`, `getSharedStack` (Run 1.5); name patterns from `@mykey/contracts`.

**Produces** (`@mykey/db`):

```ts
export const ROLE_NAMES: readonly ["migration_owner","api_runtime","provisioner_runtime","backup_reader","maintenance"];
export interface DbTarget { host: string; port: number; database: string; user: string; password: string; caCertPath: string }
export function createPool(target: DbTarget, opts?: { max?: number }): pg.Pool;        // TLS verify-full always
export function applyRoles(superuser: DbTarget, passwords: Record<(typeof ROLE_NAMES)[number], string>): Promise<void>;
export function migrate(owner: DbTarget, opts?: { dir?: string }):
  Promise<{ applied: string[]; alreadyApplied: string[] }>;                            // throws MigrationChecksumMismatch
export class MigrationChecksumMismatch extends Error { readonly migration: string }
export * as schema from "./schema/index.ts";                                           // Drizzle tables
```

Design fixed here:

- **Schemas:** `app`, `audit`, `auth` (empty, P-14), `jobs` (empty, P-14), `meta`. Nothing in `public`. Database owner and every object owner is `migration_owner`.
- **Roles** (`roles.sql`, idempotent, run by the superuser, cluster-global): the five roles with `LOGIN`, no password in the file, `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`. `applyRoles` runs the file and then sets each password with `ALTER ROLE … PASSWORD` from its argument. The test harness generates random passwords per database.
- **Migrator:** takes `pg_advisory_lock` on one dedicated connection for the whole run; creates `meta.schema_migration(name text primary key, sha256 text not null, applied_at timestamptz not null default now(), applied_by text not null)`; reads `*.sql` in name order; for each already-applied name compares the stored checksum to the file and throws `MigrationChecksumMismatch` on any difference; applies each pending file in its own transaction together with its history row. Hand-written migrations are created with `drizzle-kit generate --custom` so the Kit journal stays consistent. No `drizzle-kit push` anywhere.
- **Identifiers and time:** every `id` is `uuid`, generated by the application, no database default. Every timestamp is `timestamptz`. `created_at` defaults to `now()`.
- **Tables** (schema `app` unless shown). Later sessions add columns with new migrations; `0000`/`0001` are never edited after merge.

  | Table | Columns and constraints |
  | --- | --- |
  | `organization` | `id` pk; `namespace` text unique not null; `state` in (`provisioning`,`active`,`failed`,`needs_review`); `config_digest` text null; `provisioning_operation_id` uuid null; `created_at` |
  | `membership` | `id` pk; `organization_id` → organization; `user_id` uuid not null; `role` in (`owner`,`admin`,`member`); `state` in (`active`,`revoked`); unique (`organization_id`,`user_id`) |
  | `project` | `id` pk; `organization_id` → organization; `name` text, check `char_length(name) between 1 and 64` and `name = normalize(name, NFC)`; `state` in (`pending`,`active`,`revoking`,`archived`,`needs_review`); `archive_operation_id` uuid null; unique (`organization_id`,`name`); unique (`organization_id`,`id`) |
  | `environment` | `id` pk; `organization_id`; `project_id`; fk (`organization_id`,`project_id`) → project(`organization_id`,`id`); `name` check `~ '^[a-z][a-z0-9-]{0,62}$'`; `state` as project; `kv_ready` boolean default false; `policy_digest` text null; `metadata_generation` bigint default 0; `live_value_bytes` bigint default 0, check between 0 and 8388608; `lock_key` bigint unique not null default `nextval('app.environment_lock_key_seq')`; `archive_origin` null or in (`self`,`project`); `archive_operation_id` uuid null; unique (`project_id`,`name`); unique (`organization_id`,`id`) |
  | `access_grant` | `id` pk; `organization_id`; `user_id`; fk (`organization_id`,`user_id`) → membership; `project_id` null with fk (`organization_id`,`project_id`); `environment_id` null with fk (`organization_id`,`environment_id`) → environment(`organization_id`,`id`); `role` in (`reader`,`editor`); check `num_nonnulls(project_id, environment_id) = 1` |
  | `secret_index` | pk (`environment_id`,`name`); `organization_id`; fk (`organization_id`,`environment_id`); `name` check `~ '^[A-Z][A-Z0-9_]{0,127}$'`; `current_version` int null; `state_tag` text not null; `state` in (`live`,`deleted`,`needs_review`); `live_value_bytes` int default 0, check between 0 and 65536; `last_changed_at`; `last_operation_id` uuid null. **No value column, no value digest.** |
  | `secret_version_event` | `id` pk; `organization_id`; `environment_id`; `name`; `version` int; `operation_id` null; `actor_kind` in (`user`,`operator`,`system`,`unknown`); `actor_id` text null; `action` text; `occurred_at`; index (`environment_id`,`name`,`version`) |
  | `machine_credential` | `id` pk; `organization_id`; `project_id`; `environment_id`; fk (`organization_id`,`environment_id`); `name` text; `issuance_operation_id` uuid; `accessor` text null; `requested_expires_at`; `effective_expires_at` null; `state` in (`issuing`,`active`,`revoking`,`revoked`,`expired`,`needs_review`); `issued_by` uuid; `last_used_at` null; unique (`organization_id`,`accessor`). **No token column.** |
  | `operation` | `id` pk; `organization_id` null; `principal_kind` in (`user`,`machine`,`operator`,`system`); `principal_id` text; `action` text; `target` text; `idempotency_key` text; `fingerprint` bytea null; `fingerprint_key_id` text null; `expected` jsonb null; `state` in the seven operation states; `executor_boot_id` uuid null; `dispatched_at` null; `heartbeat_at` null; `result` jsonb null; `error_code` text null; `replay_expires_at` null; `audit_event_id` uuid null; `created_at`; `completed_at` null; unique (`principal_kind`,`principal_id`,`action`,`target`,`idempotency_key`) |
  | `operation_tombstone` | the five unique-key columns of `operation` as pk; `expired_at`. No fingerprint, no result. |
  | `operation_step` | `id` pk; `operation_id` → operation; `ordinal` int; `target` text; `before_state` jsonb null; `dispatch_attempt_id` uuid null; `outcome` text null; `backend_ref` text null; unique (`operation_id`,`ordinal`) |
  | `effect_slot` | `scope_key` text pk; `operation_id` → operation; `step_id` null; `generation` bigint not null; `acquired_at`. **No expiry column.** |
  | `outbox` | `id` pk; `operation_id` → operation; `job_kind` text; `state` in (`pending`,`delivered`); `created_at`; `delivered_at` null; unique (`operation_id`,`job_kind`) |
  | `import_preview` | `id` pk; `organization_id`; `environment_id`; `owner_user_id`; `file_hmac` bytea; `hmac_key_id` text; `expires_at`; `entries` jsonb (names, classifications, observed versions and tags only); `claimed_by_operation_id` uuid null unique |
  | `import_entry` | `id` pk; `parent_operation_id` → operation; `ordinal` int; `name` text; `classification` in (`create`,`update`,`unchanged`,`invalid`,`duplicate`,`conflict`); `expected_version` int null; `expected_state_tag` text null; `child_operation_id` uuid null; `outcome` null or in (`created`,`updated`,`unchanged`,`conflict`,`rejected`,`uncertain`,`not_attempted`); unique (`parent_operation_id`,`ordinal`); unique (`parent_operation_id`,`name`) |
  | `service_control` | `id` boolean pk default true, check (`id`); `capture_mode` in (`idle`,`draining`,`capturing`) default `idle`; `epoch` bigint default 0; `owner` text null; `pair_id` uuid null; `updated_at`. Migration inserts the single row. |
  | `backup_pair` | `id` pk; `capture_started_at`; `boundary` jsonb; `artifact_hashes` jsonb; `schema_revision` text; `release_commit` text; `key_refs` jsonb; `validation_status` in (`candidate`,`eligible`,`ineligible`,`expired`); `eligible_until` null; `created_at` |
  | `rate_limit` | pk (`scope`,`key_digest`,`window_start`); `scope` text; `key_digest` bytea; `window_start` timestamptz; `count` int check ≥ 0 |
  | `audit.event` | `id` pk; `occurred_at` default `now()`; `actor_kind` text; `actor_id` text null; `source_category` text null; `organization_id` uuid null; `action` text; `target_kind` text null; `target_id` text null; `outcome` text; `request_id` text null; `operation_id` uuid null; `details` jsonb null; index (`organization_id`,`occurred_at`,`id`) |

- **Grants** (`0001_grants.sql`). First: `REVOKE ALL ON DATABASE … FROM PUBLIC`, `REVOKE ALL ON SCHEMA public FROM PUBLIC`, and no grant to `PUBLIC` on any schema, table, sequence or function. Then:

  | Role | Rights |
  | --- | --- |
  | `api_runtime` | `CONNECT`; `USAGE` on `app`, `audit`, `auth`. `SELECT, INSERT` on every `app` table. `UPDATE` on `app` tables **by column**, excluding identity columns (`id`, `organization_id`, `project_id`, `environment_id`, `namespace`, `lock_key`, `created_at`, and the unique-key columns of `operation`). `DELETE` only on `effect_slot`, `import_preview`, `rate_limit`. `USAGE` on `app.environment_lock_key_seq`. `SELECT, INSERT` on `audit.event` — no `UPDATE`, `DELETE`, `TRUNCATE`. Default privileges: DML on future tables in `auth`. Nothing in `meta` or `jobs` yet. |
  | `provisioner_runtime` | `CONNECT`; `USAGE` on `app`, `audit`. `SELECT` on `organization`, `project`, `environment`; `UPDATE (state, config_digest, provisioning_operation_id)` on `organization`; `UPDATE (state, kv_ready, policy_digest)` on `environment`; `SELECT, INSERT, UPDATE` on `operation`, `operation_step`, `outbox`; `SELECT, INSERT, DELETE` on `effect_slot`; `INSERT` on `audit.event`. Nothing on `membership`, `access_grant`, `secret_index`, `secret_version_event`, `machine_credential`, `import_*`, `rate_limit`, or schema `auth`. |
  | `backup_reader` | `CONNECT`; `USAGE` and `SELECT` on every table and sequence in `app`, `audit`, `auth`, `jobs`, `meta`, plus default privileges for future tables. No write of any kind. |
  | `maintenance` | `CONNECT`; `USAGE` on all five schemas; full DML on `app`; `SELECT, DELETE` on `audit.event`; `SELECT` on `meta`. No DDL. Its password is never mounted into `api` or `provisioner`. |
  | `migration_owner` | Owns the database, schemas and objects. Used only by `migrate`. |

Steps:

- [ ] **Step 1 — Failing tests** (each suite: `freshDatabase()`, `applyRoles`, `migrate`, then connect as the role under test).
  - `migrate.test.ts`: `fresh database applies all migrations and records name + sha256`; `second run applies nothing`; `two migrators started together both resolve and each migration is recorded once`; `an edited applied migration throws MigrationChecksumMismatch` (fixture `tampered`); `a migration with failing SQL leaves no partial objects and no history row, and succeeds after the file is fixed` (fixture `broken`); `schema matches Drizzle` — running `drizzle-kit generate` produces no new file.
  - `privileges.test.ts`, table-driven, expecting success or SQLSTATE `42501`:
    - `api_runtime`: insert and select a `project` ok; `CREATE TABLE app.x()` denied; `ALTER TABLE app.project ADD COLUMN x int` denied; `UPDATE app.organization SET namespace = 'x'` denied; insert into `audit.event` ok; `UPDATE`, `DELETE`, `TRUNCATE` on `audit.event` each denied; `SELECT` from `meta.schema_migration` denied; `DELETE FROM app.project` denied.
    - `provisioner_runtime`: update `environment.kv_ready` ok; select from `secret_index`, `membership`, `machine_credential` each denied; update `environment.name` denied; insert into `audit.event` ok; select from `audit.event` denied; DDL denied.
    - `backup_reader`: select from every table ok; insert into `app.project` denied; delete from `audit.event` denied; DDL denied.
    - `maintenance`: delete from `audit.event` ok; `CREATE TABLE` denied.
    - a freshly created role with no grants: connecting to the database is refused.
    - **catalog sweep (Review focus 5):** every table in `app`, `audit`, `meta` appears in the test's expected-grants matrix (an unknown table fails the test); `has_table_privilege('public', …)` is false for every table and every privilege; no table is owned by a runtime role.
  - `tenancy.test.ts` (two synthetic organizations A and B): an `environment` with A's `organization_id` and B's `project_id` fails with `23503`; a `secret_index` row with A's organization and B's environment fails `23503`; an `access_grant` naming both a project and an environment, or neither, fails `23514`; a grant for a user who is not a member of that organization fails `23503`.
  - `constraints.test.ts`: second `service_control` row fails; second `effect_slot` with the same `scope_key` fails `23505`; duplicate operation key fails `23505`; environment name `Prod`, secret name `lower`, `live_value_bytes` 65,537, a project name in NFD form each fail `23514`; `information_schema.columns` has no column named `token`, `value`, `secret` or `password` in `app` or `audit`.
- [ ] **Step 2 — Run:** `pnpm run test:integration -- tests/integration/database` → FAIL (module not found).
- [ ] **Step 3 — Implement** roles, pool, Drizzle schema files, `drizzle-kit generate` → review the SQL line by line → commit as `0000_*`; write `0001_grants.sql`; implement `migrate`. Add root scripts `db:generate`, `db:migrate`, `db:check` (`drizzle-kit generate` then `git diff --exit-code packages/db/migrations`); append `db:check` to `check`.
- [ ] **Step 4 — Run:** all PASS; `pnpm run check` green.
- [ ] **Step 5 — DB-G1 inventory.** `docs/runbooks/db-globals-inventory.md`: a table of everything a per-database `pg_dump` does **not** carry and where it is defined instead — the five roles and their attributes (`roles.sql`); role passwords (operator-managed, regenerated on restore); role memberships; database-level `CONNECT` revocation and ownership; default privileges; `pg_hba.conf`; `postgresql.conf` TLS settings; server certificates; extensions (none today — say so); tablespaces (default only). End with the reconstruction order used by Runs 2.9 and 6.8. State plainly: this is the inventory, not a DB-G1 pass.
- [ ] **Step 6 — Run note, commit** `feat(db): base schema, least-privilege roles, checksum migrator`.

**Covers:** DB-G1 inventory. **Done when:** tests prove each runtime role can do what it needs and is denied DDL, audit update/delete, and other roles' tables.

---

## Run 1.8 — Strict dotenv codec (D08-S22) · ∥

**Files:** `packages/contracts/src/dotenv/{parse,serialize,warnings,index}.ts`, `tests/unit/dotenv/{parse,serialize,roundtrip,warnings,fixtures}.test.ts`, `tests/fixtures/dotenv/{accepted,rejected}/*.env`, `tests/fixtures/dotenv-loaders/{corpus.json,node-loader.ts,python/check.py,python/requirements.txt}`, `tests/integration/dotenv-loaders/loaders.test.ts`, `docs/runbooks/dotenv-format-v1.md`.

**Consumes:** `LIMITS`, `checkSecretName`, `checkSecretValue` (Run 1.6 Task A).

**Produces:**

```ts
export type DotenvRule =
  | "file_too_large" | "bom" | "invalid_utf8" | "nul" | "lone_cr" | "invalid_line" | "missing_equals"
  | "export_prefix" | "invalid_name" | "reserved_name" | "duplicate_name" | "single_quote"
  | "unquoted_whitespace" | "unquoted_forbidden_character" | "inline_comment"
  | "unterminated_quote" | "raw_newline_in_quotes" | "unknown_escape" | "text_after_quote"
  | "value_too_large" | "too_many_entries";
export interface DotenvIssue { line: number; rule: DotenvRule; name?: string }   // never contains input text
export type DotenvParseResult =
  | { ok: true; entries: { name: string; value: string; line: number }[] }
  | { ok: false; issues: DotenvIssue[] };
export function parseDotenv(bytes: Uint8Array): DotenvParseResult;
export function serializeDotenv(entries: readonly { name: string; value: string }[]): Uint8Array; // throws on invalid name/value/duplicate
export interface LoaderWarning { name: string; loader: "nextjs" | "python-dotenv"; reason: "expansion" | "escape" }
export function loaderWarnings(entries: readonly { name: string; value: string }[]): LoaderWarning[];
```

Grammar decisions where Doc 04 FR-1.33 leaves room (all on the strict side; record them in `dotenv-format-v1.md`):

- Decode with a fatal UTF-8 decoder. Lines end with LF or CRLF; a CR not followed by LF is `lone_cr`. A final line without a terminator is accepted.
- A line is one of: empty (zero characters); a comment (first character `#`); `NAME=value`. A whitespace-only line, leading whitespace, or whitespace around `=` is `invalid_line`.
- `NAME` must pass `checkSecretName` (`invalid_name` / `reserved_name`). Everything after the **first** `=` is the value, so `A=b=c` has value `b=c`.
- Unquoted value: may be empty; may contain interior spaces; `unquoted_whitespace` for a leading or trailing space; `unquoted_forbidden_character` for a `"` or `'` after the first character, a `\`, or a tab; a `#` anywhere in it is `inline_comment`. A value starting with `"` is parsed as quoted. A value starting with `'` is `single_quote`.
- Double-quoted value: starts with `"`; escapes `\n`, `\r`, `\t`, `\\`, `\"` only (`unknown_escape` otherwise); the line ends before the closing quote → `unterminated_quote` (this is how a raw CR/LF inside quotes surfaces; report `raw_newline_in_quotes` when a later line closes the quote); anything after the closing quote → `text_after_quote`. A raw tab and other control characters except NUL, CR, LF are data.
- `$` is always data. `A=` and `A=""` both mean the empty string.
- Parsing collects every issue (up to 100) rather than stopping at the first, checks `file_too_large` before decoding, and `too_many_entries` / `value_too_large` from `LIMITS`.
- Canonical output: entries sorted by name in ASCII order; each line `NAME="<escaped>"` + LF; escape exactly LF, CR, TAB, `\`, `"`; zero entries → zero bytes.
- Warnings (static rules, verified against the real loaders): `nextjs` + `expansion` when the value contains `$`; `nextjs` + `escape` when it contains `\`, `"` or a tab; `python-dotenv` + `expansion` when it contains `${`. Extend the rules if the loader tests find another difference; never narrow them without a loader test proving it.

Steps:

- [ ] **Step 1 — Failing unit tests.**
  - `parse.test.ts`, accepted: `A=1`; `A=` → `""`; `A=""` → `""`; `A=b=c`; `A=hello world`; `A="a\nb"` → two lines; `A="\\\"\t\r"`; `A=$HOME` and `A="${X}"` unchanged; comment and empty lines skipped; CRLF file; mixed LF/CRLF; no trailing newline; empty file → zero entries; Unicode value (`"naïve 🔑"`); a 65,536-byte value; 1,000 entries.
  - `parse.test.ts`, rejected, each asserting the exact `rule` and `line`: BOM; invalid UTF-8 byte `0xFF`; NUL; lone CR; `export A=1`; `A='x'`; duplicate `A`; `A="\q"`; `A=1 # c`; `A=x#y`; `A= x`; `A=x ` (trailing space); `A=a\b`; tab in unquoted value; `A="x`; a quoted value spanning two lines; `A="x" y`; ` A=1`; `A =1`; a whitespace-only line; `a=1`; `1A=1`; `SECRETS_X=1`; line without `=`; 65,537-byte value; 1,001 entries; a file of 1,048,577 bytes.
  - `no issue leaks input`: parse a file whose values and bad lines contain the canary `MYKEY_CANARY_…`; `JSON.stringify(result)` does not contain it; names of **invalid** lines are not echoed either (only names that passed `checkSecretName` appear in `name`).
  - `serialize.test.ts`: sorted output for `[B, A, A_1, AB]` in ASCII order; every value quoted; exact bytes for a value containing each escaped character; ends with LF; zero entries → length 0; throws on a duplicate name, an invalid name, a NUL, an oversize value, a lone surrogate; the thrown message contains no value.
  - `roundtrip.test.ts` (fast-check, ≥ 1,000 runs each): for arbitrary valid entry sets, `parse(serialize(x))` deep-equals `x` sorted by name, and `serialize(parse(serialize(x)).entries)` is byte-identical to `serialize(x)`; value generator must include empty strings, astral characters, quotes, backslashes, `$`, `#`, CR, LF, tabs, leading/trailing spaces; fuzz: `parseDotenv` on arbitrary byte arrays never throws and returns `ok: false` or entries that all pass `checkSecretName` and `checkSecretValue`.
  - `fixtures.test.ts` (Review focus 1): every file under `tests/fixtures/dotenv/accepted` parses and every file under `rejected` fails with the rule named in its filename (`<rule>.<n>.env`); no fixture contains CRLF unless its name ends `.crlf.env`.
- [ ] **Step 2 — Run:** `pnpm test -- tests/unit/dotenv` → FAIL.
- [ ] **Step 3 — Implement** `parse.ts`, `serialize.ts`, `warnings.ts`; re-export from `packages/contracts/src/index.ts`.
- [ ] **Step 4 — Run:** PASS.
- [ ] **Step 5 — Loader evidence.** `corpus.json`: about 40 named cases covering plain text, empty, spaces, each escaped character, `$VAR`, `${VAR}`, `\$`, `#`, quotes, Unicode, multi-line. `loaders.test.ts` (integration project): write the canonical file for the corpus; load it with pinned `@next/env` (`node-loader.ts`) and with pinned `python-dotenv` (`python/check.py`, installed from `requirements.txt` with `--require-hashes` into a virtual environment under `.stack/`); for every case and loader assert **`loaded !== original` implies a warning exists** for that name and loader (no silent change), and write the observed difference table to `docs/runbooks/dotenv-format-v1.md`. Add `actions/setup-python` (SHA-pinned) to the CI `integration` job.
- [ ] **Step 6 — Format document.** `dotenv-format-v1.md`: the grammar above, the limits, the canonical form, the loader difference table, and the sentence "This is MyKey dotenv format v1; it does not claim universal dotenv compatibility."
- [ ] **Step 7 — Run note, commit** `feat(contracts): strict dotenv codec v1 with loader compatibility evidence`. Registry note: FR-1.33, FR-1.34, FR-1.38 become `SPIKE_PASS`.

**Covers:** FR-1.33, FR-1.34, FR-1.38. **Done when:** export → import round-trips byte-exact; every rejected construct has a test.

---

## Run 1.9 — R2 buckets and retention clock (D08-S09) · ∥

**Files:** `infra/backup/retention-fixture/{r2.ts,provision.ts,build-pair.ts,upload.ts}`, `scripts/require-cloud-env.ts`, `tests/restore/retention/fixture.cloud.test.ts`, `docs/evidence/session-1/retention-fixture.json`, `docs/evidence/cost-sheet.md`, `docs/decisions/D-16-r2-token-model.md`; update `docs/runbooks/credential-custody.md`; root script `test:cloud`.

**Consumes:** `restic` image digest and `@aws-sdk/client-s3` pin (Run 1.3).

**Produces:**

```ts
// infra/backup/retention-fixture/r2.ts
export interface R2Credentials { accountId: string; accessKeyId: string; secretAccessKey: string }
export function loadR2Credentials(tokenName: string): R2Credentials;   // env first, then ~/.mykey/secrets/r2/<tokenName>.json
export function s3ClientFor(creds: R2Credentials): S3Client;           // endpoint https://<accountId>.r2.cloudflarestorage.com, region "auto"
export interface DeleteOutcome { key: string; deleted: boolean; errorCode?: string }
export function deleteObjectsChecked(client: S3Client, bucket: string, keys: string[]): Promise<DeleteOutcome[]>;
```

Names fixed here:

- **Buckets:** `mykey-prod-pairs`, `mykey-staging-pairs`, `mykey-audit-archive`, `mykey-retention-fixture` (default jurisdiction; location hint nearest the OVH region if known, otherwise automatic).
- **Lock rules**, set with `PUT /accounts/{account_id}/r2/buckets/{bucket}/lock`:
  - `mykey-prod-pairs`: `{"rules":[{"id":"pairs-30d","enabled":true,"prefix":"pairs/","condition":{"type":"Age","maxAgeSeconds":2592000}}]}`
  - `mykey-retention-fixture`: `{"rules":[{"id":"fixture-pairs-4d","enabled":true,"prefix":"pairs/","condition":{"type":"Age","maxAgeSeconds":345600}},{"id":"fixture-probe-10m","enabled":true,"prefix":"probe/","condition":{"type":"Age","maxAgeSeconds":600}}]}`
  - `mykey-staging-pairs` and `mykey-audit-archive`: no rule today; Runs 6.5 and 6.2 own them.
  - If the API rejects 600 s, raise the probe value step by step (3,600; 86,400) and record the smallest accepted value and the error text — that is the "minimum R2 allows" finding.
- **Tokens** (created through `POST /user/tokens` or the account-token equivalent; permission-group IDs looked up by name from the permission-groups endpoint; bucket resources written as `com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_default_<BUCKET>`). S3 credentials are derived as Cloudflare documents: access key ID = token `id`; secret access key = SHA-256 hex of the token `value`.

  | Token name | Permission group | Scope |
  | --- | --- | --- |
  | `mykey-r2-admin` | Workers R2 Storage Write | account (bucket configuration and lock rules) |
  | `mykey-prod-pairs-upload`, `mykey-prod-pairs-cleanup` | Workers R2 Storage Bucket Item Write | `mykey-prod-pairs` |
  | `mykey-staging-pairs-upload`, `mykey-staging-pairs-cleanup` | same | `mykey-staging-pairs` |
  | `mykey-audit-archive-upload` | same | `mykey-audit-archive` |
  | `mykey-fixture-upload`, `mykey-fixture-cleanup` | same | `mykey-retention-fixture` |

  Each token's S3 credentials are written to `~/.mykey/secrets/r2/<token name>.json` (`{accountId, accessKeyId, secretAccessKey}`) and listed, without values, in `credential-custody.md`. Token values never appear in the transcript: scripts write the file and print only the token name and ID. The two fixture tokens are also stored as GitHub Actions secrets with `gh secret set` reading from the file.
- **Fixture objects.** Three pairs under `pairs/<pairId>/` and two under `probe/<pairId>/`, each as `bundle.tar` + `manifest.json`, plus two unlocked control objects under `scratch/`. `build-pair.ts` creates a new Restic repository in a temporary directory with the pinned Restic image (password from `~/.mykey/secrets/retention-fixture/restic-password`, generated once, passed with `--password-file` through a mounted file, never as an argument); backs up three synthetic files (`pg.dump` and `raft.snap` of 1 MiB random bytes each, `globals.sql` of a few lines); runs `restic check --read-data`; tars the repository directory into one bundle. `manifest.json`: `{pairId, captureTime, bundleSha256, bundleBytes, resticVersion, synthetic: true}`. Capture times are staggered — now − 2 h, now − 1 h, now — so the "oldest eligible pair" is well defined and the capture clock differs from the upload clock.

Steps:

- [ ] **Step 1 — Get Cloudflare API access.** In this order: the Cloudflare API tool of your session if it is authenticated; otherwise a bootstrap token at `~/.mykey/secrets/cloudflare/bootstrap-token`; otherwise ask the owner to create one user API token from the "Create Additional Tokens" template plus account-level R2 edit, and save it to that path themselves (never pasted into chat). Confirm R2 is enabled (OWN-1 question 5). Record the account ID in the run note (it is not a secret).
- [ ] **Step 2 — Guard against silent skips (Review focus 2).** `scripts/require-cloud-env.ts` exits 1 with `cloud credentials missing: <token names>` unless the fixture upload, fixture clean-up and admin credentials can be loaded. Root script `test:cloud` = `node scripts/require-cloud-env.ts && vitest run --project cloud`. Verify: with `HOME` pointed at an empty directory, `pnpm run test:cloud` exits 1.
- [ ] **Step 3 — Write the cloud tests** `fixture.cloud.test.ts` (they describe provider behaviour; a failure is a finding to record, never something to "fix" by weakening the assertion):
  - `production pairs rule reads back as 30 days` — GET lock configuration of `mykey-prod-pairs` → rule `pairs-30d`, prefix `pairs/`, `maxAgeSeconds` 2,592,000, enabled.
  - `fixture rules read back as configured`.
  - `overwrite of a locked object is denied` — PUT to an existing `pairs/…/bundle.tar` with the upload token → HTTP 409, code `ObjectLockedByBucketPolicy`; the object's ETag is unchanged.
  - `delete of a locked object is denied` — DeleteObject with the clean-up token → 409 `ObjectLockedByBucketPolicy`; HEAD still 200.
  - `bulk delete returns HTTP 200 with per-object errors` — DeleteObjects for one locked key and one `scratch/` key → HTTP 200; `deleteObjectsChecked` returns `{deleted:false, errorCode:"ObjectLockedByBucketPolicy"}` for the first and `{deleted:true}` for the second; a following HEAD confirms each.
  - `deleteObjectsChecked never reports success from the HTTP status alone` — unit-level check on a recorded response with `Errors` present.
  - `failed multipart upload is cleaned up` — create a multipart upload under `scratch/`, upload one part, do not complete; it appears in ListMultipartUploads; abort it; it no longer appears and no object exists at the key.
  - `object tokens cannot change the lock rule` — the token value exists only in memory while `provision.ts` creates it, so `provision.ts` makes this call at that moment (PUT lock configuration with the new upload token as bearer → 401/403) and writes `{token, status, deniedAt}` to `retention-fixture.json`; the test asserts that a denied result is recorded for every upload and clean-up token.
  - `probe lock expires` (run after the wait in Step 6): deleting a `probe/` object older than its lock succeeds and HEAD returns 404, while a `pairs/` object uploaded at the same time is still denied.
- [ ] **Step 4 — Implement** `r2.ts`, `provision.ts` (idempotent: creates buckets, sets and reads back lock rules, creates missing tokens), `build-pair.ts`, `upload.ts`. Follow Cloudflare's current AWS SDK v3 example for R2 client options (checksum settings have changed between SDK versions; use the documented ones for the pinned version).
- [ ] **Step 5 — Provision and upload.** Run `provision.ts`, then `upload.ts`. For every object record in `retention-fixture.json`: `key`, `bytes`, `etag`, `uploadedAt` (the `LastModified` value R2 returns, UTC — not the workstation clock), `captureTime`, `lockRule`, `lockExpiresAt` (= `uploadedAt` + rule age), `pairId`. Also record the lock configuration as read back, the account ID, and the token names used.
- [ ] **Step 6 — Run the tests.** `pnpm run test:cloud` now; all but `probe lock expires` must pass. Continue with other work; after the probe lock age has passed, run that last test and append its result with timestamps.
- [ ] **Step 7 — Checkpoints and cost sheet.** In `retention-fixture.json` add `checkpoints`: (1) probe expiry — done in this run; (2) "first session gate on or after `<lockExpiresAt of pairs/>`": repeat denied-delete on a `pairs/` object before expiry or record expiry after it; (3) Run 6.6: clean-up of expired fixture objects and restore of the oldest eligible pair. `docs/evidence/cost-sheet.md`: bundle and manifest bytes per pair; counted Class A and Class B operations for provisioning, one pair upload, one verification download; today's published R2 storage and operation rates with the date looked up; a 30-pair storage projection. Mark every projected figure `estimated`.
- [ ] **Step 8 — D-16, custody list, run note, commit** `feat(backup): R2 buckets, lock rules, scoped tokens and ageing retention fixture`. Registry note: PO-9, R2-L1, COST-B1 stay `OPEN` with Run 1.9 listed as contributing evidence — the fixture is **started**, nothing is passed.

**Covers:** start of PO-9, R2-L1, COST-B1 under D-04. **Done when:** fixture objects are locked with their clocks recorded; the denied-delete results are saved.

---

## Run 1.10 — Registry and session gate

**Files:** `scripts/registry-build.ts`, `scripts/registry-verify.ts`, `docs/evidence/registry.json`, `docs/evidence/registry-overrides.json`, `tests/unit/registry/registry.test.ts`, `docs/evidence/session-1/report.md`, `docs/evidence/session-1/run-1.10.md`.

**Produces** `docs/evidence/registry.json`:

```json
{
  "version": 1,
  "generatedFrom": { "doc04Sha256": "…", "doc08Sha256": "…", "doc10Sha256": "…" },
  "items": [
    { "id": "FR-1.33", "kind": "FR", "title": "Format v1", "gate": "R",
      "ownerRun": "1.8", "contributingRuns": [], "oldSession": "D08-S22",
      "status": "SPIKE_PASS", "evidence": ["docs/evidence/session-1/run-1.8.md"], "note": "" }
  ]
}
```

`kind` ∈ `FR`, `AC`, `PROOF`. `status` ∈ `OPEN`, `SPIKE_PASS`, `PASS`, `FAIL`, `WATCH`, `CUT`. `gate` is `F` for AC-1.53, AC-1.54, AC-1.58, AC-1.59 and `R` for everything else.

- [ ] **Step 1 — Failing test** `registry.test.ts`: exactly 102 `FR` (FR-1.01 … FR-1.102, none missing), 60 `AC` (AC-1.01 … AC-1.60), 29 `PROOF` (PO-1 … PO-24, KMS-L1, DB-G1, R2-L1, AGENT-B1, COST-B1); ids unique; every `ownerRun` and contributing run is one of the 89 runs of Doc 10 §7; every id named on a "Covers:" line of Doc 10 §7 without the words "early", "start of" or "server side of" has that run as `ownerRun`, and with those words has it in `contributingRuns`; exactly four items have gate `F`; no item is `PASS` (nothing is integrated yet); every non-`OPEN` item has at least one existing evidence path; rebuilding from the documents reproduces the committed file byte for byte.
- [ ] **Step 2 — Implement `registry-build.ts`.** Sources: Doc 04 for FR and AC ids and titles (the bold lead-in of each row); Doc 08 Part IV sections E, F, G for each id's old session; Doc 10 §9 for old session → new runs; Doc 10 §7 "Covers:" lines to choose the owner where an old session maps to several runs. Where the documents still leave more than one candidate, the script stops and lists the ids; resolve each by hand in `registry-overrides.json` as `{id, ownerRun, reason}`. Statuses come from the overrides file too: PO-24, FR-1.33, FR-1.34, FR-1.38 → `SPIKE_PASS` with their run notes as evidence; everything else `OPEN`.
- [ ] **Step 3 — Implement `registry-verify.ts`** (the checks of Step 1 as a command) and add root script `evidence:verify`; append it to `check`.
- [ ] **Step 4 — Run:** `pnpm test`, `pnpm run check` → PASS. Commit `docs(evidence): requirement, acceptance and proof registry`.
- [ ] **Step 5 — Gate, part 1: full suite.** On `session-1` with all parallel runs merged: `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test`, `pnpm run test:integration`, `pnpm run test:cloud`, then CI green on the pushed head. Session 1 has no staging demonstration (§4.5 applies it from Session 2). Demonstrate the end goal instead: clone the repository into a fresh directory outside OneDrive, run `pnpm install --frozen-lockfile && pnpm run stack:up && pnpm run test:integration`, and record the output.
- [ ] **Step 6 — Gate, part 2: independent review.** Start a fresh-context reviewer agent with only this brief: "Review `git diff main...session-1` of the MyKey repository against `docs/plans/session-1-plan.md` and Doc 10 §4.1. Concentrate on the negative tests of Runs 1.4 (scanner self-test), 1.7 (role privilege matrix, tenancy constraints), 1.8 (rejected constructs, no input in diagnostics) and 1.9 (denied overwrite/delete, per-object delete errors). Report findings by severity with file and line; say explicitly whether any test can pass without exercising what it claims." Fix every high or critical finding; list the rest in the report.
- [ ] **Step 7 — Gate, part 3: report.** `report.md` with these headings: `Result` (PASS / PASS WITH ISSUES / FAIL); `What works now` (the three commands and what they prove); `What failed or was deferred`; `Decisions taken` (D-12 … D-16 and any fallback); `Pins` (Node, PostgreSQL, OpenBao, Traefik, Better Auth versions and the `dependencies.lock.json` hash); `Reviewer findings` (fixed / open); `What Session 2 must know` — harness API (`startStack`, `freshDatabase`, `freshNamespace`, `baoFetch`, `restartService`), role names and how `applyRoles` sets passwords, schema names, CI job names, where credentials live, the fixture's `lockExpiresAt` and next checkpoint date, the pending-route list, measured idle memory of the stack, the server sizing verdict; `Owner actions pending` (OWN-1 answers still missing; OWN-2 by Run 2.5; OWN-3 by Run 2.7).
- [ ] **Step 8 — Merge and tell the owner.** Open a pull request `session-1` → `main`, wait for CI, merge with a merge commit. Send the owner a short message: what works now, what failed, decisions taken, and what is needed from them next with dates. Commit the run note.

**Done when:** session report written.

---

## Session 1 end state

- `git clone` + `pnpm install --frozen-lockfile` + `pnpm run stack:up` + `pnpm run test:integration` works on a clean machine with Docker.
- CI is green on `main` and demonstrably red for a seeded secret and a seeded vulnerable dependency.
- `@mykey/contracts` exports limits, validators, error codes, 41 frozen routes, the dotenv codec and a generated OpenAPI 3.1 document.
- `@mykey/db` migrates an empty PostgreSQL 18 database and its five roles pass the privilege matrix.
- Four R2 buckets exist; production `pairs/` reads back a 30-day lock; the fixture's objects are ageing with both clocks recorded.
- Decision records D-01 … D-16, the 191-item registry, ten run notes and the session report are committed.
- The owner has the OVH purchase list with "needed by" times.
