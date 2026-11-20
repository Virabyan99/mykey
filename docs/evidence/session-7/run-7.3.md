# Run 7.3 — Overview and resources (D08-S33, S39)

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Decisions:** P-139 (the record D-61 comes with Run 7.8, after the third body), P-140.

## What was done

- **`overview.get` has its body** (commit `contract: overview`): the organization's projects with their environments and the key counts of `app.secret_index`, read by one statement at one database time, at most 100 projects by id. `keys` is `null` for an environment that is `pending` or `needs_review`. The pending snapshot holds two routes.
- **The overview screen:** each project with its environments, their state, the three counts and the last change, with "from the index, as of <time>". A count that is `null` reads "not available". A member gets the list of the projects they can see, without counts and without asking the route.
- **The project screen:** the project's and each environment's state, review reason and immutable id; create and rename with the contract's own name rules; archive and reactivate.
- **The confirmation** (`ui/Dialog.tsx`): fixed text, the resource's name typed exactly. An archive first reads what it will revoke from `credentials.list` and `operations.list`: active credentials and unfinished issuances, per affected environment. A number that could not be read is said to be unread.
- **Following a state** (`state/use-follow.ts`): while a listed resource is `pending` or `revoking` the page asks again by the schedule of P-140 and then stops with "Check again". With nothing moving it asks nothing.
- **One change, one key** (`state/use-action.ts`): the idempotency key stays with the request while its outcome is open (no usable answer, or a 5xx) and is renewed after a definite answer.
- **The carried archive fix:** a throw of the drive inside the request answers 503 `dependency_unavailable` with the operation id, and is logged as `unhandled` with the route.
- **A harness for both stores:** `startWebWithStores()` serves the workspace from the API of the credentials fixture (real OpenBao, the real provisioning job, real tokens).

## Commits

- `contract: overview`
- `feat: the overview route and the resource screens` (this commit)

## Commands and results

| Command                                                                                                  | Result                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm exec vitest run --project integration tests/integration/overview/overview.test.ts --maxWorkers=2`  | 4 passed (red first: 404, no handler)                    |
| `pnpm exec vitest run --project integration tests/integration/lifecycle/archive.test.ts -t driveArchive` | 1 passed (red first: 503 without the operation id)       |
| `pnpm exec vitest run --project browser tests/browser/resources.test.ts`                                 | 5 passed (red first: 5 failed, no screen existed)        |
| `pnpm exec vitest run --project browser tests/browser/shell.test.ts tests/browser/auth.test.ts`          | 13 passed (rerun: the app changed under them)            |
| `pnpm run contracts:check`                                                                               | the document is current and compatible with the baseline |
| `pnpm test`, `pnpm run check`                                                                            | green                                                    |

CI after Run 7.2's push: green in 2 min 8 s (`check` and `secret-scan`).

## Registry

FR-1.90 SPIKE_PASS — the owner sees the projects and environments they may see with their names, immutable ids, state, review reason, last change and the index's counts of live, deleted and review keys, with source and time. A count that was not made is `null` and reads "not available". Pending, revoking, archived and review resources offer only what their state allows (`tests/integration/overview/overview.test.ts`, `tests/browser/resources.test.ts`).

AC-1.46 SPIKE_PASS — active, pending, archived, revoking and review resources were made and shown with their counts, times and actions. A member gets 403 and organization B the hidden 404; nothing of B and no secret name is in the answer (`tests/integration/overview/overview.test.ts`, `tests/browser/resources.test.ts`). FR-1.94's part of it is Run 7.8's.

## Deviations and decisions

- **A new project or environment answers 201 while the resource is `pending`.** The create is finished; the preparation is not. The page says so and follows the lists by the poll schedule; it does not poll the operation, which is already `succeeded`.
- **"Its secrets screen offers no write"** is proven here by the notice an environment that is not active shows on its screens. The secrets screen and its write buttons are Run 7.4's, which adds the positive half (an active environment offers the write, an archived one does not).
- **Unread counts do not block an archive.** The server archives a project that has an environment under review, whose lists cannot be read. The dialog names what it could not read.
- **A member's overview does not call `overview.get`.** The call would be refused and would write an `access.denied` row on every visit. The role only spares the request.
- **`observedAt` is the read transaction's time**, taken before the one statement that reads the rows: the data is never older than the time shown.
- **Found and fixed:** `apps/api/src/app.ts` held one byte that was not UTF-8 (a dash typed through the shell in Run 7.1, inside a comment). Every tracked text file was then checked: no other.

## Open issues

- The overview makes 4 API requests. The credentials summary (Run 7.7) and the metrics summary (Run 7.8) add one each: the test's bound moves with them, and the reason is written there.
- A project's archive dialog reads two lists per environment. A project with many environments makes that many requests once, when the dialog opens; the session's limit is 120 a minute.
