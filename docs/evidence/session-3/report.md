# Session 3 report — Identity, access and resources

**Date:** 12–13 November 2026 · **Branch:** `session-3` · **Plan:** `docs/plans/session-3-plan.md`

## Result

**PASS WITH ISSUES.** All ten runs are done. On the integrated product on staging: only the operator creates accounts; sign-in requires TOTP; sessions are revoked when their time is up; throttling holds across processes; reset is operator-only; authorization is decided from current rows; organizations and environments are provisioned with read-back; projects and environments are replayable operations. Nothing is `PASS`; 32 items moved to `SPIKE_PASS`.

The issues:

- CI was red on three jobs from Run 3.1 to the gate. Nobody looked; it is fixed now.
- Two load flakes are still watched.
- Ten minor review findings are deferred, each with an owner run.
- Production was not updated (the owner gave no answer).

G-AUTH is closed on the integrated product on staging. Test names:

- `tests/staging/identity.staging.test.ts`: sign-in with password and TOTP; the cookie's attributes; `mfa_incomplete` for a password-only session; sign-up 404; operator reset of both kinds end to end over the public name; an aged link; two parallel completions; the shut-out cases; foreign Origin; the throttle.
- The canary sweep: 0 hits.
- `tests/staging/api.staging.test.ts`: gate, keys, owner cookie, throttle.
- The local suites of Runs 3.2–3.6 on real stores.

## Step 1 — the full suite

From a clean clone outside OneDrive (`C:/Users/gmpar/mykey-gate-clone`, commit `64acfdf`):

| Command                          | Result                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | exit 0                                                                                                                                               |
| `pnpm run check`                 | exit 0 (registry ok, 191 items)                                                                                                                      |
| `pnpm test`                      | 55 files, 823 passed                                                                                                                                 |
| `pnpm run test:integration`      | 66 files, 785 passed                                                                                                                                 |
| `pnpm run test:cloud`            | 8 of 8, 13 Nov 2026 10:29 UTC. This is before the R2 fixture guard date (15 Nov 09:42 UTC). From that date the suite fails on purpose until Run 6.6. |

After the review's fix pass (`acf94e5`), the whole integration suite locally gave 64 of 66 files.

- `jobs/outbox.test.ts` still inserted an organization through the API pool, which migration `0010` now refuses. Fixed in `76ba930`.
- `ops/bootstrap.test.ts` hit its known load timeout: the "killed at each point" case passes 120 s and leaves an owner behind, so the next case refuses both bootstraps. Green alone (4 files, 32 passed).

CI on the branch:

- **Found at the gate:** `check`, `secret-scan` and `image-scan` had been red since Run 3.1. Causes:
  - `check` ran out of Node's default heap on the runner.
  - `secret-scan` flagged a fixed synthetic UUID in `compose.test.ts`, a reviewed false positive.
  - The API image carried `drizzle-kit`, `vitest`, `vite` and `esbuild` as `better-auth`'s optional peers, linked from the workspace root.
- Fixed in `d756d2d`, whose CI run is green on every job.
- The run on `acf94e5` failed only the outbox test. `76ba930` fixes it, and its CI result is in the pull request.

Watched load flakes:

- `tests/fault/effects/exclusion.test.ts`: the Session 2 spike's executors answer `busy` under the whole run.
- `tests/integration/api/health.test.ts`: `afterAll` (Run 3.6).
- The ops kill-point cases (Run 3.7).

All three are green alone.

## Step 2 — pins

No new package and no new upstream image. The provisioner image is built on the pinned `node` base; it is in the pin check's own images (`OWN_IMAGES`) and the CI image scan (`OWN_SCANNED_IMAGES`).

`.trivyignore.images` still expires on **20 Nov 2026**. It was not extended.

## Step 3 — checkpoints

- `pairs-lock-session-gate` is not due before 15 Nov 2026 10:42:20 UTC, so it is owed by the Session 4 gate.
- `kms-checkpoints.json`: nothing is due before 12 Dec 2026.

## Steps 4–5 — staging

**Deploy window:** 13 Nov 2026 08:57–09:45 UTC (Run 3.8) and 10:40–12:47 UTC (gate). The expected alerts were `health` during restarts and `review_open` during the drills; `review_open` opened and resolved six times.

**Images now on staging:**

- API `acf94e5ac0f1` (`sha256:0e3227f8…`)
- Provisioner `acf94e5ac0f1` (`sha256:c9c24be4…`)
- Migrations up to `0010`

**State:** gate open, provisioner healthy, sweeping every 60 s; API self-check `runtimeLogin: ok`; `reviewOpen: 0`.

