# MyKey Stage 1 — Session 3 (Identity, access and resources) Execution Plan

> **For the executing agent:** carry this plan out run by run, in the order given in "Run order". If you have the superpowers skills, use `superpowers:executing-plans` (inline execution is the owner's standing preference; one fresh-context review at the gate). Steps use checkbox (`- [ ]`) syntax for tracking. You do not re-decide anything in Doc 10 §3 / §8 or in the "Planner decisions" table below; if one proves wrong, write a one-paragraph decision record and continue (Doc 10 §1). No fallback of Doc 10 §8.1 is open in this session: the auth, token and late-write designs were proven in Session 2 (GO, no fallback).

**Goal:** By the end of Day 5 (14 November 2026), on staging, an owner created by the operator tool signs in with password and TOTP, recovers through an operator reset, and creates projects and environments through the API; a provisioner process makes each environment ready in OpenBao; and a synthetic second organization, an admin, an editor, a reader and an ungranted member are provably shut out of everything the authorization matrix denies them.

**Architecture:** One request pipeline in `apps/api`, driven by the frozen route table of `@mykey/contracts`: gate → limits → authentication → membership and ancestry → visibility → action → state → freshness → handler, with the error envelope, `no-store`, output validation and an audit record on every path. A route cannot be mounted outside it. Identity is `@mykey/auth` from Session 2, now seated on that pipeline and completed: sign-in that checks account state and epochs, sessions with idle and absolute expiry, fresh-TOTP, a product-owned password change, throttling in PostgreSQL, and an operator-started reset. Operator authority never enters a public process: the owner bootstrap, the reset and the organization's OpenBao set-up are commands of `apps/ops`, run from the workstation through `scripts/host.ts`. `apps/provisioner` is a separate process with its own database role and its own AppRole credential; it takes value-free jobs (an operation id, nothing else) from pg-boss, fed by a transactional outbox, makes an environment's machine policy and token role, reads them back, and sweeps for drift.

**Tech stack:** everything pinned in Sessions 1–2. First used here: `pg-boss` 12.38.1 (already in the catalog and the lock file). No new dependency is planned; one that proves necessary is pinned in the run that adds it, after the advisory check of Run 1.3 Step 2.

**Spec:** `docs/doc_10_mykey_stage_1_compressed_implementation_plan_v1.0.md` §1–§5, §7 "Session 3", §8, §9. Behaviour: Doc 04 §1 (model, §1.1 authorization matrix, §1.2 state precedence), §2 and §2.1, §3, §8 (FR-1.55, FR-1.56, FR-1.59, FR-1.80) and §8.1; acceptance AC-1.01–1.06, 1.08–1.10, 1.35. Design: Doc 06 §2, §3, §4 (all), §5 ("Organization bootstrap"), §6.1–6.2 (lock order, steps), §7.1, §9, §11, §12, §14.1. Previous session: `docs/evidence/session-2/report.md` ("What Session 3 must know"), `docs/auth-route-contract.md`, D-14, D-15, D-17, D-19, D-20. Old runbooks for ideas only: D08-S11–S17.

**Provider facts used here** were read on 12 November 2026 from the installed `better-auth@1.7.19` package (`dist/cookies/index.mjs`, `dist/context/create-context.mjs`), the pg-boss documentation (`docs/api/constructor.md`, `docs/api/utils.md`) and the OpenBao `v2.7.2` documentation. Nothing was executed. Where a step says "(source reading)", the test in that step is the first real evidence — when the observation differs, the observation wins and goes into the run note.

---

## Global constraints

Every run's requirements include this section and the "Global constraints" of the Session 1 and Session 2 plans (synthetic data only, real stores for proof, a skipped test is not a pass, the forbidden components, pins, limits live once in `@mykey/contracts`, remote work through `scripts/host.ts`, secrets only on stdin).

- **Doc 10 §4.1 is at stake in every run of this session.** Read the eleven rules before starting. The ones this session can break: rule 2 (a password, TOTP seed or code, recovery code, session token or reset link in a log, a job, a test diff or the transcript — see Review focus 3), rule 5 (permissions from current database state on every request; hidden and absent share one 404), rule 6 (password alone grants nothing; no signup, no MFA-disable, no trusted device), rule 8 (the audit record is committed before the effect or the answer; no audit, no action), rule 11 (no "active" without a read-back).
- **One pipeline.** Every HTTP route of the API is registered through `mountRoute` (Run 3.1) from its `RouteDef`, or through `mountAuthRoutes` for the routes of `docs/auth-route-contract.md`. A unit test lists the routes of the Hono app and fails on any other. A handler returns only error codes its route lists; a handler never writes SQL (repositories in `@mykey/db` do, and each takes a scope object first).
- **Contract changes.** The route list stays frozen (D-15). A run that fills a pending body, adds a field to `RouteDef` or changes an error list does it in a commit titled `contract: …` that also regenerates `openapi.json` and shrinks `tests/unit/contracts/pending-routes.snapshot.json`. Auth routes under `/v1/auth` are not in `ROUTES`; they change through `packages/auth` and `pnpm run auth:contract` in the same commit.
- **A denial must be a denial.** Every "denied" assertion states the exact status and code and is paired with a control: the same request by an authorised identity succeeds. A 404 from a mistyped path, a 401 from an expired fixture session and a 422 from a bad body are not denials (Review focus 1).
- **Secret material in tests.** A test never puts a password, seed, code, token or link into an assertion that prints it on failure: compare a digest, a length or a boolean (`expect(text.includes(token)).toBe(false)`). Canaries are assembled at run time (never a literal `MYKEY_CANARY_` followed by 32 characters).
- **Time.** Expiry and admission use database time (`now()` in the statement), never the API's clock. Tests move time by ageing rows with the superuser, and every limit is tested on both sides (limit − 5 s is valid, limit + 1 s is not). TOTP uses the API's clock with the ±1 step window; tests pass `now`.
- **Statuses.** Session 3 proves product code against real stores and on staging, but not on the frozen release candidate. The registry therefore moves an item to `SPIKE_PASS` or `FAIL`, never to `PASS` (`evidence:verify` keeps refusing `PASS` until Run 8.7 — P-38). A `SPIKE_PASS` needs a run note that states the id and the status on one line, for example `FR-1.07 SPIKE_PASS — …`; the note of an item proven on staging says so.
- **Migrations.** One migration per run that needs one, numbered in merge order (`0004` … ); never edit a merged migration. Every new table, column or grant extends `tests/harness/privilege-matrix.ts` and `docs/runbooks/db-globals-inventory.md` in the same commit — the catalog sweep fails on anything unknown.
- **Staging.** The synthetic owner of staging is created once (Run 3.2) and reused; other staging identities are created per test run with fresh ids and removed at the end with the superuser (test hygiene, not a product path). A staging test begins by asserting its target, as in Session 2. `pnpm run test:staging` reboots staging and takes about 1.5 hours: inside a run, execute one file — `node scripts/require-staging-env.ts && pnpm exec vitest run --project staging tests/staging/<file>`.
- **Production is not touched** before the gate run, and there only with the owner's word (it is still at migration `0002` with its Run 2.5 image).
- **Every run ends with:** `pnpm run check` green, the run's tests green, a commit on branch `session-3`, and a run note `docs/evidence/session-3/run-3.N.md` (template of Run 1.1: `What was done`, `Commits`, `Commands and results`, `Deviations and decisions`, `Open issues`).
- **Git.** Never commit on `main`. Worktrees, when used, live under `C:/Users/gmpar/mykey-wt/` (outside OneDrive). The pull request to `main` is opened at the gate and merged only when the owner says so.

## Review focus

Five conditions the specifications imply but do not spell out, most likely to bite first. Each has a test pinned in the run named.

1. **A denial test passes for the wrong reason.** The fixture session has expired, the path has a typo, the body fails validation — and the test sees its 401, 404 or 422 and goes green with the protection removed. → the control rule above; the matrix test of Run 3.7 Task C reads the `access.denied` audit row of every denied cell and asserts the recorded reason (`hidden`, `action`, `state`), and fails when a deny cell has no allow cell for the same request by another fixture user.
2. **The only owner is locked out with no way back.** Five wrong codes lock the account for fifteen minutes; a reset link lasts fifteen; a wrong `SameSite` or Origin setting refuses every sign-in on the real host name. → Run 3.3: a throttle lock never blocks an operator command, and a new reset link issued while the account is locked redeems; Run 3.6: an expired link leaves the account pending and a re-issued one works; Run 3.8 Task D and Run 3.10 sign in through the public host name of staging, not through a tunnel.
3. **A secret reaches the transcript through tooling.** The bootstrap password, the reset link, recovery codes printed by an `ops` command; a token inside a Vitest failure diff; a request body inside an error log. → `ops` commands write secret output to a 0600 file under `~/.mykey/out/` and print the path; a unit test runs every `ops` command with canary inputs and finds none in stdout or stderr (Run 3.2 Task B); the logger accepts typed entries only and a second pass drops denied key names (Run 3.1 Task C); Run 3.10 sweeps logs, dumps and tables.
4. **Time is taken from the wrong clock.** The API host and PostgreSQL disagree by seconds; a test "expires" a session by sleeping; a TOTP code is checked against a clock two steps off. → the Time rule above; `resolveSession` compares in SQL (Run 3.5); Run 3.10 asserts `chronyOffsetMs` under one second on staging before the TOTP steps.
5. **A new image starts closed and nobody notices why.** The gate file is missing, a key ring is empty, the provisioner cannot log in: `/health` is down, the probe alerts the owner's Telegram, and the cause is one line in a log nobody reads. → every start-up refusal is one typed log line naming the missing thing (never its value); `host.ts <host> status` reports the gate state and the provisioner's last sweep (Run 3.1 Task F, Run 3.8 Task D); the kick-off message tells the owner that staging alerts during this session's deploy windows are expected.

## Planner decisions

Settled here so the executor does not have to choose. Each one marked **DR** gets a decision record in the run shown.

| # | Decision | Why | Run |
| --- | --- | --- | --- |
| P-38 | The registry ceiling in Session 3 is `SPIKE_PASS`. Evidence moves to the Session 3 run notes; the note field says `product code, real stores` or `staging`. G-AUTH "closed on the integrated product" is a line in the session report, not a `PASS`. | Gate R counts scenarios on one frozen build (Doc 10 §2); `registry-verify.ts` already says Session 8 lifts the rule. | all |
| P-39 | The session cookie keeps Better Auth's name `__Secure-better-auth.session_token` and gains `SameSite=Strict` through `advanced.cookies.session_token.attributes`. It has no `Domain` attribute (host-only). `__Host-` is not used. The OpenAPI security scheme takes the real name. **DR D-27.** | FR-1.02 requires Strict and host-only. In 1.7.19 the cookie getter can only prefix `__Secure-`; a `__Host-` name would mean copying the library's cookie code (source reading). Doc 06 §9 says "preferably". | 3.1, 3.2 |
| P-40 | Routes are mounted from the contract: `mountRoute(app, deps, routeId, handler)` reads method, path, auth class, idempotency, schemas and error list from `ROUTES`. Every contract route is mounted from the first day; one with no handler yet passes through every check of the pipeline and then ends in `404 not_found` (so an anonymous call to it is 401 and a call on a blocked scope gets the state error, on staging too). `RouteDef` gains `action` and `scope` (Run 3.7), so authorization is part of the frozen contract. | Doc 06 §9: the freeze covers "authorization"; one registration point is what makes "every route" tests possible. | 3.1, 3.7 |
| P-41 | No 500, 413 or 415 and no new error code: an oversized, mistyped or unparsable request is `400 malformed_request`. An unexpected exception answers `503 dependency_unavailable` and logs `{event:"unhandled", errorClass}` — the class name only. Output that fails its schema is never sent: `503 dependency_unavailable`, log `output_invalid`. **DR D-26.** | Doc 04 §8.1 lists no 500 case; D-14 fixes thirty codes. | 3.1 |
| P-42 | The logger is the typed-entry writer the API already has, not pino. First defence: an entry type per event, with no free-form object. Second defence: before writing, any key named `authorization`, `cookie`, `set-cookie`, `password`, `token`, `code`, `secret`, `value`, `link` (any case, any depth) is replaced by `"[redacted]"`. **DR D-26** (amends the mention of pino in Doc 06 §12). | Doc 10 Run 3.1 asks for "log redaction as a second defence", not for a library; the API runs under Node's permission model without worker threads. | 3.1 |
| P-43 | Gate record v1: `/etc/mykey/gate/gate.json`, root-owned, directory mounted read-only at `/run/mykey/gate`. Content `{"version":1,"state":"open"\|"closed","gateEpoch":<int>,"hostInstanceId":"<uuid>","writtenAt":"<iso>"}`, at most 4,096 bytes, strict. Open only when the file is a regular file, parses, has `state:"open"` and names the `MYKEY_HOST_INSTANCE_ID` of `host.env`. Read afresh for every request. The bindings to backend incarnation, restore pair, release and report hash are version 2, Run 6.7; the reader treats an unknown version as closed. **DR D-26.** | Doc 06 §14.1; Doc 10 Run 3.1 wants the check now and Run 6.7 the verified opening. | 3.1 |
| P-44 | `packages/audit` exports one append function over a closed list of actions, each with a strict `details` schema of ids, enums and counts. It writes inside the caller's transaction when given one. A failed append is `503 audit_unavailable` and the action does not happen. Denials of an authenticated caller are audited as `access.denied`. | Rule 8; FR-1.56. The full coverage walk is Run 6.1. | 3.1 |
| P-45 | Operator commands live in `apps/ops` and run on the workstation: `node scripts/host.ts <host> ops <command>` opens the tunnels and logs in as `maintenance`. Migration `0004` gives `maintenance` `INSERT` on `audit.event` and the writes on schema `auth` that bootstrap and reset need. Account code that only an operator may call is the entry point `@mykey/auth/operator`, which `apps/api` must not import (skeleton test). **DR D-27.** This also answers the open question of Run 4.5 (which identity records a reconciliation): `maintenance`, unless that run finds a reason against. | FR-1.01, FR-1.04, FR-1.55: absent from public entry points. The `maintenance` password is already kept on the workstation only. | 3.1, 3.2 |
| P-46 | Passwords: 12 to 1,024 characters and at most 1,024 UTF-8 bytes, checked by the product (bootstrap, change, reset); Better Auth is configured with `minPasswordLength: 12`, `maxPasswordLength: 1024`. The bootstrap reads the initial password from stdin and never prints it. **DR D-27.** | Doc 06 §11 fixes only the maximum; the library's default maximum is 128, which would refuse passwords the limit allows (source reading). | 3.2 |
| P-47 | Request source: when the TCP peer is the configured edge address (`MYKEY_TRUSTED_PROXY`, 10.78.1.2 on the hosts) and `X-Forwarded-For` holds exactly one valid address, that address; otherwise the TCP peer. Nothing else reads a forwarded header. | Doc 06 §9: trust only the actual edge hop. | 3.3 |
| P-48 | Throttling: counters in `app.rate_limit`, key `HMAC-SHA-256(rate key, scope ‖ 0x00 ‖ subject)`, windows on database time. Per source and phase: 5 attempts a minute, successes included. Per account and phase: 5 failures inside the current and the previous 15-minute window lock the account for 15 minutes. Phases: `password`, `factor` (TOTP, activation, step-up and recovery codes together), `reset`. A locked or over-budget attempt answers `429 rate_limited` before any credential is checked, the same for known and unknown accounts. The general 300/120/60-a-minute limits are Run 6.3 and use the same counter. **DR D-28.** | Doc 06 §11; FR-1.07. Two adjacent fixed windows would otherwise allow nine failures. | 3.3 |
| P-49 | Password change is product-owned: one transaction that locks the account and session, requires fresh TOTP, verifies the current password with Better Auth's verifier, stores the new hash, increments `credential_epoch`, deletes every other session and writes the audit row. The native `/change-password` endpoint is no longer called; `NATIVE_ALLOWED` shrinks to four. The current session stays `mfa_complete`. **DR D-29** (amends D-19). | Doc 06 §4.2: "migrate only the verified current session"; the native call replaced the session with a password-only one and could not be made atomic with the revocation. | 3.5 |
| P-50 | Session lists and single revocation are product routes under `/v1/auth`: `GET /v1/auth/sessions`, `POST /v1/auth/sessions/revoke` with `{sessionId}`; step-up is `POST /v1/auth/totp/step-up`. They are added to the auth route contract. | The native list and revoke routes hand out tokens (D-19) and stay denied; `ROUTES` is frozen and holds no auth route but reset completion. | 3.4, 3.5 |
| P-51 | Reset: table `auth.reset_token` holds a keyed verifier, the kind (`password` or `mfa`), expiry and consumption. `password` completes with the new password and a current TOTP or recovery code, in one transaction, and issues no session. `mfa` consumes the token, retires the old enrollment and codes, stores the new password while the account stays `recovery_pending`, and sets the cookie of a challenge session that can only enroll, activate or sign out; activation makes the account `active` and deletes every session. Every failure of `reset/complete` is the same `401 unauthenticated`. **DR D-30.** | Doc 06 §4.3. Keeping the account `recovery_pending` until activation is what makes the new password unusable before enrollment, without a second password column. | 3.6 |
| P-52 | Authorization actions are a closed list in `@mykey/contracts` and every route names one (or none). A project is visible to a member who holds a grant on it or on one of its environments; an environment when granted directly or through its project. Hidden is `404 not_found`, byte-identical to absent except for the request id; visible without the right is `403 action_denied`. **DR D-31.** | Doc 04 §1.1, FR-1.11; a member with an environment grant must be able to address that environment. | 3.7 |
| P-53 | State precedence (Doc 04 §1.2) is one table in the pipeline, keyed by a state class derived from the route's action and method. Organization `provisioning` or `failed` → `409 state_conflict` on every organization route; organization `needs_review` → `503 backend_inconsistent`. A project or environment in `needs_review` → `503 backend_inconsistent` for secret and credential actions, while non-secret lists still answer. A scope in `needs_review` records why in a new column `review_reason` (`backend_inconsistent`, `provisioning_failed`; later runs add values by migration). Archive, reactivate and credential revocation are class `lifecycle`: only the organization rule applies and Runs 5.2 and 5.3 decide the rest. **DR D-31.** | FR-1.12, FR-1.16; the owner must be able to see why a scope is blocked without reading logs. | 3.7, 3.8 |
| P-54 | An organization's OpenBao set-up is an operator command (`ops provision-organization`), a durable operation with one step per backend object; `apps/provisioner` only makes and verifies `machine-env-*` policies and token roles. The provisioner policy gains `read` on `kv/config`, `sys/mounts/kv` and the three policies `runtime`, `issuer`, `provisioner`, so that one identity can verify the organization's configuration and sweep for drift. The authority matrix is regenerated. **DR D-32** (amends D-17). | Doc 06 §5: namespace set-up is operator authority; §2: the provisioner provisions environments. Nobody in a running process could otherwise notice a changed mount or policy. | 3.8 |
| P-55 | Provisioning effects are deterministic writes of fixed content, so a step is safe to repeat after a comparison: equal → verified, absent → write, different → review, never overwrite. This is the reconciliation rule for effects without an operation marker (the open issue of D-20 for Run 3.8). AppRole secret ids are the one non-repeatable effect: a retry destroys every secret-id accessor of the role before it makes the one it delivers. **DR D-32.** | A late duplicate of an identical write changes nothing; a duplicate secret id would be a credential nobody tracks. | 3.8 |
| P-56 | On the hosts every AppRole role is bound to its container's address on `mk-bao` (`secret_id_bound_cidrs` and `token_bound_cidrs`: API 10.78.3.3/32, provisioner 10.78.3.4/32). Secret ids still do not expire; rotation is part of Run 6.8. Closes M14 as far as Session 3 goes. | Defence in depth Doc 06 §5 allows; the binding costs one field and is testable through the tunnel, which has another address. | 3.8 |
| P-57 | Alerts in this session leave the host the only way a host can speak: the heartbeat. `status.sh` adds `reviewOpen` (scopes in `needs_review`, counted through the PostgreSQL container's local socket) and the probe gains the condition `review_open`. Every other FR-1.63 condition stays with Run 6.4. | `api`, `provisioner` and `postgres` have no route out (D-21); AC-1.09 needs a delivered alert now. | 3.8 |
| P-58 | A create or rename of a project or environment is a database-only operation that is `succeeded` in the transaction that makes the change: the route answers 201 or 200 with the operation envelope and `result` ids. Provisioning of the new environment is a second operation of principal `system`, carried by the outbox. Replay uses the unique key of `app.operation` and an HMAC fingerprint (key ring `replay-fingerprint`); `Idempotency-Key` is a UUID. Tombstones, expiry and the status routes stay with Run 4.1. **DR D-33.** | FR-1.14: the application operation is the durable record; provisioning "may complete asynchronously". Doc 06 §6.3 fixes the fingerprint. | 3.9 |
| P-59 | Lists of projects and environments are keyset pages by immutable id, `limit` 1–100 (default 50), cursor `base64url(payload).base64url(HMAC)` binding route, scope, last id and `organization.resource_generation`, which a create increments. A changed generation is `409 listing_changed`. Key ring `cursor-mac`. Run 4.3 reuses the cursor module. **DR D-33.** | Doc 06 §9 "Metadata lists". | 3.9 |
| P-60 | Deploys to staging happen in Runs 3.1 (skeleton and gate), 3.8 (identity, pipeline and provisioner) and 3.10 (everything). Run 3.2 only installs the key files and bootstraps the staging owner through the tunnel — it deploys nothing, because an API with auth routes and no throttling must not start. Runs 3.2–3.7 and 3.9 are proven on the local stack and proven again on staging at the gate. | A deploy is about ten minutes and closes staging; three are enough to find host-only faults early. | 3.1, 3.8, 3.10 |

## Carried items

The eighteen minors and the open issues of the Session 2 report, each with its place.

| Item | Where |
| --- | --- |
| Sign-in does not check `account_state`; epochs | Run 3.2 Task C |
| Change-password loses the factor | Run 3.5 (P-49) |
| The 30-minute idle limit is not enforced | Run 3.5 |
| Recovery and step tables grow without clean-up; expired sessions | Run 3.5 Task C (the timer for `ops auth-cleanup`: Run 6.9) |
| Origin check and throttling of auth routes | Runs 3.7, 3.3 |
| Effects without an operation marker: provisioning | Run 3.8 (P-55). Archive, issuance, revocation, soft delete stay with Runs 5.3, 5.2, 4.6 |
| M13 `kvRead(path, 0)` accepted; `tokenRevokeSelf` maps a 5xx like a read; D-17 text on the foreign-accessor 500 | Run 3.8 Task A Step 1 |
| M14 AppRole secret ids not bound | Run 3.8 (P-56) |
| M15 key ring picks the current key by text order | Run 3.2 Task A |
| M16 the auth relay parses every 2xx body as JSON | Run 3.2 Task C |
| M17 `scripts/host.ts` takes SSH and redaction code from `tests/harness/` | Run 3.2 Task A |
| Reconciliation audit identity | P-45; Run 4.5 confirms |
| M1 root token unrevoked on the staging host; M5 `bao-init` parse error may quote input | not this session — the run that first initialises OpenBao on production (Run 8.1) |
| M2 pair capture leaves secrets until closed | Run 6.5 |
| M3 `maint` runs any command; M7 spike Compose file pushed to production; npm in the API image | Run 6.9 |
| M4 `scripts/probe.ts` prints without the redacting logger | Run 3.8 Task D (the file is edited there) |
| M6 listener-timeout comment; M8 KMS directory mount; M12 `chronyOffsetMs` sign; unloaded-firewall heartbeat field; Worker self-monitoring | Run 6.4 |
| M9, M10, M11; IPv6 scan; shared-address egress | Session 8 |
| `key-loss.staging.test.ts` leaves key L-C active | with the `kms-cert-expiry` checkpoint, 12 Dec 2026 |
| Production update (migrations, image) | Run 3.10 Step 5, only with the owner's word |
| R2 fixture guard 15 Nov 09:42 UTC; checkpoint `pairs-lock-session-gate` from 15 Nov 10:42 UTC; `.trivyignore.images` 20 Nov | Run 3.10 Step 3 |

## Session start (before Run 3.1)

- [ ] **Step 1 — Branch.** `git switch main && git pull && git switch -c session-3 && git push -u origin session-3`. Commit this plan as `docs: session 3 plan` if it is not on `main` yet.
- [ ] **Step 2 — One message to the owner**, then start Run 3.1 without waiting. Save the text as `docs/evidence/session-3/owner-requests.md`. It contains:
  1. **Nothing to buy and nothing to click in this session.**
  2. **Expect Telegram alerts from staging** during three deploy windows (Runs 3.1, 3.8, 3.10 — staging starts closed after every deploy until its gate is opened) and one deliberate drill (Run 3.8: a policy is removed on staging to prove the alert). Each is announced in the run note; an alert outside those windows is real.
  3. **One yes/no, needed only at the gate:** may the gate run bring production to the current migrations and API image, with its gate closed? Default when there is no answer: no — production stays as it is and the item is carried to Session 4.
  4. **For information:** the staging seal certificate still expires on 12 Dec 2026; `.trivyignore.images` expires on 20 Nov 2026 and the image scan in CI turns red that day unless it is reviewed again (proposed for the Session 4 gate).
- [ ] **Step 3 — When the owner answers** (in any run): record the answer in `owner-requests.md`, commit.

## Run order

```text
identity track                                  resource track

3.1 ─→ 3.2 ─┬─→ 3.4 ─→ 3.5 ─→ 3.6               3.1 ─→ 3.8 Tasks A–C (needs 3.2 for the owner binding)
            └─→ 3.3 (∥; merged before 3.4)              │
                        3.4 ─────────────→ 3.7 ─────────┴─→ 3.9 ─→ 3.10
```

- Inline execution takes the linear order 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10. Nothing else is required; the graph only says what may be reordered when a run is blocked.
- Run 3.3 touches `packages/auth/src/throttle.ts`, its own tests and one hook in `routes.ts`; it is the only run that could go to a parallel worktree.
- Run 3.7 needs `mfa_complete` sessions (Run 3.4) for its fixtures. Run 3.9 needs the pipeline's authorization (3.7) and the provisioner (3.8).
- Four runs add a migration: 3.1 (`0004_operator_and_jobs`), 3.6 (`0005_reset`), 3.7 (`0006_review_reason`), 3.9 (`0007_resource_generation`). Under a reordering, whoever merges second regenerates its number.

## File map

```text
packages/contracts/src/        routes.ts (action, scope, six pending bodies filled)  authz.ts  openapi.ts (cookie name)
packages/db/src/               tx.ts  scope.ts  repos/{organizations,memberships,projects,environments,operations,outbox,rate-limits}.ts
packages/db/migrations/        0004_operator_and_jobs.sql  0005_reset.sql  0006_review_reason.sql  0007_resource_generation.sql
packages/audit/src/            events.ts append.ts index.ts
packages/auth/src/             keys.ts (rings)  routes.ts (AuthRouteEnv)  sign-in.ts  sessions.ts  fresh.ts  password.ts  throttle.ts
                               reset/complete.ts   factors/elevate.ts (step-up, reset challenge)
                               operator/{index,bootstrap,reset}.ts            entry point "@mykey/auth/operator"
packages/operations/src/       replay.ts  records.ts  jobs.ts  outbox.ts
                               provisioning/{steps,organization,environment,verify}.ts
packages/openbao/src/          admin.ts (bound CIDRs, secret-id accessors)  provisioner.ts  client.ts (M13)
infra/openbao/policies/provisioner.hcl
apps/api/src/                  app.ts config.ts log.ts server.ts selfcheck.ts outbox-dispatcher.ts
                               pipeline/{context,respond,body,gate,route,source,authn,origin,authz,states,cursor}.ts
                               routes/{version,organizations,projects,environments,session,reset}.ts
apps/api/Dockerfile            (+ auth, audit, operations, openbao)
apps/provisioner/              Dockerfile  src/{main,config,worker,sweep,healthcheck}.ts
apps/ops/src/                  cli.ts  commands/{bootstrap-owner,reset-account,auth-cleanup,provision-organization,verify-organization}.ts
                               remote/{ssh,redact,hosts,tunnel}.ts            (moved from tests/harness/staging.ts)
infra/compose/host.compose.yml (gate, key and credential mounts; service provisioner)   dev.compose.yml unchanged
infra/hosts/checks/            status.sh heartbeat.sh (reviewOpen, gate)
workers/probe/src/             evaluate.ts (condition review_open)
scripts/                       host.ts (ops, gate, keys)  pgboss-schema.ts
tests/harness/                 api.ts api-worker.ts tenants.ts staging-owner.ts   staging.ts (re-exports)
tests/unit/{api,audit,auth,authz,contracts,ops,operations,probe}/…
tests/integration/api/         pipeline.test.ts gate.test.ts routes-mounted.test.ts
tests/integration/audit/       append.test.ts
tests/integration/jobs/        outbox.test.ts privileges.test.ts
tests/integration/ops/         bootstrap.test.ts reset.test.ts output.test.ts
tests/integration/auth/        sign-in.test.ts throttle.test.ts throttle-two-process.test.ts factors-http.test.ts
                               sessions.test.ts fresh.test.ts password.test.ts reset.test.ts reset-race.test.ts
tests/integration/authz/       matrix.test.ts concealment.test.ts origin.test.ts states.test.ts revocation.test.ts
tests/integration/provisioning/ organization.test.ts environment.test.ts drift.test.ts
tests/fault/provisioning/      boundaries.test.ts runner.ts
tests/integration/resources/   projects.test.ts environments.test.ts listing.test.ts readiness.test.ts no-delete.test.ts
tests/staging/                 api.staging.test.ts provisioning.staging.test.ts identity.staging.test.ts
docs/decisions/D-26 … D-33-*.md
docs/runbooks/                 operator-accounts.md service-gate.md provisioning.md  (+ credential-custody, custody-map, db-globals-inventory, probe updated)
docs/evidence/session-3/       owner-requests.md run-3.1 … run-3.10.md authorization-matrix.md canary-sweep.txt report.md
```

Decision records of this session: D-26 API pipeline, error mapping, logger and gate record (3.1) · D-27 operator commands, `maintenance` rights, password rule, cookie (3.2) · D-28 throttling model (3.3) · D-29 sessions, fresh verification and product-owned password change (3.5) · D-30 reset design (3.6) · D-31 authorization model, visibility and review reasons (3.7) · D-32 provisioning model and provisioner rights (3.8) · D-33 resource operations, replay and cursors (3.9).

---

## Run 3.1 — API skeleton and persistence layer (D08-S11)

**Files:** `apps/api/src/{app,config,log,server,outbox-dispatcher}.ts`, `apps/api/src/pipeline/{context,respond,body,gate,route}.ts`, `apps/api/src/routes/version.ts`, `apps/api/Dockerfile`, `apps/api/package.json`, `packages/db/src/{tx,scope,index}.ts`, `packages/db/src/repos/{operations,outbox}.ts`, `packages/db/migrations/0004_operator_and_jobs.sql`, `packages/audit/src/{events,append,index}.ts`, `packages/operations/src/{jobs,outbox,index}.ts`, `packages/contracts/src/{routes,openapi}.ts` (+ `openapi.json`, pending snapshot), `scripts/{pgboss-schema,db-migrate,host}.ts`, `infra/compose/host.compose.yml`, `infra/hosts/checks/status.sh`, `tests/harness/{api,privilege-matrix}.ts`, `tests/unit/api/{respond,body,log,gate}.test.ts`, `tests/unit/audit/events.test.ts`, `tests/unit/skeleton/skeleton.test.ts` (extended), `tests/integration/api/{pipeline,gate,routes-mounted}.test.ts`, `tests/integration/audit/append.test.ts`, `tests/integration/jobs/{outbox,privileges}.test.ts`, `tests/staging/api.staging.test.ts`, `docs/runbooks/{service-gate,db-globals-inventory}.md`, `docs/decisions/D-26-api-pipeline-and-gate.md`.

**Consumes:** `ROUTES`, `RouteDef`, `ERROR_CODES`, `ErrorEnvelope`, `LIMITS` (`@mykey/contracts`); `createPool`, `migrate`, `schema` (`@mykey/db`); `createHealthCheck` (`apps/api/src/health.ts`); `freshDatabase`, `getSharedStack` (harness); `sshExec`, `connectStaging` (harness, Session 2).

**Produces:**

```ts
// @mykey/db — tx.ts, scope.ts
export type Queryable = Pool | PoolClient;
export function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T>; // READ COMMITTED, one attempt, ROLLBACK on throw
export interface OrgScope { readonly organizationId: OrganizationId }
export interface ProjectScope extends OrgScope { readonly projectId: ProjectId }
export interface EnvironmentScope extends ProjectScope { readonly environmentId: EnvironmentId }
// @mykey/db — repos/operations.ts, repos/outbox.ts
export interface OperationKey { principalKind: "user" | "machine" | "operator" | "system"; principalId: string; action: string; target: string; idempotencyKey: string }
export function insertOperation(tx: PoolClient, row: OperationKey & { id: OperationId; organizationId: OrganizationId | null; state: OperationState; fingerprint: Buffer | null; fingerprintKeyId: string | null; result: Record<string, unknown> | null }): Promise<"inserted" | "exists">;
export function findOperationByKey(db: Queryable, key: OperationKey): Promise<OperationRow | null>;
export function enqueueOutbox(tx: PoolClient, operationId: OperationId, jobKind: JobKind): Promise<void>;
export function claimOutbox(tx: PoolClient, limit: number): Promise<{ id: string; operationId: OperationId; jobKind: JobKind }[]>; // FOR UPDATE SKIP LOCKED, oldest first
export function markOutboxDelivered(tx: PoolClient, id: string): Promise<void>;

// @mykey/audit
export const AUDIT_ACTIONS: readonly string[];                 // closed list; grows only in this file
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export interface AuditEvent { action: AuditAction; actor: { kind: "user" | "machine" | "operator" | "system" | "anonymous"; id: string | null };
  source: "web" | "cli" | "api" | "operator" | "system"; organizationId: string | null; target: { kind: string; id: string | null } | null;
  outcome: "success" | "denied" | "failure"; requestId: string | null; operationId: string | null; details: Record<string, string | number | boolean | null> }
export class AuditUnavailable extends Error {}
export function appendAudit(db: Queryable, event: AuditEvent): Promise<string>;   // the event id; throws AuditUnavailable, never swallows

// @mykey/operations — jobs.ts, outbox.ts
export const JOB_KINDS = ["environment.provision"] as const;    // later runs add kinds here
export type JobKind = (typeof JOB_KINDS)[number];
export const jobPayloadSchema: z.ZodType<{ operationId: OperationId }>; // strict: nothing else may ride in a job
export function ensureQueues(connectionString: string): Promise<void>;  // run as migration_owner; idempotent
export function createSender(pool: Pool): Promise<JobSender>;           // api_runtime; { send(kind, operationId), stop() }
export function createWorker(pool: Pool, handlers: Record<JobKind, (operationId: OperationId) => Promise<void>>): Promise<{ stop(): Promise<void> }>;
export function dispatchOutbox(pool: Pool, sender: JobSender): Promise<number>; // one pass; returns rows delivered

// apps/api — pipeline
export interface ApiContext { requestId: RequestId; source: string; route: RouteDef; body: unknown; query: unknown; params: Record<string, string>; principal: Principal | null }
export type Handler = (ctx: ApiContext, deps: AppDeps) => Promise<{ status: number; body: unknown }>;
export class ApiError extends Error { constructor(readonly code: ErrorCode, readonly reason?: string) }
export function mountRoute(app: Hono<ApiEnv>, deps: AppDeps, routeId: string, handler: Handler): void;
export function errorResponse(code: ErrorCode, requestId: string): Response;   // the one envelope builder; packages/auth uses it from Run 3.2
export function readGate(path: string, hostInstanceId: string): GateReading;   // { open: true; gateEpoch } | { open: false; cause: "missing" | "unreadable" | "invalid" | "version" | "host" | "closed" }
export function createApp(deps: AppDeps): Hono<ApiEnv>;
export interface AppDeps { pool: Pool; config: ApiConfig; health: () => Promise<HealthReading>; log: (entry: LogEntry) => void;
  test?: { routes?: readonly { def: RouteDef; handler: Handler }[]; stubs?: (routeId: string) => void; clock?: (headers: Headers) => Date | undefined } } // set by the harness only
// tests/harness/api.ts
export function startTestApi(opts?: { gate?: "open" | "closed" | "missing"; env?: Record<string, string> }): Promise<TestApi>;
export interface TestApi { baseUrl: string; origin: string; pool: Pool; superuser: Pool; logs: LogEntry[]; setGate(state: "open" | "closed" | "missing" | { raw: string }): void;
  request(method: string, path: string, init?: { body?: unknown; cookie?: string; headers?: Record<string, string>; rawBody?: string | Uint8Array }): Promise<Response>; close(): Promise<void> }
```

`TestApi.request` always sends `Origin: <origin>` and `Sec-Fetch-Site: same-origin` unless `headers` overrides them: Run 3.7 turns the check on and no earlier test may break when it does.

Design fixed here:

- **Order inside a request** (the full order of Doc 06 §4.4 arrives in Run 3.7; this run fixes the outer frame): request id → gate → route match → body limits and parsing → strict validation → handler → output validation → `Cache-Control: no-store` and `x-request-id` on every response, the 404 and the errors included. `/health` is outside the gate's refusal but reports it: a closed gate makes `/health` answer `503 {"status":"down"}` with cause `gate` in the log.
- **Errors.** One builder; message texts come from one table keyed by code, never from an exception. `ApiError(code)` from a handler becomes its envelope only when `route.errors` lists the code; otherwise the response is `503 dependency_unavailable` and the log entry `{event:"unlisted_error", routeId, code}` — in tests this entry fails the test (the harness asserts `logs` holds none at `close()`). P-41 for everything else.
- **Body rules** (Doc 06 §11). The contract has no 413 or 415 code (D-14), so every one of these is `400 malformed_request`, refused before the handler: headers over `LIMITS.body.headersMaxBytes`; a body over the route's maximum (`authMaxBytes` under `/v1/auth`, `jsonMaxBytes` elsewhere), decided from `Content-Length` when present and by counting while reading otherwise — the read stops at the limit; a `Content-Type` other than `application/json` on a JSON route; a body on a GET; invalid UTF-8; invalid JSON; depth over `jsonMaxDepth`; a duplicate key in any object; an unknown field. Duplicate keys need a scanning pass before `JSON.parse` — `body.ts` owns it and is the only place a body is parsed. A value of the right shape that breaks a rule of its schema (a name outside its pattern, a number out of range) is `422 validation_failed`: Zod issues `invalid_type` and `unrecognized_keys` map to `malformed_request`, every other issue to `validation_failed`.
- **Gate (P-43).** `readGate` opens the file with `O_NOFOLLOW`, `fstat`s it (regular file, at most 4,096 bytes), parses with a strict schema. Any failure is closed with its cause. No caching: the path is opened on every request, so an atomic replacement is seen by the next request. `host.ts <host> gate open|close|status` writes `gate.json.tmp` in the same directory, `fsync`, `rename`, `fsync` of the directory; `gateEpoch` is the previous epoch + 1. On a host, `MYKEY_HOST_INSTANCE_ID` is written once into `/etc/mykey/host.env` by `host.ts <host> env` (a UUID generated on first use, kept afterwards).
- **Audit (P-44).** Actions of this run: `gate.refused` is **not** audited (the database may be the reason the gate is closed; it is logged). `request.denied` is not an action either — denials are audited from Run 3.7 as `access.denied`. This run defines the list with `operator.bootstrap`, `auth.sign_in`, `access.denied` as first entries so the schema machinery is tested; each later run adds its own. `details` values are validated per action by a strict Zod object whose fields are ids, enums, integers or booleans — a `z.string()` without `.uuid()`, `.enum` or a `max` under 64 fails a unit test that walks every schema.
- **Jobs (source reading).** `scripts/pgboss-schema.ts` prints `getConstructionPlans("jobs", { createSchema: false })` for the pinned version; its output is pasted into `0004_operator_and_jobs.sql` and `scripts/pgboss-schema.ts --check` (added to `pnpm run check`) fails when the migration no longer contains it. Runtime instances are built with `{ schema: "jobs", migrate: false, createSchema: false, supervise: <worker only>, schedule: false }`. Queues are created by `ensureQueues` as `migration_owner`, called after `migrate()` in `scripts/db-migrate.ts`, in `host.ts db-init` and in the harness. Grants: start with none for `api_runtime` and `provisioner_runtime` on schema `jobs`, add exactly what the failing statements of the tests name, and write the final list into the migration, the privilege matrix and D-26. If a runtime role turns out to need DDL, stop: record it and run the worker's maintenance as a separate `maintenance`-role timer instead.
- **Outbox.** `dispatchOutbox`: one transaction per row — claim, `send(kind, operationId)` with the outbox id as the job's singleton key, mark delivered, commit. A crash between send and commit sends twice; the worker's conditional claim of the operation (Run 3.8) makes the second job a no-op. The API runs a pass every second and once at start.
- **Migration `0004`:** `GRANT INSERT ON audit.event TO maintenance`; on schema `auth` for `maintenance`: `INSERT` on `user`, `account`, `account_state`; `UPDATE (state, auth_epoch, credential_epoch, updated_at)` on `account_state`; `DELETE` on `session`; the pg-boss objects; the `jobs` grants found above.
- **Image.** The Dockerfile copies `packages/{contracts,db,audit,operations,auth,openbao}` and `apps/api`; the entrypoint gains `--allow-fs-read=/run/mykey` (already there) and nothing else. Compose: `/etc/mykey/gate:/run/mykey/gate:ro`; environment `MYKEY_GATE_PATH=/run/mykey/gate/gate.json`, `MYKEY_HOST_INSTANCE_ID`, `MYKEY_BASE_URL`, `MYKEY_TRUSTED_PROXY=10.78.1.2`, `MYKEY_BUILD` (the commit, baked at build time).

### Task A — transactions, repositories, migration `0004`

- [ ] **Step 1 — Failing tests.**
  - `tests/integration/database/privileges.test.ts` (matrix extended): `maintenance` can insert into `audit.event` and cannot update or truncate it; `maintenance` can insert `auth.user` and delete `auth.session` and cannot read `auth.session.token` changes it did not need (`UPDATE auth.session` refused); `api_runtime` and `provisioner_runtime` cannot `CREATE TABLE` in schema `jobs`; every object in schema `jobs` is in the expected matrix (an unknown one fails by name).
  - `tests/integration/jobs/privileges.test.ts`: `ensureQueues` run twice leaves one queue per `JOB_KINDS` entry; `createSender` as `api_runtime` sends; `createWorker` as `provisioner_runtime` receives it; `createSender` as `api_runtime` against a database where `ensureQueues` never ran rejects (the role cannot create the queue).
  - `tests/integration/jobs/outbox.test.ts`: `a job carries an operation id and nothing else` — the stored job's data equals `{ operationId }` exactly, and `jobPayloadSchema` rejects `{ operationId, name: "x" }`; `an outbox row written in a rolled-back transaction is never delivered`; `a committed row is delivered once and marked`; `two dispatchers running together deliver each row once` (two pools, 50 rows, 50 jobs); `a dispatcher killed after send and before commit delivers again and the row ends delivered` (inject the crash through a `beforeCommit` hook in the function's deps, not an environment variable).
  - `withTransaction`: a throw rolls back and releases the client (pool `idleCount` returns); the isolation level reported inside is `read committed`.
- [ ] **Step 2 — Run:** FAIL (no migration, no modules).
- [ ] **Step 3 — Implement.** The migration is hand-written SQL, created the way `0001_grants.sql` was (`node node_modules/drizzle-kit/bin.cjs generate --custom --name operator_and_jobs` inside `packages/db`). `pnpm run db:check` green.
- [ ] **Step 4 — Run:** PASS. **Commit** `feat(db): transactions, operator grants, job schema and outbox`.

### Task B — audit append

- [ ] **Step 1 — Failing tests.**
  - `events.test.ts` (unit): every action has a details schema; the walking test above; `appendAudit` with an action outside the list is a type error and a runtime throw; details with an extra key throw before any SQL.
  - `append.test.ts` (integration): `the row holds exactly the allowlisted columns`; `inside a transaction that rolls back, no row remains`; `when the insert fails the caller gets AuditUnavailable` (revoke `INSERT` from a throw-away role for the test, restore after); `a details value that looks like a secret is rejected by its schema` — pass a 40-character random string where an id is expected.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(audit): append path with closed actions and strict details`.

### Task C — pipeline frame, logger, `version.get`

- [ ] **Step 1 — Contract commit.** `version.get`: response `200` `z.strictObject({ apiMajor: z.literal(1), build: z.string().regex(/^[0-9a-f]{7,40}$/) })`; OpenAPI security scheme name `__Secure-better-auth.session_token`. Regenerate `openapi.json`, update the pending snapshot. **Commit** `contract: version.get body and the real cookie name`.
- [ ] **Step 2 — Failing tests.**
  - `routes-mounted.test.ts`: `every route of the app is a contract route, an auth route or /health` — walk `app.routes`; an extra one fails with its method and path. `a contract route without a handler ends in 404 not_found` for every contract route that has none — every contract route is mounted through `mountRoute` from this run on (P-40), and here nothing but the gate and the body rules stands before the terminal handler. `GET /v1/version` answers 200 with `apiMajor: 1`.
  - `pipeline.test.ts`, each through `startTestApi()` over HTTPS: every response of a table of twelve requests (200, 404, 400, 503) carries `Cache-Control: no-store` and an `x-request-id` that is a UUID, equals `error.requestId` on errors, and differs between two requests; a client-sent `x-request-id` is ignored. Body table, each refusal a `400 malformed_request` whose stub handler was not reached: 524,288 bytes accepted and 524,289 refused on a stub JSON route (the harness mounts `POST /v1/_test/echo` through `mountRoute` from a test-only `RouteDef` passed in `AppDeps.test.routes`, absent in the production entry — a unit test asserts `server.ts` never sets `test`); depth 16 accepted, 17 refused; duplicate key refused; unknown field refused; `text/plain` refused; invalid UTF-8 refused; a chunked body without a length over the limit is refused after at most limit + 64 KiB read.
  - `a handler that throws answers 503 and leaks nothing` — the stub throws `new Error("<canary>")`; the response and every log line lack the canary; the log holds `errorClass: "Error"`.
  - `a handler that returns an unlisted code answers 503 and logs unlisted_error`; `output that fails the response schema is not sent`.
  - `log.test.ts` (unit): an entry with a nested `password`, `Authorization`, `set-cookie`, `token`, `link`, `value` key is written with `"[redacted]"`; the request entry type has no field that could hold a body or a query string (`path` is the route pattern, not the URL — a request to `/v1/projects/<uuid>?x=<canary>` logs `/v1/projects/:id`).
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement.** **Step 5 — Run:** PASS. **Commit** `feat(api): contract-driven pipeline frame, envelope, limits and logger`.

### Task D — service gate

- [ ] **Step 1 — Failing tests.**
  - `gate.test.ts` (unit, real files in a temporary directory outside OneDrive): open only for the exact valid record; closed with the right cause for: no file, a directory, a symlink to a valid record, empty file, 4,097 bytes, invalid JSON, `version: 2`, an extra field, `state: "closed"`, another `hostInstanceId`, a file the process cannot read (skip-free: on Windows assert through a mocked `open` error code `EACCES`; the real permission case runs in the staging test).
  - `gate.test.ts` (integration): gate missing → `GET /v1/version` is `503 quarantined` and `/health` is 503; `setGate("open")` → the **next** request is 200 with no restart; `setGate("closed")` → the next is 503 again; while closed, a request with an invalid body is still `503 quarantined` (the gate is first); the closed answer is the same for a mounted and an unmounted route.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** `gate.ts`, the `/health` cause, `host.ts gate`, `status.sh` field `gate`. **Step 4 — Run:** PASS. **Commit** `feat(api): external service gate, closed by default`.

### Task E — dispatcher in the process

- [ ] **Step 1 — Failing test** (`outbox.test.ts`): with the API started, a row committed by the test is delivered within three seconds; with PostgreSQL restarted (`restartService`) the dispatcher resumes without a process restart and `/health` returns to 200.
- [ ] **Step 2 — Implement** `outbox-dispatcher.ts`; start and stop it in `server.ts`. **Run:** PASS. **Commit** `feat(api): outbox dispatcher`.

### Task F — staging

- [ ] **Step 1 — Failing staging test** `api.staging.test.ts`: target assertion first; `the gate file is root-owned and the API container sees it read-only` (`stat` through `sshExec`; a write attempt inside the container fails); `closed gate: /health down and /v1/version quarantined through the public name`; `after host.ts gate open the next request answers 200 without a restart` (container start time unchanged); `an atomic replacement under load is never read half-written` — 200 requests while the gate is rewritten 20 times: every answer is 200 or `503 quarantined`, none is a `dependency_unavailable`; `the response carries no-store and Strict-Transport-Security` (the header Traefik adds); `chmod 000` on the file → closed with cause `unreadable`, restored afterwards.
- [ ] **Step 2 — Deploy:** `docker build`, `docker save` (one tag), `host.ts staging image api`, `push`, `env`, `db-init` (applies `0004` and `ensureQueues`), `up`. The gate does not exist yet: confirm the probe reports staging down (expected alert, note the time), then `host.ts staging gate open`.
- [ ] **Step 3 — Run** the staging file: PASS. Write `docs/runbooks/service-gate.md` (open, close, status, what closed looks like from outside, that every deploy starts closed) and D-26. **Commit** `feat(hosts): API image with the gate on staging`.

**Registry:** none moves in this run (the requirement ids of this run are proven with the features that use it). **Covers:** the frame for FR-1.56, FR-1.59, FR-1.80; Doc 06 §9, §12, §14.1. **Done when:** a request through the stack is validated, audited (Task B's path used by a stub route in `pipeline.test.ts`: a failing append gives `503 audit_unavailable` and the stub's effect did not happen) and denied when the gate is closed.

---

## Run 3.2 — Owner bootstrap and password sign-in (D08-S12)

**Files:** `apps/ops/src/cli.ts`, `apps/ops/src/commands/bootstrap-owner.ts`, `apps/ops/src/remote/{ssh,redact,hosts,tunnel}.ts`, `apps/ops/package.json`, `packages/auth/src/{auth,keys,routes,sign-in,index}.ts`, `packages/auth/src/operator/{index,bootstrap}.ts`, `packages/auth/package.json` (export `./operator`), `packages/db/src/repos/{organizations,memberships}.ts`, `apps/api/src/{app,config,server}.ts`, `scripts/host.ts` (`ops`, `keys`), `infra/compose/host.compose.yml`, `tests/harness/{staging,api}.ts`, `tests/unit/auth/{keys,routes}.test.ts`, `tests/unit/ops/{cli,output}.test.ts`, `tests/unit/skeleton/skeleton.test.ts`, `tests/integration/ops/{bootstrap,output}.test.ts`, `tests/integration/auth/{sign-in,routes}.test.ts`, `docs/auth-route-contract.md`, `docs/runbooks/{operator-accounts,credential-custody}.md`, `docs/decisions/D-27-operator-commands.md`.

**Consumes:** Run 3.1 (`withTransaction`, `appendAudit`, `errorResponse`, `mountRoute` frame, `startTestApi`); `createAuth`, `mountAuthRoutes`, `loadAuthKeys`, `sessionCookie`, `currentSession` (Session 2).

**Produces:**

```ts
// @mykey/auth — keys.ts
export const KEY_RINGS = ["cookie", "session-lookup", "seed-encryption", "recovery-verifier", "rate-limit", "reset-verifier", "replay-fingerprint", "cursor-mac"] as const;
export interface AuthKeys { cookieSecret: string; sessionLookup: KeyRing; seedEncryption: KeyRing; recoveryVerifier: KeyRing; rateLimit: KeyRing; resetVerifier: KeyRing; replayFingerprint: KeyRing; cursorMac: KeyRing }
export function generateKeyFiles(directory: string, rings?: readonly string[]): string[]; // creates "<ring>.k1.key" 0600 for rings that have none; returns the names created, never a value
// @mykey/auth — routes.ts
export interface AuthRouteEnv { pool: Pool; keys: AuthKeys; baseUrl: string;
  respondError(code: ErrorCode, requestId: string): Response;
  requestId(c: Context): string; source(c: Context): string;
  audit(event: AuditEvent): Promise<void>;
  throttle?: Throttle }                                          // Run 3.3 fills it; absent means the route refuses (see Design)
export function mountAuthRoutes(app: Hono, auth: Auth, env: AuthRouteEnv): void;
// @mykey/auth — sign-in.ts
export type SignInResult = { ok: true; setCookie: string; phase: "password_verified" } | { ok: false };
export function signInWithPassword(deps: { auth: Auth; pool: Pool }, input: { email: string; password: string }): Promise<SignInResult>;
// @mykey/auth/operator — bootstrap.ts
export type BootstrapResult = { outcome: "created" | "already_present"; userId: UserId; organizationId: OrganizationId } | { outcome: "refused"; reason: "another_owner_exists" | "password_rejected" };
export function bootstrapOwner(deps: { auth: Auth; pool: Pool; crashAt?: (point: BootstrapPoint) => void }, input: { email: string; password: string }): Promise<BootstrapResult>;
export function checkPassword(value: string): { ok: true } | { ok: false; reason: "too_short" | "too_long" };   // P-46; exported from the package root too
// apps/ops — cli.ts
export function runOps(argv: string[], io: { stdin: Readable; stdout: Writable; stderr: Writable; env: OpsEnv }): Promise<number>; // exit code
// tests/harness/api.ts
export function seedOwner(api: TestApi, opts?: { email?: string }): Promise<{ userId: string; organizationId: string; email: string; password: string }>; // through bootstrapOwner
```

Design fixed here:

- **Key rings.** Eight rings; key ids are `k<positive integer>` and the current key is the greatest number (fixes M15: today `k10` sorts before `k9`). A file whose id does not match is a start-up error naming the file. The four new rings are generated now so later runs never touch host custody again: on a host, `host.ts <host> keys init` runs `generateKeyFiles` on the workstation into `~/.mykey/secrets/hosts/<host>/auth-keys/` (existing files untouched), then installs each file on stdin to `/etc/mykey/secrets/api-keys/<file>` (owner 1000:1000, 0600) — the installer's path rule gains this one directory with the dotted name pattern `^(cookie|session-lookup|…)\.k[0-9]+\.key$`. Compose mounts it read-only at `/run/mykey/keys`. `credential-custody.md` and `custody-map.md` gain the entries (names and places only).
- **`apps/ops`.** `runOps` parses `<command> [--flag value]`, never takes a secret as an argument, reads secrets from stdin, and writes secret output only through `writeSecretFile(name, content)` → `~/.mykey/out/<utc-timestamp>-<name>` (0600, directory 0700), printing the path. `host.ts <host> ops <command…>` opens the PostgreSQL tunnel (and the OpenBao tunnel for commands that declare `needsOpenBao`), loads the `maintenance` password and the key directory from workstation custody, and calls `runOps` in-process. The SSH, redaction, hosts-file and tunnel code moves from `tests/harness/staging.ts` to `apps/ops/src/remote/`; the harness re-exports it, `scripts/host.ts` imports from `apps/ops` (closes M17). No behaviour change: `tests/unit/hosts/*.test.ts` stay green untouched.
- **Bootstrap** (one transaction, advisory lock `pg_advisory_xact_lock(hashtext('mykey.bootstrap'))`): if a membership with role `owner` exists → for the same email (case-folded as Better Auth stores it) return `already_present` and change nothing, the password included; for another email return `refused`. Otherwise insert `auth.user`, the credential `auth.account` with `(await auth.$context).password.hash(password)`, `auth.account_state` (`enrollment_pending`, epochs 0), `app.organization` (`id` new, `namespace` `org-<id>`, state `provisioning`), `app.membership` (owner, active), audit `operator.bootstrap` (ids only). `crashAt` is called after each statement in tests. The command: `ops bootstrap-owner --email <address>`, password on stdin (one line), exit 0 for `created` and `already_present`, 2 for `refused`; stdout says which, with the two ids.
- **Sign-in** (replaces the relay of the native route for `POST /v1/auth/sign-in/email`; the native endpoint is still what verifies the password): read `(state, auth_epoch, credential_epoch)` for the email (absent user: skip to the dummy path) → `auth.api.signInEmail` → on success, in one transaction lock `account_state`, require state in (`enrollment_pending`, `active`) and both epochs unchanged, set the new session's `auth_epoch`, `authenticated_at = now()`, `last_user_activity_at = now()`, phase `password_verified` → commit → answer `200 {"phase":"password_verified"}` with the cookie (this replaces the Session 2 body `{ redirect, user }`: the client needs the phase, not the user object). Any failure after the native call deletes the session row it made. Every failure — unknown email, wrong password, `disabled`, `recovery_pending`, epoch moved — is the same `401 unauthenticated` with no cookie; for an unknown email the handler runs one hash verification against a fixed dummy hash so the work is the same. Audit `auth.sign_in` with outcome and, when known, the user id; never the email.
- **Auth routes on the pipeline.** `mountAuthRoutes` uses `env.respondError` and `env.requestId` (no second envelope builder, no random request id), sits behind the gate and body limits of Run 3.1, and the relay parses a native response as JSON only when its content type is JSON (closes M16). While `env.throttle` is absent, `mountAuthRoutes` throws at start unless `MYKEY_ALLOW_UNTHROTTLED=test` is passed in its env object by the harness — an API without throttling cannot start by accident between this run and the next.
- **Cookie (P-39).** `advanced.cookies.session_token.attributes = { sameSite: "strict", secure: true, httpOnly: true, path: "/" }`; `sessionCookie` (factor elevation) must produce the same attributes — one helper, one test.
- **Password rule (P-46)** in `createAuth` and `checkPassword`.

### Task A — key rings, `apps/ops` frame, moved remote code

- [ ] **Step 1 — Failing tests.** `keys.test.ts`: `k10` is current over `k9`; `k01`, `K2`, `key2` are refused by file name; a missing ring names the ring; `generateKeyFiles` creates only missing rings, 32 random bytes base64url, mode 0600, and returns names. `cli.test.ts`: unknown command → exit 64 and usage; a flag named `--password` is refused for every command. `output.test.ts` (unit): `writeSecretFile` creates 0600 under a 0700 directory and returns the path. `skeleton.test.ts`: `apps/api` has no import path to `@mykey/auth/operator`, `@mykey/openbao/admin` or `apps/ops` (walk the import graph from `apps/api/src/server.ts`).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement;** move the remote code. **Step 4 — Run:** PASS, and `pnpm test` whole (the moved code has many dependants). **Commit** `refactor(ops): operator tool frame, key rings by number, remote code out of the test harness`.

### Task B — bootstrap

- [ ] **Step 1 — Failing tests** (`tests/integration/ops/bootstrap.test.ts`, real database, connected as `maintenance`):
  - `creates one owner, one organization in provisioning, one audit row`; the account can then sign in (Task C) and cannot before.
  - `repeated with the same email changes nothing` — row counts equal, password hash byte-identical, outcome `already_present`, even when the second call passes a different password.
  - `a different email is refused when an owner exists`.
  - `killed after each statement, then repeated: exactly one owner` — a child process (`tests/integration/ops/bootstrap-worker.ts`) runs `bootstrapOwner` with `crashAt` calling `process.exit(137)` at point *n*, for every point; after each, the tables hold nothing of the attempt; a clean repeat creates one owner.
  - `two bootstraps at once: one created, one already_present` (two child processes released together, same email) and `…with different emails: one created, one refused`.
  - `a password of 11 characters is refused; 12 is accepted; 1,024 bytes accepted; 1,025 refused`.
  - `api_runtime cannot run it` — the same function with an `api_runtime` pool fails on the first insert (permission denied on `auth.user`), leaving nothing.
  - `output.test.ts` (integration): run `runOps(["bootstrap-owner", "--email", …])` with a canary password on stdin: stdout and stderr hold neither the password nor the hash; the audit row's details hold neither.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(ops): idempotent owner bootstrap`.

### Task C — sign-in on the pipeline, every creation path closed

- [ ] **Step 1 — Failing tests.**
  - `sign-in.test.ts`: `the owner signs in: 200, one cookie named __Secure-better-auth.session_token with Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, Max-Age 43200`; the body is exactly `{"phase":"password_verified"}`; the stored token is a verifier (not the cookie value). `unknown email, wrong password, disabled, recovery_pending: byte-identical 401 except requestId, no Set-Cookie, no session row`. `epoch moved between verification and commit → 401 and no session row` (the test bumps `auth_epoch` through a hook between the two phases). `a 2xx native response that is not JSON is relayed as dependency_unavailable, not a crash` (M16; stub the native handler). Each sign-in writes one `auth.sign_in` audit row with the right outcome and no email in any column.
  - `routes.test.ts` (integration, now through `startTestApi` — the full pipeline): the Session 2 table of denied native routes passes unchanged against the integrated app, with and without an `mfa_complete` cookie: 404 `not_found`, `no-store`, a pipeline request id, no row created; `auth.api.signUpEmail` in-process is refused; a `POST /v1/auth/sign-up/email` that carries a valid owner cookie and a correct Origin still 404s. `a route listing of the integrated app holds no path that creates a user` — any mounted path matching `sign-up|register|invite|accept` fails.
  - `routes.test.ts` (unit): `mountAuthRoutes` without a throttle and without the test flag throws.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement;** `pnpm run auth:contract` and commit the regenerated `docs/auth-route-contract.md` in the same commit. **Step 4 — Run:** PASS. **Commit** `feat(auth): sign-in bound to account state and epochs, auth routes on the pipeline`.

### Task D — staging owner

- [ ] **Step 1.** `host.ts staging keys init` (key files on the workstation and on the host; the running Run 3.1 image does not read them). No deploy in this run (P-60): the image with auth routes goes to staging in Run 3.8, after throttling exists. Generate the staging owner's password on the workstation into `~/.mykey/secrets/hosts/staging/owner-password` (0600, never printed) and run `host.ts staging ops bootstrap-owner --email owner@mykey-staging.invalid` with it on stdin — the command needs only the database tunnel and the workstation's key directory. Record the two ids in the run note.
- [ ] **Step 2 — Staging check** (`api.staging.test.ts`): `the bootstrap repeated on staging reports already_present and the row counts are unchanged`; `the key directory on the host holds the eight rings, owner 1000:1000, mode 0600` (names and modes through `sshExec`, never content). The sign-in checks through the public name are written and run in Run 3.8 Task D.
- [ ] **Step 3.** Write `docs/runbooks/operator-accounts.md` (bootstrap, where output files go, how to shred them) and D-27. **Commit** `docs: operator accounts runbook, D-27`.

**Registry:** `FR-1.01`, `AC-1.01`, `PO-5` → `SPIKE_PASS` (product code, real stores; staging). **Covers:** FR-1.01; AC-1.01; PO-5. **Done when:** an interrupted and repeated bootstrap yields exactly one owner; every signup path returns the generic not-found.

---

## Run 3.3 — Throttling (D08-S12) · ∥

**Files:** `packages/auth/src/{throttle,routes,index}.ts`, `packages/db/src/repos/rate-limits.ts`, `apps/api/src/pipeline/source.ts`, `apps/api/src/{app,server}.ts`, `tests/harness/api-worker.ts`, `tests/unit/api/source.test.ts`, `tests/unit/auth/throttle.test.ts`, `tests/integration/auth/{throttle,throttle-two-process}.test.ts`, `docs/auth-route-contract.md`, `docs/decisions/D-28-throttling.md`.

**Consumes:** Run 3.2 (`AuthRouteEnv.throttle`, `signInWithPassword`, `KEY_RINGS` with `rate-limit`, `startTestApi`, `seedOwner`); `LIMITS.rate`; table `app.rate_limit`.

**Produces:**

```ts
// @mykey/db — repos/rate-limits.ts
export function bumpCounter(db: Queryable, scope: string, keyDigest: Buffer, windowSeconds: number): Promise<{ count: number; secondsLeft: number }>; // one INSERT … ON CONFLICT DO UPDATE … RETURNING, window from now()
export function sumCounters(db: Queryable, scope: string, keyDigest: Buffer, windowSeconds: number, windows: number): Promise<number>;
export function sweepCounters(db: Queryable, olderThanSeconds: number, batch: number): Promise<number>;
// @mykey/auth — throttle.ts
export type ThrottlePhase = "password" | "factor" | "reset";
export type Admission = { allowed: true } | { allowed: false; retryAfterSeconds: number };
export interface Throttle {
  admit(phase: ThrottlePhase, subject: { source: string; account: string | null }): Promise<Admission>; // counts the attempt; throws when the counter cannot be written
  recordFailure(phase: ThrottlePhase, account: string): Promise<void>;
  clearAccount(accounts: readonly string[]): Promise<void>;       // operator reset only (Run 3.6)
}
export function createThrottle(deps: { pool: Pool; ring: KeyRing }): Throttle;
// apps/api — pipeline/source.ts
export function requestSource(peer: string | undefined, forwardedFor: string | undefined, trustedProxy: string | null): string; // P-47
// tests/harness/api-worker.ts
export function startApiProcess(database: DbTarget, opts?: { gate?: "open" }): Promise<{ baseUrl: string; pid: number; kill(signal?: NodeJS.Signals): Promise<void> }>; // a real second process on the same database and key directory
```

Design fixed here (P-48):

- **Subjects.** `account` is, for `password`, the e-mail as submitted after trimming and lower-casing — whether or not such a user exists; for `factor`, the user id of the session; for `reset`, `null` (a reset token is 256 random bits; the factor code presented with it is charged to `factor` for the token's user). `source` is `requestSource(…)`.
- **Rows.** `scope` is one of `src:<phase>`, `fail:<phase>`, `lock:<phase>`; `key_digest = HMAC-SHA-256(ringKey(rateLimit), scope ‖ 0x00 ‖ subject)`; no row holds an address, an e-mail or a user id. `src` rows use 60-second windows, `fail` rows 900-second windows, both cut with `date_bin` on `now()`. A `lock` row's `window_start` is the moment the lock began.
- **`admit`**, in this order: a `lock:<phase>` row for the account younger than `LIMITS.rate.authDelaySeconds` → refused, `retryAfterSeconds` = what is left; then `bumpCounter("src:<phase>", source, 60)` → refused when the count exceeds `authAttemptsPerMinute`. An attempt refused by the lock is not counted against the source.
- **`recordFailure`**, one transaction: bump `fail:<phase>`; when current + previous window reach `authFailuresPerAccount`, insert the lock row and delete the account's `fail` rows. Two adjacent fixed windows see between 15 and 30 minutes of history: the lock can only come earlier than a sliding window would give it, never later (D-28 says so). A success does not clear failures.
- **Use in a route:** `admit` first; refused → `429 rate_limited` with `Retry-After`, and nothing else happens — no user lookup, no hash, no native call. `admit` throws → `503 dependency_unavailable`, likewise nothing else happens. Then the credential step; on failure `recordFailure`, then the route's own failure answer. If `recordFailure` throws, the answer is `503 dependency_unavailable` (the failure is still not disclosed as a success).
- **Wired in this run:** `password` on sign-in; `factor` on `/totp/verify`, `/totp/activate`, `/recovery/verify`. Run 3.4 adds step-up, Run 3.5 password change (`password`), Run 3.6 reset completion (`reset`, and `factor` for its code). `AuthRouteEnv.throttle` becomes required and the `MYKEY_ALLOW_UNTHROTTLED` flag of Run 3.2 is deleted.
- **Sweep:** the API deletes rows older than one hour every ten minutes, at most 1,000 a pass (`api_runtime` already holds `DELETE` on `rate_limit`).
- **Not here:** the general per-session and per-source limits (300, 120 and 60 a minute) — Run 6.3, on `bumpCounter`.

### Task A — source and counters

- [ ] **Step 1 — Failing tests.**
  - `source.test.ts`: peer = trusted proxy and one valid IPv4 or IPv6 value → that value; two values, an empty value, `unknown`, a value with a port, 300 characters → the peer; peer ≠ trusted proxy with any header → the peer; no trusted proxy configured → the peer; an IPv4-mapped IPv6 peer equals its IPv4 form.
  - `throttle.test.ts` (unit): the digest differs by scope and by subject, is 32 bytes, and equals a fixed vector for a fixed key (pins the `‖ 0x00 ‖` construction).
  - `throttle.test.ts` (integration, counters): `50 concurrent bumps of one key return 1…50 exactly once each` (two pools); `the window comes from database time` — a row aged by 61 s through the superuser is not counted; `sumCounters` over two windows; `a table dump holds no e-mail, address or user id of the test` (search `pgDump` output for each).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(auth): rate counters with keyed digests, trusted request source`.

### Task B — limits on the routes

- [ ] **Step 1 — Failing tests** (`throttle.test.ts`, through `startTestApi`; time moved by ageing rows):
  - `per source: attempts 1–5 in a minute reach the credential check, the 6th is 429 with Retry-After between 1 and 60` — with a correct password on the 6th: still 429, and no session row.
  - `per account: five wrong passwords from five sources lock the account; the correct password from a sixth source is 429`; `after the lock rows are aged by 901 s the correct password signs in`; at 895 s it does not.
  - `known and unknown accounts are indistinguishable` — run the same six-attempt script against the owner's e-mail and against an unused one: status sequence, bodies (request id removed), header names and `Retry-After` values are equal; the unused e-mail gets locked too.
  - `a locked attempt verifies nothing` — the native sign-in spy is not called and no `auth.sign_in` audit row is written with outcome `failure`; a `rate_limited` audit row is (action `auth.throttled`, details `{ phase }` only).
  - `factor: five wrong TOTP codes lock the factor phase for the user; a correct code is then 429`; `recovery codes share the budget` — three wrong TOTP codes and two wrong recovery codes lock both routes; the `password` phase of the same account is not locked by it.
  - `counter failure refuses` — with `INSERT` on `app.rate_limit` revoked from the API's role for the test: sign-in with the correct password is `503 dependency_unavailable`, no session row, the native spy not called.
  - `a throttle lock does not stop the operator` — with the owner locked in both phases, `bootstrapOwner` (same e-mail) still answers `already_present`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement;** regenerate the auth contract. **Step 4 — Run:** PASS. **Commit** `feat(auth): throttling of password and factor attempts`.

### Task C — two processes

- [ ] **Step 1 — Failing test** `throttle-two-process.test.ts`: two API processes (`startApiProcess` twice) on one database. `ten sign-in attempts from one source, alternating between the processes, inside one window: exactly five reach the credential check` (five 401, five 429 — never six 401). `five wrong passwords split 3 + 2 across the processes lock the account on both`. `ten parallel attempts, five to each process, released together: at most five 401`.
- [ ] **Step 2 — Run:** FAIL (no worker). **Step 3 — Implement** `api-worker.ts`. **Step 4 — Run:** PASS, five times in a row (`--repeat` is not needed: run the file five times and paste the five summaries). **Commit** `test(auth): throttling holds across two API processes`. Write D-28.

**Registry:** `FR-1.07`, `AC-1.05` → `SPIKE_PASS` (product code, real stores). **Covers:** FR-1.07; AC-1.05. **Done when:** the limits of Doc 06 §11 are enforced across two processes.

---

## Run 3.4 — TOTP and recovery codes (D08-S13)

**Files:** `packages/auth/src/{routes,fresh,index}.ts`, `packages/auth/src/factors/elevate.ts`, `apps/api/src/pipeline/authn.ts`, `apps/api/src/app.ts`, `tests/harness/api.ts`, `tests/integration/auth/{factors-http,fresh}.test.ts`, `tests/integration/auth/race-worker.ts` (reused), `docs/auth-route-contract.md`.

**Consumes:** Session 2 factors (`enrollTotp`, `activateTotp`, `elevateWithTotp`, `elevateWithRecoveryCode`, `regenerateRecoveryCodes`, `codeAt`, `stepAt`); Run 3.2 (`AuthRouteEnv`, `seedOwner`); Run 3.3 (`Throttle`, `startApiProcess`).

**Produces:**

```ts
// @mykey/auth — factors/elevate.ts
export function stepUpWithTotp(deps: FactorDeps, input: { sessionToken: string; code: string; now?: Date }): Promise<{ ok: true } | { ok: false; reason: FailureReason }>; // mfa_complete session only; uses a step once; sets totp_verified_at = now(); no token rotation
// @mykey/auth — fresh.ts
export function hasFreshTotp(db: Queryable, sessionId: string): Promise<boolean>; // totp_verified_at > now() - LIMITS.session.freshTotpSeconds AND session.enrollment_id is the user's active enrollment
// apps/api — pipeline/authn.ts
export type Principal = { kind: "user"; userId: UserId; sessionId: string; fresh: boolean };
export function authenticateHuman(deps: AppDeps, headers: Headers): Promise<Principal>; // throws ApiError("unauthenticated" | "mfa_incomplete")
// tests/harness/api.ts
export interface TestApi { reached: string[] }                                         // route ids whose stub handler ran (startTestApi({ stubs: true }))
export function signInComplete(api: TestApi, user: { email: string; password: string; seed: Uint8Array }): Promise<{ cookie: string; sessionId: string }>;
export function enrollOwner(api: TestApi, owner: { email: string; password: string }): Promise<{ seed: Uint8Array; recoveryCodes: string[] }>; // through the HTTP routes
```

Design fixed here:

- **Routes without a handler (P-40).** `createApp` mounts every contract route through `mountRoute`. One that has no real handler gets the terminal handler: after every pipeline check has passed it answers `404 not_found` (written directly, since not every such route lists the code). `startTestApi({ stubs: true })` sets `AppDeps.test.stubs`, which replaces the terminal handler by one that records the route id in `reached` and answers `204` with no body. `server.ts` never sets it (the unit test of Run 3.1 Task C covers this field too). Run 3.7 uses the same stubs for the matrix. The test of Run 3.1 "a contract route without a handler answers 404" now holds for an authorised caller only — update it in this task.
- **Product routes and phases.** `mountRoute` calls `authenticateHuman` for classes `human` and `human_fresh_totp`: no valid cookie → `401 unauthenticated`; phase `password_verified` or `enrollment` → `401 mfa_incomplete`; account not `active` or epoch moved → `401 unauthenticated`. This run uses `requireMfaComplete`'s logic; Run 3.5 swaps the decision for `resolveSession` without changing the answers.
- **Factor routes** keep their Session 2 behaviour and gain: the pipeline's envelope and request id; the `factor` throttle; an audit row per attempt — actions `auth.totp_enroll`, `auth.totp_activate`, `auth.mfa_complete` (details `{ method: "totp" | "recovery" }`), `auth.step_up`, `auth.recovery_regenerate`, each with outcome and, on failure, `reason` as the enum of `FailureReason` (never the code).
- **Step-up** `POST /v1/auth/totp/step-up`, body `{ code }` strict: `mfa_complete` session only; a wrong, replayed or expired code is the same `401 unauthenticated` and does not end the session.
- **Regeneration** requires `hasFreshTotp` → otherwise `403 fresh_verification_required`. A session completed with a recovery code has `totp_verified_at` empty and must step up first.
- **Incomplete challenges.** A `password_verified` or `enrollment` session older than `LIMITS.session.incompleteChallengeSeconds` (from `authenticated_at`, database time) is refused on every factor route with `401 unauthenticated` and its row deleted.
- **Enrollment** only while the account is `enrollment_pending` (the Session 2 rule); activation returns the ten codes once, in the response body, and nowhere else.

### Task A — product routes closed to incomplete sessions

- [ ] **Step 1 — Failing tests** (`factors-http.test.ts`, `startTestApi({ stubs: true })`):
  - `a password-only session reaches no product route` — for every route in `ROUTES` of class `human` or `human_fresh_totp` (path parameters filled with fresh UUIDs, a valid body where the schema is known): `401 mfa_incomplete`, and `reached` stays empty. Control: the same loop with an `mfa_complete` cookie leaves every route id in `reached` or answers one of 403, 404 (authorization arrives in Run 3.7; until then the stub is reached).
  - `an enrollment-phase session reaches no product route` — same loop, session taken after `/totp/enroll` and before `/totp/activate`.
  - `no cookie: 401 unauthenticated`; `a cookie with a broken signature: 401 unauthenticated`.
  - `an enrollment_pending account can only sign in, enroll, activate and sign out` — every other auth route with its session answers 401 or 409 as the auth contract says, and creates nothing.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** `authn.ts`, the stubs. **Step 4 — Run:** PASS. **Commit** `feat(api): human routes require a completed second factor`.

### Task B — factor routes on the pipeline, step-up, fresh regeneration

- [ ] **Step 1 — Failing tests** (`factors-http.test.ts`, `fresh.test.ts`):
  - `enroll → activate with a valid code → ten codes shown once`: the activation body holds ten codes of the format; the database holds ten verifiers and no code; `GET /v1/auth/get-session` and every other auth route called afterwards return none of them (search each body for each code).
  - `verify rotates the session token` — the cookie value changes, the old cookie is `401` on its next request, `authenticated_at` is unchanged.
  - `a wrong, a replayed and an expired code answer alike` (three bodies equal but for the request id).
  - `a used step is refused after an API restart and after a PostgreSQL restart` (`restartService`), inside the same 30-second step (the test passes `now`).
  - `a consumed recovery code is refused; the other nine still work once each`.
  - `step-up: wrong code → 401 and the session still works; right code → 200 and hasFreshTotp is true`; `the step used for sign-in cannot be used again for step-up`.
  - `regeneration without fresh TOTP is 403 fresh_verification_required` — for a session whose `totp_verified_at` was aged to 601 s, and for a session completed with a recovery code; at 595 s it succeeds; after success all ten old codes are refused and every old row is marked consumed.
  - `hasFreshTotp is false when the session's enrollment is not the active one` (retire the enrollment through the superuser).
  - `an 11-minute-old password-only session cannot verify` — aged to 601 s: 401 and the row is gone; at 595 s it verifies.
  - `trustDevice, rememberDevice, disable: no such field or route` — `{ code, trustDevice: true }` is `400`; `/v1/auth/totp/disable` and `/v1/auth/two-factor/disable` are 404 with an `mfa_complete` cookie.
  - every attempt above left exactly one audit row with the expected action, outcome and reason, and no code (search `details::text` for each code used).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement;** regenerate the auth contract. **Step 4 — Run:** PASS. **Commit** `feat(auth): factor routes with audit, throttle, step-up and fresh regeneration`.

### Task C — races across two processes

- [ ] **Step 1 — Failing test** (`factors-http.test.ts`, two processes from `startApiProcess`):
  - `one TOTP step, two sessions of the same user, one request to each process, released together: exactly one 200` — repeated 20 times with a new step each time (the test passes `now` through a header honoured only when `AppDeps.test.clock` is set); never two successes.
  - `one recovery code, two password-only sessions, two processes: exactly one 200`, 20 times, each with a fresh code set.
  - `the same session presented to both processes with one valid code: one 200, one 401, one mfa_complete row`.
- [ ] **Step 2 — Run:** FAIL or flaky → fix until 20/20. **Step 3 — Run** the whole auth folder. **Commit** `test(auth): one-use steps and codes across two API processes`.

**Registry:** `FR-1.02`, `FR-1.03`, `AC-1.02`, `PO-15` → `SPIKE_PASS` (product code, real stores). **Covers:** FR-1.02, FR-1.03; AC-1.02; PO-15. **Done when:** a password-only or enrolment-incomplete session reaches no product route; a replayed TOTP step is refused in a two-process race.

---

## Run 3.5 — Sessions and fresh verification (D08-S14)

**Files:** `packages/auth/src/{sessions,password,routes,auth,index}.ts`, `apps/api/src/pipeline/{authn,route}.ts`, `apps/api/src/routes/session.ts`, `apps/api/src/server.ts` (clean-up timer), `packages/contracts/src/routes.ts`, `tests/integration/auth/{sessions,fresh,password}.test.ts`, `tests/unit/auth/routes.test.ts`, `docs/auth-route-contract.md`, `docs/decisions/D-29-sessions-and-password-change.md`.

**Consumes:** Runs 3.2–3.4 (`AuthRouteEnv`, `Throttle`, `hasFreshTotp`, `authenticateHuman`, `signInComplete`, `checkPassword`).

**Produces:**

```ts
// @mykey/auth — sessions.ts
export type SessionVerdict =
  | { ok: true; session: { id: string; userId: UserId; phase: "password_verified" | "enrollment" | "mfa_complete"; fresh: boolean; token: string } }
  | { ok: false; reason: "absent" | "absolute" | "idle" | "challenge" | "account" | "epoch" };
export function resolveSession(deps: { auth: Auth; pool: Pool }, headers: Headers): Promise<SessionVerdict>;   // the one validity decision; deletes a row it finds expired
export function touchActivity(db: Queryable, sessionId: string): Promise<void>;                                // at most one write a minute per session
export interface SessionInfo { id: string; createdAt: string; lastActivityAt: string; client: string; current: boolean }
export function listSessions(db: Queryable, userId: UserId, currentSessionId: string): Promise<SessionInfo[]>;
export function revokeSession(db: Queryable, userId: UserId, sessionId: string): Promise<boolean>;             // false when the id is not this user's
export function cleanUpSessions(db: Queryable): Promise<number>;                                               // api_runtime: rows past either limit or past the challenge limit
// @mykey/auth/operator
export function cleanUpFactors(db: Queryable): Promise<{ steps: number; codes: number }>;                      // maintenance: steps older than a day, consumed codes, codes of retired enrollments
// @mykey/auth — password.ts
export type ChangeResult = { ok: true; revoked: number } | { ok: false; reason: "not_fresh" | "wrong_password" | "password_rejected" };
export function changePassword(deps: { auth: Auth; pool: Pool }, input: { sessionId: string; currentPassword: string; newPassword: string }): Promise<ChangeResult>;
```

Design fixed here:

- **`resolveSession`.** The raw token comes from the signed cookie as `sessionTokenOf` gets it today; everything after that is one SQL statement joining `auth.session` and `auth.account_state`, with every comparison on `now()`: absolute `authenticated_at + 12 h`; idle `last_user_activity_at + 30 min` (`mfa_complete` only); challenge `authenticated_at + 10 min` (the other phases); account state `active` (or `enrollment_pending` / `recovery_pending` for the phases that serve them); `auth_epoch` equal. An expired row is deleted in the same call. `authenticateHuman`, `currentSession`, `requireMfaComplete`, every factor route and `GET /v1/auth/get-session` decide through it — a search for `api.getSession` outside `sessions.ts` fails a unit test.
- **What moves `last_user_activity_at`:** sign-in, factor completion, step-up, and `POST /v1/session/activity`. Nothing else — not a GET, not a mutation. `touchActivity` writes only when the stored value is older than 60 s.
- **`session.activity`** (contract filled): no body; `200 { idleExpiresAt, absoluteExpiresAt }` (ISO times). Class `human`, so an expired session gets 401 and cannot revive itself.
- **Lists and revocation (P-50).** `GET /v1/auth/sessions` → `{ sessions: SessionInfo[] }`; `client` is the stored user agent cut to 120 printable ASCII characters. `POST /v1/auth/sessions/revoke { sessionId }` → 200; an id that is not the caller's own is the same `404 not_found` as an absent one; revoking the current session is allowed and equals sign-out. `POST /v1/auth/revoke-sessions` (native, kept) ends all including the current. Both need an `mfa_complete` session. No response of these routes holds a token or verifier.
- **Password change (P-49)** `POST /v1/auth/change-password { currentPassword, newPassword }`: `password` throttle for the account → lock account and session rows → `hasFreshTotp` else `403 fresh_verification_required` → `checkPassword(newPassword)` else `422 validation_failed` → verify the current hash with `(await auth.$context).password.verify` else `recordFailure` and `401 unauthenticated` → store the new hash, `credential_epoch + 1`, delete every other session of the user, audit `auth.password_change` → commit → `200 { revokedSessions }`. The session keeps its token and phase. `NATIVE_ALLOWED` loses `/change-password` (four remain); the route unit test pins the four.
- **Fresh class in the pipeline.** `mountRoute` for class `human_fresh_totp`: `principal.fresh` false → `403 fresh_verification_required`, after authorization and state (order of Doc 06 §4.4; Run 3.7 places it) and before the handler. Proven here on the two contract routes of that class through stubs.
- **Clean-up.** `cleanUpSessions` runs at start and every hour in the API (Doc 04 §2.1 asks for daily; hourly needs no schedule). The API's role may not delete used steps or recovery codes — Session 2 withheld that on purpose, so a compromised API cannot erase replay evidence — so those are removed by `ops auth-cleanup` as `maintenance` (`cleanUpFactors`; migration `0005` of Run 3.6 carries the two `DELETE` grants, until then the test grants them to its own role). Running it on a timer belongs to the host timers of Run 6.9; the report carries it.

### Task A — one validity decision, both limits

- [ ] **Step 1 — Failing tests** (`sessions.test.ts`; rows aged through the superuser; each case with its control):
  - `absolute: at 12 h − 5 s a product route answers, at 12 h + 1 s it is 401 and the row is gone` — with `last_user_activity_at` fresh, so only the absolute limit can be the reason.
  - `idle: at 30 min − 5 s it answers, at 30 min + 1 s it is 401 and the row is gone`.
  - `polling does not extend a session` — 40 GETs to a stubbed product route and to `/v1/auth/get-session` over an aged span: `last_user_activity_at` is byte-identical before and after; the session then expires on time.
  - `the activity signal extends idle and never absolute` — signal at 29 min: idle moves; a session at 11 h 59 min signals and still dies at 12 h.
  - `an expired session cannot signal` (401), `a password-only session cannot signal` (`mfa_incomplete`).
  - `two signals inside a minute write once` (row `xmin` unchanged on the second).
  - `sign-out ends the session for the next request`; `the account set to disabled, or its auth_epoch raised, ends it for the next request`.
  - `get-session agrees` — for each expired case above `GET /v1/auth/get-session` answers `null` and never reports a session a product route refuses.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Contract commit** `contract: session.activity body`. **Step 4 — Implement.** **Step 5 — Run:** PASS. **Commit** `feat(auth): session validity from database time, activity signal`.

### Task B — list, revoke, password change

- [ ] **Step 1 — Failing tests.**
  - `sessions.test.ts`: `the list shows this user's sessions with creation, last activity and client, marks the current one, and holds no token` (search the body for the cookie value and for `v1.`); `revoking another session ends it for its next request and leaves this one`; `revoking an id of another user is 404 and ends nothing` (control: that user's session still answers); `revoke-all ends every session including this one`; `a password-only session can neither list nor revoke`.
  - `password.test.ts`: `without fresh TOTP: 403 fresh_verification_required and nothing changes` (hash byte-identical, other sessions alive) — for an aged `totp_verified_at` and for a recovery-code session; `wrong current password: 401, counted, nothing changes`; `a new password of 11 characters: 422`; `success: the new password signs in, the old does not, credential_epoch rose by one, every other session is gone, this session still answers as mfa_complete with the same cookie`; `a sign-in that verified the old password before the change and commits after it is refused` (the epoch check of Run 3.2, driven by the hook); `a failure injected before commit leaves the old password and all sessions` (crash hook in deps); `five wrong current passwords lock the password phase`.
  - `routes.test.ts` (unit): `NATIVE_ALLOWED` is exactly sign-in, sign-out, get-session, revoke-sessions.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement;** regenerate the auth contract. **Step 4 — Run:** PASS. **Commit** `feat(auth): session list and revoke, atomic password change`.

### Task C — fresh verification on sensitive starts, clean-up

- [ ] **Step 1 — Failing tests** (`fresh.test.ts`, stubs): for each route of class `human_fresh_totp` (`export.create`, `credentials.issue`), as the owner on an active environment fixture (rows inserted by the test until Run 3.7's fixtures exist): `totp_verified_at` aged 601 s → `403 fresh_verification_required`, stub not reached; a new session completed with a recovery code → 403; after step-up → stub reached; at 595 s → reached; `freshness is per session` — a second session of the same user is not fresh because the first is. A unit test asserts the list of fresh-class routes plus the two auth routes (password change, regeneration) equals the four sensitive starts of FR-1.77.
  - `cleanUpSessions removes expired sessions and nothing live`; `cleanUpFactors removes steps older than a day, consumed codes and codes of retired enrollments, and nothing live` (counts before and after, with one live row of each kind as control); `a step removed after a day cannot be replayed` — its 30-second window is long past (assert `stepAt(now) − step > 1`).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement,** with the command `ops auth-cleanup` (`apps/ops/src/commands/auth-cleanup.ts`; prints the two counts). **Step 4 — Run:** PASS. **Commit** `feat(api): fresh-TOTP class, auth clean-up`. Write D-29.

**Registry:** `FR-1.05`, `FR-1.06`, `FR-1.77`, `AC-1.04`, `AC-1.35` → `SPIKE_PASS` (product code, real stores; the run note says that AC-1.35 for export and issuance was proven on stub handlers and is proven again by Runs 4.9 and 5.1). **Covers:** FR-1.05, FR-1.06, FR-1.77; AC-1.04, AC-1.35. **Done when:** background polling does not extend a session; each sensitive action returns `fresh_verification_required` without recent TOTP.

---

## Run 3.6 — Operator reset and recovery (D08-S14)

**Files:** `packages/db/src/schema/auth.ts`, `packages/db/migrations/0005_reset.sql`, `packages/auth/src/operator/{reset,index}.ts`, `packages/auth/src/reset/complete.ts`, `packages/auth/src/{sessions,routes,index}.ts`, `packages/auth/src/factors/elevate.ts`, `apps/ops/src/commands/reset-account.ts`, `apps/api/src/routes/reset.ts`, `packages/contracts/src/routes.ts`, `tests/harness/privilege-matrix.ts`, `tests/integration/ops/{reset,output}.test.ts`, `tests/integration/auth/{reset,reset-race}.test.ts`, `docs/auth-route-contract.md`, `docs/runbooks/operator-accounts.md`, `docs/decisions/D-30-reset-design.md`.

**Consumes:** Runs 3.2–3.5 (`runOps`, `writeSecretFile`, `resolveSession`, `Throttle.clearAccount`, `checkPassword`, `signInWithPassword`, `enrollOwner`, `startApiProcess`); key ring `reset-verifier`; `LIMITS.reset.linkSeconds`.

**Produces:**

```ts
// @mykey/auth/operator — reset.ts
export type ResetKind = "password" | "mfa";
export type InitiateResult = { outcome: "issued"; userId: UserId; token: string; expiresAt: Date } | { outcome: "refused"; reason: "no_such_account" | "disabled" };
export function initiateReset(deps: { pool: Pool; keys: AuthKeys; throttle: Throttle; crashAt?: (point: string) => void }, input: { email: string; kind: ResetKind }): Promise<InitiateResult>;
export function resetLink(baseUrl: string, token: string, kind: ResetKind): string;      // `${baseUrl}/reset#t=<token>&k=<kind>` — the fragment never reaches a server
// @mykey/auth — reset/complete.ts
export type CompleteResult = { ok: true; next: "sign_in" } | { ok: true; next: "enroll"; setCookie: string } | { ok: false; reason: "token" | "factor" | "state" };
export function completeReset(deps: FactorDeps & { throttle: Throttle }, input: { token: string; newPassword: string; code?: string; source: string; now?: Date }): Promise<CompleteResult>;
```

Design fixed here (P-51; Doc 06 §4.3):

- **Migration `0005`.** Table `auth.reset_token`: `id` uuid pk; `user_id` → `auth.user`; `verifier` bytea null, unique; `key_id` text; `kind` in (`password`, `mfa`); `created_at`; `expires_at`; `consumed_at` null; `superseded_at` null. Column `auth.session.reset_token_id` uuid null → `reset_token`. Grants: `maintenance` `INSERT`, `UPDATE (verifier, superseded_at)` on `reset_token`, `DELETE` on `auth.totp_step_used` and `auth.recovery_code` (Run 3.5's clean-up); `api_runtime` `SELECT`, `UPDATE (verifier, consumed_at)` on `reset_token`. The verifier is `HMAC-SHA-256(reset key, token)`; the token is 32 random bytes, base64url. The verifier is set to `NULL` at consumption, at supersession and by `cleanUpSessions` once expired (Doc 04 §2.1).
- **Initiation** — only `initiateReset`, only from `ops reset-account --email <address> --kind password|mfa`, one transaction as `maintenance`: lock `account_state` → state `recovery_pending`, `auth_epoch + 1` → delete every session of the user → supersede every open token of the user → insert the new token (`expires_at = now() + 900 s`) → audit `operator.reset_initiate` (details `{ kind }`). After commit: `throttle.clearAccount` for the e-mail and the user id (Review focus 2). The command writes the link with `writeSecretFile("reset-link", …)` and prints the path and the expiry time, never the link. No HTTP route initiates anything: there is no such handler to mount.
- **Completion** `POST /v1/auth/reset/complete` (contract filled; class `reset_flow`; Origin checked from Run 3.7): body `z.strictObject({ token: z.string().length(43), newPassword: <P-46 rule>, code: z.string().min(1).max(64).optional() })`; response `200 z.strictObject({ next: z.enum(["sign_in", "enroll"]) })`. A password outside the rule is `422 validation_failed` from the schema, before the token is looked at. Steps: `admit("reset", source)` → find the token row by verifier (every key of the ring) `FOR UPDATE`; it must be unconsumed, not superseded, `expires_at > now()`, and its account `recovery_pending` → lock `account_state`.
  - kind `password`: `code` is required; `admit("factor", user)`; check it as a TOTP step (used once) or a recovery code (consumed) against the active enrollment; wrong → `recordFailure("factor", user)`, the token stays open, answer the failure. Right → new hash, `credential_epoch + 1`, `auth_epoch + 1`, state `active`, token consumed, every session deleted, audit `auth.reset_complete` → `200 { next: "sign_in" }`, no cookie.
  - kind `mfa`: retire the active enrollment (state `retired`, `seed_jwe = ''`), mark all its recovery codes consumed, new hash, `credential_epoch + 1`, token consumed, every session deleted; the account **stays** `recovery_pending`; insert one challenge session (phase `enrollment`, `reset_token_id` set) → `200 { next: "enroll" }` with its cookie.
  - Every failure — unknown, expired, superseded or consumed token, wrong or missing code, wrong account state — is the same `401 unauthenticated`, audited as `auth.reset_failed` with the reason enum.
- **The challenge session.** `resolveSession` accepts it while the account is `recovery_pending`, the epoch matches, and `now()` is before the lesser of `authenticated_at + 10 min` and the token's `expires_at`. It reaches `/totp/enroll`, `/totp/activate` and `/sign-out` and nothing else. `enrollTotp` accepts `recovery_pending` only for such a session. Activation: enrollment `active`, ten new codes returned once, account `active`, `auth_epoch + 1`, every session deleted including the challenge — the user signs in afresh.
- **While `recovery_pending`** no password signs in (Run 3.2's state check) — neither the old nor, in the `mfa` flow before activation, the new.

### Task A — initiation

- [ ] **Step 1 — Failing tests** (`tests/integration/ops/reset.test.ts`, as `maintenance`; matrix extended in `privileges.test.ts`):
  - `initiation blocks the account at once` — a live `mfa_complete` session gets 401 on its next request; the correct password no longer signs in; the state is `recovery_pending`; `auth_epoch` rose by one.
  - `a second initiation supersedes the first link` — the first token then fails completion; one open token row exists.
  - `the table holds a verifier, never the token` (`pgDump` searched for the token); the audit row holds neither.
  - `the link carries the token only in the fragment` — `new URL(link)`: `pathname === "/reset"`, `search === ""`, the token is in `hash`.
  - `killed at each point and repeated: one open token, account recovery_pending` (child process, `crashAt`).
  - `a sign-in that verified the old password before initiation and commits after it is refused` (Run 3.2's hook).
  - `initiation clears a throttle lock` — lock both phases, initiate, complete with the right factor code: it succeeds.
  - `unknown e-mail: refused, nothing written`; `api_runtime cannot initiate` (permission denied on `reset_token`).
  - `output.test.ts`: `runOps(["reset-account", …])` prints a path and an expiry; stdout and stderr hold neither the token nor the link; the file is 0600 and holds the link.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(ops): operator-initiated reset`.

### Task B — completion, both kinds

- [ ] **Step 1 — Contract commit** `contract: auth.reset.complete body`.
- [ ] **Step 2 — Failing tests** (`reset.test.ts`, through `startTestApi`):
  - `password kind: token + new password + TOTP code → 200 next sign_in, no cookie; the new password with TOTP then signs in; the old password does not; the enrollment and recovery codes are unchanged`. Same with a recovery code in place of the TOTP code (that code is then consumed).
  - `password kind without a code, with a wrong code, with a replayed step: the same 401; the token still redeems afterwards with a right code`; `five wrong codes lock the factor phase: the right code is then 429`.
  - `mfa kind: 200 next enroll with a cookie; the old TOTP code and all old recovery codes are dead; the old seed is gone from the table`; `the challenge session reaches enroll, activate and sign-out, and for every other auth route and every product route (stubs) answers 401`; `the new password does not sign in before activation`; `activation returns ten codes, ends the challenge session, and only then does new password + new TOTP sign in`.
  - `an expired link leaves the account blocked` — token aged to 901 s: 401; state still `recovery_pending`; the old password still refused; at 895 s it redeems (control). `the challenge ends with the link` — redeemed at 14 min, challenge aged past the token's expiry: enroll is 401, account still `recovery_pending`; a re-issued link works.
  - `every failure looks alike` — unknown token, expired, superseded, consumed, wrong code, token of an `active` account: bodies equal but for the request id, same status, no cookie.
  - `a consumed token's verifier is NULL`; `completion cannot create an account or start a reset` — a well-formed token that matches no row: 401 and row counts of `auth.user`, `auth.reset_token` unchanged.
  - `the token is in no log` — after the suite: the harness `logs`, `postgresLog(stack, since)` and the audit table do not contain any token used (assembled at run time, compared by `includes`).
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement;** regenerate the auth contract. **Step 5 — Run:** PASS. **Commit** `feat(auth): reset completion for password and MFA loss`.

### Task C — only one link ever redeems

- [ ] **Step 1 — Failing test** `reset-race.test.ts` (two processes): `one token, two completions released together, one to each process: exactly one 200` — 20 rounds, each with a fresh reset; after each round one password hash change (`credential_epoch` rose by exactly one). `mfa kind under the same race: exactly one challenge session exists`. `initiation racing completion of the previous link: afterwards either the old link completed and the new one is open with the account recovery_pending again, or the old one failed — never an active account with an open token`.
- [ ] **Step 2 — Run** until 20/20. **Commit** `test(auth): single redemption across two API processes`. Extend `operator-accounts.md` (reset, both kinds, where the link file is, what the owner sees). Write D-30.

**Registry:** `FR-1.04`, `AC-1.03`, `PO-6` → `SPIKE_PASS` (product code, real stores). **Covers:** FR-1.04; AC-1.03; PO-6. **Done when:** an expired link leaves the account blocked; only one link ever redeems; no token appears in server logs.

---

## Run 3.7 — Authorization pipeline (D08-S15)

**Files:** `packages/contracts/src/{authz,routes,index}.ts` (+ `openapi.json`), `packages/db/migrations/0006_review_reason.sql`, `packages/db/src/schema/app.ts`, `packages/db/src/repos/{memberships,organizations,projects,environments}.ts`, `apps/api/src/pipeline/{origin,authn,authz,states,route}.ts`, `apps/api/src/routes/organizations.ts`, `packages/auth/src/routes.ts` (Origin on auth routes), `tests/harness/{tenants,privilege-matrix}.ts`, `tests/unit/authz/{decide,route-actions}.test.ts`, `tests/integration/authz/{matrix,concealment,origin,states,revocation}.test.ts`, `docs/evidence/session-3/authorization-matrix.md`, `docs/decisions/D-31-authorization-model.md`.

**Consumes:** Runs 3.1–3.5 (`mountRoute`, `authenticateHuman`, stubs, `resolveSession`, `appendAudit`, `signInComplete`); `enrolledUser` (Session 2 fixture); Doc 04 §1.1 and §1.2.

**Produces:**

```ts
// @mykey/contracts — authz.ts
export const ACTIONS = ["resources.manage", "secrets.read", "secrets.history", "secrets.write", "credentials.manage", "audit.view"] as const;
export type Action = (typeof ACTIONS)[number];
export type RouteScope = "none" | "organization" | "project" | "environment" | "operation";
export type Role = "owner" | "admin" | "member";
export type GrantRole = "reader" | "editor";
export interface Authority { role: Role; projectGrants: ReadonlyMap<string, GrantRole>; environmentGrants: ReadonlyMap<string, { projectId: string; role: GrantRole }> }
export interface Target { projectId?: string; environmentId?: string }
export type Decision = "allow" | "hidden" | "denied";
export function decide(authority: Authority | null, target: Target, action: Action | null): Decision;   // pure
export type StateClass = "none" | "metadata_read" | "metadata_write" | "secret_read" | "secret_write" | "credential_issue" | "lifecycle";
export function stateClassOf(route: RouteDef): StateClass;
// RouteDef gains:  readonly action: Action | null;  readonly scope: RouteScope;
// @mykey/db — repos/memberships.ts
export interface Resolved { authority: Authority | null; organization: { state: string; reviewReason: string | null } | null;
  project: { state: string; reviewReason: string | null } | null; environment: { state: string; reviewReason: string | null; kvReady: boolean } | null }
export function resolveAccess(db: Queryable, userId: UserId, ids: { organizationId: string; projectId?: string; environmentId?: string }): Promise<Resolved>; // current rows, one round trip, no cache
// apps/api — pipeline
export function checkOrigin(headers: Headers, baseUrl: string): boolean;
export function checkStates(route: RouteDef, resolved: Resolved): ErrorCode | null;
// ApiContext gains:  scope: OrgScope | ProjectScope | EnvironmentScope | null;  authority: Authority | null
// tests/harness/tenants.ts
export type FixtureUser = "ownerA" | "adminA" | "editorA" | "readerA" | "envEditorA" | "ungrantedA" | "ownerB";
export interface Tenants { a: { organizationId: string; project1: string; env1a: string; env1b: string; project2: string; env2a: string };
  b: { organizationId: string; project1: string; env1a: string }; cookie(user: FixtureUser): Promise<string>; userId(user: FixtureUser): string }
export function createTenants(api: TestApi): Promise<Tenants>;
```

Design fixed here (P-52, P-53):

- **Pipeline order** (Doc 06 §4.4), final: request id → gate → body limits → mixed-credential check → Origin check → authentication → strict validation of body and query → ancestry and membership → visibility → action → state → freshness → handler. A request with both a session cookie and an `Authorization` header is `400 mixed_authentication` before any database read. Validation comes after authentication so an anonymous caller learns nothing from a 422.
- **Origin** (FR-1.76): for every non-GET request of class `human`, `human_fresh_totp` or `reset_flow`, and every POST under `/v1/auth` including sign-in: the `Origin` header must be present and equal the origin of `config.baseUrl` exactly; `Sec-Fetch-Site`, when present, must be `same-origin`. Otherwise `403 origin_rejected`, before the session is read. A missing `Origin` is a refusal.
- **Ancestry.** Path ids that are not UUIDs, or that do not chain (`environment.project_id`, `project.organization_id`), are `404 not_found` — the same answer as hidden. `resolveAccess` reads membership (state `active`), grants and the three state rows in one statement on every request.
- **`decide`:** no authority → `hidden`. Owner and admin → `allow`. Member: an organization-level target is `allow` for action `null` and `denied` for any action; a project is visible when it has a project grant or any environment grant inside it — otherwise `hidden`; visible project with an action → `denied`; an environment's effective role is the stronger of its own grant and its project's (union) — none → `hidden`, even when a sibling environment is granted; `secrets.read` and `secrets.history` → `allow`; `secrets.write` → `allow` for `editor`, `denied` for `reader`; any other action → `denied`.
- **Answers.** `hidden` → `404 not_found`; `denied` → `403 action_denied`. Each is audited as `access.denied` with details `{ routeId, reason: "hidden" | "action" | "state" | "fresh" }`; `organizationId` is recorded only when the caller is a member of it.
- **Route actions** (the `contract:` commit; rows of routes owned by Sessions 4–7 are this plan's reading of Doc 04 §1.1, and the owning run may change one with its own `contract:` commit): `null` — `organizations.list`, `projects.list`, `environments.list`, `session.activity`, `reference.get`, `openapi.get`; `resources.manage` — project and environment create, rename, archive, reactivate; `secrets.read` — `secrets.list`, `secrets.reveal`, `export.create`, `operations.get`, `operations.list`; `secrets.history` — `secrets.history` and the historical reveal; `secrets.write` — create, update, delete, undelete, restore, import preview and apply; `credentials.manage` — every `credentials.*` route; `audit.view` — `audit.list`, `activity.list`, `overview.get`, `metrics.get`. A unit test fails when a human route has no entry. Every route under `/v1/organizations/:org` gains `state_conflict` and `backend_inconsistent` in its error list. Scope `operation` (`operations.get`) answers `404 not_found` until Run 4.1 defines its resolution.
- **State classes.** `metadata_read`: GET with action `null`, `resources.manage`, `credentials.manage` or `audit.view`. `metadata_write`: non-GET `resources.manage` except archive and reactivate. `secret_read`: `secrets.read`, `secrets.history`. `secret_write`: `secrets.write`. `credential_issue`: `credentials.issue`. `lifecycle`: archive, reactivate, credential revocation. `checkStates`, parent before child:

  | State | `metadata_read` | `metadata_write` | `secret_read` | `secret_write` | `credential_issue` |
  | --- | --- | --- | --- | --- | --- |
  | organization `provisioning`, `failed` | `state_conflict` | `state_conflict` | `state_conflict` | `state_conflict` | `state_conflict` |
  | organization `needs_review` | `backend_inconsistent` | `backend_inconsistent` | `backend_inconsistent` | `backend_inconsistent` | `backend_inconsistent` |
  | project or environment `pending` | ok | ok | ok when `kv_ready`, else `state_conflict` | same | `state_conflict` |
  | `active` | ok | ok | ok | ok | ok |
  | `revoking`, `archived` | ok | `state_conflict` | ok | `state_conflict` | `state_conflict` |
  | `needs_review` | ok | `state_conflict` | `backend_inconsistent` | `backend_inconsistent` | `backend_inconsistent` |

  `organizations.list` (scope `none`) is not subject to it: it is how the owner sees the state. State errors come only after visibility and action: a caller who may not see or do the thing gets 404 or 403, never the state.
- **Migration `0006`:** `review_reason` text null on `app.organization`, `app.project`, `app.environment`, check `review_reason IS NULL OR state = 'needs_review'` and a value check; grants for `provisioner_runtime`: `UPDATE (review_reason)` on organization and environment, `UPDATE (state, review_reason)` on project.
- **`organizations.list`** (contract filled): `200 { organizations: [{ id, role, state, reviewReason }] }` for the caller's active memberships. No namespace, no digest.
- **Fixtures.** `createTenants` inserts through the superuser (no product path creates these — that is the specification): organization A (`active`) with project 1 (environments 1a, 1b) and project 2 (environment 2a), organization B with one project and environment; users `ownerA`, `adminA`, `editorA` (editor on project 1), `readerA` (reader on project 1), `envEditorA` (editor on environment 1a only), `ungrantedA` (member, no grant), `ownerB`; each enrolled so `cookie()` returns an `mfa_complete` session with fresh TOTP.

### Task A — actions in the contract, `decide`

- [ ] **Step 1 — Failing tests.** `route-actions.test.ts`: every route of class `human` or `human_fresh_totp` has an action entry and a scope that matches its path (`:env` → `environment`, `:project` → `project`, `:org` → `organization`); machine and public routes have `action: null`, scope `none`; every organization route lists `state_conflict` and `backend_inconsistent`. `decide.test.ts`: the seven rows of Doc 04 §1.1 as a literal table (role or grant × action → decision); properties with `fast-check`: adding a grant never turns `allow` into anything else; an environment grant never narrows a project grant; no authority is always `hidden`; `decide` never returns `allow` for a member on `resources.manage`, `credentials.manage`, `audit.view`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `pnpm run contracts:openapi`. **Commit** `contract: an action and a scope for every route`.

### Task B — the pipeline steps

- [ ] **Step 1 — Failing tests.**
  - `origin.test.ts`: for every non-GET human route, `auth.reset.complete` and every POST auth route (table built from `ROUTES` and the mounted auth routes): no `Origin` → `403 origin_rejected`; `Origin: https://evil.example`; the right host with `http:`; the right host with another port; `Origin: null`; right `Origin` with `Sec-Fetch-Site: cross-site` and with `same-site` → 403 each, with a valid `mfa_complete` cookie attached, and the stub or handler not reached and no row changed. Control: the right `Origin`, with and without `Sec-Fetch-Site: same-origin`, passes this step. `a GET is not subject to it`. `sign-in with a foreign Origin is 403 and counts no throttle attempt`.
  - `concealment.test.ts`: `cookie + Authorization: Bearer x → 400 mixed_authentication` on a human and on a machine route, with zero queries on the pool (count through a wrapped pool); `client-supplied selectors are refused` — `?namespace=org-x`, `?path=kv/data/x`, a body with `namespace`, `policy`, `role: "owner"`, `organizationId` → `400 malformed_request`, for every Session 3 route; `a header x-role: owner changes nothing` (a reader stays denied).
  - `organizations.list returns only the caller's organizations, with role and state, and no namespace` (`ownerA` sees A; `ownerB` sees B; the body lacks `org-`).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Migration `0006`, implement** `origin.ts`, `authz.ts`, `states.ts`, `resolveAccess`, `tenants.ts`; contract commit `contract: organizations.list body`. **Step 4 — Run:** PASS. **Commit** `feat(api): origin check, tenant resolution, visibility and action checks`.

### Task C — every cell of the matrix

- [ ] **Step 1 — Failing test** `matrix.test.ts` (`startTestApi({ stubs: true })`, `createTenants`). The expected outcome of each cell is a literal table in the test, written from Doc 04 §1.1 — it does not call `decide`. Cells: every human route × the seven fixture users × targets (project 1 / environment 1a; environment 1b; project 2 / environment 2a; organization B's). Each cell asserts one of: stub reached (`allow`); `403 action_denied` and stub not reached; `404 not_found` and stub not reached. For every non-allow cell the test reads the `access.denied` audit row of that request id and asserts its `reason` (Review focus 1), and the suite fails if some route has no allow cell at all. Named cases on top of the table:
  - `envEditorA writes in environment 1a, gets 404 for 1b, sees project 1 in projects.list and not project 2`.
  - `readerA reads values and history in project 1 and gets 403 on every write`.
  - `editorA cannot manage resources, credentials or audit: 403`; `ungrantedA sees an empty project list and 404 on every project`.
  - `ownerB gets 404 for every id of organization A`, and `ownerA for B`.
  - `hidden equals absent` — for each scope, the response to a hidden id and to a random UUID: same status, same header names, same body but for `requestId`, same `Content-Length`.
  - `an id of the right kind under the wrong parent is 404` — environment 2a addressed under project 1; project 1 under organization B.
  - `non-UUID ids are 404`.
  - The test writes `docs/evidence/session-3/authorization-matrix.md`: one line per cell with its result, and the totals.
- [ ] **Step 2 — Run:** FAIL where the pipeline is wrong; fix the pipeline, never the table (a wrong table entry is fixed only with a quotation of Doc 04 in the commit message). **Step 3 — Run:** PASS. **Commit** `test(authz): the authorization matrix, cell by cell`.

### Task D — states and revocation mid-session

- [ ] **Step 1 — Failing tests.**
  - `states.test.ts`: one case per filled cell of the state table above (state set through the superuser, `ownerA` as caller), asserting the code or that the stub was reached; `a caller who cannot see the scope gets 404, not the state` (`ownerB` against a `needs_review` environment of A; `readerA` gets 403 on a write to an archived environment, not `state_conflict`); `a parent's state wins` — organization `needs_review` with an `active` environment: `backend_inconsistent`; `organizations.list still answers and shows needs_review with its reason`.
  - `revocation.test.ts`: with one live session per user and no new sign-in: `grant deleted → the next request is 404`; `grant lowered editor → reader → the next write is 403`; `membership revoked → 404 on every route of the organization, organizations.list no longer shows it`; `admin lowered to member → 403 / 404 as the matrix says`; `session revoked → 401`; `account disabled → 401`. `a change flips the very next request, 20 times in a row` (grant on, off, on …) — there is no cache to wait for. `a request already inside its handler finishes; the one after is denied` — the stub waits on a latch while the grant is deleted, then returns its 204; the next request is 404.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(api): state precedence; test(authz): revocation takes effect on the next request`. Write D-31.

**Registry:** `FR-1.09`, `FR-1.10`, `FR-1.11`, `AC-1.08` → `SPIKE_PASS` (product code, real stores; secret, credential and audit routes on stub handlers — their owner runs re-run `matrix.test.ts` with the real handlers, which needs no change to the test). **Covers:** FR-1.09, FR-1.10, FR-1.11; AC-1.08; the browser-protection part of FR-1.76 that the API owns. **Done when:** every cell of the authorization matrix has a passing test, including after a grant is removed mid-session.

---

## Run 3.8 — Organization provisioning (D08-S16)

**Files:** `packages/openbao/src/{client,admin,provisioner,policies,index}.ts`, `packages/openbao/package.json` (export `./provisioner`), `infra/openbao/policies/provisioner.hcl`, `docs/evidence/session-2/authority-matrix.md` (regenerated by `pnpm run authority:matrix`), `packages/operations/src/provisioning/{steps,organization,environment,verify}.ts`, `packages/operations/src/records.ts`, `packages/db/src/repos/{organizations,environments,operations}.ts`, `apps/ops/src/commands/{provision-organization,verify-organization}.ts`, `apps/provisioner/{Dockerfile,package.json}`, `apps/provisioner/src/{main,config,worker,sweep,healthcheck}.ts`, `apps/api/src/selfcheck.ts`, `tests/harness/{org-fixture,api-worker,staging-owner}.ts`, `tests/staging/api.staging.test.ts`, `infra/compose/host.compose.yml`, `infra/hosts/checks/{status,heartbeat}.sh`, `workers/probe/src/evaluate.ts`, `scripts/{host,probe}.ts`, `tests/unit/openbao/*.test.ts`, `tests/unit/probe/evaluate.test.ts`, `tests/unit/skeleton/skeleton.test.ts`, `tests/integration/provisioning/{organization,environment,drift}.test.ts`, `tests/fault/provisioning/{boundaries.test,runner}.ts`, `tests/staging/provisioning.staging.test.ts`, `docs/runbooks/{provisioning,credential-custody,probe}.md`, `docs/decisions/D-32-provisioning-model.md`, `docs/decisions/D-17-*.md` (amendment note).

**Consumes:** `OpenBaoAdmin`, `appRoleLogin`, `renderPolicy`, `renderMachinePolicy`, `machineTokenRole`, `namespaceFor`, `machineName`, `APPROLE_TOKEN_TTL_SECONDS` (Session 2); Run 3.1 (`insertOperation`, `createWorker`, `appendAudit`, `readGate`); Run 3.2 (`runOps`, `bootstrapOwner`); Run 3.7 (`review_reason`, state table); `freshNamespace`, `baoFetch`, `readAuditLog`, `restartService` (harness).

**Produces:**

```ts
// @mykey/openbao/admin — additions
putAppRole(namespace: string, name: AppRoleName, ttlSeconds: number, boundCidrs?: readonly string[]): Promise<{ roleId: string }>;
readAppRole(namespace: string, name: AppRoleName): Promise<Record<string, unknown> | null>;
listSecretIdAccessors(namespace: string, name: AppRoleName): Promise<string[]>;
destroySecretIdAccessor(namespace: string, name: AppRoleName, accessor: string): Promise<void>;
readNamespace(namespace: string): Promise<boolean>;  readKvMount(namespace: string): Promise<Record<string, unknown> | null>;  readKvConfig(namespace: string): Promise<Record<string, unknown> | null>;
// @mykey/openbao/provisioner — the provisioner identity's whole reach
export class ProvisionerClient { constructor(target: OpenBaoTarget, namespace: string, credential: { roleId: string; secretId: string });
  readOrgPolicy(name: AppRoleName): Promise<Answer<string | null>>;  readKvMount(): Promise<Answer<Record<string, unknown> | null>>;  readKvConfig(): Promise<Answer<Record<string, unknown> | null>>;
  readMachinePolicy(name: string): Promise<Answer<string | null>>;   putMachinePolicy(name: string, hcl: string): Promise<Answer<void>>;
  readMachineTokenRole(name: string): Promise<Answer<ReadableTokenRole | null>>;  putMachineTokenRole(name: string, role: MachineTokenRole): Promise<Answer<void>>;
  close(): Promise<void> }                                            // revoke-self
export type Answer<T> = { ok: true; value: T } | { ok: false; cause: "denied" | "unreachable" | "sealed" | "unknown" };
// @mykey/operations — provisioning
export type StepOutcome = "verified" | "written" | "mismatch" | "unknown";
export interface OrganizationPlan { namespace: string; kv: Record<string, unknown>; policies: Record<AppRoleName, string>; appRoles: Record<AppRoleName, Record<string, unknown>> }
export function organizationPlan(organizationId: OrganizationId, boundCidrs: Record<AppRoleName, readonly string[]>): OrganizationPlan;
export function configDigest(read: { kvMount: unknown; kvConfig: unknown; policies: Record<AppRoleName, string> }): string;   // sha256 hex of canonical JSON; only what the provisioner identity can read
export type ProvisionResult = { outcome: "active"; operationId: OperationId; configDigest: string } | { outcome: "review"; operationId: OperationId; step: string } | { outcome: "retry"; operationId: OperationId; step: string; cause: string };
export function provisionOrganization(deps: { pool: Pool; admin: OpenBaoAdmin; deliver: (name: AppRoleName, credential: { roleId: string; secretId: string }) => Promise<void>; boundCidrs: Record<AppRoleName, readonly string[]>; crashAt?: (point: string) => void }, organizationId: OrganizationId): Promise<ProvisionResult>;
export function provisionEnvironment(deps: { pool: Pool; clientFor: (organizationId: OrganizationId) => Promise<ProvisionerClient | null>; bootId: string; crashAt?: (point: string) => void }, operationId: OperationId): Promise<void>;
export function sweepOrganization(deps: { pool: Pool; clientFor: (organizationId: OrganizationId) => Promise<ProvisionerClient | null> }, organizationId: OrganizationId): Promise<{ reviewed: { scope: "organization" | "environment"; id: string; object: string }[] }>;
// tests/harness/org-fixture.ts
export function provisionTestOrganization(api: TestApi, stack: Stack, organizationId: string): Promise<{ credentials: Record<AppRoleName, { roleId: string; secretId: string }> }>;   // provisionOrganization with the stack's root token
```

Design fixed here (P-54, P-55, P-56, P-57):

- **Carried fixes first (M13).** `kvRead(path, 0)` is refused before any request (version 0 is not a version); `tokenRevokeSelf` answers `unknown` on a 5xx, as every other change does; the amendment note in D-17 corrects the sentence about the foreign-accessor 500 to what Run 2.2 observed. Each with its test in `tests/unit/openbao`.
- **Provisioner policy** gains `read` on `sys/policies/acl/runtime`, `…/issuer`, `…/provisioner`, `sys/mounts/kv` and `kv/config` — nothing it can write changes. `pnpm run authority:matrix` regenerates the matrix; the Session 2 authority tests (`tests/integration/openbao`) are extended with the five new allowed reads and re-assert every denied row unchanged.
- **Organization provisioning is the operator's** (`ops provision-organization --organization <id>`, `needsOpenBao`, root token from workstation custody as `connectStaging` reads it). One operation: principal `operator`, action `organization.provision`, target and idempotency key the organization id — a repeat finds the same row (FR-1.08: one operation id). A session-level advisory lock on the organization id makes a second concurrent run exit with `already running`.
- **Steps**, in order; each records an `operation_step` row before its effect and its outcome after: `owner-binding` (exactly one active owner membership — else refuse), `namespace`, `kv-mount` (type `kv`, version 2, and `kv/config` equal to `cas_required: true`, `max_versions: LIMITS.secret.versionsKept`, `delete_version_after: "0s"`), `approle-auth`, `policy:runtime`, `policy:issuer`, `policy:provisioner`, `approle:runtime`, `approle:issuer`, `approle:provisioner`, `read-back` (everything again, then `configDigest`), `secret-ids`, `activate`.
- **Compare, then act (P-55).** Each step reads its object first: equal to the plan → `verified`, nothing written; absent → write, read back, `written`; present and different → `mismatch`: stop, organization `needs_review` with reason `backend_inconsistent`, operation `awaiting_input`, audit, exit 3 — **never overwrite**. A write whose answer is unclear → `unknown`: stop with `retry`; the next run's comparison settles it. A resumed run starts at the first step again. After the operator has removed the foreign object, the same command is the reconciliation. `ops verify-organization --organization <id>` is the read-only half: every object read back with the root token, the AppRoles included, nothing written; it prints `equal` or the names of the objects that differ and exits 0 or 3.
- **`secret-ids`.** For each role: list secret-id accessors, destroy every one, issue one, `deliver` it. After the step each role has exactly one accessor, whatever was interrupted. On a host `deliver` installs `runtime-role-id`, `runtime-secret-id`, `issuer-role-id`, `issuer-secret-id` under `/etc/mykey/secrets/api/` and `provisioner-role-id`, `provisioner-secret-id` under `/etc/mykey/secrets/provisioner/`, each on stdin, plus the non-secret `organization-id` beside them. A host serves one provisioned organization in Stage 1; `clientFor` on a host answers for that id and `null` for any other.
- **`activate`:** one transaction — organization `active`, `config_digest`, `provisioning_operation_id`, operation `succeeded`, audit `operator.organization_provision`.
- **Bound addresses (P-56).** `organizationPlan` puts `secret_id_bound_cidrs` and `token_bound_cidrs` into each AppRole; the comparison covers them. Hosts: `runtime` and `issuer` 10.78.3.3/32, `provisioner` 10.78.3.4/32. Local tests pass empty lists, except the one test that proves the binding.
- **`apps/provisioner`.** Start: read config and files, open the pool as `provisioner_runtime`, `createWorker`, start the sweep timer. It imports `@mykey/openbao/provisioner`, never `/admin`. Job `environment.provision`: check the gate (closed → throw, pg-boss retries); claim `UPDATE app.operation SET state = 'executing', executor_boot_id, dispatched_at = now(), heartbeat_at = now() WHERE id = $1 AND (state = 'accepted' OR (state = 'executing' AND heartbeat_at < now() - interval '60 seconds'))` — no row → done, another run has it; then steps `kv-scope` (read `kv/config`, compare), `machine-policy`, `token-role`, each compare-then-act with read-back; then one transaction: environment `active`, `kv_ready`, `policy_digest`; its project `active` when it was `pending`; operation `succeeded`; audit `system.environment_provision`. `mismatch` → environment `needs_review` / `backend_inconsistent`. `clientFor` gives `null`, or OpenBao answers `denied` → environment `needs_review` / `provisioning_failed`. `unreachable`, `sealed`, `unknown` → throw; the job is retried (limit 5, exponential backoff) and the environment stays `pending`; after the last retry → `needs_review` / `provisioning_failed`. A late duplicate job finds the operation `succeeded` and returns.
- **Drift sweep** every `MYKEY_SWEEP_SECONDS` (default 300; 60 on staging) and at start, for every `active` organization: KV mount, KV config and the three policies against `config_digest`; for every `active` environment its machine policy and token role against `policy_digest`. A difference or an absence in an environment's objects → that environment `needs_review` / `backend_inconsistent`; in an organization's objects, or the provisioner's own login `denied` → the organization. `unreachable` or `sealed` changes nothing (that is the health check's business). One audit row `system.drift_detected` per scope, details `{ scope, object }` with `object` from a closed enum. A scope already in review is not written again.
- **Alert (P-57).** `status.sh` gains `reviewOpen` (count of organizations, projects and environments in `needs_review`, one read-only statement through the PostgreSQL container's local socket; `null` when it cannot be read) and `provisioner` (`healthy`, `unhealthy`, `absent` from the container's health state — the image's health check is `healthcheck.ts`, which fails when the last sweep is older than three intervals). The heartbeat sends `reviewOpen`; the probe's `evaluate` gains condition `review_open` (true while `reviewOpen > 0`), alerting once on entry and once on exit like the others. `scripts/probe.ts` prints through `redact` (M4).
- **The API holds no such credential.** Compose service `provisioner` (profile `openbao`): networks `mk-db` 10.78.2.4 and `mk-bao` 10.78.3.4, mounts `/etc/mykey/secrets/provisioner:/run/mykey/secrets:ro` and the gate directory, no published port, no egress row. The `provisioner_runtime` database password moves to the host (`HOST_SECRETS`, `ROLE_PASSWORD_PLACE`, custody documents). `selfcheck.ts` in the API: at start, where OpenBao is configured, log in with the runtime credential and revoke the token; log `{ event: "selfcheck", runtimeLogin: "ok" | "refused" | "unreachable" | "absent" }` — a log line only in this session; Run 4.2 decides whether it gates health.

### Task A — client fixes, provisioner reach

- [ ] **Step 1 — Failing tests.** Unit: the three M13 cases. Integration (`tests/integration/openbao`, a fresh namespace from `provisionTestOrganization` once Task B exists — until then `createOrgFixture`): the provisioner identity reads the three policies, `sys/mounts/kv` and `kv/config`; it still cannot write any of them, cannot read `kv/data/*`, cannot read `auth/approle/role/*`, cannot create a token; `runtime` and `issuer` gained nothing (their rows of the matrix unchanged). `an AppRole bound to 203.0.113.7/32 refuses a login from the test host; bound to the address OpenBao's audit log shows for the test host, it accepts` (`readAuditLog`). `after three newSecretId calls, listSecretIdAccessors returns three; after destroying them a login with any of the three is refused`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement;** `pnpm run authority:matrix`. **Step 4 — Run:** PASS. **Commit** `feat(openbao): provisioner reads for verification, bound AppRoles, M13`.

### Task B — the organization operation

- [ ] **Step 1 — Failing tests** (`organization.test.ts`):
  - `a bootstrapped organization becomes active: namespace, mount, config, three policies, three roles read back equal to the plan; one secret-id accessor per role; config_digest set; one operation, succeeded; one audit row`.
  - `a second run changes nothing in OpenBao` — the audit log of OpenBao (`readAuditLog`) shows no write request in the namespace during the second run except the secret-id rotation; the operation id is the same.
  - `each foreign object stops it` — for each of: a policy with other text, `kv/config` with `cas_required: false`, an AppRole with a longer TTL, an AppRole without its CIDRs: outcome `review` naming the step; the object is byte-identical afterwards (not overwritten); organization `needs_review` / `backend_inconsistent`; after the object is removed the same command ends `active`.
  - `verify-organization says equal after provisioning; after an AppRole's TTL is changed it names approle:runtime, exits 3, and has written nothing` (OpenBao's audit log shows reads only).
  - `no owner, or two owners: refused before any OpenBao request`.
  - `two runs at once: one works, one reports already running; one namespace`.
  - `an organization that is not active is closed to its owner` — while `provisioning`: every organization route is `409 state_conflict`; `organizations.list` shows `provisioning`.
  - `a late duplicate of each write is harmless` — after completion, each step's write is sent once more with the root token: the read-back and `configDigest` are unchanged.
  - `tests/fault/provisioning/boundaries.test.ts`: the child process `runner.ts` runs `provisionOrganization` with `crashAt` exiting 137 at `<step>:before`, `<step>:after-effect`, `<step>:after-record` for every step (39 points). After each kill, a clean run ends `active` with: exactly one namespace for the organization, every object equal to the plan, exactly one secret-id accessor per role, the credential last delivered logs in and no earlier one does, one operation id, organization `active` exactly once in the audit trail.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement;** rebuild `createOrgFixture` on `provisionOrganization` (the Session 2 tests that use it stay green — run `pnpm run test:integration` whole). **Step 4 — Run:** PASS. **Commit** `feat(ops): durable organization provisioning with read-back`.

### Task C — the provisioner process

- [ ] **Step 1 — Failing tests** (`environment.test.ts`, `drift.test.ts`; the provisioner runs as a child process on the test stack, started by `startProvisionerProcess(database, credentials)` in `tests/harness/api-worker.ts`, which returns `{ pid, kill(), stop() }`):
  - `an accepted environment.provision operation ends with policy and token role equal to the plan, environment active, kv_ready, policy_digest set, project active` (operation and outbox rows inserted by the test until Run 3.9).
  - `killed at each point and restarted: one policy, one token role, environment active once` (`crashAt` points of the three steps and the final transaction; the stale-claim rule is tested by ageing `heartbeat_at`).
  - `two workers, one job delivered twice: one executes, the other returns`.
  - `a different machine policy already present → environment needs_review / backend_inconsistent, object untouched`.
  - `provisioner credential destroyed → after the retries the environment is needs_review / provisioning_failed`; `OpenBao stopped → the environment stays pending and becomes active after it returns` (`stopService`, `startService`).
  - `gate closed → no job is executed`; opened → it runs.
  - `drift.test.ts`: `machine policy deleted → within one sweep that environment is needs_review, its sibling environment and the organization are not`; `token role changed (longer TTL)` → same; `policy runtime deleted`, `kv/config changed`, `policy provisioner deleted` → the organization `needs_review`; `OpenBao stopped during a sweep → nothing changes state`; each detection wrote one `system.drift_detected` row and a second sweep wrote none; `the pipeline then answers 503 backend_inconsistent for a secret-class route on that scope and still lists it` (owner cookie, terminal handler; a sibling scope answers the terminal 404).
  - `skeleton.test.ts`: `apps/api` has no import path to `@mykey/openbao/provisioner` or `/admin`; `apps/provisioner` has none to `/admin`, `@mykey/auth` or `apps/ops`.
  - `evaluate.test.ts`: `review_open` enters on `reviewOpen: 1`, stays without a second alert, leaves on `0`; `reviewOpen: null` is not an alert of this condition.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(provisioner): environment provisioning worker and drift sweep`.

### Task D — staging

- [ ] **Step 1 — Failing staging test** `provisioning.staging.test.ts` (target assertion first): `the staging organization is active with a config_digest`; `the API container mounts no provisioner secret, holds no file or environment variable named like a root or provisioner credential, and its self-check logged runtimeLogin ok` (`docker inspect`, `ls` of `/run/mykey/secrets` through `sshExec`, the log line); `the provisioner container has no published port and no route out` (as `boundary.staging.test.ts` does for the others); `the runtime credential is refused from the tunnel's address` (read role id and secret id with `secretOutput`, `registerSecret` both, `appRoleLogin` through the tunnel → refused); `AC-1.09` — insert a synthetic project and environment for the staging organization through the superuser with an `environment.provision` operation, wait until `active`; delete its machine policy with the root token; within 150 s the environment is `needs_review` / `backend_inconsistent`, the owner's `secrets.list` on it answers `503 backend_inconsistent`, `environments.list` still shows it, `host.ts staging status` reports `reviewOpen: 1`, and `probe.ts state staging` shows `review_open`; then restore: put the policy back, set the environment `active` through the superuser (the operator's reconciliation command is Run 4.5), and see `review_open` leave. The synthetic rows stay (ids in the run note) for Run 3.10.
- [ ] **Step 2 — Deploy.** Announce the window in the run note (expected alerts: `health` during the restart, `review_open` during the drill). Build and load both images (`host.ts staging image api`, `image provisioner`), `push`, install the `provisioner_runtime` password on the host, `db-init` (migrations to `0006`), `node scripts/probe.ts deploy`, `host.ts staging ops provision-organization --organization <id of Run 3.2>`, `up`, `gate open`.
- [ ] **Step 3 — The staging owner's first sign-in.** `tests/harness/staging-owner.ts` (created here): `stagingOwnerSession(): Promise<{ cookie: string }>` signs in through the public name with the password of Run 3.2, enrolls and activates TOTP on first use and stores the seed and the recovery codes under `~/.mykey/secrets/hosts/staging/` (0600, never printed), and from then on completes sign-in with a code from the stored seed. Added to `api.staging.test.ts`: `the staging owner signs in through the public name and receives a Secure, HttpOnly, SameSite=Strict, host-only cookie`; `a sign-up attempt through the public name is 404`; `a password-only session gets 401 mfa_incomplete on organizations.list`; `the sixth sign-in attempt in a minute for an unused synthetic e-mail is 429` (the rows of that subject are aged away afterwards through the superuser tunnel).
- [ ] **Step 4 — Run** the staging files `api` and `provisioning`: PASS. Write `docs/runbooks/provisioning.md` (the command, its exit codes, what review means, how to reconcile, where the delivered files are), update `credential-custody.md`, `custody-map.md`, `probe.md`; D-32 and the D-17 amendment note. **Commit** `feat(hosts): provisioner on staging, review alert through the heartbeat`.

**Registry:** `FR-1.08`, `FR-1.12`, `FR-1.55`, `AC-1.06`, `AC-1.09`, `PO-4` → `SPIKE_PASS` (product code, real stores; staging). **Covers:** FR-1.08, FR-1.12, FR-1.55; the Session 3 share of FR-1.13; AC-1.06, AC-1.09; PO-4. **Done when:** killing the provisioner at every step and retrying ends with one correct namespace; removing a policy on staging triggers review and an alert.

---

## Run 3.9 — Projects and environments (D08-S17)

**Files:** `packages/contracts/src/routes.ts` (+ `openapi.json`, pending snapshot), `packages/db/src/schema/app.ts`, `packages/db/migrations/0007_resource_generation.sql`, `packages/db/src/repos/{projects,environments,organizations,operations}.ts`, `packages/operations/src/{replay,records,index}.ts`, `apps/api/src/pipeline/{cursor,route}.ts`, `apps/api/src/routes/{projects,environments}.ts`, `tests/harness/privilege-matrix.ts`, `tests/unit/operations/replay.test.ts`, `tests/unit/api/cursor.test.ts`, `tests/integration/resources/{projects,environments,listing,readiness,no-delete}.test.ts`, `docs/decisions/D-33-resource-operations.md`.

**Consumes:** Run 3.1 (`withTransaction`, `insertOperation`, `findOperationByKey`, `enqueueOutbox`, `appendAudit`); Run 3.7 (pipeline, `ApiContext.scope`, `createTenants`, state table); Run 3.8 (the provisioner process and its test helper, `provisionTestOrganization`); key rings `replay-fingerprint`, `cursor-mac`; `checkProjectName`, `ENVIRONMENT_NAME_PATTERN`, `LIMITS.listing`, `operationResponseSchema`.

**Produces:**

```ts
// @mykey/operations — replay.ts
export function intentFingerprint(ring: KeyRing, intent: { principalKind: string; principalId: string; action: string; target: string; body: unknown }): { digest: Buffer; keyId: string }; // HMAC-SHA-256 over canonical JSON (sorted keys, NFC strings)
export type Begin = { kind: "fresh"; operationId: OperationId } | { kind: "replay"; operation: OperationRow } | { kind: "conflict" };
export function beginOperation(tx: PoolClient, ring: KeyRing, input: OperationKey & { organizationId: OrganizationId; body: unknown }): Promise<Begin>;  // insert-or-find on the unique key; compares fingerprints under the stored key id
export function operationResponse(row: OperationRow): OperationResponse;                    // statusUrl `/v1/operations/<id>`; never the fingerprint
// @mykey/db — repos
export function createProject(tx: PoolClient, scope: OrgScope, input: { projectId: ProjectId; name: string; developmentEnvironmentId: EnvironmentId }): Promise<"created" | "name_taken">;
export function renameProject(tx: PoolClient, scope: ProjectScope, name: string): Promise<"renamed" | "name_taken" | "unchanged">;
export function createEnvironment(tx: PoolClient, scope: ProjectScope, input: { environmentId: EnvironmentId; name: string }): Promise<"created" | "name_taken">;
export function renameEnvironment(tx: PoolClient, scope: EnvironmentScope, name: string): Promise<"renamed" | "name_taken" | "unchanged">;
export function listProjects(db: Queryable, scope: OrgScope, visible: "all" | readonly string[], page: { afterId: string | null; limit: number }): Promise<ProjectRow[]>;
export function listEnvironments(db: Queryable, scope: ProjectScope, visible: "all" | readonly string[], page: { afterId: string | null; limit: number }): Promise<EnvironmentRow[]>;
export function bumpResourceGeneration(tx: PoolClient, scope: OrgScope): Promise<bigint>;
// apps/api — pipeline/cursor.ts  (Run 4.3 reuses it)
export function signCursor(ring: KeyRing, c: { routeId: string; scope: string; filter: string; lastKey: string; generation: string }): string; // base64url(payload) + "." + base64url(HMAC)
export function readCursor(ring: KeyRing, text: string, expect: { routeId: string; scope: string; filter: string }): { lastKey: string; generation: string } | null;
```

Design fixed here (P-58, P-59; Doc 06 §6.3, §9):

- **Contract commit.** `projects.list`: query `z.strictObject({ limit, cursor })` as `secretsListQuery` without `prefix`; `200 { projects: [{ id, name, state, reviewReason, createdAt }], nextCursor: string | null }`. `environments.list`: the same with `{ id, name, state, reviewReason, kvReady, createdAt }`. No namespace, path, policy name or digest in either. Create and rename keep the operation envelope; their `result` is `{ projectId, developmentEnvironmentId }`, `{ environmentId }`, or `{}` for a rename.
- **A mutation** (`mountRoute` does the common part for every `idempotent` route; `ApiContext` gains `idempotencyKey`): `Idempotency-Key` missing or not a UUID → `422 precondition_required`. Replay is looked up after authorization and **before** the state and freshness checks (Doc 06 §6.2 step 1): `findOperationByKey` → found with an equal fingerprint: answer the stored row with the status it had (201 or 200) and stop; found with another fingerprint: `409 idempotency_conflict`. So a completed request replays its answer even when the scope has since been blocked. Not found: state → freshness → the handler's one transaction: `beginOperation` (which settles the race of two first requests: the loser gets `replay` or `conflict` as above) → `fresh`: re-read the parent states `FOR SHARE` (FR-1.10's admission recheck) → the repository call → `name_taken`: roll back and answer `409 already_exists` — nothing of the operation remains, and the same key with the same body gets the same 409 again → on success: operation `succeeded` with `result` and `completed_at`, audit (`project.create`, `project.rename`, `environment.create`, `environment.rename`; details hold ids and the name's length, never the name), `bumpResourceGeneration` for creates → commit → answer.
- **Create project:** the project (`pending`), its `development` environment (`pending`), one system operation `environment.provision` (state `accepted`, principal `system`, target the environment id, idempotency key the environment id) and its outbox row — all in that transaction. **Create environment:** the same for one environment; the project must be `pending` or `active`.
- **Names.** The schemas of the contract already normalise a project name to NFC and check both rules; a name outside them is `422 validation_failed`. Uniqueness is the database's (`project_organization_name_key`, `environment_project_name_key`), exact after NFC: `Api` and `api` are two projects; leading and trailing spaces are kept and count.
- **Rename** changes `name` only. A rename to the current name is `unchanged`: `200`, operation `succeeded`, no audit row for a change that did not happen. Allowed in `pending` and `active` (the state table's `metadata_write`).
- **Lists.** Order by `id`; `visible` is `"all"` for owner and admin and the ids from the caller's grants for a member (a project with only an environment grant appears; in `environments.list` only the granted environments, unless the project itself is granted). The first page reads `organization.resource_generation` and signs it into the cursor with route id, scope (`organizationId` or `organizationId/projectId`) and an empty filter; a later page whose stored generation differs → `409 listing_changed`; a cursor that fails its MAC, belongs to another route or scope, or does not parse → `400 malformed_request`. A rename does not change the generation (ids, the keys of the order, do not move).
- **No delete.** `HttpMethod` has no `DELETE`; no repository function deletes a project or an environment; `api_runtime` holds no `DELETE` on either table.
- **Migration `0007`:** `app.organization.resource_generation` bigint not null default 0; `GRANT UPDATE (resource_generation) ON app.organization TO api_runtime`.

### Task A — replay and cursors

- [ ] **Step 1 — Failing tests.** `replay.test.ts` (unit): the fingerprint is equal for bodies that differ only in key order, differs for a different name, principal, action or target, is 32 bytes, and carries the key id; a fixed vector for a fixed key. Integration (in `projects.test.ts`, on a stub-free route below, written now and red until Task B): see Task B's replay cases. `cursor.test.ts`: round trip; a changed byte in payload or MAC → `null`; a cursor of `projects.list` given to `environments.list` → `null`; another organization's scope → `null`; a cursor signed with a retired key id still reads while the key is in the ring.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** unit PASS. **Commit** `feat(operations): replay identity and intent fingerprint; signed list cursors`.

### Task B — projects

- [ ] **Step 1 — Contract commit** `contract: project and environment list bodies`.
- [ ] **Step 2 — Failing tests** (`projects.test.ts`; `createTenants`, organization A provisioned with `provisionTestOrganization`, the provisioner child process running):
  - `the owner creates a project: 201 with the operation envelope, state succeeded, result ids; the project and its development environment exist as pending; one accepted environment.provision operation and one outbox row exist; one audit row` — and within ten seconds the environment and the project are `active` (Task D asserts the details).
  - `the admin can; editor, reader, ungranted member get 403; ownerB gets 404` — each denial with its control and nothing created.
  - Names, each as its own case with the exact code point counts: 1 code point accepted; 64 accepted; 65 → 422; empty → 422; only spaces → 422; a tab, a NUL, U+0085, U+202E inside → 422 (control characters; if `checkProjectName` allows a format character such as U+202E, assert what the contract function says and note it); an astral character counts as one (64 emoji accepted); `"e" + U+0301` is stored as U+00E9 and collides with a project created as U+00E9 (`409 already_exists`); `" api"`, `"api "` and `"api"` are three projects; `Api` and `api` are two; the response and the list return the stored (NFC) form.
  - `two creates of one name at once: one 201, one 409 already_exists, one project, one development environment` (20 rounds, two keys).
  - Replay: `the same key and body again → the same 201 body (same operationId, same ids), no second project`; `the same key with another name → 409 idempotency_conflict`; `two identical requests at once with one key → one project, both answers name the same operationId`; `no key → 422 precondition_required`; `a key that is not a UUID → 422`; `the same key used by another user is another operation`; `after the organization is set to needs_review, the completed request still replays its 201 and a new key gets backend_inconsistent`.
  - `rename: 200; id, namespace path, policy digest, grants and created_at unchanged; editorA keeps exactly the access it had` (a secret-class stub route on the renamed project is still reached by `editorA` and still 404 for `ungrantedA`); `rename to an existing name → 409 already_exists`; `rename to the same name → 200 and no project.rename audit row`; `rename of an archived project → 409 state_conflict` (state set through the superuser).
  - `a failed audit append creates nothing` — with `INSERT` on `audit.event` revoked for the test: `503 audit_unavailable`, no project, no operation, no outbox row.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Migration `0007`, implement.** **Step 5 — Run:** PASS. **Commit** `feat(api): create, rename and list projects`.

### Task C — environments and lists

- [ ] **Step 1 — Failing tests.**
  - `environments.test.ts`: names `a`, `a` + 62 × `b` (63 characters) accepted; 64 characters, `A`, `1a`, `-a`, `a_b`, `a.b`, empty, `a ` → 422; `development` twice in one project → `409 already_exists`, and in two projects → both created; concurrent same-name create → one 201; create under an archived or `needs_review` project → `409 state_conflict`; create under a project of organization B, or with project 2's id on organization B's path → 404; rename keeps `id`, `lock_key`, `policy_digest`, `kv_ready`, grants and the machine policy text in OpenBao byte-identical (`readMachinePolicy` before and after); the permission and replay cases of Task B, shortened to one each.
  - `listing.test.ts`: 120 projects (inserted through the repository in the test): default page 50, `limit=100` gives 100, `limit=101` and `limit=0` → 422; pages are in id order, disjoint and complete; `a project created between two pages → 409 listing_changed on the next page; a fresh first page works`; `a rename between two pages does not disturb them`; a tampered cursor, a cursor of the other list, a cursor of organization B → `400 malformed_request`; `a member's list holds only what the grants make visible` (`envEditorA`: project 1 and, inside it, environment 1a only; `ungrantedA`: empty list, 200); `no response holds org-, kv/ or machine-env-` (search every body of this file).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(api): create, rename and list environments; keyset pages`.

### Task D — readiness and no deletion

- [ ] **Step 1 — Failing tests.**
  - `readiness.test.ts`: `a new environment is pending until its machine policy and token role are verified` — with the provisioner stopped: it stays `pending`, `kv_ready` false; `credentials.issue` on it (owner, fresh TOTP) → `409 state_conflict`, and the terminal handler is not reached; the machine token role does not exist in OpenBao. Provisioner started: within ten seconds `active`, `kv_ready`, `policy_digest` equal to the digest of the policy read back; the role and policy read back equal to `machineTokenRole` and `renderMachinePolicy`. `the first verified environment activates the project`. `a provisioning failure becomes needs_review` — the provisioner's credential destroyed before the create: after the retries the environment is `needs_review` / `provisioning_failed`, `reviewOpen` would count it (the status query returns 1), and `credentials.issue` → `503 backend_inconsistent`. `the job carried an id only` (the stored job data equals `{ operationId }`).
  - `no-delete.test.ts`: `DELETE` on every project and environment path, as owner with a right Origin → 404, nothing changed; no route in `ROUTES` has a method other than GET, POST, PATCH, and none has `delete` in its id except `secrets.delete`; `api_runtime` and `provisioner_runtime` cannot `DELETE FROM app.project` or `app.environment` (permission denied); no exported function of `packages/db/src/repos/{projects,environments}.ts` has a name starting with `delete` or `remove`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** what is missing. **Step 4 — Run:** PASS; then the whole integration suite. **Commit** `test(resources): readiness and the absence of deletion`. Write D-33.

**Registry:** `FR-1.14`, `FR-1.15`, `FR-1.16`, `FR-1.19`, `AC-1.10` → `SPIKE_PASS` (product code, real stores; the run note says that "a pending environment cannot issue credentials" was proven at the state gate and is proven again on the real issuance route by Run 5.1). **Covers:** FR-1.14, FR-1.15, FR-1.16, FR-1.19; AC-1.10. **Done when:** name rules pass their boundary tests and a pending environment cannot issue credentials.

---

## Run 3.10 — Session gate

**Files:** `tests/staging/identity.staging.test.ts`, `docs/evidence/session-3/{canary-sweep.txt,report.md}`, `docs/evidence/registry-overrides.json`, `docs/evidence/registry.json`, `docs/evidence/session-1/retention-fixture.json` (checkpoint result), `infra/dependencies.lock.json`, `scripts/pins-verify.ts`, `.github/workflows/*` (image scan list), `CLAUDE.md`.

**Consumes:** every run note of the session; the staging owner of Run 3.2 and the staging organization of Run 3.8.

- [ ] **Step 1 — Full suite on `session-3`,** from a clean clone outside OneDrive: `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test`, `pnpm run test:integration`. `pnpm run test:cloud`: before 15 Nov 2026 09:42 UTC it must pass; from then on it fails on purpose through the R2 fixture guard — run it, paste the failing guard's line, and list it in the report as expected until Run 6.6; any other failing cloud test is a finding. CI green on the branch. Paste the summary lines into the report; a failing or skipped test is listed by name with its reason.
- [ ] **Step 2 — Pins.** Nothing new is expected. If a run added a package or an image (the provisioner image is built from the repository on the pinned `node` base), it is in `infra/dependencies.lock.json` exactly and the image-scan job scans the provisioner image as it scans the API image. `.trivyignore.images` still expires on 20 Nov 2026 — do not extend it here; list it in the report.
- [ ] **Step 3 — Checkpoints.** `retention-fixture.json`, checkpoint `pairs-lock-session-gate` (not before 15 Nov 2026 10:42:20 UTC): if this step runs on or after that time, do what the checkpoint says — repeat the refused delete on a `pairs/` object before the lock ends, or record that the lock has ended after it — and write the result into the file and the report; if it runs earlier, carry it as owed by the Session 4 gate. `kms-checkpoints.json`: nothing is due before 12 Dec 2026; say so.
- [ ] **Step 4 — Deploy the branch to staging:** both images, `push`, `db-init` (migrations to `0007`), `up`, `gate open`; `host.ts staging status` shows gate open, provisioner healthy, `reviewOpen: 0`. Note the alert window.
- [ ] **Step 5 — The integrated suite on staging** (`identity.staging.test.ts`; target assertion first; every request through `https://mykey-staging.nomikey.com`, never a tunnel; the time check `chronyOffsetMs` under 1,000 before any TOTP step). The owner's session comes from `stagingOwnerSession` (Run 3.8), which never prints the password or the seed. The suite reuses the local test bodies where it can — the same assertions against another base URL:
  1. **Known state.** The owner was enrolled in Run 3.8. If the stored seed no longer signs in, recover the way an operator would: `host.ts staging ops reset-account --kind mfa`, complete it, store the new seed — and say so in the report.
  2. **Sign-in** with password and TOTP; cookie attributes; a password-only session gets `401 mfa_incomplete` on `organizations.list`; sign-up paths are 404.
  3. **Operator reset, both kinds,** end to end: initiate through `host.ts staging ops`, read the link file, complete over the public name; the old password and the old session are dead; an aged link (the test waits for nothing — it ages the row through the superuser tunnel) leaves the account `recovery_pending`; one of two parallel completions wins.
  4. **Resources:** the owner creates a project and a second environment; both environments become `active` through the provisioner on the host; rename; list with a cursor; replay of the create returns the same ids.
  5. **Shut out:** a synthetic organization B and synthetic users (admin, editor, reader, ungranted member of the staging organization; owner of B) inserted through the superuser tunnel with fresh ids — never through `applyRoles` — and enrolled through the public routes; the named cases of Run 3.7 Task C run against staging (hidden equals absent; reader cannot write; editor cannot manage; B sees nothing of A and A nothing of B; a grant removed mid-session denies the next request). Secret-class routes end in the terminal 404 for allowed callers, 403 or 404 for the others, which is enough to tell the cells apart.
  6. **Foreign origin:** a sign-in and a project create with `Origin: https://evil.example` → `403 origin_rejected`.
  7. **Throttle:** six sign-in attempts for an unused synthetic e-mail from the test's address → the sixth is 429; then the rows of that subject are aged away through the superuser tunnel so the next run starts clean.
  8. **Canary sweep.** Every secret the suite used — passwords, TOTP seeds and codes, recovery codes, reset tokens and links, session cookie values, the AppRole secret ids read in Run 3.8 — is collected in memory. After the suite: search for each in a `pg_dump` of the staging database (taken through the tunnel into a temporary directory outside OneDrive and the repository, removed afterwards), in the `docker logs` of `api`, `provisioner`, `postgres`, `edge` and `openbao` since the suite began, in `audit.event`, in the job tables of schema `jobs`, and in the OpenBao audit device file. Expected: no hit, except the documented representations — a session cookie's token never appears, its verifier does. Write counts only into `docs/evidence/session-3/canary-sweep.txt` (how many values, how many places, zero hits); a hit is written as the place and the kind of value, never the value.
  9. **Clean up** the synthetic users and organization B through the superuser tunnel; the staging owner, its organization and one project stay for Session 4. `reviewOpen: 0` at the end.
- [ ] **Step 6 — Production,** only if the owner answered yes (Session start, item 3): `host.ts prod push`, `image api`, `db-init`, `up`; the gate stays closed (no gate file is written), so `/health` on production reports down and the probe alerts — tell the owner before, and record it. No bootstrap, no OpenBao, no provisioner on production. Without a yes: nothing, and the item goes into "What Session 4 must know".
- [ ] **Step 7 — Fresh-context review.** A reviewer agent with no history of this session gets `git diff main...session-3`, this plan and Doc 10 §4.1, and is asked specifically: (a) for each of Runs 3.2–3.9, find a denial or negative test that would still pass with the protection removed (expired fixture session, wrong path, invalid body, missing control); (b) any path by which a password, TOTP seed or code, recovery code, session token, reset token or link, or AppRole secret id reaches Git, a log line, a job, an audit row, an evidence file, a test failure message or the terminal; (c) any route reachable outside `mountRoute` / `mountAuthRoutes`, any handler that writes SQL, any authorization read that is cached or taken from the request; (d) any way the API process can reach operator or provisioner authority — imports, mounts, environment, database grants; (e) any time comparison against the API's clock where the plan says database time; (f) any place where a state becomes `active` without a read-back. Every finding is fixed or listed in the report with an owner run.
- [ ] **Step 8 — Registry.** Apply the statuses named in each run through `registry-overrides.json`, each with its evidence file (the run note that states the id and the status on one line); `pnpm run evidence:build`; `pnpm run check`. Nothing is `PASS` (P-38). An item whose test failed and was not fixed is `FAIL` with its run note.
- [ ] **Step 9 — `docs/evidence/session-3/report.md`:** the §4.5 gate result in one line (`PASS` / `PASS WITH ISSUES` / `FAIL`); the sentence "G-AUTH is closed on the integrated product on staging: …" with the test names behind it, or what is missing; the summary lines of Step 1; the staging demonstration of Step 5 as commands and results; registry changes; decisions D-26 … D-33 in one line each; review findings and what became of each; open issues with owner runs; and **"What Session 4 must know"**: the pipeline order and how a route is mounted; `beginOperation` and what Run 4.1 still owes (tombstones, `replay_expired`, the status routes, scope `operation`); the outbox, the job kinds and the grants on schema `jobs`; the state table and that Sessions 4–5 routes got their action and state class from this plan's reading; the stubs and how to re-run `matrix.test.ts` on real handlers; the provisioner (`clientFor`, sweep, review reasons) and what is not there (API-side drift detection on a request, the operator's reconciliation command — Run 4.5); the runtime and issuer credential files on the host and the self-check; `maintenance` as the operator identity; `ops auth-cleanup` needing a timer (Run 6.9); the general rate limits (Run 6.3) on `bumpCounter`; the reset page's duties for Run 7.x (read the fragment, clear it from the address bar, send no referrer); the dated items; the state of production.
- [ ] **Step 10 — `CLAUDE.md`:** "Where we stand" (Session 3 done, what exists, what Session 4 needs), "Commands" (the `ops` and `gate` commands, the provisioner child process in tests), "Architecture" (pipeline, operator commands, provisioner), "Things already learned" (only what every later session needs). Commit `docs: session 3 report, registry and CLAUDE.md`.
- [ ] **Step 11 — Pull request** `session-3` → `main`, with the report's first section as its description. Not merged: the owner says when.

**Covers:** the §4.5 gate; G-AUTH on the integrated product. **Done when:** the report exists with every step above answered, CI is green on the branch, and the pull request is open.

---

## Session 3 end state

- **Identity:** an owner who exists only through the operator's bootstrap; sign-in bound to account state and epochs; mandatory TOTP with one-use steps and ten one-time recovery codes; sessions that end at 12 hours or after 30 minutes without a real activity signal; fresh TOTP for the four sensitive starts; an atomic password change; throttling that holds across processes; an operator reset for a lost password and for a lost second factor. No route creates an account, disables MFA, trusts a device or starts a reset.
- **Access:** one pipeline every route passes — gate, limits, origin, authentication, tenant resolution from current rows, visibility, action, state, freshness — with every cell of the authorization matrix tested and hidden indistinguishable from absent.
- **Resources:** an organization made ready in OpenBao by a durable operator operation that survives a kill at every step; projects and environments created, renamed and listed through the API as replay-safe operations; a separate provisioner process that makes each environment's machine policy and token role, reads them back, and puts a drifting scope into review with an alert.
- **Hosts:** staging runs the API behind a closed-by-default gate, the provisioner, and the staging owner's organization; production is unchanged unless the owner allowed its update.
- **Evidence:** run notes 3.1–3.10, `authorization-matrix.md`, `canary-sweep.txt`, decisions D-26 … D-33, the registry (nothing `PASS`), the report, an open pull request.
- **Not here, on purpose:** secret routes and the mutation protocol (Session 4); tombstones and operation status routes (Run 4.1); machine credentials (Session 5); the general rate limits, the full alert set, backups and timers (Session 6); every screen (Session 7).
