# Session 7 report — The owner web workspace

**Gate date:** 19 and 20 Nov 2026. **Branch:** `session-7`, pull request #19. **Runs:** 7.1 … 7.10. **Decisions:** D-58 … D-62. **Migrations:** none.

## Result

**PASS WITH ISSUES.** The workspace is built, served by the API, and proven three ways: in Chromium against a local API with real PostgreSQL and OpenBao (81 tests), by a canary scan of everything the browser keeps, and by the same journey on staging under `host-v0.7.0`. The full suite is green on CI, and every staging file ran, including the seven that Session 6's gate skipped.

The issues:

- **A defect of Session 6, found and fixed at this gate.** After a reboot, staging's OpenBao did not start again, and the service answered 503 until an operator ran `up`. The nightly audit rotation was the cause (Step 4 below). No data was lost. Production has no OpenBao and was not affected, but its host files still hold the old script.
- **The review found two Important defects of the page**, both fixed before the release was built (Step 2).
- **Thirteen Minor findings** go to Session 8.
- **Nothing is `PASS` in the registry**: the items are `SPIKE_PASS` until Session 8's integrated proof.

What the session built and proved:

- **The shell** (7.1): the workspace is one built bundle inside the API image, served by the API on a table of page paths, with a content policy that allows only its own script and stylesheet. One client reads the contract; one table gives every error code its text.
- **Sign-in and account** (7.2): password and code, enrolment with the setup key and the recovery codes shown once, the operator's reset link (its token leaves the address before anything is shown), password change, new recovery codes, the sessions list.
- **Resources** (7.3): the overview (route `overview.get`), projects and environments with create, rename, archive and reactivate. A resource is shown pending, revoking or under review in the server's words, and never as active before the server says so.
- **Secrets** (7.4, 7.5): list, create, edit with the version check, reveal for 30 seconds, copy, history, delete, undelete and restore. A value is held in one place that forgets it on time, on tab hide, on navigation and on sign-out, and is never in the query cache or any storage.
- **Import and export** (7.6): preview with what will change, apply, a partial import shown as partial, resume with the same file, export behind a fresh code with the file checked by length and digest.
- **Machine credentials** (7.7): issue with the token shown once, the inventory, revoke; the summary route `credentials.summary`.
- **Activity, audit, operations and the summary** (7.8): the timeline, the audit screen with its filters, the operations of an environment, and the summary as three tables (route `metrics.get`), each with its source, window and observation time.
- **Errors, keyboard, narrow screen, browser security** (7.9): nine failure classes each in their own words; the main flow with the keyboard only; no sideways scroll at 360 pixels; framing and injected scripts refused by the browser; no GET changes a row.
- **The journey and the canary scan** (7.10): one owner from the sign-in form to the sign-out, every step checked against what the server says; then the same journey with a canary as every secret, and a search of everything the browser keeps.

Registry: the session's 18 items are `SPIKE_PASS`, nothing is `PASS`. The totals are 172 `SPIKE_PASS` and 19 `OPEN` (154 and 37 after Session 6). `ROUTES` has no pending body.

## How the session was tested (D-58)

The owner asked for a faster session than Session 6's three days: CI on every run only if it takes minutes, and the suites once, at the end.

| What                                                   | When                   | Cost                                                                                  |
| ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------- |
| `pnpm run check`, the run's own test files             | inside every run       | minutes, locally                                                                      |
| CI on the draft pull request: `check`, the secret scan | after every run's push | 2 min 24 s to 2 min 35 s a push, 11 pushes                                            |
| CI on the ready pull request: all jobs                 | at the gate, twice     | 16 minutes of wall time a run (integration 12 and 14 minutes, browser 7)              |
| The staging files, one at a time                       | at the gate, once      | about 2 h 20 min, of which the reboot defect and five stale tests took about one hour |
| `pnpm run test:consumers`                              | at the gate, once      | 13 minutes                                                                            |

