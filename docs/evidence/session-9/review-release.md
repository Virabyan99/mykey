# Fresh-context review of the release candidate (`host-v0.8.1..HEAD`, D-06)

_Run 9.0 Task I Step 2. One reviewer (Opus 5.5), fresh context, read-only. It was given the paths, `known-limits.md`, the workspace's rules and the screenshots, and not the plan or the run notes. The review is saved as it came. How each finding was handled is at the end, under "Disposition", which is not the reviewer's text._

**Summary.** The new workspace surfaces (palette, help search, copy buttons, Connect an application, Getting started, screenshots) hold, copy, index and keep no secret value or token. I found nothing in them that breaks the workspace's rules: no storage, no `style`, no markup from text, and secret-bearing routes only through `callSecret`. The texts are mostly accurate. The few overstatements are around the token-storing step and the restore custody files. Tests were rewritten for the new shell without weakening anything of substance. Two new tests prove less than their names say.

The serious problem is the restore. The R4-2 fix makes a new root token before `openGate`, and `openGate` re-checks `machine_accessors_none`. That check counts every accessor other than the restore's own, so it counts the new root token. As written, `restore-verify --open` cannot open any restored host. Each retry also leaves one more live, non-expiring root token in a custody file that the runbook calls dead. The fault test misses this because it never calls `openGate` after `generateRoot`.

R4-3, R4-4, R4-7 and R4-10 are largely fixed. Residual gaps:

- The 2-hour restore token now bounds the whole window from step 4 to `--open`, and nothing says so.
- The deploy refusal fails open on an SSH error.
- A narrow R4-4 window remains.

The biggest first-time UX trap is in Connect: copying the "store the token" command overwrites the token on the clipboard.

---

## (a) Does any new surface hold, copy, index or keep a value or a token?

**No finding.** What I checked:

- **Palette** (`apps/web/src/palette/sources.ts`, `Palette.tsx`)
  - Its entries come only from scope rows (organization, project and environment names and ids), fixed page labels and help-article titles and keywords.
  - It makes no request, and no secret name or value is a source.
  - What is typed lives in the dialog's `useState` and is discarded when the dialog unmounts.
  - The palette is gone with the session (`navigation.test.ts:655` checks there is none while signed out).
- **Help search** (`help/search.ts`, `HelpCenter.tsx`)
  - An in-memory index of bundled articles only.
  - The query is component state; it is never sent and never put in the address.
  - The only `window.location` use in help is reading an anchor hash (`Article.tsx:238`).
- **Copy buttons**
  - `IdChip.tsx:10,29` refuses anything that is not a UUID.
  - The Connect `CodeBlock` copies only runbook text with three fills (origin, project id, environment name).
  - `fillVariables` refuses any fill outside `[A-Za-z0-9.:/_-]` (`connect/commands.ts:63`).
  - The token is never filled in.
  - `ui/Secret.tsx` (the value and token copy) is unchanged in kind.
- **Getting started** (`screens/getting-started.tsx`)
  - Uses only `overview.get`, `credentials.summary` and `audit.list` (limit 1, `items.length` only).
  - None is in `SECRET_BEARING`.
  - `hiddenByOwner` is a module boolean, not storage.
- **The other rules**
  - Grep over `apps/web/src`: no `style=`, `.style.`, `innerHTML`, `insertAdjacentHTML`, `document.write`, storage, or theme or `matchMedia` persistence.
  - `tests/unit/web/sources.test.ts` walks every file under `src`, including the new `help/`, `palette/`, `connect/`, `copy/` and `ui/`.
- **`callSecret` / `useEphemeral`:** used only in the screens that used them before (account, credentials, enroll, export, import, reset, secret-value, secret, secrets). `secrets.tsx` uses `callSecret` only for create.
- **Screenshots** (home, secrets, secret, credentials, connect, palette, project, import-export, help centre, home 390, help centre 390):
  - synthetic tenants (`ownera-…@mykey.invalid`, test UUIDs, `https://mykey.test`);
  - the secret page shows the value hidden;
  - no token, value or real host address is visible.
- **The canary scan** (`tests/browser/canary.test.ts`, +37 lines) now uses the palette, an id copy, both Connect tabs and the help search while canaries are live, then scans.

## (b) Does any text claim more than the code does?

**RR-5 (Low): the Connect "Store the token" step contradicts itself and is not the rehearsed runbook block.**

