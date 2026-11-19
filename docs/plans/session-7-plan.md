# MyKey Stage 1 — Session 7 (Owner web workspace) Execution Plan

> **For the executing agent:** carry this plan out run by run, in the order given in "Run order". If you have the superpowers skills, use `superpowers:executing-plans` (inline execution is the owner's standing preference; one fresh-context review at the gate). Steps use checkbox (`- [ ]`) syntax for tracking. You do not re-decide anything in Doc 10 §3 / §8 or in the "Planner decisions" table below; if one proves wrong, write a one-paragraph decision record and continue (Doc 10 §1). **This plan is lighter than Session 6's on purpose** (the owner, 19 Nov 2026): read "How this session is tested" before anything else, and do not add a test, a suite run or a deploy that it does not name.

**Goal:** By the end of 21 November 2026: using only a browser, the owner signs in with password and TOTP, creates a project and an environment, writes, reveals, edits, deletes and restores a secret, imports and exports a dotenv file, issues and revokes a machine token, and reads the activity of the organization; a pending, uncertain or partial state is shown as what it is; and after all of it no secret value, token, code or reset link is in the browser's storage, its history or a URL.

**Architecture:** One static React application, built once by esbuild into three files (`index.html`, one script, one stylesheet) and served by the API itself from the same origin, so the session cookie, the Origin check and the strict content policy need nothing new. The API serves the shell only on a fixed table of client paths; every other path keeps today's 404. The browser talks to the product through one small client built on the contract's own route table and schemas, so the workspace cannot call a route the contract does not have, and an answer of an unexpected shape is a transport failure, never a guess. TanStack Query holds metadata only, in memory only. Everything that carries a secret (reveal, export, the one-time token, the TOTP key, recovery codes, import bytes) goes around the cache through one function and lives in one hook that forgets after 30 seconds, on hide, on navigation and on sign-out. The server stays the only authority: the workspace never marks an effect done before the server says so, and never offers a retry of an uncertain change. Three routes of the frozen list get their bodies here (`overview.get`, `credentials.summary`, `metrics.get`); no route is added and no migration is expected.

**Tech stack:** everything pinned in Sessions 1–6. Used for the first time in the product: `react` and `react-dom` 19.3.1 and `@tanstack/react-query` 5.107.1 (all three already in the catalog; their lock notes change in Run 7.1), bundled by the pinned `esbuild` 0.28.2 (build only, as for the CLI). New pins, each after the advisory check of Run 1.3 Step 2: `@types/react` and `@types/react-dom` (development only). **No** router library, component library, CSS framework, chart library, QR library, Better Auth browser client, jsdom or testing library: P-135 says what replaces each.

**Spec:** `docs/doc_10_mykey_stage_1_compressed_implementation_plan_v1.0.md` §1–§4, §7 "Session 7", §8.2, §9, §10 (items 3 and 4). Behaviour: Doc 04 §8 (the paragraph under the table, and §8.1), §11 (FR-1.89–1.94, FR-1.96), §11.1, §11.2, FR-1.22, FR-1.23, FR-1.76; acceptance AC-1.29, 1.34, 1.46, 1.47, 1.48, 1.51, 1.55; PO-12. Design: Doc 06 §9 ("Browser workflow requirements", the CSP paragraph), §18.1–§18.3. Previous sessions: `docs/evidence/session-6/report.md` ("What Sessions 7, 8 and 9 must know"), `session-5/report.md` ("Session 7's workspace gets"), `docs/auth-route-contract.md`, D-15, D-19, D-45, D-46, D-49. Old runbooks for ideas only: D08-S33–S37, S39.

**Facts used here** were read from the repository on 19 Nov 2026 (the route table, `apps/api/src/app.ts`, the auth route contract, the test harness, CI run 44481743101). Nothing was executed for this plan. Four facts are **documentation reading** only, and the test named beside each is the first real evidence — when the observation differs, the observation wins and goes into the run note:

- React sets a `style` prop through the element's style object, which a policy of `style-src 'self'` allows; a `style` attribute in markup would be refused (Run 7.1 Task B: zero policy violations);
- a download started from a `blob:` URL of the page itself is not stopped by a policy without `sandbox` (Run 7.6);
- Playwright 1.64.1 has `page.clock`, so a 30-second timer is tested without waiting 30 seconds (Run 7.4);
- on a pull request, `github.event.pull_request.draft` is `true` for a draft, and marking it ready sends the event `ready_for_review` (Session start Step 3).

---

## How this session is tested (P-132 — the owner's rule of 19 Nov 2026)

Session 6 took three days instead of two, and most of the extra time was suites, deploys and CI runs repeated inside runs. This session keeps the heavy proof and runs it **once**.

| When                        | What runs                                                                                                                                                                                                                                                                                                         | Cost               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Inside a run, on the workstation | `pnpm run check`; the unit files the run adds or changes; the run's **one** browser file (`pnpm exec vitest run --project browser tests/browser/<file>`). Runs 7.3, 7.7 and 7.8 also run the one integration file of their new route.                                                                              | minutes            |
| After a run's last commit   | `git push`. The pull request is a **draft**, so CI runs only `check` (with all unit tests) and the secret scan: about 2 minutes. **Do not wait for it.** Read it before the next run's first commit (`gh run list --branch session-7 --limit 1`); a red run is fixed before new work.                                | 2 minutes, unattended |
| Once, at the gate (Run 7.10) | The pull request is marked ready: the full integration suite (two shards), the scans and the whole browser project on CI. On the workstation and staging: one release, one deploy, the staging files, `test:consumers`, one fresh-context review.                                                                  | half a day         |

Rules that follow from it:

- **No full suite, no staging file, no deploy and no review inside Runs 7.1–7.9.** Not "to be safe", not after a refactor. The gate finds what crosses runs; that is its job.
- **A run's tests are the ones this plan names.** Each run has one browser file with at most about ten tests, and a few unit tests. When they and `check` are green, the run is done. Ideas for more tests go into the run note under `Open issues`, not into the suite.
- **Two layers only.** Logic that can be a pure function (the router, the error table, labels, formatters, the forgetting timer's reducer) is unit-tested. Everything else is proven in Chromium against the real test API with real PostgreSQL and, where values are involved, real OpenBao. There are no component tests and no mocked API.
- **After a gate fix,** rerun the files that failed, locally, then push once. A commit that changes only documents or one test does not get another full CI run (as at Session 5's and 6's gates).
- **Not run at this gate, by ruling:** `pnpm run test:cloud` and `pnpm run test:cli`, unless `git diff --stat main...session-7` shows a change under `packages/backup`, `apps/ops`, `apps/cli`, `infra/backup`, `tests/restore` or `tests/cli`. This session touches none of them, and Session 8 reruns everything on the frozen candidate (Runs 8.3, 8.7). The report says so in one line.
- **Run notes are short:** the five headings of Run 1.1's template, ten to twenty lines, with the test counts and the commit ids. No evidence JSON files are written by this session's tests.

What is **not** made lighter: Doc 10 §4.1, test-first for every behaviour the plan names, real stores as proof, the canary scan of Run 7.10, and the staging files Session 6's gate left for this one.

---

## Global constraints

Every run's requirements include this section and the "Global constraints" of the plans of Sessions 1–6 (synthetic data only, real stores for proof, a skipped test is not a pass, the forbidden components, pins, limits live once in `@mykey/contracts`, one pipeline, contract commits, a denial must be a denial, no retry of an effect, closed first).

- **Doc 10 §4.1 in the browser.** The rules this session can break: rule 2 (a value, a token, a TOTP key, a recovery code or a reset token in `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, a URL, `history.state`, the query cache, a log line of the page, or an error report), rule 3 (an uncertain change shown as failed, or offered for retry with a new key), rule 5 (a screen that decides who may do what — the server decides; a hidden button is a convenience), rule 6 (a workspace screen rendered for a `password_verified` session), rule 7 (an edit sent without the expected version and state tag, or a "save anyway"), rule 11 (a count shown as `0` when it was not counted; a green state without a server answer behind it).
- **Storage ban.** No code under `apps/web/src` names `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, `caches`, `serviceWorker`, `BroadcastChannel` or `console.` (a unit test searches the sources). No `dangerouslySetInnerHTML`, no `eval`, no inline script, no `<form action>` that leaves the origin.
- **No optimistic success.** A mutation's screen shows what the server answered: 200 or 201 is done; 202 is `accepted` or `executing` with the operation id and a status that refreshes; 503 `outcome_unknown` is "unknown — do not repeat it; check the operation". TanStack's optimistic updates are not used anywhere.
- **Status is never colour alone.** Every state has a word and an icon or a shape; a unit test checks that every state of the contract has a label.
- **The route list stays frozen (D-15).** The three pending routes get bodies in commits titled `contract: …`; `pnpm run contracts:openapi` after each. No new product route. A schema the web needs and `routes.ts` does not export is exported; an export is not a contract change.
- **Migrations.** None is expected. If one is needed it is `0019`, expand-only, with the privilege matrix and the inventory in the same commit.
- **Statuses.** The registry ceiling is `SPIKE_PASS` (P-104 holds). A `SPIKE_PASS` needs a run note that states the id and the status on one line.
- **Staging and production.** Staging is touched only at the gate. Production is not touched in this session: it receives this work with the candidate of Run 8.1.
- **The workstation.** One heavy job at a time. The browser project starts the Docker stack: never beside another suite or a Docker build. `tests/browser/reference.test.ts` rewrites `docs/evidence/session-5/reference-capture.json`: restore it before committing. Regexes and escapes are written with the editor tools, never through the shell.
- **Git.** Branch `session-7`, never `main`. The pull request is opened as a draft after Run 7.1 and merged only when the owner says so.
- **Every run ends with:** `pnpm run check` green, the run's tests green, a commit, a push, and a run note `docs/evidence/session-7/run-7.N.md`.

## Review focus

Five conditions the specifications imply but do not spell out, most likely to bite first. Each has a test pinned in the run named.

1. **A secret outlives its screen.** The revealed value is still in the DOM after the tab was hidden; the one-time token sits in `history.state` because a router put the response there; the import's bytes stay in a component that was never unmounted; a copied value is still shown after sign-out in another tab. → P-138: one hook owns every secret; Run 7.4 tests hide, navigation, the timer and sign-out; Run 7.10's canary scan reads every storage the browser has, with a control that proves the scan can find one.
2. **The page is loaded from an origin the API does not expect.** The test API is configured with one origin and reached through another, every cookie POST answers `origin_rejected`, and someone "fixes" it by rewriting the `Origin` header in the test — which would hide exactly the defect AC-1.29 is about. → Run 7.1 Task B: the harness loads the page from the configured origin itself, and the first browser test performs one real cookie POST.
3. **The shell answers where a 404 was a proof.** A catch-all that serves `index.html` for every unknown path turns `/metrics`, `/debug`, `/status` and `/dashboard/` into 200 answers and breaks `status.staging.test.ts`, which proves the API has no diagnostic route. → P-134: the shell answers only on the path table `WEB_ROUTES`; Run 7.1 Task A tests that those four paths and `/v1/anything` still get the JSON 404.
4. **Uncertain is shown as failed, or as done.** A 503 `outcome_unknown` lands in a generic "something went wrong — try again"; an import that ended `partial` shows a green tick because the HTTP status was 200; a credential in `needs_review` offers "issue again". → P-140 and the error table of Run 7.1; Run 7.8's three seeded states; a unit test that no explanation of `outcome_unknown` contains "try again" or "retry".
5. **The workspace exceeds its own limits.** A status poll every second, a refetch on every focus and five lists per screen pass 120 requests a minute for one session, and the owner's own workspace answers 429. → P-140: the polling schedule and the query defaults; Run 7.3 counts the requests of one overview load (at most 4) and of one idle minute (0).

## Planner decisions

Settled here so the executor does not have to choose. Each one marked **DR** gets a decision record in the run shown. Numbering continues from Session 6 (P-131, D-57).

| #     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Why                                                                                                                                                                                                 | Run   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| P-132 | **Test cadence**: the section "How this session is tested". **DR D-58.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The owner, 19 Nov 2026. Session 6's own report: each run proved only its files and the gate found the rest; repeating suites inside runs bought nothing the gate did not find again.                | all   |
| P-133 | **CI in two weights.** `ci.yml`: `pull_request` gains `types: [opened, synchronize, reopened, ready_for_review]`; the jobs `integration` and `scans` run only when `needs.check.outputs.code == 'true'` **and** (`github.event_name == 'workflow_dispatch'` or `github.event.pull_request.draft == false`). A new job `browser` with the same condition: checkout, pnpm, Node, `pnpm install --frozen-lockfile`, `pnpm exec playwright install --with-deps chromium`, `pnpm run test:browser`, then `node scripts/stack.ts down --all`; 30-minute limit. A draft pull request therefore costs about 2 minutes a push; "ready" starts everything. The workflow's stale comment about a private repository and 2,000 minutes is corrected.                                                                                                                                                                                                                                 | The owner's rule. Today every push to a pull request starts 13 minutes of integration. The browser project is this session's whole proof and has never run on Linux.                                | start |
| P-134 | **How the workspace is served.** `node apps/web/build.ts` (esbuild, the pattern of `apps/cli/build.ts`) writes `apps/web/dist/`: `assets/app-<hash>.js`, `assets/app-<hash>.css`, `index.html` (one `<script type="module" src>`, one `<link rel="stylesheet">`, nothing inline) and `manifest.json` `{ build, files: [{ path, sha256, contentType }] }`. The API reads the directory **once at start** into memory (`loadWebShell`) and serves from that map: `GET /assets/<file>` only for a file of the manifest, and `index.html` for a `GET` whose path matches `WEB_ROUTES` (`packages/contracts/src/web-routes.ts`, the same table the browser's router uses). Nothing is read from disk per request and no request path is ever joined to a directory. Everything else keeps the JSON 404. No dist → one log line `web_shell_missing` and 503 `dependency_unavailable` on those paths (as the reference). The shell is public and holds no data: no organization, no name, no build secret. It goes through the gate and the source limit like every request, keeps `cache-control: no-store`, and carries the headers of P-141. The API image gains a stage `web` that builds the dist; only `apps/web/dist` reaches the final image, and React never enters the runtime `node_modules`. **DR D-59.** | Doc 10 Run 7.1 ("served from the API origin"); Doc 06 §9. One origin means the `__Host-` cookie, the Origin check and `connect-src 'self'` work unchanged. A path table keeps every 404 that is a proof (Review focus 3). | 7.1   |
| P-135 | **What the workspace is built from, and what it does without.** Plain React function components and one stylesheet `apps/web/src/styles.css` with custom properties for colour, space and type (light and dark by `prefers-color-scheme`). A router of the project's own: `matchRoute(path)` over `WEB_ROUTES`, `navigate()`, a `<Link>`; no library. No chart library: P-142. No QR code at enrolment: the TOTP key is shown in groups of four with a copy button, beside the `otpauth://` address as text; whether the owner needs a QR code is asked in Run 8.8 (`known-limits.md` gets the line). No Better Auth browser client: the auth screens use `fetch` against the paths of `docs/auth-route-contract.md` and map its answers through the same error table. No component tests (P-132). **DR D-59.**                                                                                                                                                                 | Every dependency is a pin, an advisory check and a surface under the content policy. Twelve screens for one operator do not need them. The owner asked for a session that goes easy.                 | 7.1   |
| P-136 | **The client.** `apps/web/src/api/client.ts` exports `call(routeId, input)` built on `ROUTES` from `@mykey/contracts` (the package imports no `node:` module): the path from the route's pattern and `input.params`, `credentials: "same-origin"`, `Idempotency-Key` from `input.idempotencyKey` for an idempotent route (a missing key is a programming error, thrown before the request), a JSON body or raw dotenv bytes as the route says. The answer is parsed with the route's own schema. Result: `{ ok: true, status, body, requestId }` or `{ ok: false, failure }` where `failure` is `{ kind: "api", status, code, message, requestId, operationId, details, retryAfterSeconds }` (the D-14 envelope) or `{ kind: "transport", status }` for anything else — a proxy's HTML, a cut connection, a body that fails its schema. The client never retries. Types come from the exported schemas (`z.infer`).                                                          | Doc 10 Run 7.1 ("a typed API client generated from the contracts"); FR-1.52 (UI and CLI use the same contract); Doc 04 §8.1 ("clients must fail safely on unexpected bodies").                    | 7.1   |
| P-137 | **Session and guard.** The shell asks `GET /v1/auth/get-session` once at load and after every auth step. No session → `/sign-in`. Phase `password_verified` → the TOTP step, or enrolment for an account that is `enrollment_pending`; no workspace route renders (the server refuses them too: `mfa_incomplete`). Any 401 on a later call clears the query cache and every secret holder and shows `/sign-in` with "your session ended". `POST /v1/session/activity` is sent after a real key or pointer event, at most once in 60 seconds, never from a timer alone. A failed sign-in shows one fixed text for every cause (the server's answer is the same for all of them) and, below it, a fixed note: after a restore from a backup every account needs an operator reset (`restore.md`). Reset completion reads `t` and `k` from the fragment of `/reset#t=…&k=…`, removes the fragment from the address bar with `history.replaceState` before anything else, and keeps the token in the forgetting hook. | Doc 10 Run 7.2; rule 6; Session 6 report ("a restore resets everyone … explain this state"). The fragment never reaches the server or a log; it must not stay in the history either.                | 7.2   |
| P-138 | **Secrets in the page.** `callSecret(routeId, input)` is `call` without TanStack Query around it; a unit test fails when a route of the list `SECRET_BEARING` (`secrets.reveal`, `secrets.create`, `secrets.update`, `import.preview`, `import.apply`, `import.resume`, `export.create`, `credentials.issue`, and the auth paths `/totp/enroll`, `/totp/activate`, `/recovery/regenerate`, `/change-password`, `/sign-in/email`, `/reset/complete`) is used through `useQuery` or `useMutation`. `useEphemeral<T>(ttlMs = 30_000)` returns `[value, set, clear]` and clears on the timer, on `visibilitychange` to hidden, on a route change, on sign-out and on unmount. Reveal, the one-time token, the TOTP key, recovery codes and the reset token live only there. Copy is an explicit button (`navigator.clipboard.writeText`) with the fixed warning that the clipboard is outside the product. Inputs that hold a secret are `autocomplete="off"`, the password fields `current-password` / `new-password`, the TOTP field `one-time-code`. The query client: no persister, `staleTime` 30 s, `refetchOnWindowFocus: false`, `retry: false`, keys that begin with `[userId, organizationId]`, `clear()` on sign-out, on a 401 and on a change of organization. **DR D-60.** | Doc 06 §9 and §18.2; Doc 04 §8; FR-1.22, FR-1.23. One hook and one function are things a reviewer can read whole; a rule spread over twelve screens is not.                                         | 7.4   |
| P-139 | **The three bodies.** All three keep their action (owner and admin; a member gets `action_denied`), so everything they count is something the caller may list: authorization precedes aggregation by construction. Each reads at one database time `observedAt` and runs with the 5 s statement timeout of `audit.list` (a timeout is `503 busy`). **`overview.get`**: `{ observedAt, source: "index", projects: [{ id, name, state, reviewReason, environments: [{ id, name, state, reviewReason, kvReady, changedAt \| null, keys: { live, deleted, needsReview } \| null }] }], truncated }` — at most 100 projects by id; `keys` is `null` (shown "not available") for an environment that is `pending` or `needs_review`; counts come from `app.secret_index`, never from OpenBao. **`credentials.summary`**: `{ observedAt, byState: { <each of CREDENTIAL_STATES>: int }, expiring: [{ credentialId, name, projectId, environmentId, expiresAt }], expiringTruncated }` — `expiring` is the `active` credentials within 7 days of expiry, soonest first, at most 50; states are derived exactly as `credentials.list` derives them; no accessor. **`metrics.get`**: query `{ days: 1..30, default 7 }`; `{ observedAt, source: "audit.event", window: { from, to }, measuredFrom \| null, days: [{ day, counts: { success, failure, unknown, denied } \| null }], operations: { unresolved, uncertain } }` — whole UTC days; only the rows `activity.list` would serve; `denied` is the action `access.denied`; a day before `measuredFrom` (the organization's oldest served row) has `counts: null`, which the workspace shows as "not measured", never as zero. Commits `contract: overview`, `contract: credentials summary`, `contract: metrics`; the pending snapshot ends empty. **DR D-61.** | Doc 06 §18.3; FR-1.90, FR-1.91, FR-1.94; Doc 04 §11.2 (unknown is not zero). The index is the one place counts exist without reading values.                                                        | 7.3, 7.7, 7.8 |
| P-140 | **Operations in the page.** Before a mutation the page makes the key with `crypto.randomUUID()` and keeps it with the form (never with the values in any store). A 202 shows the operation id and polls `operations.get` after 1 s, 2 s, 4 s, then every 5 s, for at most 2 minutes; then polling stops and a "check again" button stays. A terminal state stops it. `uncertain` and `outcome_unknown` show the fixed text of the error table, the operation id, a link to the environment's operations screen and the sentence that an operator settles it (`reconciliation.md`); no button on that panel sends the change again. After a reload the screen finds unfinished work through `operations.list`, not through anything it kept. A version conflict (`version_conflict`, `precondition_required`) offers exactly two actions: reload (the form's value is dropped) or cancel. `429` shows the seconds of `retry-after` and disables the button for them.                    | Doc 06 §9; FR-1.92, FR-1.93; rules 3 and 7; Review focus 4 and 5.                                                                                                                                  | 7.1, 7.4 |
| P-141 | **Headers of the shell and its assets.** `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`, `cross-origin-opener-policy: same-origin`, `permissions-policy: camera=(), microphone=(), geolocation=()`. No web font is shipped (system fonts), so `font-src` and `data:` images can be tightened by the run if the build proves it. The reference keeps its own policy (D-45).                                                                                                                                                                                                                                                                                                                 | Doc 06 §9 (the CSP paragraph); FR-1.76; AC-1.34; PO-12.                                                                                                                                             | 7.1   |
| P-142 | **Analytics are tables (scope valve 1 of Doc 10 §8.2, proposed here).** The stage is two days behind its map, which is the valve's condition; the owner approves it with one line at the session start. The summary is three small tables, each with its source, its window and its observation time: outcomes by day (with a plain CSS bar per row, which is decoration: the number is in the cell), credentials by state with the expiring list, and unresolved operations. If the owner says no, the same data is drawn as an inline SVG bar chart beside its table in Run 7.8, still without a library. **DR D-62** (the valve).                                                                                                                                                                                                                                                                                                                                  | Doc 10 §8.2 item 1 ("FR-1.94 keeps its minimum"); FR-1.94 itself accepts tables. A chart nobody needs to decide anything is the first thing to give.                                                | 7.8   |

## Carried items

| Item                                                                                                           | From                 | Where it lands                                                          |
| -------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `contracts-compat.ts` misses a removed response status and a field that loses `required`                        | Session 5 report     | Run 7.1 Task A                                                          |
| `routes/lifecycle.ts`: a `driveArchive` throw answers 503 without the operation id                              | Session 5 report     | Run 7.3                                                                 |
| The archive confirmation names affected scopes and unfinished issuance (FR-1.17)                                | Session 5 report     | Run 7.3                                                                 |
| `credential_not_replayable` explained to the owner; the token in the 201 and nowhere else                       | Session 5 report     | Run 7.7                                                                 |
| The new answers: 429 with `retry-after`, 507, 503 `busy`, 503 `dependency_unavailable`, `quarantined`           | Session 6 report     | Run 7.1 (the error table), Run 7.9                                      |
| A restore resets every account and revokes every token: the workspace explains it                               | Session 6 report     | Run 7.2 (sign-in note), Run 7.7 (credentials help)                      |
| Staging files not run at Session 6's gate: `boundary`, `transport`, `identity`, `export`, `cli`, `key-loss`, `probe`; `test:consumers` | Session 6 report     | Run 7.10 Step 4                                                         |
| PR #17's provisioner fix is not on staging yet                                                                  | CLAUDE.md            | Run 7.10 Step 3 (the release)                                           |
| The watcher's first scheduled run after the merge                                                               | Session 6 report     | Run 7.10 Step 1 (`gh run list --workflow probe-watch --limit 1` is green; else run it once) |
| OWN-4 not confirmed                                                                                             | CLAUDE.md            | the owner message of the session start and of the gate                  |
| KMS certificates 12 Dec, `.trivyignore.images` 14 Dec, `pair-30-day` 17 Dec                                     | CLAUDE.md            | not this session's work; Run 7.10 re-reads the dates                    |

## Session start (before Run 7.1)

- [ ] **Step 1 — Branch.** `git switch main && git pull && git switch -c session-7`.
- [ ] **Step 2 — One message to the owner**, saved as `docs/evidence/session-7/owner-requests.md`. It asks for two one-line answers and nothing else: (1) **yes or no to scope valve 1** (P-142: the analytics are tables, no charts); work continues on "yes" until the answer comes, and only Run 7.8 depends on it; (2) **OWN-4**, still open: "copied" once the two files of `~/.mykey/custody/staging/backup/` are offline. It also says what the owner will be asked at the end: to read the report and to say "merge".
- [ ] **Step 3 — CI in two weights (P-133).** Edit `.github/workflows/ci.yml` as P-133 says. `pnpm run check` (the pins check reads the workflow). Commit `ci: integration, scans and the browser project wait for a ready pull request`. The proof comes by itself: the draft pull request of Run 7.1 must show `check` and `secret-scan` only, and the gate's "ready" must start the rest.
- [ ] **Step 4 — Chromium.** `pnpm exec playwright install chromium` if this workstation does not have revision 1248 yet; `pnpm exec vitest run --project browser tests/browser/reference.test.ts` is green (4 tests); restore the evidence file it rewrote.

## Run order

```
7.1 shell, served by the API, client, error table ──► draft pull request
 └► 7.2 sign-in and security screens
     └► 7.3 overview and resources            (contract: overview)
         └► 7.4 secrets: list, edit, reveal
             ├► 7.5 history, delete, undelete, restore
             ├► 7.6 import, export, first-run guide
             └► 7.7 machine credentials        (contract: credentials summary)
                 └► 7.8 operations, activity, summary   (contract: metrics)
                     └► 7.9 errors, keyboard, narrow screen, browser security
                         └► 7.10 journey, canary scan, session gate
```

- **Dependencies.** Everything needs 7.1. 7.3–7.8 need 7.2's session guard. 7.5–7.7 need 7.4's secret hook and are independent of each other; inline execution does them in number order.
- **Time boxes.** 7.1: half a day. 7.2–7.9: about two hours each. 7.10: half a day. A run that passes twice its box stops, writes what blocks it into its run note and takes the next valve below.
- **Scope valves inside this session,** in this order, each a line in the run note and the report: (1) the dark colour scheme; (2) the first-run guide becomes one static help page that links to the runbooks; (3) the `browser` job on CI — two red runs for reasons of the runner, not of the product, and the workstation's run of the project stands, with the gap in `known-limits.md`; (4) Doc 10 §8.2 items 3 and 5, with the owner's line, exactly as written there. **Never cut:** Run 7.4's four forgetting tests, Run 7.9's origin test, Run 7.10's canary scan and its control, any text of the error table for `outcome_unknown`.

## File map

```
packages/contracts/src/       web-routes.ts (WEB_ROUTES)  routes.ts (three bodies, exports)  index.ts
packages/db/src/repos/        overview.ts  credentials-summary.ts  metrics.ts
apps/api/src/                 web/shell.ts (loadWebShell, mountWebShell)  routes/{overview,credentials-summary,metrics}.ts  app.ts
apps/api/Dockerfile           stage `web`
apps/web/                     build.ts  package.json  tsconfig.json (jsx, DOM)
apps/web/src/                 main.tsx  app.tsx  router.ts  styles.css
apps/web/src/api/             client.ts  secret.ts (callSecret, SECRET_BEARING)  auth.ts  query.ts  operations.ts (the poll schedule)
apps/web/src/state/           ephemeral.ts (useEphemeral + its reducer)  session.tsx
apps/web/src/errors/          explain.ts (one entry per error code)  ErrorPanel.tsx
apps/web/src/ui/              Button, Field, Dialog (confirm with typed text), StateBadge, Table, Time, Layout (the scope bar), CopyButton
apps/web/src/screens/         sign-in, totp, enroll, reset, account, overview, project, secrets, secret, import, export, credentials, operations, activity, audit, help
scripts/                      contracts-compat.ts (two more breaks)
tests/harness/                web.ts (startWeb, signedIn(user), canary helpers)
tests/unit/web/               router.test.ts  explain.test.ts  labels.test.ts  ephemeral.test.ts  sources.test.ts (the storage ban, SECRET_BEARING)  poll.test.ts
tests/unit/api/               web-shell.test.ts
tests/integration/            overview/overview.test.ts  credentials/summary.test.ts  metrics/metrics.test.ts  browser-security/origin.test.ts
tests/browser/                shell.test.ts  auth.test.ts  resources.test.ts  secrets.test.ts  history.test.ts  import-export.test.ts  credentials.test.ts  activity.test.ts  access.test.ts  journey.test.ts  canary.test.ts
tests/staging/                workspace.staging.test.ts
docs/decisions/               D-58 … D-62
docs/runbooks/                workspace.md (what each screen is for, what the workspace cannot do)  known-limits.md  local-stack.md (web:build)
docs/evidence/session-7/      owner-requests.md  run-7.1.md … run-7.10.md  report.md
```

Root `package.json` gains `"web:build": "node apps/web/build.ts"`; the browser project's global setup builds the dist before the API starts.

---

## Run 7.1 — Shell, served by the API, client and error table (D08-S33)

**Produces:**

```ts
// @mykey/contracts — web-routes.ts
export interface WebRoute { readonly id: string; readonly pattern: string }   // "/o/:org/p/:project/e/:env"
export const WEB_ROUTES: readonly WebRoute[];
export function matchWebRoute(path: string): { id: string; params: Record<string, string> } | null;
// apps/api — web/shell.ts
export interface WebShell { index: Uint8Array; files: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }>; build: string }
export function loadWebShell(directory: string): WebShell | null;
export function mountWebShell(app: Hono<ApiEnv>, deps: AppDeps, shell: WebShell | null): void;
// apps/web — api/client.ts, errors/explain.ts, api/operations.ts
export function call<Id extends RouteId>(id: Id, input: CallInput<Id>): Promise<CallResult<Id>>;
export function explain(failure: Failure, context: { action: string }): { title: string; text: string; next: string; ids: { requestId: string | null; operationId: string | null } };
export const POLL_DELAYS_MS: readonly number[];   // 1000, 2000, 4000, then 5000 until 120 s
```

`WEB_ROUTES` (the whole table; ids are the screen names): `/`, `/sign-in`, `/enroll`, `/reset`, `/account`, `/help`, `/o/:org`, `/o/:org/activity`, `/o/:org/audit`, `/o/:org/p/:project`, `/o/:org/p/:project/e/:env`, `/o/:org/p/:project/e/:env/s/:name`, `/o/:org/p/:project/e/:env/import`, `/o/:org/p/:project/e/:env/credentials`, `/o/:org/p/:project/e/:env/operations`. A secret's name is metadata and may be in a path; a value, a token or a code never is.

### Task A — the API serves a shell

- [ ] **Step 1 — Failing tests** (`tests/unit/api/web-shell.test.ts`, with a fixture dist of three small files; `tests/unit/web/router.test.ts`):
  - `GET / and every pattern of WEB_ROUTES answer the index with the headers of P-141 and no-store`;
  - `GET /assets/<a manifest file> answers its bytes and content type; /assets/../package.json, /assets/unknown.js and an encoded traversal answer the JSON 404`;
  - `/metrics, /debug, /status, /dashboard/ and /v1/anything answer the JSON 404` (Review focus 3);
  - `a closed gate answers quarantined for the shell too`; `without a dist the shell paths answer 503 dependency_unavailable and one log line web_shell_missing`;
  - `a POST to a shell path answers 404`;
  - `matchWebRoute: every pattern matches its own example; a trailing segment, an empty parameter and "/o//p/x" match nothing`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** `web-routes.ts`, `shell.ts`, the mount in `app.ts` (after the contract routes and the auth module, before `notFound`), `config.webDirectory` (default `apps/web/dist`). **Step 4 — Run:** PASS.
- [ ] **Step 5 — The carried compat gaps:** two failing cases in the compat script's unit test (`response_status_removed`, `response_field_optional`), then the code. **Commit** `feat(api): the workspace shell on a path table`.

### Task B — the application, the client, the error table

- [ ] **Step 1 — Pins.** `@types/react`, `@types/react-dom` after the advisory check; the lock notes of `react`, `react-dom` and `@tanstack/react-query` say "the owner workspace (Run 7.1)". `apps/web/tsconfig.json`: `jsx: react-jsx`, `lib` with `DOM`. `apps/web/build.ts` (P-134): `bundle`, `format: "esm"`, `minify: true`, `sourcemap: false`, `jsx: "automatic"`, `define` of `process.env.NODE_ENV` as `"production"`, `entryNames: "assets/app-[hash]"`; then `index.html` and `manifest.json`. The Dockerfile stage `web`.
- [ ] **Step 2 — Failing unit tests.**
  - `explain.test.ts`: `every code of ERROR_CODES has an entry with a title, a text and a next step`; `no text of outcome_unknown, backend_inconsistent or key_under_review contains "retry" or "try again"`; `rate_limited names the seconds`; `a transport failure never claims the change failed or succeeded`.
  - `labels.test.ts`: `every resource, index, credential and operation state of the contract has a label and a shape`.
  - `sources.test.ts`: the storage ban of "Global constraints" over `apps/web/src`.
  - `poll.test.ts`: the delays of P-140 and the stop at 120 s.
- [ ] **Step 3 — The harness** `tests/harness/web.ts`: `startWeb()` builds the dist, starts the test API with it and with `baseUrl` equal to the origin the browser will really use (Review focus 2: read `startTestApi`; add a `baseUrl` option if the configured origin has no port — never rewrite `Origin` in a Playwright route), creates the tenants, launches Chromium, and gives `signedIn(user)`: a context with the session cookie, third-party requests aborted and recorded, and the init script of `reference.test.ts` that records policy violations.
- [ ] **Step 4 — Failing browser test** `shell.test.ts`:
  - `the shell loads with zero policy violations and zero third-party requests, and requests only its document, its script and its stylesheet before the first API call`;
  - `without a session every workspace path shows the sign-in screen`;
  - `as ownerA the scope bar names the organization, and after choosing a project and an environment it names all three` (FR-1.89);
  - `one real cookie POST from the page succeeds` (`/v1/session/activity`, 200) — the origin proof;
  - `a seeded 503 quarantined, a 429 and a cut connection each show their text from the error table with the request id where there is one` (the three come from the harness: a closed gate, `rateLimits` of the product with a spent budget, a route aborted in Playwright).
- [ ] **Step 5 — Run:** FAIL. **Step 6 — Implement** the build, `main.tsx`, `app.tsx`, the router, the layout with the scope bar, `client.ts`, `explain.ts`, `ErrorPanel`, `StateBadge`, the base components and `styles.css`. **Step 7 — Run:** PASS; `pnpm run check`. **Commit** `feat(web): the shell, the contract client and one error table`. Decision records D-58 and D-59. Push; open the **draft** pull request `Session 7: owner web workspace`; see that CI ran `check` and `secret-scan` only.

**Registry:** FR-1.89 → `SPIKE_PASS` after Run 7.9 (every action needs its screen first). **Done when:** both tasks are green and the draft pull request shows a 2-minute CI run.

---

## Run 7.2 — Sign-in and security screens (D08-S33)

Screens: sign-in, the TOTP step (with "use a recovery code"), enrolment (the key, activation, the ten recovery codes shown once with "I saved them"), reset completion from the fragment (P-137), and `/account`: the session list with revoke, password change (behind fresh TOTP: a 403 `fresh_verification_required` opens the step-up dialog, then the page sends the change again **once**, by the owner's click), recovery-code regeneration. All of it through `apps/web/src/api/auth.ts`, whose every function names one path of `docs/auth-route-contract.md`.

- [ ] **Step 1 — Failing browser test** `auth.test.ts` (users of the tenants fixture; codes from `credentials(user).seed`):
  - `password, then TOTP, lands on the overview; the address bar never held the password or the code`;
  - `a password-only session cannot render any workspace route`: with a `password_verified` cookie, each pattern of `WEB_ROUTES` shows the TOTP step, and the API calls behind them answered `mfa_incomplete` (Doc 10's "Done when");
  - `a wrong password and an unknown address show the same text`;
  - `enrolment shows the key and the recovery codes once: after "I saved them", back and forward do not show them again, and they are in no storage`;
  - `a reset link's fragment is gone from the address bar and the history before the form is shown; completing it leads to enrolment`;
  - `the session list shows this session as current; revoking another session removes it; revoking the current one signs out`;
  - `a password change asks for a fresh code, then succeeds, and says how many other sessions ended`;
  - `sign-out clears the page: the back button shows the sign-in screen, not the overview`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `check`. **Commit** `feat(web): sign-in, enrolment, reset and the account screens`. Push.

**Done when:** the eight tests are green.

---

## Run 7.3 — Overview and resources (D08-S33, S39)

**Contract commit** `contract: overview` (P-139). Screens: the overview (projects with their environments, state badges, key counts with "from the index, as of <time>", "not available" for `null`), the project screen; create and rename of projects and environments; archive and reactivate behind a confirmation dialog whose text is fixed and names the resource, the number of active credentials that will be revoked and any unfinished issuance (from `credentials.list` and `operations.list`; FR-1.17), and which needs the resource's name typed. A resource that is `pending`, `revoking`, `archived` or `needs_review` shows its state and the review reason and offers only the actions the state allows. The carried `driveArchive` fix: the 503 carries the operation id.

- [ ] **Step 1 — Failing tests.**
  - `tests/integration/overview/overview.test.ts`: `owner and admin get the organization's projects and environments with counts equal to a direct count of app.secret_index; a member gets 403 action_denied; ownerB gets the hidden 404`; `an environment in needs_review has keys null`; `nothing of organization B is in the answer`.
  - `tests/integration/lifecycle` (the existing file of the archive route): `a driveArchive throw answers 503 with the operation id`.
  - `resources.test.ts` (browser): `create a project, then an environment: the environment is shown pending until the server says active, never before`; `rename`; `archive asks for the typed name and lists one active credential; after it the environment is archived, its secrets screen offers no write, and reactivate brings it back`; `a needs_review project shows its reason and no create button`; `one overview load makes at most 4 API requests, and an idle minute makes none` (Review focus 5; the minute is `page.clock`).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** (`repos/overview.ts`, the handler, the screens). **Step 4 — Run:** PASS; `pnpm run contracts:openapi`; `check`. **Commit** `feat: the overview route and the resource screens`. Push.

**Registry:** FR-1.90, AC-1.46 → `SPIKE_PASS` (run note). **Done when:** the three files are green.

---

## Run 7.4 — Secrets: list, edit, reveal (D08-S34)

**Produces** `callSecret`, `SECRET_BEARING`, `useEphemeral` (P-138). Screens: the name list with prefix search and "more" (the cursor; `listing_changed` reloads the list from the start and says so), create, edit (sends `expectedVersion` and `expectedStateTag` of the row the form was opened on; a conflict offers reload or cancel and nothing else), masked values with an explicit Reveal that shows a countdown, and an explicit Copy with the clipboard warning. Decision record D-60.

- [ ] **Step 1 — Failing tests.**
  - `ephemeral.test.ts` (the reducer): `set then 30,000 ms clears`; `hide, route change, sign-out and unmount each clear at once`; `a second set restarts the timer`. `sources.test.ts` gains: `no route of SECRET_BEARING is called through useQuery or useMutation`.
  - `secrets.test.ts` (browser, real OpenBao; values are run-time canaries):
    - `create a secret, then the list shows its name and version 1 and no value anywhere in the page`;
    - `reveal shows the value; after 30 s (page.clock) it is gone from the DOM`;
    - `reveal, then hide the tab: gone`; `reveal, then navigate to the list: gone, and back does not bring it back`; `reveal, then sign out: gone` — the four forgetting tests;
    - `copy puts the value on the clipboard and shows the warning` (clipboard permission granted to the context);
    - `two tabs edit the same secret: the second save shows the conflict with reload and cancel, and no third choice; after reload the form holds the new version and an empty value`;
    - `a name that breaks the rule and a value over 65,536 bytes are refused in the form with the field's own message, and the server's 422 is shown the same way`;
    - `507 capacity_exceeded and 503 busy on a write show their texts and leave the form's value in place for the owner` (seeded by the harness's capacity mode and a held capture).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `check`. **Commit** `feat(web): secrets — list, edit and a reveal that forgets`. Push.

**Registry:** FR-1.22, FR-1.23 → `SPIKE_PASS`. **Covers:** Review focus 1 (first half). **Done when:** both files are green.

---

## Run 7.5 — History, delete, undelete, restore (D08-S34)

The secret's screen: version history (time, action, the actor as the server gives it — `unknown` is shown as "unknown", never as a guess or a blank), delete and undelete behind the fixed confirmation, restore of an old version as a **new** version behind a confirmation that names both numbers, reveal of a historical version through the same hook. `key_under_review` shows its text and no write button.

- [ ] **Step 1 — Failing browser test** `history.test.ts`:
  - `three writes show three versions, newest first, each with its author`;
  - `a history row whose actor is unknown says "unknown"` (the row seeded as Session 4's fixtures do);
  - `delete asks for confirmation; the list then shows the name as deleted and offers undelete; undelete brings it back at the next version`;
  - `restore version 1 creates version N+1 with version 1's value (compared by revealing both), and the history says "restored from 1"`;
  - `a stale restore (the secret changed in another tab) shows the conflict with reload and cancel`;
  - `a key under review shows its state and offers no write`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `check`. **Commit** `feat(web): history, delete, undelete and restore`. Push.

**Done when:** the six tests are green.

---

## Run 7.6 — Import, export, first-run guide (D08-S35)

**Import:** choose a file or paste; the bytes stay in component memory (never in the query cache, cleared on leave); preview with the server's classification per key and its warnings; apply with the same bytes and one idempotency key; per-entry progress from the operation; `partial` shows which keys were written and which were not, never a tick for the whole; an operation in `awaiting_input` offers Resume, which needs the same file chosen again (the page does not keep it) and says so. A file over 1 MiB is refused in the form with the limit named. **Export:** behind fresh TOTP (the step-up dialog of Run 7.2) and a confirmation; the page reads the whole answer, checks that the byte count equals `content-length` and that the body ends as the export format says a complete file ends (read `apps/api/src/routes/export.ts` and `dotenv-format-v1.md` for the marker the CLI already checks), and only then offers it through a `blob:` URL that is revoked after the click; a short or cut body is "incomplete — nothing was saved". The warning that the file now lives outside the product is fixed text. **First-run guide** at `/help`: from an empty workspace to a launched fixture app in six steps, each a link to the screen or the runbook (`consumer-local.md`, `machine-credentials.md`), plus links to `/v1/reference` and `known-limits.md`'s text; synthetic placeholders only.

- [ ] **Step 1 — Failing browser test** `import-export.test.ts`:
  - `a 12-key file previews as 8 new, 2 changed, 1 unchanged and 1 invalid, and apply writes exactly the ten`;
  - `an import that ends partial lists the written and the unwritten keys and shows the state partial` (an entry made to conflict by a write between preview and apply);
  - `an import waiting for input offers resume, and resume with the same file finishes it; with another file the server's refusal is shown`;
  - `after leaving the import screen its bytes are in no storage and not in the DOM`;
  - `export asks for a fresh code and a confirmation; the downloaded file's digest equals the digest of the same set read through the API`;
  - `a cut export answer (aborted in Playwright after the headers) saves nothing and says incomplete`;
  - `the guide's six steps link only to paths of WEB_ROUTES, /v1/reference and files that exist`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `check`. **Commit** `feat(web): import, export and the first-run guide`. Push.

**Done when:** the seven tests are green.

---

## Run 7.7 — Machine credentials (D08-S36)

**Contract commit** `contract: credentials summary` (P-139). The environment's credentials screen: the inventory (name, scope, state badge, issued by, effective expiry, "last used" only when the server has one, else "not known"), the 7-day warning as text on the row; Issue behind fresh TOTP with a name and a lifetime (default and maximum 30 days); the **one-time token panel**: shown once from the 201 through the forgetting hook with a longer life of 120 seconds and a visible countdown, with Copy, with the sentence that it cannot be shown again, and gone on hide, navigation and sign-out like every secret; `credential_not_replayable` explained ("the token of this request was already delivered or lost — revoke it and issue a new one"); Revoke behind the fixed confirmation; `needs_review` and `revoking` rows say that an operator settles them and offer no "issue again" on the row; a fixed help text: replace, do not renew; after a restore every token is revoked and each consumer needs a new one. The organization's summary (by state, the expiring list) sits on the overview.

- [ ] **Step 1 — Failing tests.**
  - `tests/integration/credentials/summary.test.ts`: `byState equals a direct count per derived state; expiring holds only active credentials within 7 days, soonest first; a member gets 403; nothing of organization B`; `no field of the answer is an accessor or a token`.
  - `credentials.test.ts` (browser, real OpenBao): `issue asks for a fresh code, shows the token once, and the token works against machine.keys`; `after navigating away and back the token is not in the page, the history state or any storage`; `the same request replayed (the harness sends the same key) shows credential_not_replayable with its explanation`; `revoke asks for confirmation, the row becomes revoked, and the token is refused by machine.keys`; `a credential within 7 days of expiry carries the warning text; one with no known last use says "not known"`; `a needs_review row offers no issue button`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `contracts:openapi`; `check`. **Commit** `feat: the credentials summary and the credentials screens`. Push.

**Registry:** FR-1.91, AC-1.47 → `SPIKE_PASS`. **Done when:** both files are green.

---

## Run 7.8 — Operations, activity and the summary (D08-S39)

**Contract commit** `contract: metrics` (P-139); the pending snapshot is empty after it. Screens: the environment's operations (state badge for each of the seven states, the operation id, "mine", a detail panel that polls by P-140); the organization's activity timeline from `activity.list` (time, action, actor kind, target by its current name, outcome, the linked operation's **current** state, the request id; grouped in the page by `operation.id`; filters by project and environment; "more" by cursor); the audit view from `audit.list` with its filters as form fields (an owner's tool: a plain table); and the summary of P-142 on the overview — three tables, each with source, window and observation time, with "not measured" for a `null` day and `0` only for a counted zero. An `uncertain` or `awaiting_input` operation and a `needs_review` state show the operator sentence with the runbook's name; nothing on these screens can start a reconciliation.

- [ ] **Step 1 — Failing tests.**
  - `tests/integration/metrics/metrics.test.ts`: `counts per day equal a direct query over the rows activity.list serves`; `days before the organization's first row have counts null, a later day without events has zeros`; `days 31 → 422; a member → 403; organization B's events are counted nowhere`; `operations.unresolved equals the direct count`.
  - `activity.test.ts` (browser). The three states of Doc 10's "Done when" are **seeded**: first try the existing fixtures and fault hooks (`secrets-fixture`, `credentials-fixture`, `faults`); a state they cannot produce within the run's box is written into the test database as the superuser, and the run note says which — the screen under test only reads it. Tests: `a delayed write is shown executing, then succeeded, without a reload`; `an unknown issuance is shown as needs_review with the operator sentence and no retry`; `an interrupted import is shown awaiting_input with resume`; `an uncertain operation is never labelled failed: its badge, its panel and its timeline row all say uncertain`; `the summary shows "not measured" for the days before the first event and 0 for an empty later day`; `as editorA the activity, audit and summary screens show the denial text, and the API answered 403`; `the audit filters produce the request the form describes, and a reused cursor's listing_changed reloads from the start`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `contracts:openapi`; `check`. **Commit** `feat: the metrics route, the timeline and the summary`. Push. Decision records D-61 and D-62.

**Registry:** FR-1.92, FR-1.94, AC-1.48, AC-1.55 → `SPIKE_PASS`. **Covers:** Review focus 4. **Done when:** both files are green.

---

## Run 7.9 — Errors, keyboard, narrow screen, browser security (D08-S37)

Most of this run is proof of what Runs 7.1–7.8 built, and repair of what the proof finds. The error table is complete since Run 7.1; here every screen is walked once for a failure that still shows a raw code or nothing. "One presentation across UI, API and CLI" (Doc 10) means the same parts in the same order: what happened, the safe next step, the request id and the operation id. Read how the CLI prints an API error (`apps/cli/src`; it has no table per code today) and write the difference, if one is left, as one line of the report — the CLI is not changed in this session. Focus: every dialog traps focus and returns it; every form field has a label and its error is tied to it (`aria-describedby`); every action is reachable by Tab in reading order; a visible focus ring. Narrow: at 360 px no screen scrolls sideways, and tables fall to stacked rows.

- [ ] **Step 1 — Failing tests.**
  - `tests/integration/browser-security/origin.test.ts` (first read what Runs 3.7 and 3.10 already prove and extend that file instead if it covers the same ground): `for every route of ROUTES that is not GET and not machine, and for every path of servedAuthRoutes() that is not GET: a foreign Origin, a null Origin and no Origin each answer 403 origin_rejected and change nothing`; `sec-fetch-site: cross-site with the right Origin is refused`; `the shell and its assets carry the headers of P-141`; `no GET of ROUTES changes a row` (the journey's row counts before and after a pass over every GET route).
  - `access.test.ts` (browser): `keyboard only: sign in, create a secret, reveal it, issue a token and revoke it without the mouse`; `at 360 by 740 the overview, the secrets list, a secret, the credentials and the activity screens have no sideways scroll`; `the page cannot be framed: a page of another origin that embeds it gets nothing`; `every state badge on the overview has text, with colours switched off (forced-colors)`; `each of the nine failure classes of FR-1.93 — hidden or absent, a state conflict, an expired session, fresh verification, a version conflict, review, backend sealed, audit unavailable, capacity — shows its own text and never the raw code alone` (seeded through the harness, one at a time).
- [ ] **Step 2 — Run:** FAIL where something is missing. **Step 3 — Repair.** **Step 4 — Run:** PASS; `check`. `docs/runbooks/workspace.md` and the lines for `known-limits.md` (no QR code; a closed host answers JSON, not a page; the clipboard and a saved export are outside the product; clearing JavaScript state is not zeroization). **Commit** `feat(web): errors, keyboard, narrow layout and the origin proof`. Push.

**Registry:** FR-1.76, FR-1.89, FR-1.93, FR-1.96, AC-1.29, AC-1.34, AC-1.51, PO-12 → `SPIKE_PASS`. **Done when:** both files are green.

---

## Run 7.10 — Journey, canary scan and the session gate

### Task A — the two last files

- [ ] **Step 1 — `journey.test.ts`:** one owner, one browser context, from the sign-in form to a revoked token: sign in with password and TOTP, create a project and an environment, create three secrets, edit one, reveal one, delete and undelete one, import a file, export, issue a token, read the keys with it through `machine.keys`, revoke it, read the activity, sign out. One test; every step asserts what the server then says, not what the page shows.
- [ ] **Step 2 — `canary.test.ts`:** the same journey with run-time canaries as every secret value, the password, every TOTP code used, the recovery codes, the reset token and the machine token (assembled at run time; never a literal in the file). Afterwards, in the still-open context and again after sign-out, none of them is in: `localStorage`, `sessionStorage`, the names and contents of every IndexedDB database, Cache Storage, `document.cookie`, `history.state` of every entry visited, any URL the context requested or showed, the DOM, or the page's console output. **Control:** a canary the test itself puts into `sessionStorage` and into a URL is found by the same scan. **Run:** both green. **Commit** `test(web): the owner journey and the canary scan`. Push.

### Task B — the gate (once; "How this session is tested")

- [ ] **Step 1 — Start CI and the dated items.** Mark the pull request ready (`gh pr ready`): `check`, the scans, both integration shards and `browser` start. Do not wait: read the dates (KMS 12 Dec, Trivy 14 Dec, `pair-30-day` 17 Dec), `gh run list --workflow probe-watch --limit 1`, and go on with Step 2. Failures of the full run are diagnosed (`superpowers:systematic-debugging`), fixed with a failing test first, rerun locally by file, and pushed once.
- [ ] **Step 2 — The fresh-context review.** One reviewer on the most capable model, given `git diff main...session-7` and these questions and none of this plan's reasoning: (1) can any value, token, code or reset token reach a storage, a URL, the history, the query cache or a log of the page; (2) is any screen or button deciding authority that the server does not check; (3) is any uncertain, partial or pending state shown as done or as failed, or offered for retry; (4) can the shell mount serve a file outside its manifest or answer where a 404 was expected; (5) do the three new routes count or return anything of another organization, or anything a member could not list; (6) does any cookie-authenticated change succeed without the exact Origin; (7) is anything under the content policy weaker than P-141 says. Findings are graded by you; Critical and Important are fixed now, with a failing test first; Minor goes to Session 8 with its line in the report.
- [ ] **Step 3 — One release, one deploy.** In the clean clone: `host-v0.7.0` from the session's head (`deploy.md`), published with `--target session-7`; `host.ts staging deploy --release …` through the closed gate; `status` and `probe.ts state staging` clean. This also brings PR #17's fix to staging.
- [ ] **Step 4 — Staging, one file at a time.** First `workspace.staging.test.ts` (new, written here: Chromium against staging's public name as the staging owner, with its own project and environment and synthetic values: the journey's core — sign in, a secret written and revealed, a token issued, used and revoked — and everything undone in `finally`): the session's demonstration of Doc 10 §4.5. Then the files that cover what the session changed: `api`, `status`, `audit`. Then the files left by Session 6's gate: `boundary`, `transport`, `identity`, `export`, `cli`, `key-loss`, `probe`; then `pnpm run test:consumers`. A file that is stale against Sessions 6 and 7 is repaired as a test (the pattern of Session 6's Step 4); a product defect is fixed with a failing integration test and reaches staging as `host-v0.7.1`. Restore committed evidence files a staging run rewrote.
- [ ] **Step 5 — Registry and documents.** `pnpm run evidence:build`; `check`. `docs/evidence/session-7/report.md`: the result, the suite table (what ran where, and the one line on `test:cloud` and `test:cli`), the review's findings, deviations, open issues with owner runs, the time each run took against its box (the owner asked for a faster session: the report says whether it was), and "What Sessions 8 and 9 must know". `CLAUDE.md`: "Where we stand", the commands (`web:build`, the two-weight CI), what was learned.
- [ ] **Step 6 — The owner message:** what works in the browser now, with staging's address; what failed; the valve taken; what Session 8 inherits; and the two things asked: "merge", and OWN-4 if still open.

## Session 7 end state

- The owner does every task of FR-1.89 in a browser on staging; the journey and the canary scan are green locally and on CI; the staging demonstration is green.
- `ROUTES` has no pending body. `apps/web` is a built application inside the API image, served on a path table.
- Registry: FR-1.22, 1.23, 1.76, 1.89–1.94, 1.96; AC-1.29, 1.34, 1.46, 1.47, 1.48, 1.51, 1.55; PO-12 at `SPIKE_PASS`. Nothing `PASS`.
- Staging runs `host-v0.7.x` with the gate open. Production is unchanged (closed, `host-v0.6.3`).
- CI has two weights, and the report says what the session's testing cost in hours.
