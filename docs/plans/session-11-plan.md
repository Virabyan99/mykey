# MyKey Stage 1 — Session 11 (Automation access and long-lived runtime credentials) Execution Plan

> **For the executing agent:** carry this plan out run by run, in the order given in "Run order". If you have the superpowers skills, use `superpowers:executing-plans`: the owner's standing preference is inline execution by one agent, not subagents. Steps use checkbox (`- [ ]`) syntax for tracking. You do not re-decide anything in the "Planner decisions" table below. If one proves wrong, write a one-paragraph decision record and continue (Doc 10 §1). **Read "The owner's decisions" and "How this session is tested" before anything else.** Do not add a suite run, a release, a deploy or a review that this plan does not name.

**This session is not one of Doc 10's nine, and it is not on D-74's hardening list.** It is a change of direction the owner asked for on 25 Nov 2026: MyKey gains two non-human principals and one metadata route. Doc 10 §4 (the rules for every session) and CLAUDE.md bind it as they bound Sessions 1 to 10. Gate F is **not** decided here: that is W-2, on 20 Dec 2026.

**Goal:** by the end of the session, five things are true on staging:

- **A runtime credential** exists beside today's 30-day token. Its client secret is shown once, lives up to 365 days, and is exchanged for a 15-minute read token that the unchanged `machine.keys` and `machine.resolve` accept. The `secrets` CLI (`cli-v0.2.0`) takes either kind from the same place.
- **An automation credential** exists. The owner issues it with a fresh TOTP, with chosen rights and bound addresses. With it alone a script makes a project and an environment, writes secrets create-only and issues runtime credentials. It can never read a value and never sees a project it does not manage.
- **`machine.metadata`** gives a machine each name's version and times, never a value.
- **After a restore** both new kinds are revoked, and one new automation credential issued with `replaces` brings every consumer back.
- **Everything that existed keeps working unchanged:** today's token, `cli-v0.1.2`, every route body the CLI reads, every runbook path.