- **Where:** `apps/web/src/connect/commands.ts:83-87` (`TOKEN_WARNING`, `quietly`), `copy/connect.ts:28-31`, and the file header (`commands.ts:1-6`, "the panel and the runbooks cannot drift apart").
- **What is wrong:**
  - The warning says "The pasted token stays on the screen", yet the block it sits above starts with `stty -echo`.
  - The block is the runbook's block wrapped in `stty -echo` / `stty echo`. That wrapped form is not in `consumer-local.md` §8 or `consumer-deploy.md` §5, so `tests/consumers` never rehearses it. The runbook says to _type_ `stty -echo` first.
- **Failure scenario:** in a shell without bracketed paste (bash before 5.1 by default, e.g. Ubuntu 20.04; bash 3.2), the owner pastes the three lines.
  1. `stty -echo` runs.
  2. `cat` starts and reads the still-buffered line `stty echo` as the first line of the token file.
  3. The owner pastes the token and presses Ctrl-D.
  4. The token file now starts with `stty echo`, the CLI exits 77, and the terminal is left without echo.
- **Smallest fix:** show the runbook's block unchanged, with `stty -echo` as a separate one-line block "type this first", or add the wrapped form to the runbook so it is rehearsed. Drop the sentence "The pasted token stays on the screen" where echo is off.

**RR-6 (Low): `custody-map.md` says every dated answer's root token is dead.**

- **Where:** `docs/runbooks/custody-map.md:33`: "A dated answer's root token opens nothing once a snapshot has replaced that OpenBao's store".
- **What is wrong:** a copy that `restore-verify --open` replaces after a previous `--open` attempt holds a _live_, non-expiring root token (see RR-1).
- **Smallest fix:** fix RR-1. Until then, say that a replaced copy made after the restore can hold a live root token.

**Checked and accurate** (no finding):

- `help/articles.ts` against `LIMITS`:
  - reveal 30 s;
  - 20 versions;
  - 30-day tokens, 7-day expiry warning;
  - 10 recovery codes;
  - fresh code 10 minutes;
  - import 1 MiB / 1000 entries, preview 15 minutes;
  - five failures / 15 minutes;
  - idle 30 minutes / absolute 12 hours;
  - audit 365 days.
- "A new project comes with development" matches `developmentEnvironmentId` in `apps/api/src/routes/resources.ts:137`.
- "type the secret's name to confirm" matches `ConfirmDialog` with `name` (`secret-history.tsx:231`).
- The CLI exit-code table is held to `apps/cli` by `help-search.test.ts`.
- The "Getting started" 30-day wording matches the audit list's default window.

The restore texts' accuracy is under (d).

## (c) Is any test assertion weaker than at `host-v0.8.1`?

No assertion of substance was removed. Each rewritten locator still asserts the same facts on the new shell:

- the select options became sidebar and breadcrumb links;
- "Overview" became "Home";
- the first-run guide became `/help/getting-started` plus the operator section.

Details:

- `access.test.ts`'s narrow-screen test moved to `navigation.test.ts:192`, now covering 13 screens instead of 5.
- The "no address on the page" check now runs on three help pages instead of one.
- The step-count check (6) is kept.
- `credentials.staging` → `credential-drill.staging` is a move; every removed line is present in the new file.

Notable items:

**RR-7 (Low): the narrow-screen sweep now skips elements without client rects.**

- **Where:** `tests/browser/navigation.test.ts:240` (`getClientRects().length > 0`).
- **What is wrong:** elements with `display: none` (and `display: contents` wrappers) are now excluded from the "ends outside the screen" list. That is harmless today.
- **Failure scenario:** a `display: contents` wrapper whose children overflow would still be caught through its children, so nothing real slips. I note it only because it is a loosening.
- **Fix:** none needed; a comment saying why would do.

**RR-8 (Low): the palette sign-out test proves less than its name.**

- **Where:** `navigation.test.ts:655`, "after sign-out and sign-in as another user the palette holds none of the first user's projects".
- **What is wrong:** the second user signs in through `web.signedIn("ownerB")`, which opens a new browser context (`tests/harness/web.ts:127`). The test would pass even if `forgetData` kept organization A's projects in the same page.
- **Fix:** sign in as `ownerB` in the same page after the sign-out.

**Loosened time bounds (noted, not findings):**

- `probe.staging.test.ts` (300 → 360 s);
- `unseal.staging.test.ts` (wait 290 → 410 s, block 300 → 420 s).

These are documented worst-case derivations (Doc 06 §12).

