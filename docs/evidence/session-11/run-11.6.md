# Run 11.6 — The workspace: automation credentials, and the runtime credential beside the token

**Date:** 26 Nov 2026. **Branch:** `session-11`. Spec §2.3; D-81, D-82; D-70's design system.

## What was done

- **Automation** is a new page of the organization, one click from the menu for an owner or an admin (`/o/:org/automation`, the eighteenth path of `WEB_ROUTES`).
  - The list shows each credential's state, rights, networks, expiry, last use ("never" when there was none) and the number of projects its chain manages.
  - **Issue** asks for a name, the three rights as checkboxes with one sentence each, a lifetime in days (7 unless changed), the networks one per line, and which credential it replaces, if any. It needs a fresh code.
  - **Revoke** asks for the name and says what stays working.
- **Machine credentials** opens its form with a choice of two kinds, each with its sentence: a 30-day token (chosen first, so nothing changes for a token) or a runtime credential (365 days unless changed, networks optional). The list says which kind a row is, where a runtime credential may call from, and whether a person or an automation credential issued it.
- **Both new secrets are shown once,** through `callSecret` and the forgetting holder: gone after 120 seconds, when the tab is hidden, on navigation and on sign-out. The automation page then says that the secret cannot be shown again.
- **Connect an application** says when to choose which kind, and that the step that stores it is the same.
- **A project a script made** says "Managed by automation", with the name of the chain's first credential for an owner or an admin.
- **The texts** are in the catalogue (`copy/credentials.ts`, `copy/pages.ts`, `copy/actions.ts`), linted, with a help article "Automation credentials". The claims test holds the sentences that are easy to overstate.

## Commit

- `feat(web): automation credentials, and the runtime credential beside the token`

## Commands and results

| Command                                                          | Result                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/web`, before the change                              | 8 failed as intended (no `automation` path, the two routes not in `SECRET_BEARING`, no catalogue, the claims not there)                                       |
| `pnpm run test:browser tests/browser/automation.test.ts`, before | 7 failed as intended (`webPath: no screen automation`; no choice of kinds; no "Managed by automation")                                                        |
| `pnpm run test:browser tests/browser/automation.test.ts`         | 7 passed                                                                                                                                                      |
| `pnpm run test:browser` (the whole project)                      | 16 files: 14 passed. `navigation` and `canary` each failed once (the palette's search "cred" met the new entry first); fixed, and both rerun green (19 tests) |
| `tests/integration/web` (the shell serves the new path)          | 1 file, 20 tests passed                                                                                                                                       |
| `pnpm test` (unit)                                               | 143 files, 1637 tests passed                                                                                                                                  |
| `pnpm run check`                                                 | green                                                                                                                                                         |
| CI on the draft pull request (#27), after Run 11.5's last push   | green (`check` and `secret-scan`)                                                                                                                             |

## What the browser test proves

- An owner whose code is older than ten minutes is asked for one, and the page does not issue by itself afterwards.
- The automation secret has the `mkac` shape and works: the script's first read answers 200.
- After leaving by a link and coming back by the history, the secret is in no element, storage, IndexedDB, Cache Storage, cookie, history state, address or requested address. The same search finds the credential's name, in the document only (the control).
- A runtime credential issued in the page is exchanged, and the exchanged token reads the environment's keys. Neither the client secret nor that token is kept anywhere.
- Revoking reads "revoked", and the secret is then `401`.
- A network with host bits set is refused by the service (422), and the page explains it in words: no code and no status on the screen, and no row was made.
- A member has no menu item, and the page shows the service's refusal and no table.
- No request left the test origin, and the page's policy reported no violation.

## Deviations and decisions

- **The secret stays 120 seconds, as a token does, not the plan's 30.** It has to be carried to a file, and one rule for everything shown once is easier to learn. A tab hide still removes it at once.
- **"In no query cache" is held by the sources test, not read at run time.** The cache is not reachable from the page. `tests/unit/web/sources.test.ts` refuses any cached hook that names a route of `SECRET_BEARING`, which now holds the two new routes.
- **The scan's reader moved to `tests/harness/kept.ts`,** and `canary.test.ts` imports it: every test that shows a secret searches the same places.
- **A lifetime is whole days in the page** (1 to 365). The contract's one-hour minimum of an automation credential is reachable by the API only.
- **The page checks how many networks were named, never what a network is** (D-80's cut 7). A refusal of the service is explained at that field.
- **A field's hint stays in its screen,** as on every earlier form; the catalogue holds the page, action and credential texts. The example network in a hint is of the documentation range.
- **Valve 4 was not taken:** the project page has its label. A member sees it without the name, because only an owner or an admin can list automation credentials.
- **Four tests beyond the plan's five:** the secret's end by time and by a hidden tab; the member; the project's label; axe on the open form.
- **The revoke text of a runtime credential states the residual:** for up to 15 minutes the secret store can still accept a token made before, from the host's own network only (D-81).

## Open issues

- **The runbook `automation.md` and the lines of `known-limits.md` are Run 11.7's.** The help article names no runbook yet.
- **The staging journey of the new screens** is Run 11.8's (`workspace.staging`).