**What is not in this session** (the spec's §5, plus the cuts of decision 7): updating an existing secret by automation; assigning an existing project to an automation credential; a staging restore drill of the new kinds; production. Each has a line in "Carried items".

**Architecture:** one design choice makes the session small. **Both new secrets are random strings whose keyed digest (a verifier) is stored in PostgreSQL, and nothing new is created in OpenBao** (decision 5, P-185).

1. **Runtime credential.** A row of `app.machine_credential` with `kind = 'runtime'`, a verifier and no accessor. Issuing and revoking it is one PostgreSQL transaction: no backend request, so no uncertain issuance.
2. **Exchange.** `POST /v1/machine/exchange` checks the client secret against the verifier, then mints a token with the call the product already uses for 30-day tokens (`tokenCreateFromRole` on `machine-env-<eid>`, through the issuer), at 900 seconds, with `meta.credential_id`. The token is then an ordinary machine token.
3. **Machine requests.** `authenticateMachine` finds the catalog row by accessor as today, or, for a runtime credential, by the token's `meta.credential_id`. Everything after that is D-42 unchanged.
4. **Automation credential.** A row of a new table, with rights, bound addresses and a verifier. A new auth class `automation` authenticates it, and its routes call the same protocols the human routes call (`runSecretAction`, the resource `mutate`), with a machine actor instead of a user.
5. **One contract commit, one migration, one release** (`host-v0.10.0` and `cli-v0.2.0`), staging only.

**Tech stack:** everything pinned in Sessions 1 to 10. No new dependency. CIDR matching is Node's own `net.BlockList`.

**Spec:**

- `docs/mykey-automation-credential-spec.md` (the input specification; "the spec" below) and `docs/mykey-session-11-planning-prompt.md`.
- `docs/doc_10_mykey_stage_1_compressed_implementation_plan_v1.0.md` §4.1 (eleven rules never traded for speed), §4.2, §4.3 to §4.6.
- Decisions: D-15 (route freeze), D-17 (identities, the hostile-API section), D-31, D-34, D-36, D-38, D-40, D-42, D-43, D-44, D-46, D-49, D-55, D-58, D-60, D-68, D-69, D-70, D-74, D-76, D-79.
- Runbooks: `known-limits.md`, `machine-credentials.md`, `consumer-local.md`, `consumer-deploy.md`, `restore.md`, `limits.md`, `credential-custody.md`, `deploy.md`, `production.md`; `docs/agents/connect-an-application.md`.

**Facts used here** were read from the repository on 25 Nov 2026 at `472cda4`. Nothing was executed. When the executor's reading differs, the observation wins and goes into the run note. Facts 1 to 20 are also the **planner findings**: every place where the spec and the tree disagree (the tree wins).

1. **This work is excluded from Stage 1 as Stage 1 is written.** Doc 10 §4.2 and Doc 04 FR-1.39 say a machine token is "default and maximum 30 days, non-renewable". Doc 02's Stage 1 exclusions name "autonomous credential mutation/delegation". So the session needs the owner's amendment (decision 1, D-80). No `docs/doc_*.md` file is edited: the record amends them.
2. **The spec's recommended design (one AppRole per credential) needs an identity that writes AppRole roles.** D-17 already records that an identity which writes roles holds, with the issuer, "every right inside the namespace". It also meets a known limit: about 15 minutes of failed AppRole logins lock a role out, so anyone who knows a credential's id could stop its exchanges. Neither was measured for this plan. The verifier design needs neither, and adds no OpenBao identity, policy or right.
3. **The issuer already mints with a TTL and with `meta`.** `OpenBaoClient.tokenCreateFromRole(role, ttlSeconds, correlation, meta?)` (`packages/openbao/src/client.ts:517`), and today's issuance already writes `meta.credential_id` and `meta.operation_id` (`reconcile/credentials.ts` reads them). The token role `machine-env-<eid>` is orphan, not renewable, no default policy, `token_explicit_max_ttl` 30 days (`policies.ts`). `infra/openbao/policies/issuer.hcl` allows `update` on `auth/token/create/machine-env-*`.
4. **D-42's catalog step reads by accessor** (`apps/api/src/pipeline/machine.ts:166`). An exchanged token has no row of its own. `tokenLookupSelf()` returns `TokenInfo.meta`.
5. **`reconcile-credentials` revokes every machine-policy token whose accessor no active row names** (step 2, "tokens nobody records"). Unchanged, it would revoke live exchanged tokens.
6. **`restore-invalidate` revokes every `machine_credential` row** (`apps/ops/src/commands/restore-invalidate.ts:116`), and `restore-verify` counts them (`:156`). A runtime credential in that table is covered without a change. With verifiers the restore's window gains no per-environment step: the spec's "re-measure" has nothing new to measure in OpenBao.
7. **The spec's §6 item 10 has no subject.** No issuance of a new kind sends anything to OpenBao, so the D-78 trigger has nothing to catch and nothing can block the next issuance. The one backend call is the exchange's mint, and Run 11.3 places a fault there instead.
8. **`projects.create` already makes the environment `development`** and answers `{projectId, developmentEnvironmentId}` (`apps/api/src/routes/resources.ts:131`). Project and environment creation is one PostgreSQL transaction; the provisioner builds the scope afterwards, and `kvReady` says when.
9. **A human update carries the expected version and the state tag** (`expectedVersion`, `expectedStateTag`; rule 7). The spec names the version only. Update is deferred (decision 4).
10. **The secret index holds no creation time** (`app.secret_index`: `current_version`, `last_changed_at`). `createdAt` is the time of the name's `create` row in `app.secret_version_event`, and `null` when there is none (rule 11).
11. **A secret's history cannot name a machine.** `secret_version_event_actor_kind_check` allows `user`, `operator`, `system`, `unknown`, and so does `historyActor` in `routes.ts`. A secret created by automation would fail the history route's output check.
12. **The token step's block already takes a client secret.** D-76's block stores one string of `[A-Za-z0-9._-]`, which is the shape chosen here. No second one-command form is written, and the block stays byte for byte (the spec's §2.4 asked for a new one).
13. **During the nightly capture (03:00 UTC) every non-GET route outside `CAPTURE_OPEN_ROUTES` answers `503 busy`** (`packages/contracts/src/capacity.ts`). `machine.resolve` is in the set. An exchange that is not would stop every server that restarts then.
14. **One read at a time per credential** (P-114, `exclusive: machine.credentialId`). Replicas that share one runtime credential meet `busy`, which the CLI answers by waiting (`BUSY_PAUSES_MS`).
15. **`principal_kind` already allows `machine`** (`operation_principal_kind_check`), and the audit actor kinds already hold `machine`. No new principal or actor kind is needed.
16. **The pipeline is typed around a user.** `SecretRequest.userId`, `intentOf(route, params, principal: UserPrincipal, body)`, `recheckOf(ctx, userId, scope)`, and `mutate` in `resources.ts` all name a user (D-42: "every human helper takes `UserPrincipal`").
17. **Key rings were made once per host** (`KEY_RINGS`, `host.ts <host> keys init`: "so later runs never touch custody again"), and the API refuses to start without a ring it expects. `resetVerifier` is a keyed-verifier ring.
18. **The registry holds Doc 04's ids only** (102 FR, 60 AC, 29 proofs). The spec's 14 acceptance items are not registry rows.
19. **The CLI names its token once:** `readToken` (`apps/cli/src/token.ts`) gives a string to `client.keys` or `client.resolve`. `categoryOf` maps 401, 403 and 404 to `denied` (exit 77). `apps/cli/package.json` says 0.1.2, and `cli-v0.1.2` is named in both consumer runbooks, `start-here.md`, the agent guide, `tools/agent-runner/` and the consumer fixtures.
20. **CLAUDE.md's dated list says "the next session moves the postgres pin"** (CVE-2026-124851 and the zlib and krb5 entries; `.trivyignore.images` expires on 14 Dec 2026). It is a runtime image change that goes to production with the owner's journey (D-69).
21. `docs/plans/` is not formatted by Prettier; every other Markdown file this session writes is.

---

## The owner's decisions (asked at the session start, before any run is fixed)

The plan is written on the recommendation of each. **Each is pending the owner's word.** "If otherwise" says which runs change.

| # | Question | Options and what each costs | Recommended | If otherwise |
| --- | --- | --- | --- | --- |
| 1 | **Where does this work sit?** | **(a) After W-2:** nothing changes before 20 Dec; the work waits four weeks. **(b) Now, as a Stage 1 amendment, on staging only; production after W-2:** costs Gate F's evidence nothing, because production keeps the release line it is observed on. It costs one thing: a production fix before W-2 is cut from the `host-v0.9.x` line, not from `main`. **(c) The first session of a re-scoped next stage:** needs Doc 09 replaced first, which is a planning job of its own. | **(b)** | (a): the session starts on 21 Dec, unchanged. (c): stop; a stage plan comes first. |
| 2 | **The runtime credential's longest lifetime.** | **365 days** (default and maximum), with the 7-day expiry warning: a yearly rotation that is rehearsed. **No expiry:** nobody ever rotates, and a leaked secret works until someone notices. | **365 days** | "No expiry": `expires_at` becomes nullable; Run 11.2 Task B and Run 11.3 Task A change, and the warning path gets a "never" case. |
| 3 | **The automation credential's lifetime, and bound addresses.** | Lifetime **1 hour to 365 days, default 7 days**. Addresses **mandatory**: 1 to 8 CIDRs, a `/0` refused. Mandatory costs a platform with changing addresses a wide range. Optional leaves a provisioning secret usable from anywhere. | **As stated, mandatory** | Optional: the body's minimum becomes 0; Run 11.2 Task A and one test of Run 11.5 change. |
| 4 | **Automation updates an existing secret (`secrets.update`) now, or later?** | **Later:** rotation by automation (use case U3) waits. **Now:** one more route and right, and the secret list must also serve the state tag (fact 9). About one hour. | **Later** | Now: Run 11.2 gains a route (58 in all), Run 11.5 a handler and three tests. |
| 5 | **Where the credential material lives.** | **Verifiers in PostgreSQL:** nothing new in OpenBao, no new identity, issuing is one transaction, the restore gains no step. The cost: a client secret is checked by the API, not by OpenBao. **AppRole secret ids (the spec's recommendation):** OpenBao checks the secret itself. The cost: a new identity that writes roles, four OpenBao measurements, the lockout (fact 2), D-40's uncertain states for both kinds, and a restore step per credential. About a day more. | **Verifiers** | AppRole: this plan does not fit; Runs 11.2 to 11.5 are planned again. |
| 6 | **Does production get this in the session?** | **No:** production moves only for the postgres pin (question 8). It gets `host-v0.10.x` after W-2, by `production.md`, as a dated item. **Yes:** one more owner journey now, and Gate F's 28 days are then of two different products. | **No** | Yes: Run 11.8 gains Session 10's Run 10.5 Task D, after the freeze. |
| 7 | **Four cuts that keep the session to about two days.** | (i) `secrets.update` (question 4). (ii) Assigning an existing project to an automation credential: it manages only what it creates, or what a credential it replaces managed. (iii) A staging restore drill of the new kinds: the restore is proven in the integration suite on real stores; the next real re-drill carries it. (iv) IPv6 and IPv4 sources are both bound, but the workspace checks a CIDR only when the server answers. | **All four** | Each "no" adds its work back: (ii) one route and one control on the project page, about an hour; (iii) Session 10's Run 10.6, about half a day and an owner block. |
| 8 | **The postgres pin (fact 20): in this session, first, as `host-v0.9.3`?** | **Yes:** about 90 minutes of the agent's, 10 minutes of yours (production's journey), and the dated item is closed before the product changes. **No:** it needs a session of its own before 14 Dec. | **Yes** | No: Run 11.1 does not run, and CLAUDE.md keeps the date. |

---

## How this session is tested (D-58's cadence, kept)

| When | What runs | Cost |
| --- | --- | --- |
| Inside every run | `pnpm run check`; the unit, integration, cli or browser files the run adds or changes, by file; any existing file that exercises what the run touched (each run names them). A browser file runs alone. `pnpm run test:cli` is the only way to run a `tests/cli` file on Windows. | minutes |
| After a run's last commit | `git push`. The draft pull request runs `check` and the secret scan (about 2 min). Do not wait for it. Read it before the next run's first commit (`gh run list --branch session-11 --limit 1`). | unattended |
| Once, at the freeze (Run 11.8) | Full CI by hand; the one fresh-context review; the claims walk; `host-v0.10.0` and `cli-v0.2.0`; `cli-matrix`; staging; the staging files named there, one at a time; `test:consumers`. | about 4 h, mostly unattended |
| At the gate (Run 11.9) | `gh pr ready`, which runs the full suite at the head; the manifest. A second review only of code that changed after the freeze. | 20 min unattended |

The rules that follow:

- **No full suite and no product release before the freeze** (`host-v0.9.3` of Run 11.1 is the pin alone and has its own short path). One fix release (`host-v0.10.1`) is allowed for what the freeze or staging finds. A second stops the session and goes to the owner.
- **A run's tests are the ones this plan names.** Ideas for more go into the run note under `Open issues`.
- **Test first.** Every denial is paired with a success in the same test file, and every "nothing leaked" with a control that is found.
- **Mocks prove nothing about the two stores.** Every test of issuance, exchange, a machine request or a restore runs on real PostgreSQL and real OpenBao (`tests/harness/stack.ts`).
- **Run notes are short:** the five headings of Run 1.1's template, ten to twenty lines, with the test counts, the commit ids and the run's **real time**.
- **A staging file that rewrites committed evidence** of an earlier run is restored before the commit (`git checkout -- <file>`).

---

## Global constraints

Every run's requirements include this section and the "Global constraints" of the plans of Sessions 1 to 10.

- **Doc 10 §4.1, all eleven rules.** The ones this session can break:
  - **Rule 1.** No value and no token in PostgreSQL. A verifier is an HMAC of 256 random bits: it is neither, and it cannot be turned into one. The client secret, the automation secret and the exchanged token are never stored.
  - **Rule 2.** The three new secrets never reach a log line, an operation's `result`, an audit row's `details`, an error, a URL, browser storage, an evidence file, Git or this conversation. They are named `clientSecret`, `secret` and `token` in code and nowhere else.
  - **Rule 3.** Every automation mutation is an operation with an `Idempotency-Key`. `uncertain` is resolved by reading the operation, never by sending again.
  - **Rule 5.** State, expiry, rights, the managed project and the bound addresses are read from current rows on every request, and again inside the admission transaction. A project the caller does not manage answers the same `404 not_found` bytes as an absent id.
  - **Rule 6.** `automation_credentials.issue` and `runtime_credentials.issue` are `human_fresh_totp`.
  - **Rule 8.** The exchange's audit row is committed before the token leaves.
  - **Rule 9.** A restore revokes every row of both new kinds.
  - **Rule 11.** A creation time that cannot be read is `null`, and a last use never recorded is `null`: the workspace prints "unknown" and "never", and no screen or body invents a time.
- **What does not change, byte for byte:** the bodies of `machine.keys` and `machine.resolve`; `cli-v0.1.2` and its release files; the token block of `consumer-local.md` §8 (D-76); `infra/openbao/policies/*.hcl`; the authority matrix's snapshot (`tests/unit/openbao/__snapshots__`). A run that needs to touch one of them stops and reports.
- **Additive only on existing bodies.** `credentialView` gains `kind`, `issuedByKind` and `boundCidrs`; a project's row gains `managedBy`; `historyActor.kind` gains `machine`. Nothing is removed or renamed. **No error code is added.**
- **Not allowed** (Doc 10 §4.2, the spec's §5): a new dependency, OpenBao Agent, a second queue, Redis, a folder or path inside an environment, a second organization per host, workload-identity federation, any read of a value by automation, delete, undelete, restore or archive by automation.
- **Production** changes only by Run 11.1 Task C's three commands, with the owner's yes to question 8. Its ids, names and the owner's address never go into Git, a prompt or an evidence file.
- **The public repository.** Synthetic data only. Fixtures are generic: a "tenant provisioner" script and the existing sample server. Never a literal canary. A caller's source address is never written to an evidence file: the note says "bound to the caller's /32".
- **The workspace's rules do not move** (D-59, D-60, D-70; `tests/unit/web/sources.test.ts`): no storage, no `style` attribute, every text from the catalogue, a secret only through `callSecret` and `useEphemeral`, no secret ever filled into a command.
- **The workstation:** one heavy job at a time. Long or quoted text is written with the editor tools, never through the shell. `MSYS_NO_PATHCONV=1` before `host.ts` commands with remote paths.
- **Git:** branch `session-11`, never `main`. The draft pull request exists already (opened by the planner). It is merged only when the owner says so.
- **Every run ends with** `pnpm run check` green, the run's tests green, a commit, a push and a run note `docs/evidence/session-11/run-11.N.md`.

## Review focus

Seven conditions the spec implies and does not spell out, most likely to bite first. Each has a test pinned in the run named.

1. **Code that assumes every credential row has an accessor.** Archive, reactivation, the credential sweep, `reconcile-credentials`, `restore-verify` and the summary were all written when a row without an accessor meant "unfinished". A runtime row has none for its whole life. → Run 11.3 Task A: an environment that holds an active runtime credential is archived, swept, reconciled and summarised, test first.
2. **A secret on a forbidden surface by replay or by log.** A replayed issuance must answer `credential_not_replayable`, never the secret again; the operation's `result` must hold ids only. → Run 11.3 Task A, Run 11.5 Task A, and the surfaces sweep of Run 11.3 Task D.
3. **An exchange that fails when servers need it most:** during the 03:00 capture (fact 13), with a broken runtime identity, or from ten servers at once. → Run 11.3 Task B (the capture case, the fleet).
4. **The source address read wrong behind the edge.** Then every bound credential is refused, or every bound check passes. → Run 11.3 Task B and Run 11.5 Task A in the integration suite (a trusted proxy with `X-Forwarded-For`), and Run 11.8 on staging through the real edge.
5. **A 404 that tells.** A project the caller does not manage, an id that is not a UUID, an environment of another project, and an absent id must give the same status and the same body but for the request id. → Run 11.5 Task B, one table-driven test.
6. **A check made once.** A credential revoked, expired, narrowed or replaced between the pipeline's read and the admission transaction must be refused inside the transaction. → Run 11.5 Task B (`beforeHandler` revokes, then the handler runs).
7. **An old CLI given a new secret, and a new CLI given an old token.** → Run 11.4 (both directions), and Run 11.8 against the downloaded `cli-v0.1.2`.

## Planner decisions

Settled here so the executor does not have to choose. Each one marked **DR** gets a decision record in the run shown. Numbering continues from Session 10 (P-182, D-79).

| # | Decision | Why | Run |
| --- | --- | --- | --- |
| P-183 | **Session 11 is a Stage 1 amendment by the owner's word, outside Doc 10's nine and outside D-74's list.** It amends Doc 10 §4.2's machine-token line, Doc 04 FR-1.39 (the 30-day token stays as it is; a second kind is added) and Doc 02's Stage 1 exclusion of "autonomous credential mutation", narrowly: issuing read-only runtime credentials for environments the automation manages. **DR D-80.** | Fact 1. Without a record a later reader finds a product that contradicts its own stage documents. | start |
| P-184 | **The postgres pin goes first, alone, as `host-v0.9.3`, to staging and production.** Production then stays on the `host-v0.9.x` line until W-2. | Fact 20; decision 1 (b). The pin is dated 14 Dec and must not ride on a release that changes the product. | 11.1 |
| P-185 | **Both new secrets are verifiers in PostgreSQL.** The secret is 32 random bytes, base64url. The stored verifier is `HMAC-SHA-256(key, "mykey:credential-secret:v1\n" + presented string)` under the existing `resetVerifier` ring, with its key id. The presented string is `mkrc.<credentialId>.<43 characters>` for a runtime credential and `mkac.<credentialId>.<43 characters>` for an automation credential. **DR D-81**, with the hostile-API paragraph in D-17's form. | Facts 2, 3, 17. A new ring is a custody step on both hosts; the label keeps the two uses of one ring apart. The prefix lets the CLI, the pipeline and the scanners tell the kinds apart without a lookup. | 11.2, 11.3 |
| P-186 | **A runtime credential is a row of `app.machine_credential`** with `kind = 'runtime'`, a verifier, no accessor, `bound_cidrs`, and `issued_by_kind`. It is listed by `credentials.list` and revoked by `credentials.revoke`. It is issued by a route of its own, `runtime_credentials.issue`, not by a `kind` on `credentials.issue`. | The inventory, the summary, the expiry warning, archive and the restore then cover it (fact 6). The two issuances share nothing: one is D-40's protocol, the other is one transaction. | 11.2, 11.3 |
| P-187 | **The exchange mints through the issuer, at 900 seconds, and stores nothing.** A lost answer is `503 dependency_unavailable`, and the caller may exchange again. Nothing is blocked and nothing goes to review. | Fact 3. An exchange changes no product state: a token nobody received is used by nobody and ends within 15 minutes. D-40's block exists for a 30-day token that nobody can attribute. | 11.3 |
| P-188 | **A machine token is attributed by accessor, or by `meta.credential_id` when that row is a runtime credential.** The bound addresses of a runtime credential are checked at the exchange and on every machine request. | Fact 4. Only the issuer can create a token from a `machine-env` role (D-17), and the token's own policy still bounds every read: a wrong `meta` can change the row that is checked, never what OpenBao lets the token read. | 11.3 |
| P-189 | **Revoking a runtime credential is one transaction.** The product refuses its tokens at once (`machineRecheck` re-reads the row). In OpenBao a token already minted ends with its TTL, at most 15 minutes later; OpenBao is reachable only from the host's private network. The run measures this and `known-limits.md` says it. | No accessor is stored, so none can be revoked. The spec allows either, measured. | 11.3 |
| P-190 | **`reconcile-credentials` leaves alone a token whose `meta.credential_id` names an active, unexpired runtime credential.** Every other rule of it is unchanged. | Fact 5. | 11.3 |
| P-191 | **An automation credential is a machine actor.** Its operations have `principal_kind = 'machine'` and its audit rows `actor.kind = 'machine'`, both with the credential's id. `secret_version_event` and the history body gain `machine`. **DR D-82.** | Facts 11, 15. A new kind would change two check constraints, the audit query's enum, the archive and the workspace's labels for one word. | 11.2, 11.5 |
| P-192 | **Rights are three: `projects.create`, `secrets.create`, `runtime_credentials.manage`.** At least one is chosen at issue. Reading (the lists, a project, its own operations) comes with any. | The spec's §1.1 without `secrets.update` (decision 4). | 11.2 |
| P-193 | **A project is managed by a chain of automation credentials, not by one.** `project.managed_by` holds the chain's first credential (`owner_id`). A credential issued with `replaces` joins the chain of the one it names, whatever that one's state. Both then manage the same projects until the older is revoked. Without `replaces` a credential starts a chain of its own. | Rotation without an outage for the provisioner, and the restore's "one action" (spec §4): the owner issues one credential that replaces the revoked one. Moving the projects instead would cut the old credential off the moment the new one is issued. | 11.2, 11.5 |
| P-194 | **Automation routes name the project and the environment by id.** They live under `/v1/automation`, with no `:org`: the organization is the process's own (D-34). | The same ids `A1` and `A4` answer; the machine routes' `:envName` is for a person's configuration. | 11.2 |
| P-195 | **The spec's acceptance items live in `docs/evidence/session-11/acceptance.md`**, as `S11-1` to `S11-14`, each PASS, NOT PROVEN or NOT APPLICABLE with its evidence. The registry gains no row. The release manifest is built as in Session 10. | Fact 18. | 11.9 |
| P-196 | **Limits** (in `limits.ts`, with a line in `limits.md`): runtime credential default and maximum 31,536,000 s, exchange token 900 s; automation credential 3,600 to 31,536,000 s, default 604,800 s; at most 8 CIDRs each; 10 exchanges a minute per credential; 120 requests a minute per automation credential; refused secrets count against the existing 30 misses a minute per source. Both kinds warn 7 days before expiry. **DR D-83.** | Decisions 2 and 3. The fleet boot (10 credentials, two exchanges each in 20 s) passes with room. | 11.2 |
| P-197 | **`cli-v0.2.0`:** a credential that starts with `mkrc.` is exchanged first, then the CLI goes on exactly as today. No flag, no new variable, no new exit code. | Fact 12, fact 19. Existing installs are untouched because nothing they are given starts with `mkrc.`. | 11.4 |
| P-198 | **The session is planned as two working days, with a stop line.** After Run 11.4 the runtime credential is complete and releasable on its own. | The owner asked for a session that does not take days. The honest sum is about 22 hours; the stop line is the way out if a box breaks. | all |

## Carried items

| Item | From | Where it lands |
| --- | --- | --- |
| The postgres pin; `.trivyignore.images` | CLAUDE.md "Dated", owner 25 Nov | Run 11.1 (decision 8) |
| `secrets.update` by automation | spec §1.1, optional | Not in this session (decision 4); `Open issues` in the report |
| Assign and unassign an existing project | spec §1.1, §2.3 | Not in this session (decision 7 ii); `known-limits.md` |
| A staging restore with the new kinds (spec §6 item 11) | spec §4 | Integration only (Run 11.3 Task C, Run 11.5 Task D); NOT PROVEN on staging; the next re-drill |
| The D-78 trigger aimed at an automation issuance (spec §6 item 10) | spec | NOT APPLICABLE (fact 7); the exchange's fault test stands in its place |
| Production on `host-v0.10.x` and `cli-v0.2.0` on consumer-1 | decision 6 | Dated: after W-2 (20 Dec 2026), by `production.md` |
| Workload-identity federation | Doc 02 Stage 3 | Untouched. Nothing here blocks it: an exchange that takes a different proof is a new route beside this one |
| W-1, W-2, both seal certificates, `pair-30-day`, `kms-cert-expiry`, consumer-1's rotation, weekly field reports | CLAUDE.md "Dated" | Unchanged |

## Session start

- [ ] **Step 1 — The branch.** `git switch session-11 && git pull`. The draft pull request is open. Read this plan and the spec whole.
- [ ] **Step 2 — One message to the owner**, saved as `docs/evidence/session-11/owner-requests.md` (no value in the file): the eight questions of "The owner's decisions", each with its recommendation, answerable with "all as recommended". Then the sittings:
  - **Production's journey for the pin** (question 8): about 10 minutes of yours inside about 20.
  - **The sign-off:** about 10 minutes of reading, after the gate.
- [ ] **Step 3 — D-80** (P-183), with the owner's answers and their date. `mkdir` of `docs/evidence/session-11/`. **Commit** `docs: Session 11 starts; the owner's answers`. Push.

**An answer that differs from the recommendation** changes the runs its row names. Decision 1 (a) or (c), or decision 5 "AppRole", stops the session here.

## Run order

```
start: the owner message, D-80
11.1  the postgres pin → host-v0.9.3 → staging → production (OWNER, 10 min)
11.2  the contract commit (41 → 57 routes), the limits, migration 0019      ──► push
11.3  the runtime credential: issue, revoke, exchange, metadata             ──► push
11.4  the CLI, 0.2.0                                                        ──► push
─────────────────────────────────── the stop line (P-198): releasable as it is
11.5  the automation credential: issue, the auth class, its ten routes      ──► push
11.6  the workspace                                                         ──► push
11.7  the documents                                                         ──► push
11.8  the freeze: full CI, the review, host-v0.10.0, cli-v0.2.0, staging
11.9  the gate: acceptance, manifest, report, CLAUDE.md, the owner's message ──► sign-off
```

- **Days** (P-198): **Day 1**, the start and Runs 11.1 to 11.4. **Day 2**, Runs 11.5 to 11.7 and the freeze's unattended part. **The morning after**, the rest of 11.8 and 11.9.
- **Time boxes:**

  | Run | Box |
  | --- | --- |
  | 11.1 | 1.5 h |
  | 11.2 | 2 h |
  | 11.3 | 4 h |
  | 11.4 | 1.5 h |
  | 11.5 | 4.5 h |
  | 11.6 | 2.5 h |
  | 11.7 | 1.5 h |
  | 11.8 | 4 h |
  | 11.9 | 1 h |

  A run that passes twice its box stops, writes what blocks it, and takes the next valve.
- **Scope valves, in this order.** Each is a line in the run note and the report; valve 5 needs the owner's one line.
  1. `automation.runtime_credentials.list` (the owner still lists them in the workspace).
  2. The fleet boot on staging (it stays proven in the integration suite).
  3. `test:consumers` with a runtime credential (the rehearsal then runs with today's token and the new CLI).
  4. The project page's "managed by" label (the automation screen still shows the count).
  5. **The stop line:** Runs 11.5 and the automation parts of 11.6 and 11.7 become Session 12. A `contract:` commit takes the automation routes out again, and the release holds the runtime credential alone.
- **Never cut:**
  - Doc 10 §4.1;
  - the contract commit as one commit;
  - Review focus 1, 2 and 5 with their tests;
  - the no-regression proofs (`cli-v0.1.2`, the two machine bodies, the token block);
  - the hostile-API paragraph of D-81;
  - the review;
  - `known-limits.md` with every new residual;
  - the report.

## File map

```
packages/contracts/src/  routes.ts (16 routes, 2 auth classes, `right`)  automation.ts (new: rights, secret shapes)
                         limits.ts  authz.ts (stateClassOf)  capacity.ts  openapi.ts  web-routes.ts
packages/contracts/openapi/openapi.json            generated
packages/db/             src/schema/app.ts  migrations/0019_automation_and_runtime.sql
                         src/repos/credentials.ts  automation.ts (new)  resources.ts  secrets.ts
packages/audit/src/      coverage.ts  events.ts (machine.exchange, automation_credential.issue, .revoke)
packages/operations/src/ actor.ts (new)  credentials/secret.ts (new: mint, verifier, CIDRs)
                         credentials/runtime.ts (new: issue, revoke, exchange)  credentials/automation.ts (new)
                         secrets/protocol.ts (userId → actor)  reconcile/credentials.ts  lifecycle/archive.ts
apps/api/src/pipeline/   route.ts  machine.ts  automation.ts (new)  context.ts  rate.ts  origin.ts
apps/api/src/routes/     machine.ts (exchange, metadata)  credentials.ts  automation.ts (new)
                         automation-credentials.ts (new)  resources.ts  secrets.ts
apps/ops/src/commands/   restore-invalidate.ts  restore-verify.ts
apps/cli/src/            token.ts  client.ts  main.ts  package.json (0.2.0)
apps/web/src/            screens/automation.tsx (new)  screens/credentials.tsx  screens/project.tsx  screens/connect.tsx
                         api/secret-routes.ts  router.tsx  copy/*.ts  help/articles.ts  ui/AppShell.tsx
infra/dependencies.lock.json  .trivyignore.images                      Run 11.1 only
tests/unit/contracts/    routes.test.ts  openapi.test.ts  limits.test.ts  automation.test.ts (new)
tests/unit/audit/        coverage.test.ts
tests/integration/openbao/issuance.test.ts                 the short token, measured
tests/integration/credentials/runtime.test.ts (new)  runtime-everywhere.test.ts (new)
tests/integration/machine/exchange.test.ts (new)  metadata.test.ts (new)  fleet.test.ts (new)
tests/integration/automation/ (new)  issue.test.ts  boundary.test.ts  provisioning.test.ts  recovery.test.ts
tests/integration/authz/matrix.test.ts  tests/integration/restore/{invalidate,verify}.test.ts
tests/cli/exchange.test.ts (new)  tests/cli/server.ts
tests/browser/automation.test.ts (new)  tests/unit/web/*.test.ts
tests/fixtures/automation/tenant-provisioner.ts (new)      the generic script: provision, reissue
tests/staging/runtime-credential.staging.test.ts (new)  automation.staging.test.ts (new)
              token-sweep.staging.test.ts  (+ the files of Run 11.8)
docs/runbooks/   automation.md (new)  machine-credentials.md  known-limits.md  limits.md  restore.md
                 consumer-local.md  consumer-deploy.md  start-here.md  credential-custody.md  audit.md
docs/agents/connect-an-application.md   tests/unit/agents/guide.test.ts
docs/decisions/  D-80 … D-83   D-15 (amended in the contract commit)
docs/evidence/session-11/  owner-requests.md  run-11.1.md … run-11.9.md  review.md  claims.md  acceptance.md
                           measurements.json  candidate.json  proof-map.json  results.json  manifest.md  report.md
```

---

## Run 11.1 — The postgres pin, `host-v0.9.3` (carried; P-184)

Only with answer 8 "yes". Nothing else is on the branch yet but this plan and D-80, so the release holds the pin alone.

### Task A — The pin

**Files:** `infra/dependencies.lock.json`, `.trivyignore.images`, and whatever `pins:verify` names.

- [ ] **Step 1 — See it red.** `node scripts/ci-scan.ts images` with the postgres entries (CVE-2026-124851, the zlib and krb5 entries) taken out of `.trivyignore.images`. Expected: the scan reports them on the pinned image.
- [ ] **Step 2 — Move the pin** to the newest PostgreSQL 18 image whose scan no longer reports them, by `@sha256:` digest, with its `releaseUrl`. Never PostgreSQL 19. Remove from `.trivyignore.images` only the entries the scan no longer needs.
- [ ] **Step 3 —** `pnpm run check`; `node scripts/ci-scan.ts images` green; `pnpm exec vitest run --project integration tests/integration/database`. **Commit** `fix(pins): postgres moved past CVE-2026-124851`. Push.

### Task B — The release and staging

- [ ] **Step 1 —** full CI by hand (`gh workflow run ci --ref session-11`). While it runs, read `deploy.md` and D-57 for how an upstream image reaches a host, and write that one sentence into the note.
- [ ] **Step 2 —** in the clean clone: `node infra/release/build.ts --version 0.9.3 --out ~/mykey-release/host-v0.9.3`, then `gh release create host-v0.9.3 --target session-11 …` **before any other commit is pushed**.
- [ ] **Step 3 —** `MYKEY_RELEASE_NEW=<host-v0.9.3> MYKEY_RELEASE_PREVIOUS=<host-v0.9.2> pnpm run test:staging tests/staging/deploy.staging.test.ts`. Then, one at a time: `api`, `status`, `backup`. Expected: PASS; the running postgres image's digest on the host is the lock's; one pair made by hand is `eligible` (its scratch restore proves the dump still restores).

### Task C — Production (OWNER)

- [ ] **Step 1 —** `MSYS_NO_PATHCONV=1 node scripts/host.ts prod deploy --release C:/Users/<you>/mykey-release/host-v0.9.3 --stay-closed`. Tell the owner before the command.
- [ ] **Step 2 — The owner's journey** in `node scripts/host.ts prod tunnel verify --browser`: sign in, reveal one secret they know, try one change (it must answer "The service is not open"), sign out. The owner says "journey done". The agent reads nothing from that window.
- [ ] **Step 3 —** `… prod deploy --release … --owner-confirmed`; `host.ts prod status` clean; `node scripts/probe.ts state prod` with `inService: true`.
- [ ] **Step 4 —** `run-11.1.md` (the time, the epoch, the release; no id, no name). **Commit** `docs: both hosts serve host-v0.9.3`. Push.

**If the journey fails:** redeploy `host-v0.9.2` by the same three steps, and the pin becomes a dated item again. **Done when:** both hosts serve `host-v0.9.3` and the image scan is green without the three entries.

---

## Run 11.2 — The contract, the limits, the migration (D-15; D-83)

One `contract:` commit holds Tasks A and B's contract part. After it every new route exists, passes every check of the pipeline and answers the terminal `404` until its run gives it a handler.

### Task A — The routes

**Files:** `packages/contracts/src/routes.ts`, `automation.ts` (new), `authz.ts`, `capacity.ts`, `limits.ts`, `openapi.ts`, `packages/contracts/openapi/openapi.json`, `packages/audit/src/coverage.ts`, `events.ts`, `tests/unit/contracts/{routes,openapi,limits}.test.ts`, `automation.test.ts` (new), `tests/unit/audit/coverage.test.ts`, `docs/decisions/D-15-route-freeze.md`, `docs/runbooks/limits.md`, `audit.md`.

**Produces** (names every later run uses):

```ts
// packages/contracts/src/automation.ts
export const AUTOMATION_RIGHTS = ["projects.create", "secrets.create", "runtime_credentials.manage"] as const;
export type AutomationRight = (typeof AUTOMATION_RIGHTS)[number];
export const RUNTIME_SECRET_PREFIX = "mkrc";
export const AUTOMATION_SECRET_PREFIX = "mkac";
/** `<prefix>.<uuid>.<43 base64url characters>`; null for any other string. */
export function parsePresentedSecret(text: string): { prefix: "mkrc" | "mkac"; id: string; secret: string } | null;

// routes.ts
export type AuthClass = "public" | "human" | "human_fresh_totp" | "machine" | "machine_exchange" | "automation" | "reset_flow";
// RouteDef gains:  readonly right: AutomationRight | "any" | null;   (null on every route that is not `automation`)
```

**The sixteen routes.** `O`, `E` and `M` are the prefixes `routes.ts` has. `A` is `/v1/automation`, `AP` is `A/projects/:project`, `AE` is `AP/environments/:env`.

| Id | Method and path | Auth | Key | Right or action | Body → answer |
| --- | --- | --- | --- | --- | --- |
| `automation_credentials.list` | GET `O/automation-credentials` | human | – | `credentials.manage` | page query → `{credentials: [automationCredentialView], nextCursor}` |
| `automation_credentials.issue` | POST `O/automation-credentials` | human_fresh_totp | yes | `credentials.manage` | `{name, rights, ttlSeconds, cidrs, replaces?}` → 201 `{operationId, credential, secret}` |
| `automation_credentials.revoke` | POST `O/automation-credentials/:credential/revoke` | human | yes | `credentials.manage` | `{confirmed}` → envelope with `{credentialId, state: "revoked"}` |
| `runtime_credentials.issue` | POST `E/runtime-credentials` | human_fresh_totp | yes | `credentials.manage` | `{name, ttlSeconds, cidrs}` → 201 `{operationId, credential, clientSecret}` |
| `automation.projects.list` | GET `A/projects` | automation | – | any | page query → `projectsBody` |
| `automation.projects.create` | POST `A/projects` | automation | yes | `projects.create` | `{name}` → 201 envelope, `result: {projectId, developmentEnvironmentId}` |
| `automation.projects.get` | GET `AP` | automation | – | any | → `{id, name, state, reviewReason, createdAt, environments: [as environmentsBody's], truncated}` |
| `automation.environments.create` | POST `AP/environments` | automation | yes | `projects.create` | `{name}` → 201 envelope, `result: {environmentId}` |
| `automation.secrets.list` | GET `AE/secrets` | automation | – | any | `secretsListQuery` → `{secrets: [{name, state, version, createdAt, updatedAt}], nextCursor}` |
| `automation.secrets.create` | POST `AE/secrets` | automation | yes | `secrets.create` | `{name, value}` → 201 envelope |
| `automation.runtime_credentials.list` | GET `AE/runtime-credentials` | automation | – | `runtime_credentials.manage` | page query → `credentialsListBody` |
| `automation.runtime_credentials.issue` | POST `AE/runtime-credentials` | automation | yes | `runtime_credentials.manage` | as the human one |
| `automation.runtime_credentials.revoke` | POST `AE/runtime-credentials/:credential/revoke` | automation | yes | `runtime_credentials.manage` | `{confirmed}` → `credentialRevokedBody` |
| `automation.operations.get` | GET `A/operations/:operation` | automation | – | any | → the operation envelope |
| `machine.exchange` | POST `/v1/machine/exchange` | machine_exchange | – | – | none → `{apiMajor, token, expiresAt, projectId, environmentName}` |
| `machine.metadata` | GET `M/metadata` | machine | – | – | none → `{apiMajor, environmentId, generation, count, entries: [{name, version, createdAt, updatedAt}], complete: true}` |

**The fields:**

- `rights`: 1 to 3 distinct values of `AUTOMATION_RIGHTS`.
- `ttlSeconds`: for automation, an integer from `LIMITS.automationCredential.minTtlSeconds` to `maxTtlSeconds`, default `defaultTtlSeconds`. For runtime, positive, at most `LIMITS.runtimeCredential.maxTtlSeconds`, default the same.
- `cidrs`: strings of at most 43 characters matching `^[0-9A-Fa-f:.]+/[0-9]{1,3}$`; 1 to 8 for automation, 0 to 8 (default none) for runtime. The server checks each strictly (Run 11.3): a network address with no host bits, IPv4 or IPv6, prefix not 0.
- `replaces`: a UUID.
- `automationCredentialView`: `{credentialId, ownerId, name, rights, boundCidrs, state: "active" | "revoked" | "expired", issuedBy, issuedAt, expiresAt, expiringSoon, lastUsedAt, managedProjects}`. `lastUsedAt` is null when never used.
- `credentialView` gains `kind: "token" | "runtime"`, `issuedByKind: "user" | "automation"`, `boundCidrs: string[]`. A project's row in `projectsBody` gains `managedBy: uuid | null`. `historyActor.kind` gains `"machine"`.
- `createdAt` in both metadata bodies is nullable (fact 10); `version` is nullable where the index has none.

**Error lists** follow `define()`'s rules, with these additions to the rules themselves: `automation` gets the list `MACHINE` has without `forbidden_selector`; `machine_exchange` gets `MACHINE`'s list plus `audit_unavailable` and `BACKEND`; neither gets `origin_rejected`. Per route: both issue routes list `credential_not_replayable` and `state_conflict`; the automation twins list what their human twins list.

- [ ] **Step 1 — Write the failing tests.**
  - `routes.test.ts`: the table grows from 41 to 57 rows, written out; `the non-idempotent mutations are eight` (the seven and `machine.exchange`); `every automation route has a right and no action, and no other route has a right`; `every automation mutation requires an Idempotency-Key`; `machine.keys and machine.resolve are unchanged` (their two schemas' JSON forms equal a snapshot taken from `main` before the change).
  - `automation.test.ts`: `parsePresentedSecret accepts mkrc.<uuid>.<43> and mkac.<uuid>.<43> and nothing else` (a 42-character secret, an upper-case UUID, a third prefix, a trailing newline, an OpenBao-shaped token: all null).
  - `openapi.test.ts`: 57 operations; two bearer security schemes named for the automation credential and the runtime credential; the committed file equals a fresh build.
  - `limits.test.ts`: the values of P-196, each marked "not in Doc 06 §11 (D-83)".
  - `coverage.test.ts` fails by itself until every new route has an entry.
- [ ] **Step 2 — Run them:** `pnpm exec vitest run --project unit tests/unit/contracts tests/unit/audit`. Expected: FAIL.
- [ ] **Step 3 — Write the contract.**
  - `limits.ts`: `runtimeCredential: {defaultTtlSeconds: 31536000, maxTtlSeconds: 31536000, exchangeTtlSeconds: 900, maxCidrs: 8}`, `automationCredential: {minTtlSeconds: 3600, defaultTtlSeconds: 604800, maxTtlSeconds: 31536000, maxCidrs: 8}`, and in `rate`: `exchangePerCredentialPerMinute: 10`, `perAutomationCredentialPerMinute: 120`.
  - `authz.ts`: `stateClassOf` answers for `automation` routes by id: the two creates `metadata_write`; `automation.secrets.create` `secret_write`; `automation.runtime_credentials.issue` `credential_issue`; its revoke `lifecycle`; every GET `metadata_read`. `runtime_credentials.issue` is `credential_issue`, and `automation_credentials.revoke` is `lifecycle`.
  - `capacity.ts`: each new creating route joins `EXPANDING_ROUTES` where its human twin is. `CAPTURE_OPEN_ROUTES` gains `machine.exchange`, `automation_credentials.revoke` and `automation.runtime_credentials.revoke`.
  - `coverage.ts` and `events.ts`: new actions `machine.exchange` (details `{credentialId}`), `automation_credential.issue` (details `{credentialId, ownerId, rights, ttlSeconds, cidrCount, replaces}`), `automation_credential.revoke`. The automation routes write their human twins' actions plus `access.denied`; `machine.metadata` and the reads write `access.denied` only.
  - `pnpm run contracts:openapi`.
  - `D-15`: an "Amendment (Session 11)" section: 57 routes, the sixteen ids, the three additive fields, the two auth classes.
- [ ] **Step 4 — Run again.** Expected: PASS. `pnpm run check`.

### Task B — The migration

**Files:** `packages/db/src/schema/app.ts`, `packages/db/migrations/0019_automation_and_runtime.sql`, `packages/db/src/repos/automation.ts` (new), `credentials.ts`, `tests/integration/database` (the file that checks migrations and grants).

- [ ] **Step 1 — The schema.**
  - `app.automation_credential`: `id` (pk), `organization_id`, `owner_id` (not null), `name`, `rights text[]`, `bound_cidrs text[]`, `verifier bytea`, `verifier_key_id text`, `state` (`active`, `revoked`), `expires_at`, `issued_by`, `issuance_operation_id`, `created_at`, `last_used_at`, `revoked_at`. Unique `(organization_id, id)`. A foreign key `(organization_id, owner_id)` to its own `(organization_id, id)`. Checks: `rights` a non-empty subset of the three; `bound_cidrs` holds 1 to 8.
  - `app.project.managed_by uuid`, null by default, with a foreign key `(organization_id, managed_by)` to `automation_credential (organization_id, id)`.
  - `app.machine_credential`: `kind text not null default 'token'` (`token`, `runtime`); `verifier bytea`; `verifier_key_id text`; `bound_cidrs text[] not null default '{}'`; `issued_by_kind text not null default 'user'` (`user`, `machine`). One check: a `runtime` row has a verifier and no accessor, and a `token` row has no verifier.
  - `secret_version_event_actor_kind_check` gains `machine`.
  - Grants as `0010_api_narrowed.sql` gives them for `machine_credential`: `api_runtime` select, insert, update; `maintenance` what `restore-invalidate` needs; `backup_reader` select.
- [ ] **Step 2 —** `node node_modules/drizzle-kit/bin.cjs generate --name automation_and_runtime` inside `packages/db`. **Read the SQL:** the unique key before the foreign keys that need it. `pnpm run db:check`.
- [ ] **Step 3 — Tests** (in the database suite): `migration 0019 applies to a database that holds 30-day credentials, and every one of them reads kind token, issued_by_kind user, no CIDR`; `a runtime row with an accessor is refused, and a token row with a verifier is refused`; `the first credential of a chain names itself as owner`.
- [ ] **Step 4 —** `pnpm exec vitest run --project integration tests/integration/database`. `check`. **Commit** (Tasks A and B together) `contract: automation and runtime credentials, exchange and metadata (41 → 57 routes)`. Push. `run-11.2.md`. D-83.

**Covers:** the spec's §2 and limits. **Done when:** the contract tests are green at 57 routes and the migration applies to a copy of today's schema.

---

## Run 11.3 — The runtime credential: issue, revoke, exchange, metadata (D-81)

### Task A — Issue and revoke, and the row without an accessor

**Files:** Create `packages/operations/src/actor.ts`, `credentials/secret.ts`, `credentials/runtime.ts`, `tests/integration/credentials/runtime.test.ts`, `runtime-everywhere.test.ts`. Modify `packages/db/src/repos/credentials.ts`, `apps/api/src/routes/credentials.ts`, `apps/api/src/app.ts` (or wherever handlers are mounted), `packages/operations/src/lifecycle/archive.ts`, `credentials/sweep.ts`, `reconcile/credentials.ts`, `replay.ts`, `apps/ops/src/commands/restore-verify.ts`, `apps/api/src/pipeline/rate.ts`.

**Produces:**

```ts
// actor.ts
export type Actor = { kind: "user"; id: UserId } | { kind: "machine"; id: string };

// credentials/secret.ts
export function mintSecret(prefix: "mkrc" | "mkac", id: string): string;          // the presented string
export function verifierOf(ring: KeyRing, presented: string): { digest: Buffer; keyId: string };
export function verifies(ring: KeyRing, stored: { digest: Buffer; keyId: string }, presented: string): boolean; // timingSafeEqual; false for an unknown key id
export function parseCidrs(list: readonly string[]): net.BlockList | null;       // null when one entry is not a strict network
export function sourceAllowed(cidrs: readonly string[], source: string): boolean; // true for an empty list

// credentials/runtime.ts
export function issueRuntimeCredential(deps, request: { routeId; scope: EnvironmentScope; actor: Actor; name; ttlSeconds; cidrs; idempotencyKey; intent; requestId; recheck }):
  Promise<{ kind: "issued"; operation; credential; clientSecret: string } | { kind: "replay"; operation } | { kind: "refused"; code; operationId? }>;
export function revokeRuntimeCredential(deps, request: { routeId; scope; actor: Actor; credentialId; idempotencyKey; intent; requestId; recheck }):
  Promise<{ kind: "revoked"; operation } | { kind: "replay"; operation } | { kind: "refused"; code }>;
```

- [ ] **Step 1 — Write the failing tests** (`runtime.test.ts`, the owner's session against real stores):
  - `issue with a fresh TOTP answers 201 with a clientSecret of the mkrc shape, cache-control no-store, and a credential of kind runtime, state active, expiring in 365 days`
  - `issue without a fresh TOTP is 403 fresh_verification_required, and no row exists` (the control is the test above)
  - `the same Idempotency-Key again answers credential_not_replayable with the credential's id, never the secret`
  - `the operation's stored result, the audit row and the API's log of the request hold the credential's id and no part of the secret` (the secret's 43 characters are searched; the control is the credential's id, found in all three)
  - `the database holds a 32-byte verifier and its key id, and no column holds the secret`
  - `a CIDR with host bits, a /0, a name and nine entries are each 422 validation_failed`
  - `credentials.list shows both kinds with their kind; credentials.summary counts the runtime row under active`
  - `credentials.revoke of a runtime credential answers 200 revoked in one request, with OpenBao stopped` (the control: revoking a token credential with OpenBao stopped does not answer 200)
  - `OpenBao's accessor list of the namespace is the same before and after an issue and a revoke`
- [ ] **Step 2 — Write the failing tests of Review focus 1** (`runtime-everywhere.test.ts`). Each starts with an environment that holds one active token credential and one active runtime credential:
  - `environments.archive answers 200, counts both in credentialsRevoked, and both rows are revoked`
  - `projects.reactivate after it answers 200, and both stay revoked`
  - `the credential sweep leaves the runtime row active` (it is not an unfinished issuance)
  - `reconcile-credentials leaves the runtime row active and reports nothing left`
  - `restore-invalidate revokes both, and restore-verify's credential check is ok`
  - `issuing a 30-day token is not blocked by the runtime row` (the unresolved-issuance index)
- [ ] **Step 3 — Run them.** `pnpm exec vitest run --project integration tests/integration/credentials/runtime.test.ts tests/integration/credentials/runtime-everywhere.test.ts`. Expected: FAIL (the route answers 404).
- [ ] **Step 4 — Implement.**
  - `issueRuntimeCredential` is one transaction on the main pool: the operation by its key (principal kind from the actor), the gate, `recheck`, the environment `kv_ready`, the row inserted `active` with the verifier, the operation succeeded with `result: {credentialId}`, the audit row `credential.issue` with `details.kind = "runtime"`. The secret is a local of this function and of the handler.
  - `revokeRuntimeCredential` is one transaction: parents locked, the row `active → revoked`, the operation, `credential.revoke`.
  - `credentials.revoke`'s handler reads the row's kind and calls one or the other. A runtime id given to the token protocol, or the reverse, must not be reachable.
  - `replay.ts`: the three issue routes all answer `credential_not_replayable` on replay.
  - `rate.ts`: `runtime_credentials.issue` joins `ROUTE_CLASS_LIMIT` under `rl:issue`.
  - Archive, the sweep and reconcile: a `runtime` row is closed in PostgreSQL and never sent to OpenBao.
- [ ] **Step 5 — Run again,** and with them `tests/integration/credentials` and `tests/integration/archive` whole (by directory, `--maxWorkers=2`). Expected: PASS. `check`. **Commit** `feat(credentials): the runtime credential, issued and revoked in one transaction`.

### Task B — The exchange

**Files:** Create `tests/integration/machine/exchange.test.ts`, `fleet.test.ts`. Modify `tests/integration/openbao/issuance.test.ts`, `credentials/runtime.ts`, `apps/api/src/routes/machine.ts`, `pipeline/route.ts`, `pipeline/machine.ts`, `pipeline/rate.ts`, `pipeline/origin.ts`, `reconcile/credentials.ts`, `tests/integration/credentials/reconcile.test.ts`.

**Produces:**

```ts
export function exchangeRuntimeCredential(deps: { pool; issuer: IssuerBao; verifierRing: KeyRing; faults? }, request: { organizationId; presented: { id; secret; text }; source; requestId }):
  Promise<{ kind: "exchanged"; token: string; expiresAt: Date; projectId; environmentName; credentialId }
        | { kind: "refused"; code: ErrorCode; attributed: CredentialId | null; reason: string }>;
// rate.ts: RATE_SCOPES gains "rl:exchange" (per credential) and "rl:automation" (per automation credential).
```

**The exchange, in order:**

1. Exactly one `Authorization: Bearer <text>`, and `parsePresentedSecret` gives prefix `mkrc`. Else `401`, before any read.
2. The source's count of misses (`rl:machine-miss`) is under its limit. Else `429`.
3. One statement: the row by `(organization, id)` with `kind = 'runtime'`, joined to its environment, project and organization. Absent, or the verifier does not match: `401`, a log line, one miss counted, **no audit row** (D-42: an unattributable refusal).
4. From here the caller is known. Not `active`, past `effective_expires_at` on database time, or a source outside `bound_cidrs`: `401`, audited as `access.denied` with the machine actor. A parent `revoking` or `archived`: `403 action_denied`, audited. In review: `503 backend_inconsistent`.
5. `rl:exchange` for the credential.
6. An issuer session; `tokenCreateFromRole(machineName(environmentId), 900, correlation, {credential_id, exchange: "1"})`; the token checked as an issuance checks it (policies exactly the role's, not renewable, TTL at most 900); the session closed.
7. The audit row `machine.exchange`, committed. If it cannot be written: the token is dropped (revoked by accessor through a fresh session when that works) and the answer is `503 audit_unavailable`.
8. `200`, buffered, `cache-control: no-store`.

A create whose answer is unclear is `503 dependency_unavailable` (P-187). A sealed backend is `503 backend_sealed`.

- [ ] **Step 1 — The measurement owed on the pinned OpenBao** (`issuance.test.ts`, new cases, each with its control):
  - `the issuer mints a 900 s token from a machine-env role with meta; lookup-self shows ttl ≤ 900, not renewable, orphan, policies exactly [machine-env-<eid>], meta.credential_id`
  - `renew-self leaves its lifetime unchanged`
  - `a 2 s token reads, and 3 s later it is refused` (the control: a 60 s token minted beside it still reads)
  - `the issuer cannot ask for a policy the role does not allow, with or without meta` (the control is the first case)

  Run: `pnpm exec vitest run --project integration tests/integration/openbao/issuance.test.ts`. A case that fails here is a finding that stops the run: P-187 and P-188 rest on it.
- [ ] **Step 2 — Write the failing tests** (`exchange.test.ts`):
  - `exchange answers 200 with a token and expiresAt at most 900 s away; with it machine.resolve returns all 25 seeded values, complete: true, and machine.keys the 25 names` (the digests equal the owner's export)
  - `a wrong secret for a real id, an unknown id, a mkac string and an OpenBao-shaped token each answer 401 with the same body; the audit table gains no row; the log gains machine_unauthenticated`
  - `the 31st miss of one source in a minute answers 429 before the database is read for the credential`
  - `a revoked credential, an expired one, and a call from outside its CIDRs each answer 401 and write access.denied with the machine actor` (the control: the same call from inside the CIDR, sent through the trusted proxy with X-Forwarded-For, answers 200)
  - `revoke after an exchange: the next exchange is 401, and the token already minted answers 401 on machine.resolve at once` — and the measurement: `lookup-accessor` of that token in OpenBao still answers until its TTL (recorded for P-189)
  - `the token is refused on another environment's path with 404, and a 30-day token of the same environment still resolves` (no regression)
  - `a machine request from outside a runtime credential's CIDRs is 401, and the same request for a 30-day token, which has none, is 200`
  - `the 11th exchange of one credential in a minute answers 429 with retry-after`
  - `with the capture mode set to capturing, exchange answers 200` (Review focus 3; the control: `secrets.create` answers 503 busy)
  - `with the runtime identity's secret id refused, exchange and resolve still answer 200` (D-42's property, kept)
  - `a query parameter or a body key is 400 forbidden_selector`
  - `fault after_create_sent: the answer is 503, nothing is in review, the next exchange answers 200, and issuing a 30-day token is not blocked` (stands in for the spec's item 10, fact 7)
  - `audit unavailable: the answer is 503 audit_unavailable and the minted token is refused afterwards`
  - `reconcile-credentials with a live exchanged token: nothing is revoked, nothing is left; after the credential is revoked, the same command revokes the token as unrecorded` (P-190; in `reconcile.test.ts`)
- [ ] **Step 3 — The fleet** (`fleet.test.ts`, spec §6 item 8): `ten runtime credentials from one source, each exchanging and resolving twice within 20 s through the CLI's own client, all succeed under the product's limits`. It uses `createClient` of `apps/cli/src/client.ts`, so `busy` is waited out as a real start waits. The limiter runs with the product's limits, not the harness's wide ones. It records the slowest start.
- [ ] **Step 4 — Run them.** Expected: FAIL. **Implement** the exchange as listed, `machineStep`'s twin for `machine_exchange` in `route.ts`, and the attribution of P-188 in `authenticateMachine`: the statement's `WHERE` becomes "this accessor, or a runtime row with this id" where the id is `meta.credential_id` when it is a UUID. `hasMixedCredentials` and the Origin rule treat both new classes as they treat `machine`.
- [ ] **Step 5 — Run again,** with `tests/integration/machine` and `tests/integration/limits` whole. Expected: PASS. Write the fleet's and the exchange's times into `docs/evidence/session-11/measurements.json`. `check`. **Commit** `feat(machine): a runtime credential is exchanged for a 15-minute token`.

### Task C — `machine.metadata`, and the restore

**Files:** Create `tests/integration/machine/metadata.test.ts`. Modify `apps/api/src/routes/machine.ts`, `packages/db/src/repos/secrets.ts`, `apps/ops/src/commands/restore-invalidate.ts`, `restore-verify.ts`, `tests/integration/restore/{invalidate,verify}.test.ts`.

- [ ] **Step 1 — Write the failing tests:**
  - `metadata returns every live name with its version, createdAt and updatedAt, in bytewise order, with count, generation and complete: true, for a 30-day token and for an exchanged one`
  - `a name written twice has version 2, createdAt of the first write and updatedAt of the second`
  - `a name whose create event is gone has createdAt null` (the event row is deleted by the test)
  - `no value of the environment appears in the body` (25 canary values searched; the control: `machine.resolve`'s body holds all 25)
  - `metadata writes no audit row and reads nothing from OpenBao but the token's lookup` (the runtime identity is broken for the test)
  - in the restore suite: `after restore-invalidate every runtime credential is revoked, its exchange answers 401, and restore-verify's credential check is ok`
- [ ] **Step 2 — Implement.** One statement over `app.secret_index` (`state = 'live'`), with `createdAt` as the earliest `create` row of `app.secret_version_event` for the name. Name the columns in `ORDER BY` (the text-alias lesson). The handler takes the per-credential slot as `machine.keys` does.
- [ ] **Step 3 — Run,** `check`, **commit** `feat(machine): metadata — version and times, never a value`.

### Task D — The surfaces, and the record

- [ ] **Step 1 —** extend `tests/integration/credentials/surfaces.test.ts`: after an issue, an exchange and a resolve, the client secret and the exchanged token are found **0** times in the API's log, the provisioner's log, every table of a `pg_dump`, the job payloads and OpenBao's audit file, with a control found in each (the credential's id).
- [ ] **Step 2 —** D-81: the design (P-185 to P-190), the four measurements of Task B Step 1, the lifetime of a token after revocation as measured, and **the hostile-API paragraph** in D-17's form:
  - what a compromised API process **can** do that is new: nothing in OpenBao (it could already mint a 30-day token for any environment; it can now also accept a client secret it wrote);
  - what it **cannot**: anything outside the `machine-env-*` family, as before (the matrix snapshot is byte-equal);
  - a reader of a database dump: verifiers and addresses, no usable secret;
  - **a writer of the database alone:** it can plant a verifier and then exchange through the API from an allowed address, for a read token of one environment. Before writing this sentence, check what the same writer can already do today (the `auth` tables), and state the difference as it is. It becomes a line of `known-limits.md`.
- [ ] **Step 3 — The authority matrix** (spec §6 item 14): `pnpm exec vitest run --project unit tests/unit/openbao/authority.test.ts`, regenerated and compared. Expected: PASS with the snapshot byte-equal, because no identity and no right was added. A changed snapshot stops the run.
- [ ] **Step 4 —** `check`. **Commit** `docs: D-81, the runtime credential's design and what a hostile API holds`. Push. `run-11.3.md`.

**Covers:** spec §1.2, §2.2, §6 items 6 to 9 and 13 (integration), Review focus 1 to 4. **Done when:** every file above is green and D-81 holds the measured figures.

---

## Run 11.4 — The CLI, `0.2.0` (P-197)

**Files:** Modify `apps/cli/src/client.ts`, `main.ts`, `token.ts` (a comment only, if anything), `apps/cli/package.json`, `tests/cli/server.ts`. Create `tests/cli/exchange.test.ts`. Modify `tests/integration/machine/cli-client.test.ts`.

**Interfaces:** `ApiClient` gains `exchange(presented: string): Promise<{ token: string }>`. `main.ts`, after `readToken`: when `parsePresentedSecret(token)?.prefix === "mkrc"`, the credential's token becomes the exchange's answer, and the client secret's variable is emptied. Everything after is today's code.

- [ ] **Step 1 — Write the failing tests** (`exchange.test.ts`, against the test server of `tests/cli/server.ts`, which gains the route):
  - `run with SECRETS_MACHINE_TOKEN holding a runtime credential: the child starts with every entry, and the server saw one exchange, then one resolve with the exchanged token`
  - `keys and export with --token-stdin holding a runtime credential work the same way`
  - `the exchange refused with 401: nothing starts, exit 77, one line on stderr with the code and the request id, and the line holds no part of the secret`
  - `the exchange answering 429 is exit 75, and 503 is exit 69`
  - `an exchange answer that is not the contract's body is exit 65, and nothing starts`
  - `a 30-day token: the server sees no exchange` (no regression)
  - `the child's environment holds neither the client secret nor the exchanged token` (as today's test for the token)
  - `the exchange goes to SECRETS_API_URL only, over https, with the bearer header and no body`
- [ ] **Step 2 — Run:** `pnpm run test:cli --testNamePattern=exchange`. Expected: FAIL.
- [ ] **Step 3 — Implement.** The answer is validated with the contract's schema, as `validateResolve` does for its body. The version check comes first, as for every call. `apps/cli/package.json` becomes 0.2.0.
- [ ] **Step 4 — Run again,** then the whole CLI suite (`pnpm run test:cli`) and `tests/integration/machine/cli-client.test.ts` (one new case: the real API, a real runtime credential, `run` starts the sample child with 25 entries). Expected: PASS. `check`. **Commit** `feat(cli): a runtime credential is exchanged before the read (0.2.0)`. Push. `run-11.4.md`.

**Covers:** spec §2.4 (the CLI), §6 item 6's last sentence, Review focus 7. **Done when:** the CLI suite is green and the 30-day path made no exchange.

**This is the stop line (P-198).** If Day 1 ends here late, tell the owner in one line and ask whether to go on or to take valve 5.

---

## Run 11.5 — The automation credential (D-82)

### Task A — Issue, list, revoke (the owner's routes)

**Files:** Create `packages/operations/src/credentials/automation.ts`, `apps/api/src/routes/automation-credentials.ts`, `tests/integration/automation/issue.test.ts`. Modify `packages/db/src/repos/automation.ts`, `apps/api/src/pipeline/rate.ts`.

**Produces:** `issueAutomationCredential`, `revokeAutomationCredential` (one transaction each, shaped as the runtime pair), and in the repo: `findAutomationCredential(db, organizationId, id)`, `listAutomationCredentials`, `managedProjectCount`.

- [ ] **Step 1 — Write the failing tests** (spec §6 item 1):
  - `issue with a fresh TOTP answers 201 with a secret of the mkac shape, once; the list shows the credential with its rights, addresses, expiry and no secret; a second read of the operation shows ids only`
  - `issue without a fresh TOTP is 403 and no row exists; an admin may issue, a member gets 404`
  - `no right, an unknown right, no CIDR, a /0, a lifetime of 3,599 s and one of a year and a second are each 422`
  - `a replayed key answers credential_not_replayable`
  - `issued with replaces: the new credential's ownerId is the replaced one's, whatever its state (active, revoked, expired); replaces naming an id of nothing is 404, and nothing is issued`
  - `revoke answers 200; the credential's next request is 401; the projects it manages, their secrets and their runtime credentials are untouched, and an exchange for one of them still answers 200` (spec §6 item 9, second sentence)
  - `the sixth issuance of one person in a minute is 429`
- [ ] **Step 2 — Implement,** run, `check`. **Commit** `feat(automation): the owner issues, lists and revokes automation credentials`.

### Task B — The auth class and the boundary

**Files:** Create `apps/api/src/pipeline/automation.ts`, `tests/integration/automation/boundary.test.ts`. Modify `pipeline/route.ts`, `context.ts`, `tests/integration/authz/matrix.test.ts`.

**Produces:**

```ts
export interface AutomationPrincipal { kind: "automation"; credentialId: string; ownerId: string; rights: ReadonlySet<AutomationRight>; }
// ApiContext gains:  automation: AutomationPrincipal | null;     (principal and machine stay as they are)
export function authenticateAutomation(deps, rawHeaders, source, route, requestId): Promise<AutomationPrincipal>;
export function authorizeAutomation(deps, route, params, principal, requestId): Promise<Access>;  // scope and resolved, authority null
export function automationRecheck(ctx, principal, scope): (tx) => Promise<ErrorCode | null>;
export function intentFor(route, params, actor: Actor, body): Intent;   // intentOf(…principal…) becomes a call of it
```

**An automation request, in order:** the bearer of prefix `mkac`, else 401 → the miss limit → the row and its verifier, else 401, a miss, no audit → state, expiry and source, else 401 with `access.denied` → `rl:automation` → the capture step → validation → the path: `:project` must be a UUID of a project of this organization whose `managed_by` is the caller's `ownerId`, and `:env` an environment of that project, else `404 not_found` with `access.denied` (reason `hidden`) → the route's right, else `403 action_denied` with `access.denied` (reason `action`) → the idempotency key and the replay lookup, with principal kind `machine` → the capacity step → the states (`checkStates`) → the handler. `automationRecheck` repeats the row, the right, the managed project and the states inside the admission transaction, after `lockParents`.

- [ ] **Step 1 — Write the failing tests** (`boundary.test.ts`; spec §6 items 4 and 5). The harness's `stubs` stand in for handlers not yet written, so the pipeline alone is tested:
  - **Least privilege, table-driven over `ROUTES`:** `for each automation route with a right: a credential without it gets 403 action_denied and an access.denied row; a credential with only it passes`
  - **The same 404 (Review focus 5):** `a project of another chain, a project made by the owner, an absent UUID, a path that is not a UUID, and an environment of another managed project all answer 404 with one body` (compared but for the request id), on a GET and on a mutation
  - `from outside the bound addresses: 401 before any backend is asked` (OpenBao is stopped for the test; the control from inside answers the stub's 204)
  - `expired, and revoked: 401`
  - `no route of ROUTES with auth automation has a path under /secrets/:name, an id that ends in reveal, export, history, delete, undelete, restore, archive or reactivate, or a response that holds a value` (the boundary as a property of the contract)
  - `the automation secret on a human route, a machine route and the exchange is 401; a session cookie beside it is 400 mixed_authentication; a session cookie alone on an automation route is 401`
  - **A check made once (Review focus 6):** `the credential revoked by beforeHandler, after the pipeline passed: the mutation is refused inside its transaction and nothing is written`; the same for a project whose `managed_by` is cleared
  - `a mutation without an Idempotency-Key is 428 precondition_required; the same key and body again replays; the same key with another body is 409`
  - `the 121st request of one credential in a minute is 429`
  - `matrix.test.ts`: every automation route with every human session is 401
- [ ] **Step 2 — Implement,** run with `tests/integration/authz` whole. `check`. **Commit** `feat(api): the automation auth class — rights, managed projects, one 404`.

### Task C — The ten routes

**Files:** Create `apps/api/src/routes/automation.ts`, `tests/integration/automation/provisioning.test.ts`, `tests/fixtures/automation/tenant-provisioner.ts`. Modify `apps/api/src/routes/resources.ts` (`mutate` takes an `Actor` and an optional `managedBy`), `routes/secrets.ts`, `packages/operations/src/secrets/protocol.ts` (`SecretRequest.userId` becomes `actor: Actor`, in its three places and its callers), `packages/db/src/repos/resources.ts` (`createProject` takes `managedBy`; `listProjects` takes "managed by this owner"), `apps/api/src/routes/operations.ts`.

**The fixture** `tenant-provisioner.ts` is the generic script of the spec: `provision(api, secret, {tenant, secrets})` and `reissue(api, secret)`. It reads the secret from a file or stdin, never from an argument, sends a fresh `Idempotency-Key` per step, waits for `kvReady` through `automation.projects.get`, resolves a `202` or an `outcome_unknown` through `automation.operations.get`, honours `retry-after`, and prints ids and timings only.

- [ ] **Step 1 — Write the failing tests** (`provisioning.test.ts`; spec §6 items 2, 3, 7):
  - `with the automation credential alone, the script makes a project and an environment, waits until it is ready, writes 25 synthetic secrets and issues a runtime credential; the client secret then exchanges and resolves all 25 with the digests the script computed; each step is timed`
  - `the project is managed by the caller's chain and listed by automation.projects.list; a project made by the owner is not listed`
  - `the owner sees the project, its secrets and its credential in the human routes, with managedBy set and issuedByKind automation, and can reveal a value` (the owner keeps every right)
  - `writing an existing name answers 409 already_exists, and the value, read by the owner, is unchanged`
  - `automation.secrets.list returns name, state, version, createdAt and updatedAt for all 25 and no value` (the canaries are searched; the control is the owner's reveal)
  - `the secret's history, read by the owner, names a machine actor with the credential's id` (fact 11)
  - `automation.operations.get shows the caller's own operation, and answers 404 for the owner's operation and for another chain's`
  - `runtime credentials: issue, list (kind runtime only, no secret), revoke; a 30-day token's id on the automation revoke route is 404`
  - `with OpenBao stopped, automation.secrets.create answers 503 outcome_unknown with an operation id, and the operation read later is uncertain` (rule 3 holds for the machine actor)
  - `every audit row of the run has actor kind machine and the credential's id, and none holds a value or a secret`
- [ ] **Step 2 — Implement.** Each handler is a thin twin of the human one: it takes `ctx.automation`, builds the same request with `actor: {kind: "machine", id: credentialId}` and `recheck: automationRecheck(…)`, and calls the same protocol. `automation.projects.create` passes `managedBy: ownerId`. The runtime-credential handlers call Run 11.3's two functions with the machine actor.
- [ ] **Step 3 — Run,** with `tests/integration/secrets`, `resources`, `imports` and `operations` whole (the `actor` change touches them). Expected: PASS. Write the script's timings into `measurements.json`. `check`. **Commit** `feat(automation): projects, environments, secrets and runtime credentials by automation`.

### Task D — Recovery after a restore (spec §4, §6 item 11, in the integration suite)

**Files:** Create `tests/integration/automation/recovery.test.ts`. Modify `apps/ops/src/commands/restore-invalidate.ts`, `restore-verify.ts`.

- [ ] **Step 1 — Write the failing test:** `three provisioned tenants; restore-invalidate; every automation and runtime credential is revoked and every exchange answers 401; the owner issues one automation credential with replaces; the script's reissue lists the three projects and issues a runtime credential for every environment; each new one exchanges and resolves; the time from the issuance to the last resolve is recorded`. The control: before `replaces`, a new credential without it lists no project.
- [ ] **Step 2 — Implement:** `restore-invalidate` revokes every `automation_credential` row in the transaction that revokes the machine credentials; `restore-verify`'s credential check counts both tables.
- [ ] **Step 3 — Run** with `tests/integration/restore` whole. `check`. D-82 (P-191 to P-194, the rights table, the 404 rule, what revocation leaves). **Commit** `feat(restore): both new kinds are revoked, and one credential brings the consumers back`. Push. `run-11.5.md`.

**Covers:** spec §1.1, §2.1, §4, §6 items 1 to 5, 7, 9, 11 (integration), 14. **Done when:** the four files of `tests/integration/automation` are green and the suites named in Task C Step 3 still are.

---

## Run 11.6 — The workspace (D-70's design system)

**Files:** Create `apps/web/src/screens/automation.tsx`, `tests/browser/automation.test.ts`. Modify `packages/contracts/src/web-routes.ts` (`automation` at `/o/:org/automation`), `apps/web/src/router.tsx`, `ui/AppShell.tsx`, `screens/credentials.tsx`, `screens/project.tsx`, `screens/connect.tsx`, `api/secret-routes.ts`, `copy/*.ts`, `help/articles.ts`, `connect/commands.ts` only if a text changes (never the token block), the unit tests under `tests/unit/web/` that list screens, routes and claims.

**What the owner sees:**

- **Automation** (a new page, one click from the organization's menu): the list (name, state, rights, addresses, expiry, last use or "never", managed projects), **Issue** (name, three checkboxes, lifetime, addresses one per line, "replaces" as a choice among existing credentials), and **Revoke** with a confirmation that says what it leaves working. The secret is shown once, through `callSecret` and `useEphemeral`, with the copy button; after 30 seconds, a tab hide or navigation it is gone and the page says so.
- **Credentials** (the existing page): the issue form opens with a choice of two, each with one sentence: "A 30-day token: for a workstation or a job a person restarts" and "A runtime credential: for a server that must start by itself for up to a year". The list shows the kind and, for a runtime credential, its addresses.
- **Connect an application:** one paragraph that says when to choose which, and that the store step is the same block for both. No secret is filled in, as today.
- **A project** managed by automation shows "Managed by automation: <the chain's name>" (valve 4).

- [ ] **Step 1 — Write the failing tests.**
  - `tests/unit/web`: `SECRET_BEARING holds automation_credentials.issue and runtime_credentials.issue`; the router and the page table know `automation`; every new text is in the catalogue and passes the copy lint; the claims test has a row for each new sentence that states a fact (lifetime, "never reads a value", "revoking leaves its projects working").
  - `tests/browser/automation.test.ts` (alone): `the owner issues an automation credential with a fresh code: the secret is on the screen once, and after navigation it is in no element, no storage and no query cache` (the canary scan of `tests/browser`, extended to the two new secret shapes); `issuing a runtime credential from the credentials page shows the client secret once, and the list then shows kind runtime`; `revoke asks, says what stays, and the row reads revoked`; `a CIDR the server refuses is explained in words, with no code on the screen`; `no request left the test origin`.
- [ ] **Step 2 — Implement,** `pnpm run web:build`, run the unit files, then the browser file alone, then `tests/browser/navigation.test.ts` alone (the menu changed). `check`. **Commit** `feat(web): automation credentials, and the runtime credential beside the token`. Push. `run-11.6.md`.

**Covers:** spec §2.3. **Done when:** the browser file is green and the scan found neither new shape after navigation.

---

## Run 11.7 — The documents

**Files:** Create `docs/runbooks/automation.md`. Modify `machine-credentials.md`, `known-limits.md`, `limits.md`, `restore.md`, `consumer-local.md`, `consumer-deploy.md`, `start-here.md`, `credential-custody.md`, `audit.md` (rendered), `docs/agents/connect-an-application.md`, `tests/unit/agents/guide.test.ts`, `tests/unit/runbooks/*.test.ts` as they require, `apps/web/src/connect/runbooks.ts` (generated by `scripts/web-runbooks.ts`), `tools/agent-runner/` and the consumer fixtures (the CLI version).

- [ ] **Step 1 — `automation.md`** (new), in this order: what an automation credential is and is not (it never reads a value); issue it (the workspace, the three rights as a table generated from `AUTOMATION_RIGHTS`, lifetime, addresses); store it (a file of mode 0600, read by the client, never an argument); the ten routes, each with one `curl` example that reads the secret from a file and holds no real value, and a pointer to `/v1/reference`; the rules a client must keep (a fresh `Idempotency-Key` per step, read the operation on `202` and on `outcome_unknown`, honour `retry-after`, wait for `kvReady`); rotate it (`replaces`, then revoke the old one); revoke it (what stays working); **after a restore** (issue one with `replaces`, run the re-issue).
- [ ] **Step 2 — `machine-credentials.md`:** both kinds, a table of when to choose which, the exchange in one paragraph, what revocation does at the product and in OpenBao (P-189, as measured). **The token block is not touched.**
- [ ] **Step 3 — `known-limits.md`,** one line each, plainly:
  - a client secret is checked by the API, not by OpenBao (D-81's database-writer line, as written there);
  - a token minted before a revocation lives up to 15 minutes in OpenBao, and the product refuses it at once;
  - a lost exchange answer leaves a token nobody holds, for at most 15 minutes;
  - replicas that share one runtime credential queue (`busy`); give each server its own;
  - automation cannot update, delete or read a secret, and manages only projects it or its chain created;
  - bound addresses are what the edge reports; a credential bound to an IPv4 range refuses the same caller over IPv6;
  - a restore with the new kinds is proven in the integration suite, not yet on a host;
  - `cli-v0.1.2` given a runtime credential answers exit 77: it needs `cli-v0.2.0`;
  - production serves `host-v0.9.3` and has none of this until after W-2.
- [ ] **Step 4 —** `limits.md` (P-196's rows); `restore.md` (the step "after the opening: for each automation chain, the owner issues one credential with `replaces`; its holder re-issues"; and that the restore revokes both kinds with no added time); `credential-custody.md` (names and places only); the consumer runbooks and `start-here.md` (`cli-v0.2.0`; one sentence and a link for the runtime credential); the agent guide (a short section "A server that runs longer than 30 days", the CLI version, the exit codes unchanged).
- [ ] **Step 5 — Tests:** `guide.test.ts` and `tests/unit/runbooks` green, with one new assertion each: `the rights table of automation.md is AUTOMATION_RIGHTS`; `every limit automation.md and machine-credentials.md name is LIMITS's`; `the token block is still byte for byte the same in every place` (already there: it must stay green untouched); `no file names a secret of the mkrc or mkac shape` (the lint).
- [ ] **Step 6 —** `node scripts/web-runbooks.ts`; `check`. **Commit** `docs: automation.md, both credential kinds, the new limits said plainly`. Push. `run-11.7.md`.

**Covers:** spec §2.4. **Done when:** every document test is green and `known-limits.md` holds the nine lines.

---

## Run 11.8 — The freeze, `host-v0.10.0`, `cli-v0.2.0`, staging

### Task A — The freeze

- [ ] **Step 1 — Full CI by hand** (`gh workflow run ci --ref session-11`, about 16 min). While it runs:
  - **The fresh-context review** (one reviewer, the most capable model, read-only). It gets `git diff host-v0.9.3..HEAD`, the spec, `known-limits.md` and Doc 10 §4.1. It does not get this plan or the run notes. Its questions:
    - (a) Can a client secret, an automation secret or an exchanged token reach a log, a table, an operation, an audit row, an error, a URL or the browser's storage?
    - (b) Can an automation credential read a value, or reach a project its chain does not manage, by any route, replay, operation id or timing of a revocation?
    - (c) Can a token be attributed to the wrong credential through `meta`, and what would that give its holder?
    - (d) Is any existing assertion weaker than before, and are the two machine bodies and the token block unchanged?
    - (e) Does any code path still treat a row without an accessor as unfinished?
    - (f) Is every denial in the new tests paired with a success, and every "not found" search with a control?

    Saved as it came, as `docs/evidence/session-11/review.md`, with severities. High and Critical are fixed before the release. A Medium is fixed or gets a `known-limits.md` line.
  - **The claims walk:** `claims.md`, one row for each catalogue entry, help article and runbook sentence this session wrote that states a fact, with its evidence.
- [ ] **Step 2 —** CI green, the review without an open High. **Commit** `docs: Session 11's review and claims`. Push.

### Task B — The releases

- [ ] **Step 1 — The CLI:** `pnpm run cli:release -- --version 0.2.0`, published as D-44 does. Then `gh workflow run ci --ref session-11 -f jobs=cli-matrix -f cli_release=cli-v0.2.0` (about 5 min; Linux and macOS).
- [ ] **Step 2 — The host:** in the clean clone, `node infra/release/build.ts --version 0.10.0 --out ~/mykey-release/host-v0.10.0`; `gh release create host-v0.10.0 --target session-11 …`; `node scripts/release-candidate.ts --session 11 --release C:/Users/<you>/mykey-release/host-v0.10.0 --cli cli-v0.2.0`.

### Task C — Staging

- [ ] **Step 1 — The deploy, as its own proof:** `MYKEY_RELEASE_NEW=<host-v0.10.0> MYKEY_RELEASE_PREVIOUS=<host-v0.9.3> pnpm run test:staging tests/staging/deploy.staging.test.ts`. Expected: PASS, migration `0019` applied, staging on `host-v0.10.0`. Record the deploy in the candidate.
- [ ] **Step 2 — The two new files,** written now, one at a time. The caller's address is read from the host's own access log for one request of the test (`sshExec`), used as a `/32`, and never written down.
  - `tests/staging/runtime-credential.staging.test.ts`: the staging owner issues a runtime credential bound to the caller; exchange; resolve 25 values through the public name with the digests of the owner's export; metadata; `expiresAt` at most 900 s away; a credential bound to `192.0.2.0/24` is refused from here (Review focus 4, through the real edge); revoke, then exchange 401 and the minted token 401; the fleet (valve 2). Each step is timed into `measurements.json`. In `finally`: everything revoked, the project archived.
  - `tests/staging/automation.staging.test.ts`: the staging owner issues an automation credential; `tenant-provisioner.ts` provisions one tenant with 25 secrets and a runtime credential; a server started by `cli-v0.2.0` from that credential answers with the 25 digests; the boundary's five denials, each beside its control; `reissue` after the owner revokes the runtime credentials. Timed. In `finally`: revoked and archived.
- [ ] **Step 3 — No leak** (`token-sweep.staging.test.ts`, extended): the client secret, the automation secret and the exchanged token the two files held are found **0** times in the API's journal, the provisioner's journal, Traefik's access log, a `pg_dump` and OpenBao's audit file (`countOnHost`), with a control found on every surface. After the pull request's CI: `node scripts/sweep-ci.ts <logs>` with the two new shapes added to it.
- [ ] **Step 4 — No regression** (spec §6 item 12), one file at a time:
  - `pnpm run test:cli --release <the downloaded cli-v0.1.2>` against staging on `host-v0.10.0`, with a 30-day token;
  - every staging file that Session 10's `results.json` names as run on staging, in that order: stale tests are fixed as tests, never by weakening what they assert. `probe.staging` runs last and alone (its blackout).
  - Not run: `drill`, `redrill`, `key-loss`, `kms-expiry` and the agent files. They are `earlier` in the manifest.
- [ ] **Step 5 — `pnpm run test:consumers`** (about 17 min): both runbooks with `cli-v0.2.0`; the deploy runbook's rehearsal uses a runtime credential (valve 3).
- [ ] **Step 6 —** restore the evidence files of earlier runs that these files rewrote. `run-11.8.md`. **Commit** `docs: host-v0.10.0 and cli-v0.2.0 on staging`. Push.

**Done when:** staging serves `host-v0.10.0` with every named file green, or the note names each file that is not and why.

---

## Run 11.9 — The gate

- [ ] **Step 1 — `acceptance.md`** (P-195): the spec's 14 items as `S11-1` to `S11-14`, each on one line with its status and its evidence (a test file and name, or a staging file with its figures). Expected, written from the results and not from this plan: item 10 NOT APPLICABLE (fact 7); item 11 PASS at integration and NOT PROVEN on staging; item 3's update half NOT IN SCOPE (decision 4).
- [ ] **Step 2 — The manifest of `host-v0.10.0`.** `proof-map.json` and `results.json` start as Session 10's; the entries this session ran name its results, every other entry is `earlier` with the release it keeps. `node scripts/release-manifest.ts --session 11`, then `--apply`. The counts are built, not typed. No registry row is added.
- [ ] **Step 3 —** `gh pr ready <n>`: the full suite at the head. While it runs, Steps 4 and 5. A red run is fixed before the report is final. Code changed after the freeze gets a review of that change alone, appended to `review.md`.
- [ ] **Step 4 — `report.md`:** the result, item by item of the goal; "what ran where, once", with each run's real time against its box; the measurements (issue, exchange, resolve, the provisioning steps, the fleet's slowest start, the recovery); the four OpenBao measurements; valves taken and deviations; open issues (`secrets.update`, assignment, the staging restore, IPv6); "What the next session must know".
- [ ] **Step 5 — CLAUDE.md:**
  - "Where we stand": Session 11 in the table; staging on `host-v0.10.0`, production on `host-v0.9.3`; 57 routes;
  - "What the product has now": the two credential kinds, the exchange, the automation routes, the metadata route;
  - "Architecture": the verifier, the attribution by `meta`, the automation auth class and the chain;
  - "Open items" and "Dated": the pin's line removed; **production gets `host-v0.10.x` and consumer-1 `cli-v0.2.0` after W-2**; the next re-drill carries the new kinds; a production fix before W-2 is cut from the `host-v0.9.x` line;
  - "Commands": the new test files;
  - "Things already learned": what this session learned, in its section; remove what no longer holds ("since Session 7 no route has a pending body" stays true; "19 tables" becomes 20; "the route list is frozen at 41").

  `check`. **Commit**, push.
- [ ] **Step 6 — The owner's message,** short:
  - **Proven,** in five lines at most.
  - **Not proven,** in as many lines as it takes.
  - **Yours next:** nothing before W-2; then production's journey for `host-v0.10.x`.
  - **Asked:** "merge", yes or no.

  The answer is recorded with its date in `owner-requests.md`. Gate F is not asked: it is W-2's.

## Session 11 end state

- **A runtime credential** is issued by the owner with a fresh TOTP, or by automation. Its client secret is shown once and stored only as a verifier. It is exchanged for a 15-minute token that the unchanged machine routes accept, and `cli-v0.2.0` does that by itself. Revoking it stops it at the product at once.
- **An automation credential** provisions projects, environments, secrets and runtime credentials within the projects its chain manages, from its bound addresses, with the rights it was given. It reads no value, and every other project answers it the same 404 as an absent one.
- **`machine.metadata`** serves version and times to either machine kind.
- **A restore** revokes both kinds, and one credential issued with `replaces` re-issues every consumer's access: proven on real stores in the integration suite, not yet on a host.
- **Nothing that existed changed:** the two machine bodies, `cli-v0.1.2`, the token block, OpenBao's policies and the authority matrix are byte for byte what they were.
- **Staging** serves `host-v0.10.0`. **Production** serves `host-v0.9.3` (the postgres pin) and gets the rest after W-2. **Stage 1 stays open**, and Gate F is decided again on 20 Dec 2026.