**Also under (c):** `tests/fault/restore/interrupted.test.ts:181-212` calls `generateRoot` after `restoreVerify` but never calls `openGate` with `recheckForOpen` after it. That is how RR-1 got through.

## (d) Do the restore fixes do what R4-2, R4-3, R4-4, R4-7 and R4-10 ask?

**RR-1 (High): after the R4-2 fix, `restore-verify --open` can never open a restored host.**

- **Where:** `scripts/host.ts:3165-3192`, with `apps/ops/src/commands/restore-verify.ts:134-140` and `packages/operations/src/gate-write.ts:81-85`.
- **What is wrong, in order:**
  1. With `--open` and all checks ok, the code first calls `generateRoot` (`host.ts:3170`). That creates a new root token, with its own accessor, in the root namespace.
  2. It then calls `openGate({ recheck: () => recheckForOpen(deps) })` (`host.ts:3184-3192`).
  3. `RECHECKED` includes `machine_accessors_none`. That check counts every accessor in `""` and every organization namespace other than the restore token's own. The new root token is one, so the check is `failed`.
  4. `openGate` returns "check machine_accessors_none is failed now", and the command exits 1.
- **Further damage:**
  - Before `openGate`, `writeCustodyAfterRestore` has already renamed the custody copy and written the new token.
  - A rerun makes another root token and moves the previous one (live, never revoked, non-expiring) into a dated `openbao-init.<stamp>.json`. `custody-map.md` describes such a file as one that "opens nothing".
- **Failure scenario:** a production disaster restore reaches step 9.
  1. `--open` refuses every time.
  2. A deploy refuses because the state file is there (R4-7).
  3. The standalone `gate open` refuses restore reports.
  4. The host stays closed with no documented way out.
  5. Each attempt adds an undocumented live root token in workstation custody.
- **Why the tests pass:** the fault test (`interrupted.test.ts:196-212`) runs `generateRoot` after `restoreVerify` and never runs `openGate`. The unit tests use a fake `SysCall`.
- **Smallest fix:**
  - Make the next root token _after_ `openGate` succeeds and before `revokeSelf`. If generation fails, do not revoke the restore token: it is still the way to retry within its 2 hours.
  - Alternatively, pass the new token's accessor to the recheck as allowed.
  - Add `openGate(… recheck: recheckForOpen)` after `generateRoot` to the fault test.

**RR-2 (Medium): the restore token's 2-hour TTL bounds the whole window from step 4 to `--open`, and a lapse strands the host.**

- **Where:**
  - `packages/openbao/src/admin.ts:359-365` (`ttl: "2h", renewable: false`);
  - `scripts/host.ts:3082, 3170` (`--open` uses the restore token for `restoreVerify` and `generateRoot`);
  - `docs/runbooks/restore.md:66`;
  - `docs/runbooks/known-limits.md` (the new rerun line).
- **What is wrong:**
  - `generate-root` needs a live root token, because the code uses the authenticated `sys/generate-root-token`; its own comment says the unauthenticated endpoint answers 405.
  - The only live token after step 5 is the restore's, and it dies 2 hours after step 4.
  - The texts state the 2-hour limit only for a _rerun_.
  - Yet "Between 7 and 8" includes `reconcile-credentials` for every environment (27 minutes measured on staging) and the owner's reset, enrolment, reveal and sign-out, possibly the next day.
- **Failure scenario:** the owner comes back three hours after the restore.
  - `restore-verify` fails its OpenBao checks.
  - `generate-root` is impossible: the pair's token was revoked at step 5, the target's own token died at the snapshot, and the restore token has expired.
  - OpenBao must be initialised anew and the whole restore redone.
  - This was latent before Run 9.7. The new design now depends on that token for the next root token too, and the texts were edited without saying it.
- **Smallest fix:**
  - Make the next root token at the end of `restore` (step 7) and keep it at `restore-root-token`; then `--open` only revokes the 2-hour one.
  - Or at least state in `restore.md` ("Between 7 and 8") and `known-limits.md` that `--open` must come within 2 hours of step 4.

**RR-3 (Low): the R4-7 deploy refusal fails open, comes late, and misdirects.**

- **Where:** `scripts/host.ts:3694-3704`, `deployRestoreRefusal` at `:2758`.
- **What is wrong:**
  - **Fails open:** `restoreState.code === 0 ? stdout : null`. An SSH or `sudo` failure reads as "no restore", and the deploy opens with the deploy checks alone, which is exactly R4-7.
  - **Comes late:** the check runs at the `gate_open` step, after the deploy has already installed the new release on a host that is closed and verifying.
  - **Misdirects:** the message always says "it opens with restore-verify --open". For a leftover `"opened"` line that is wrong, because `--open` removed the workstation hand-off files, so `restore-verify` answers "no restore … to verify".
  - It keys on the state file, not on the gate record's `restore` origin that R4-7 names. Removing the file by hand, as `startRefusal`'s message tells the operator to do, lifts the guard.