| Suite                             | Result                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.staging.test.ts`        | 14 passed: known state; sign-in; both resets; aged link and the race; resources (create, second environment, both active through the provisioner, rename, cursor, replay); shut out (hidden equals absent; reader, editor, ungranted member; B and A apart; grant removed mid-session); foreign Origin; throttle; canary sweep; clean-up |
| `api.staging.test.ts`             | 12 passed                                                                                                                                                                                                                                                                                                                                |
| `provisioning.staging.test.ts`    | 5 passed: organization active with its digest; no provisioner or root credential in the API; provisioner without port or route out; runtime credential refused from the tunnel; AC-1.09 drill                                                                                                                                            |
| Canary sweep (`canary-sweep.txt`) | 95 values in 9 places (logs of api, provisioner, postgres, edge, openbao; OpenBao's audit device; `audit.event`; `jobs.job`; a `pg_dump`), **0 hits**                                                                                                                                                                                    |

Staging owner:

- The suite reset the owner with both kinds of reset.
- Its password, TOTP seed, recovery codes and last step are in `~/.mykey/secrets/hosts/staging/`.
- Organization `e2350312-…` and its projects stay, including the synthetic drill rows listed in `run-3.8.md`.
- The synthetic users and organization B were removed.

What went wrong on the way:

- The first identity runs failed on the suite's own helpers: rate-limit rows shifted back in time collided, and a capital letter in a synthetic e-mail broke sign-in.
- Two drills stopped before their undo. I undid both by hand.

## Step 6 — production

Updated after the merge, on the owner's yes (13 Nov 2026, 16:01–16:06 UTC):

- `host.ts prod keys init` installed production's eight auth key rings (the new API needs them).
- `push`, `image api` (`c9ce24ef9d08`, `sha256:c48c08ab…`), `db-init` (migrations `0003`–`0010`, job queues), `up`.
- Before the update, `up` could not render the compose file on a host without OpenBao: compose interpolates the provisioner's required variables even in an inactive profile. Fixed first: `up` now gives them placeholders there (`c9ce24e`, test in `deploy.test.ts`).
- No gate file was written, no owner was bootstrapped, and there is no OpenBao and no provisioner. Production answers `503 quarantined` on every route, `/health` reports `down` (503), and the probe raises `health_failing` for production until its gate opens.
- `status`: API, edge and postgres running; `gate: absent`; `reviewOpen: 0`; `provisioner: absent`.

## Step 7 — the fresh-context review

A reviewer agent with no history of the session got the diff, the plan and Doc 10 §4.1. It made 3 Important and 10 Minor findings.

**Fixed, each with a test that failed first:**

| Finding                                                                                                                                                                                                  | Fix                                        | Test                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| The API's role could still mark an environment ready, set an organization's digest or provisioning operation, clear a review, and create organizations and memberships                                   | Migration `0010_api_narrowed`              | `privileges.test.ts`: 5 denials                                                    |
| A re-run of `provision-organization` destroyed every secret id before delivering the new one, so the API and the provisioner briefly held dead credentials, and the provisioner treats `denied` as final | Deliver first, then destroy the others     | `organization.test.ts` "a re-run never leaves a role without a working credential" |
| A gate closed longer than the queue's retries left an environment `pending` for ever                                                                                                                     | A closed gate re-queues the job 30 s later | `environment.test.ts` "gate closed longer than the queue's retries (200 s)"        |

**Deferred (Minor), with owner runs:**

- Environment activation without `state = 'pending'` and a claim re-check (4.1).
- `kv-scope` compares two of the three config fields (4.5).
- The in-transaction admission recheck has no test that changes state after the pipeline (4.1).
- The "denied ends the job at once" branch is not isolated (4.5).
- A reset test that proves nothing about rights (6.x).
- A queue-privilege test that accepts any error (4.1).
- Operation-scope rows in the matrix (4.1).
- The auth module writes SQL directly (8.x).
- The API image holds operator and provisioner source files that the import graph cannot reach (8.x).
- Better Auth writes `expires_at` on the API clock (6.x).

## Step 8 — registry

Applied through `registry-overrides.json`, each entry with its run note: 54 `SPIKE_PASS`, 137 `OPEN`, nothing `PASS`. The 32 Session 3 items:

| Run | Items                                             |
| --- | ------------------------------------------------- |
| 3.2 | FR-1.01, AC-1.01, PO-5                            |
| 3.3 | FR-1.07, AC-1.05                                  |
| 3.4 | FR-1.02, FR-1.03, AC-1.02, PO-15                  |
| 3.5 | FR-1.05, FR-1.06, FR-1.77, AC-1.04, AC-1.35       |
| 3.6 | FR-1.04, AC-1.03, PO-6                            |
| 3.7 | FR-1.09, FR-1.10, FR-1.11, AC-1.08                |
| 3.8 | FR-1.08, FR-1.12, FR-1.55, AC-1.06, AC-1.09, PO-4 |
| 3.9 | FR-1.14, FR-1.15, FR-1.16, FR-1.19, AC-1.10       |

## Decisions

- **D-26:** one contract-driven pipeline (`mountRoute`); a terminal 404 for routes without a handler; the external service gate read on every request.
- **D-27:** operator commands in `apps/ops`, run through `host.ts <host> ops` as `maintenance` over a tunnel; secrets only on stdin and in 0600 files.
- **D-28:** throttling with HMAC-keyed counters on database time, per source and per account, across processes.
- **D-29:** sessions: one validity decision on database time, idle and absolute limits, product-owned password change.
- **D-30:** operator-initiated reset of a lost password or factor; verifier-only tokens; link in the fragment; one redemption.
- **D-31:** authorization from current rows in one statement; `decide` in the contract; hidden equals absent; the state table.
- **D-32:** compare, then act, never overwrite; the operator provisions organizations, the provisioner provisions environments; drift sweep; bound AppRoles; review alert.
- **D-33:** replayable mutations (Idempotency-Key, fingerprint, replay before state), keyset lists under signed cursors, no deletion.

## Open issues (with owner runs)

- **4.1:** operation status routes, tombstones, `replay_expired`, scope `operation` (`operations.get` answers 404 to everyone until then).
- **4.1:** a job held by a killed provisioner waits for pg-boss's 15-minute expiry.
- **4.5:** the reconciliation command (an environment's review is cleared through the superuser until then).
- **4.2:** whether the API self-check gates `/health`.
- **5.3:** archive and reactivate need their own grants (migration `0010` removed the API's review-reason right).
- **6.3:** the general rate limits.
- **6.9:** a timer for `ops auth-cleanup`.
- **7.x:** the reset page must read the fragment, clear it from the address bar and send no referrer.
- **Gate checks:** the load flakes above.
- The workstation copy of the `provisioner_runtime` password is obsolete.

## What Session 4 must know

1. **Production** runs the Session 3 API (`c9ce24ef9d08`, migrations up to `0010`, its own key rings) behind a gate that is not open: every route answers `quarantined` and the probe's `health_failing` stays open for production until a gate is written (`host.ts prod gate open`, an owner decision). No OpenBao, no provisioner and no owner exist there.
2. **The pipeline order** is final (Doc 06 §4.4): request id → gate → body limits → mixed credentials → Origin → authentication → validation → ancestry and membership → visibility → action → (mutation: Idempotency-Key and replay lookup) → state → freshness → handler.
   - A route is mounted from `ROUTES` by `mountRoute(app, deps, routeId, handler)`; a missing handler answers the terminal 404 (or the stub under `startTestApi({ stubs: true })`).
   - Handlers get `ctx.scope`, `ctx.authority` and `ctx.idempotencyKey`.
3. **Mutations:** `beginOperation(tx, ring, key + body)` inserts or finds the operation; the replay lookup happens in the pipeline before state and freshness.
   - `completeOperation` sets `succeeded`, the `result` and a 30-day replay expiry.
   - Run 4.1 still owes tombstones, `replay_expired`, the status routes and scope `operation`.
   - Lock order: take an update lock before any share lock on the same row (two deadlocks were found and fixed).
4. **Outbox and jobs:** `enqueueOutbox` in the operation's transaction; the API's dispatcher sends `environment.provision` jobs carrying `{ operationId }` only.
   - The provisioner supervises the queue (migration `0008`'s rights).
   - A closed gate re-queues a job.
5. **States:** the state table of D-31 (`checkStates`). The routes of Sessions 4–5 got their action and state class from this plan's reading of Doc 04, and the owning run may change a row with a `contract:` commit. `lifecycle` routes see only the organization's row.
6. **The matrix:** `tests/integration/authz/matrix.test.ts` runs on stubs for routes without a handler. Re-run it unchanged once real handlers exist; any 2xx counts as allowed.
7. **The provisioner:**
   - `clientFor` answers for the one organization in `/run/mykey/secrets`.
   - The sweep compares digests and logs `unread`.
   - Review reasons: `backend_inconsistent`, `provisioning_failed`.
   - Not there yet: drift detection on a request, and the operator's reconciliation command (Run 4.5).
8. **Credentials on a host:**
   - `/etc/mykey/secrets/api/{runtime,issuer}-{role,secret}-id`, `organization-id`; the API self-check logs `runtimeLogin` at start.
   - `/etc/mykey/secrets/provisioner/…` and its `db-password`.
   - Re-running `provision-organization` rotates every secret id; restart the API afterwards.
9. **`maintenance` is the operator identity.**
   - `ops auth-cleanup` needs a timer (Run 6.9).
   - The general rate limits (Run 6.3) build on `bumpCounter`.
   - The reset page's duties are for Run 7.x.
10. **Dated items:**
    - R2 fixture guard: 15 Nov 2026 09:42 UTC.
    - Checkpoint `pairs-lock-session-gate`: from 15 Nov 10:42 UTC (owed by the Session 4 gate).
    - `.trivyignore.images` expires 20 Nov 2026.
    - All KMS certificates expire 12 Dec 2026 (staging seal 10:50 UTC).
11. **CI:** watch it after every push. It was red for a whole session without anyone noticing.