**Was it faster?** Yes. Runs 7.1 to 7.9 and the two last test files were committed between 14:51 and 19:22 on 19 Nov (the commits' own times); the gate ran from 19:22 to about 01:45 the next morning, with two stops of about half an hour each in which the workstation was out of memory and waited for the owner. Session 6 took three days. No run passed its time box, and no scope valve was needed beyond valve 1 (tables for the analytics), which the owner approved at the start.

**What the saving cost.** The first full run found four test files that Runs 7.1, 7.3 and 7.8 had made stale, hours after the change that did it. None was a product defect. That is the price D-58 named, and it was one repair commit.

**Not run, and why:**

- `pnpm run test:cloud`: the session changed nothing that touches R2.
- `pnpm run test:cli` and the `cli-matrix` job: the CLI was not changed.

## Step 1 — the full suite on CI

**First run** (`35dc700`): `check`, the secret scan, the scans and `browser` green; both integration shards red, on four files.

| File                                           | What it was                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/api/health.test.ts`         | Stale: it asked `GET /` for the terminal 404. `/` is a page path now, and answers 503 where no workspace is built.                            |
| `tests/integration/api/routes-mounted.test.ts` | Stale: it expected a 404 from the three routes that had no handler. They have one.                                                            |
| `tests/integration/auth/factors-http.test.ts`  | Stale: the same three routes in its list of stubs.                                                                                            |
| `tests/integration/limits/large.test.ts`       | A race in the test (Run 6.3's): after releasing one held request it waited for the first request it had sent, which need not be the same one. |

All four were repaired as tests (`236083a`).

**Second run** (`236083a`): green.

| Job             | Result                        |
| --------------- | ----------------------------- |
| `check`         | 115 files, 1,429 unit tests   |
| integration (1) | 81 files, 599 tests           |
| integration (2) | 80 files, 807 tests           |
| `browser`       | 12 files, 81 tests            |
| scans           | green (`.trivyignore.images`) |
| secret scan     | green                         |

## Step 1 — dated items

Nothing is due. All KMS certificates end on 12 Dec 2026 (staging's seal at 10:50 UTC); `.trivyignore.images` ends on 14 Dec; the checkpoint `pair-30-day` is due from 17 Dec 19:00 UTC. The probe's watcher last ran green on 19 Nov 08:48 UTC.

## Step 2 — the fresh-context review

One reviewer on the most capable model read `git diff main...session-7` at `35dc700` with the plan's seven questions and none of the plan's reasoning. It found nothing Critical and two Important findings, both on the third question. Both are fixed (`e121aab`), each with a test that failed first.

| Question                                                            | Finding                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. A secret in a storage, an address, the history, the cache, a log | None. Five places where the page holds something longer than its own 30-second rule (Minor, below).                                                                                                                                                                                                          |
| 2. A screen deciding what the server does not check                 | None.                                                                                                                                                                                                                                                                                                        |
| 3. Pending or uncertain shown as done or failed                     | **Important, fixed:** a 202 was taken for success. A changing route answers 202 while its operation is still executing, as a repeated request gets after a lost answer; the page then said "Saved", "is revoked" and so on. It now says "Not finished yet", with the operation id and the way to Operations. |
|                                                                     | **Important, fixed:** the text for `dependency_unavailable` said "refused before anything was changed". The archive route answers that code after it has accepted the archive. The text no longer claims it; with an operation id it says the service continues the request.                                 |
| 4. The shell serving what it should not                             | None. Two Minor notes (a `HEAD` answers 404; an encoded path gets the page, which then says "No such page").                                                                                                                                                                                                 |
| 5. The three new routes and another organization                    | None.                                                                                                                                                                                                                                                                                                        |
| 6. A cookie change without the exact Origin                         | None.                                                                                                                                                                                                                                                                                                        |
| 7. The content policy                                               | Minor: `img-src 'self' data:` and `font-src 'self'` are wider than the page uses.                                                                                                                                                                                                                            |

The reviewer also listed tests that prove less than they say. One was repaired now, because it is the proof for question 4: the shell's unit test "a path outside the directory" passed for a missing field, not for the path. It now writes a real file outside the directory with the right digest and type, and fails when the path rules are removed.

**Found by the canary journey, not by the reviewer:** after an operator's reset ends with a new authenticator, the service ends every session (P-51), and the sign-in form came back without a word. It now says why. Fixed with a failing test first.

**Minor, to Session 8** (each has a line in `known-limits.md` where an owner can notice it):

1. The bytes of a previewed import file sit in a plain reference: no time limit, kept on tab hide and after a failed apply.
2. An export that arrives while the tab is hidden is held; the download address lives 10 seconds after Save although the page says it has let go.
3. The captured reset token has no time limit when the session read fails.
4. A value typed into an open form and not sent stays while the tab is hidden.
5. The import's summary sentence counts uncertain entries as "not written" (the rows and the state paragraph are right).
6. After "the outcome is not known" the form's own button is still enabled. The server answers a repeated request and does not do it twice.
7. `HEAD` on a page path answers 404.
8. The API decodes a path before matching the page table; the page's router does not.
9. `no-store` on the script: the 875 kB bundle is downloaded at every load.
10. The content policy's `img-src` and `font-src` are wider than used.
11. The GET proof asks the routes of `ROUTES`; the two GETs of the auth module are not in its comparison.
12. The canary scan cannot see the query cache or what the page holds in memory. The proof for the cache is the source search, which a wrapper function could pass.
13. No test sends an encoded path through the HTTP server to the shell.

**What the reviewer declined to judge**, and what was decided:

- The browser's own history may keep the pasted reset link: browser behaviour; the token works once, for 15 minutes; `known-limits.md` has the line.
- A page restored from the back-forward cache with a key or codes still held: the page is sent `no-store`, which Chromium does not cache that way, and the canary's walk through every history entry found nothing. Stands.
- Whether "the action was not performed" is true on every path that answers `audit_unavailable`: to Session 8's review.
- Whether the edge's access log holds page paths with secret names: to Session 8. Names are metadata, not values.

## Step 3 — one release, one deploy

`host-v0.7.0` was built in the clean clone from `236083a`, published with `--target session-7`, and deployed to staging through the closed gate (gate epoch 309). `status` and the probe were clean, and `provision-organization` was run again for the owner's organization. The images were not built again after that: the one later fix is a host file (below).

The build and the deploy were each stopped once by Claude Code because the workstation was out of memory (Chrome held 4.3 GB). Nothing on staging was changed by the stopped deploy: it was still uploading.

## Step 4 — staging, one file at a time

| File              | Result                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `workspace` (new) | 1 of 1, at its first run                                                                                                       |
| `api`             | 12 of 12                                                                                                                       |
| `status`          | 3 of 3                                                                                                                         |
| `audit`           | 5 of 5 (and again after the rotation fix)                                                                                      |
| `boundary`        | 11 of 12, a **product defect** (below); 12 of 12 after the fix. SSH back 28 s after the reboot, `/health` 200 one second later |
| `transport`       | 7 of 10 while staging was down from that reboot; 10 of 10 after                                                                |
| `identity`        | 13 of 14, a stale test; 14 of 14 after its repair                                                                              |
| `export`          | 2 of 3, a stale test; 3 of 3 after its repair. The slowest export of 1,000 names (7.18 MB) took 23.1 s of the 60 allowed       |
| `cli`             | 1 of 1                                                                                                                         |
| `key-loss`        | 2 of 2                                                                                                                         |
| `probe`           | 2 of 4, two stale tests; both pass after their repair (the other two passed in the full run)                                   |
| `test:consumers`  | 2 files, 7 tests                                                                                                               |

**The workspace on staging.** `tests/staging/workspace.staging.test.ts` opens `https://mykey-staging.nomikey.com/` in Chromium and reads the document's headers (the content policy without `unsafe`, no framing, `no-store`, HSTS). It then signs in by the form as the staging owner, creates a project through the page, writes and reveals a secret, issues a machine token, resolves the value with it (compared by digest), revokes it (401), and signs out (the cookie then answers 401). No request left the origin and the console stayed clean. The project is archived in `finally`. Evidence: `run-7.10-staging.json`.

**The defect: after a reboot, OpenBao stayed down.**

- **What happened.** `boundary` reboots staging and waits for `/health`. It answered 503 for ten minutes. OpenBao's container was `exited`, and Docker had not started it, although its policy is `unless-stopped`.
- **The cause.** `bao-audit-rotate.sh` (Run 6.2) sent its SIGHUP with `docker kill --signal HUP`. Docker marks a container it has signalled as stopped by hand, and `unless-stopped` then starts it neither after an exit nor at boot. On the host, that mark was set on OpenBao's container and on no other.
- **What it means.** Since Run 6.2, any reboot of a host after its first nightly rotation left the service down until an operator ran `up`, and a crash of OpenBao would not have been restarted either. Session 6 did not see it because its gate skipped `boundary`.
- **The fix.** The script sends the signal from inside the container (`kill -HUP 1`). Two tests failed first:
  - `tests/integration/archive/rotation.test.ts`: after a rotation, a real OpenBao container that exits by itself is started again by Docker;
  - `tests/unit/hosts/signals.test.ts`: no host file and no operator script calls `docker kill`.
- **On staging.** OpenBao was started with `host.ts staging up` (a start clears the mark), and the fixed script was sent with `host.ts staging push`. After a rotation with the new script the mark stayed unset, and `boundary`'s reboot passed.
- **No `host-v0.7.1`.** The plan sends a product defect to staging as a new release. This one is a host file, and a release holds only images.
- **Production** has no OpenBao, so nothing stopped there. Its host files still hold the old script: `host.ts prod push` is needed before OpenBao is ever started on it. That is a change on production, so it waits for the owner's word.

**The five stale tests**, each repaired as a test:

| Test                                | Why it was stale                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity`: the admin's audit read  | It expected a 404, as before the audit route had its handler (Run 6.1). It expects 200.                                                                                                                |
| `export`: the measurement of P-62   | Its eight imports ask more than five import requests a minute (Run 6.3). A request that limit refuses is sent again in the next minute, and the wait is not counted in an import's time.               |
| `probe`: heartbeats from both hosts | It expected nothing open on production. Production has no OpenBao since its reinstall, so `checks_unknown` is open there (Run 6.4's rule).                                                             |
| `probe`: a dead endpoint            | It expected only `health_failing`. Since Run 6.4 the host reads its public certificate through the edge, so a stopped edge can also open `checks_unknown`; `heartbeat_missing` is still never allowed. |
| `transport` (three tests)           | Not stale: they failed only because staging was down after the reboot.                                                                                                                                 |

Committed evidence files of Sessions 2 to 5 that these runs rewrote were restored before the commit.

## Measurements

| What                                         | Value                                               |
| -------------------------------------------- | --------------------------------------------------- |
| The bundle                                   | 875 kB, 216 kB compressed, one script               |
| Requests of the overview before it is drawn  | at most 6                                           |
| CI, draft pull request                       | about 2.5 minutes                                   |
| CI, ready pull request                       | about 16 minutes                                    |
| Staging after a reboot                       | SSH back after 28 s, `/health` 200 one second later |
| The slowest export of 1,000 names on staging | 23.1 s (ceiling 60 s)                               |
| The consumer rehearsal                       | 13 minutes                                          |
| The journey test, locally                    | under a minute after the stack is up                |

## Time per run

By the commits' own times on 19 Nov (the first commit is 14:51; work before it is not counted).

| Run                 | Time box   | From the previous commit to its last         |
| ------------------- | ---------- | -------------------------------------------- |
| 7.1                 | half a day | 35 minutes                                   |
| 7.2                 | 2 hours    | 20 minutes                                   |
| 7.3                 | 2 hours    | 38 minutes                                   |
| 7.4                 | 2 hours    | 29 minutes                                   |
| 7.5                 | 2 hours    | 16 minutes                                   |
| 7.6                 | 2 hours    | 18 minutes                                   |
| 7.7                 | 2 hours    | 25 minutes                                   |
| 7.8                 | 2 hours    | 32 minutes                                   |
| 7.9                 | 2 hours    | 40 minutes                                   |
| 7.10, the two files | half a day | 18 minutes                                   |
| 7.10, the gate      |            | about 6 hours 20 minutes, with the two stops |

The gate was the one part over its box. An hour of it went to the reboot defect, and about an hour to waiting for memory.

## Decisions

| Record | Decision                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| D-58   | The test cadence: light CI on every run, everything heavy once at the gate.                                            |
| D-59   | The workspace is served by the API on a path table, under one content policy.                                          |
| D-60   | Secrets in the page: one forgetting holder, no storage, no query cache; what the page cannot undo.                     |
| D-61   | Three summary bodies (`overview.get`, `credentials.summary`, `metrics.get`), each a count of what the caller may list. |
| D-62   | The analytics are tables (scope valve 1, approved by the owner).                                                       |

## Deviations from the plan

Every ruling is in the run note of its run. The ones that change what the owner gets:

- **Analytics are tables** (valve 1, D-62).
- **Without a session the sign-in screen is drawn in place**, and the address is kept. There is no `/sign-in` redirect (7.1).
- **An organization has no name** in the contract: the scope bar shows the first eight characters of its id and the role (7.1).
- **The page cannot know that an account has no authenticator yet**: the second sign-in step offers "Set up an authenticator" (7.2).
- **The setup key, the recovery codes and the reset token are not cleared when the tab is hidden**: the owner has to leave the tab to use them. Everything else is (7.2).
- **A member's overview asks neither `overview.get` nor `metrics.get`** and shows a sentence where an admin sees numbers (7.3, 7.8).
- **The value field is a plain text area**, visible while typed (7.4).
- **Undelete brings a secret back at the same version**, as Doc 04 says; the plan's test title said "the next" (7.5).
- **An import file with one invalid line is refused whole** by the server, so the plan's "apply the ten valid ones" cannot happen (7.6).
- **No per-entry progress while an import waits for its file** (7.6).
- **`credentials.summary` leaves out issuances that never made a token** (7.7).
- **The summary's window ends today**, counted to the observation time; `intent` rows are in no column; days before the oldest audit row read "not measured" (7.8).
- **Wide tables scroll inside their own frame at 360 pixels**; rows are not stacked (7.9).
- **Four of the nine failure classes are answered by the test harness**, with the contract's envelope, because they cannot be made on the shared test stack (7.9).
- **Contrast was not measured, and no accessibility standard is claimed** (7.9).
- **The canary journey starts from an operator's reset**, so that the reset token, the new password, the setup key and the recovery codes are real secrets of the run (7.10).
- **The executing-plans scripts were not used**: the plan's units are runs, not tasks. The ledger was kept by hand.

## Open issues (with owner runs)

- **OWN-4** is still open: an offline copy of `~/.mykey/custody/staging/backup/`.
- **Production's host files hold the old rotation script.** `host.ts prod push` before OpenBao is started there (the owner's word is needed for a change on production).
- **Production's probe shows `checks_unknown`** since the reinstall, because it has no OpenBao. It closes when production is set up.
- **Carried to Session 8, unchanged:** the resting custody root token (M1, Blocker candidate); `reconcile-credentials --all`; the OpenBao user lockout; review findings C–I of Session 6; `CVE-2026-97054`; the credential drill's probabilistic fault placement.
- **New for Session 8:** the thirteen Minor findings above, and the two questions the reviewer declined.
- **Dated:** KMS certificates 12 Dec 2026; `.trivyignore.images` 14 Dec; `pair-30-day` from 17 Dec 19:00 UTC.
- **GitGuardian** still flags the harness line of incident 39994924 (a false positive only the owner can dismiss).

## What Sessions 8 and 9 must know

- **The workspace is in the API image.** A release without a built workspace answers 503 on the page paths and logs `web_shell_missing` once; the API's routes are not affected. Runbook `workspace.md`.
- **The security review of Session 8 starts from the review above**: questions 1 and 3 are where the findings were. The page's rules are in D-60, and `tests/unit/web/sources.test.ts` is what keeps them; its weakness is finding 12.
- **Every change in the page goes through `useAction`.** A new screen that reads a 202 itself must print the operation's state, and the source test must be told.
- **The content policy forbids inline styles.** A chart, if Session 9 wants one, needs a way that does not use a `style` attribute.
- **The owner's first real use (Session 9) starts at the sign-in form of staging's address.** The first-run guide is the Help screen; the reset link comes from the operator (`operator-accounts.md`).
- **A reset of the authenticator ends with a new sign-in.** A reload between the new password and the new authenticator needs a new link.
- **The staging owner's organization holds archived projects of the test runs** (`s4-…`, `s5-…`, `s7-web-…`). Projects cannot be deleted.
- **Every staging file runs at every gate.** The seven files Session 6's gate skipped held one product defect and four stale tests a session later.
- **A container is never signalled with `docker kill`** (`tests/unit/hosts/signals.test.ts`), and host files reach a host only by `push`.
- **Production is unchanged**: closed, `host-v0.6.3`, no OpenBao, no owner.