- **Smallest fix:**
  - Throw when `code !== 0`.
  - Run the check at the deploy's first step.
  - Also refuse a `gate_open` whose previous record is closed with a `restore` origin and not yet opened.
  - Give a distinct message for `step: "opened"`.

**RR-4 (Low): a narrow R4-4 window remains.**

- **Where:** `scripts/host.ts:3184-3207`, `apps/ops/src/commands/restore.ts` `startRefusal`.
- **What is fixed:** an open gate is now always refused (`serving: true`), and the `"opened"` line is refused. That closes R4-4 as the finding states it.
- **What remains:** `"opened"` is written only after `openGate` succeeds.
- **Failure scenario:**
  1. The SSH write fails after the gate opened, so the line stays at `start`.
  2. The host serves and takes writes, then is later closed (`gate close`; a deploy is refused).
  3. `restore --pair P` with the same pair passes step 1: the host holds organizations, but the line names this pair at a step before opening.
  4. `DROP SCHEMA … CASCADE` runs on data written after the opening.
- **Smallest fix:** write `{step: "opening"}` before `openGate` and refuse it like `"opened"`. Or refuse data whenever the gate record shows any opening after the line's pair.

**Verdicts per finding, in their own words:**

- **R4-2** ("after a completed restore no root token exists for the restored OpenBao … no runbook says to run generate-root with the source's recovery key or to update the custody copy"):
  - Addressed in intent: generate-root with the source's recovery key, the custody copy rewritten, the old copy kept dated, the runbook updated, and the `known-limits` lines removed.
  - Broken in practice by RR-1, and fragile by RR-2.
  - R4-13 and R4-14 remain open and are listed as such.
- **R4-3** ("a host restore that stops after step 4 cannot be run again … the minted root token is written to disk only after `restoreToVerifying` has returned"):
  - Fixed. `keepRootToken` writes it (0600) before `done("openbao")`.
  - Step 4 offers the kept token, then the dated copies, the custody copy and the pair's token, and uses the first that `lookup-self` accepts.
  - The harness now keeps one scratch OpenBao per target (`restore-target.ts`), so the fault test meets the store the stopped run left. It covers a stop after `snapshot` and after `invalidate`.
  - The 2-hour residual is stated for reruns only (RR-2).
- **R4-4:** fixed as stated; residual in RR-4.
- **R4-7:** mitigated by the state file, not by the restore origin; gaps in RR-3.
- **R4-10** ("`bao-init` refuses to overwrite the lost host's custody copy … the restore then sends `snapshot-force` with the lost host's token"):
  - Fixed. `custodyInitPlan` writes the new server's answer dated beside the copy.
  - `rootTokenCandidates` offers the dated answers before the copy.
  - `pairRootToken` still reads the lost host's copy, which is correct.
  - No `Before` step between `bao-init` and `restore` reads the custody token (`backup-init`, standalone `gate open` and deploy `withAdmin` do, but none is in the list).
- **Untested:** the host-side `hostSysCall` (curl over SSH, header file, body on stdin) has no test; only `generateRoot` with a fake call and the local `baoFetch` path are tested.

## (e) UX for a first-time owner

**RR-9 (Medium): Connect's flow loses the token at the clipboard.**

- **Where:** `apps/web/src/connect/commands.ts:129-134` (step 5 "Issue a token", then step 6 "Store the token" with a Copy button), `copy/connect.ts:24-31`.
- **What is wrong:** step 5 says "The token is shown once: copy it then".
- **Failure scenario:**
  1. The owner opens Machine credentials, issues a token and copies it.
  2. Leaving the page clears the token from the screen (`useEphemeral`).
  3. Back on Connect, the owner presses Copy on step 6's block, which replaces the token on the clipboard.
  4. The owner pastes the block into the terminal, `cat` waits, and there is no token left to paste.
  5. The owner has to revoke and issue again, and may conclude the product is broken.
- **Smallest fix:** in both tabs, put "Run this block first" before "Issue a token", or say in step 6 "Copy and run this block before you copy the token".

**RR-10 (Low): Getting started points at the wrong place and assumes owner rights.**

- **Where:** `screens/getting-started.tsx:73-78` and `:110`.
- **What is wrong:**
  - The step links always use `projects[0]` and its first environment, whatever was done. In the Home screenshot, "Add your secrets" is Done but links to Project Two / dev, which has 0 keys; the secrets are in Project One / dev.
  - "Press New project above" is shown to a member who has no such button.
- **Fix:**
  - Link to the first environment that has keys or credentials, or to the project list.
  - Use role-aware wording.

**RR-11 (Low): Home's first view is dominated by machinery.**

- **Where:** `home-light-1440.png`, `home-light-390.png`.
- **What is wrong:** below the checklist, a new owner sees:
  - a six-row credential-state table of zeros;
  - a seven-row "Outcomes by day" table that is mostly "not measured";
  - "Operations without an end" (two zero rows) mentioning `reconciliation.md`.

  At 390 px the projects come after a long checklist, and the tables cut columns behind horizontal frames ("UNDER REVIEW", "DENIED").

- **Fix:** collapse the three summary sections behind a "Service health" disclosure while they are all zero, and put projects first after the checklist.

**RR-12 (Low): smaller confusions.**

- The organization has no name: it appears as `d374cf93` in three places (breadcrumb, sidebar, page header). This is a Stage 1 limit, but nothing on Home says so.
- The palette's "Issue a machine credential" and "Add a secret" are labelled _Action_ but only navigate to the list. "New project", by contrast, opens the form.
- The getting-started checklist comes back on every reload (by design, no storage). The button says only "Hide the checklist", not "for now".
- There are no screenshots of sign-in, reset, enrolment or recovery codes, which are the first screens a new owner meets. I could not review that part from the evidence. The screen code for them did not change in kind.

**What a new owner would find without trouble:**

- the sidebar (projects, then the environment's sections);
- the breadcrumbs with copyable ids;
- the per-page "How this works";
- the help centre's popular questions;
- the empty states with one primary action;
- Ctrl K.

The project id problem from the walkthrough is solved: it is on every environment screen and in Connect's commands.

---

## Disposition

(Written after the review, by the executor.)

| Finding        | Severity | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RR-1           | High     | **Fixed before the release.** `--open` makes the next root token, then opens the gate with its accessor named to the recheck as the operator's own. `VerifyDeps.operatorAccessors` is counted in the root namespace only, and every other accessor still fails. A refused opening revokes the new token at once. The custody copy is rewritten only after the gate is open. Proof: `tests/fault/restore/interrupted.test.ts` now runs the real `recheckForOpen` after `generateRoot`. It was RED (`machine_accessors_none` failed), then GREEN 5/5 for the file. |
| RR-2           | Medium   | **A known-limits line, and a warning in `restore.md`.** `--open` must come within two hours of step 4. Making the next root token at step 7 would lift this; that is left for Stage 2.                                                                                                                                                                                                                                                                                                                                                                           |
| RR-3           | Low      | **Partly fixed.** The state read now refuses on an SSH or `sudo` error instead of reading as "no restore", and a leftover `opened` line gets its own message (`restore-custody.test.ts`). Not done: the check stays at the deploy's `gate_open` step and keys on the state file, not on the gate record's origin.                                                                                                                                                                                                                                                |
| RR-4           | Low      | Not fixed. The window needs a failed SSH write right after the opening, then a later restore of the same pair. It is written here and carried to the session report.                                                                                                                                                                                                                                                                                                                                                                                             |
| RR-5           | Low      | **Fixed.** `stty -echo`, the runbook's block and `stty echo` are three blocks run one at a time, as the runbook says to type them. The warning says to run them as separate lines (`connect-commands.test.ts`, `navigation.test.ts`).                                                                                                                                                                                                                                                                                                                            |
| RR-6           | Low      | Holds once RR-1 is fixed: no attempt leaves a live token in a dated copy. No text change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| RR-7           | Low      | No change (the reviewer: nothing real slips).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| RR-8           | Low      | Not fixed; it was already ruled in Run 9.0. The canary scan's sign-out pass covers a cache kept on one page.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| RR-9           | Medium   | **Fixed.** In both tabs, the terminal is made ready (the store step) before the token is issued, and the texts say why (`copy/connect.ts`; `connect-commands.test.ts` asserts the order).                                                                                                                                                                                                                                                                                                                                                                        |
| RR-10 to RR-12 | Low      | Not fixed before the release. They are open for the owner's task test (OWN-UX). A task "not found" there is fixed in `host-v0.9.1`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
