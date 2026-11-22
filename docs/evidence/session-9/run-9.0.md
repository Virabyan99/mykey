# Run 9.0 — The workspace redesign (Tasks A to H)

**Date:** 21 and 22 Nov 2026. **Branch:** `session-9` (draft PR). **Decisions:** D-69 (changes after Gate R), D-70 (the palette). **Owner's request:** Session 8's `walkthrough.md` (first-visit navigation is poor; the project id was only in the address).

Task I (the freeze, the review, the claims walk, `host-v0.9.0`, OWN-UX, production closed) completes this note.

## What was done

- **Task A (tokens, icons, base components):** `styles.css` rewritten on design tokens, light and dark, every text pair at 4.5:1 or more (`contrast.test.ts`). A Lucide subset as inline SVG with its licence. `PageHeader`, `EmptyState`, `Callout`, `IdChip`, `Breadcrumbs`, `EnvironmentTabs`, `Term`, `Tip`, `Menu`. Popovers sit in portals, so a row's text is unchanged. axe-core 4.14.0 pinned; `a11y.test.ts` runs it on 13 screens.
- **Task B (the frame):** a sidebar (Home, projects and their environments, the environment's sections, Activity, Audit, Help centre, Account), breadcrumbs with a Copy button for each id, environment tabs that keep the section, a drawer below 64rem, and a skip link. The project id is on every screen of the project as text, with a Copy button.
- **Task C (the catalogue):** `copy/pages.ts`, `states.ts`, `actions.ts`, `glossary.ts`, `connect.ts`, with a lint (`copy/lint.ts`) for canaries, tokens, reset links, addresses, host names and claims the code does not make. Every confirmation text comes from `actions.ts` (`copy.test.ts`).
- **Task D (the page contract):** every screen opens with one h1, its summary, "How this works" and its main action. Empty states teach and offer the next action. A badge's meaning opens on focus and hover. Every refusal links to its entry in the error list.
- **Task E (getting started, Connect an application):** Home's checklist has six steps, each marked from the server's facts. The CLI step is "Not checked". Connect an application shows `consumer-local.md`'s and `consumer-deploy.md`'s own blocks, with the origin, the project id and the environment's name filled in. The token is never filled in, and its step turns echo off. There is a "no application yet" variant. The runbooks travel as a generated module (`scripts/web-runbooks.ts`). `consumer-local.md` now gives the `curl` downloads first, with `gh` as the alternative.
- **Task F (help):** a help centre with search (`help/search.ts`), 31 articles in 9 categories, the error list A to Z, the CLI's exit codes (equal to `apps/cli`'s `EXIT`), the glossary and the known limits. "?" on every page opens that page's help in a side panel.
- **Task G (Ctrl K):** a palette over pages, projects, environments, help articles and actions only, named in `palette/sources.ts`. A unit test reads that file for secret routes and secret lists.
- **Task H (the page's own proofs):** the canary journey now opens the palette, copies a project id, opens both connect tabs and searches the help. `build.ts` fails above 1.2 MB of script. `screens.capture.ts` takes the review's screenshots by hand. `workspace.md` and `start-here.md` describe the new frame.

## Commits

- `2368f3d` feat(web): the workspace's design tokens, icons and base components
- `9cff895` feat(web): one catalogue holds every description the workspace shows
- `bf9e752` feat(web): every screen on the page contract; the help centre, Connect an application and Ctrl K
- `392f51e` test(web): the canary scan uses the palette, the help and the connect panel

## Commands and results

| Command                                                                          | Result                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest --project unit tests/unit/web/palette-sources.test.ts`                   | RED (no `palette/sources.ts`); GREEN 3/3                                                                                                                                         |
| `vitest --project unit tests/unit/web` (with `tests/unit/api/web-shell.test.ts`) | GREEN 241/241 at the Task G commit; 198/198 for `tests/unit/web` at the end                                                                                                      |
| `vitest --project browser tests/browser/navigation.test.ts`                      | first run 13/18: five findings (below); GREEN 18/18                                                                                                                              |
| `vitest --project browser tests/browser/help.test.ts`                            | 4/5 (links read before the page rendered); GREEN 5/5                                                                                                                             |
| every other browser file, one at a time                                          | a11y 2/2, access 15/15, activity 7/7, auth 8/8, canary 1/1, credentials 8/8, history 6/6, import-export 9/9, journey 1/1, reference 4/4, resources 5/5, secrets 13/13, shell 6/6 |
| `node apps/web/build.ts`                                                         | script 998,381 bytes (255,300 gzip); stylesheet 15,468 bytes; 875 kB in Run 7.9                                                                                                  |
| `pnpm run check`                                                                 | green                                                                                                                                                                            |
| `pnpm test`                                                                      | 1509/1511: two 5-second timeouts under load (`dotenv/roundtrip`, `registry`); 22/22 when run alone                                                                               |

## What the browser tests found

- **resources.test:** Home's first load made 7 requests against D-61's bound of 6. The extra one was Getting started's audit query. It is now asked only while a credential is active: a load without one stays at 6, and the test asserts no audit call. With one active, a load makes 7, and `navigation.test` asserts the seventh is the one-row machine-read query.
- **secrets.test:** the palette button "Search and go to" made `getByRole("button", { name: "Search" })` ambiguous. It is now "Go to… Ctrl K".
- **history.test:** a key under review must offer no button in `main`. The secret page's id chips were buttons, so its ids are now text; the breadcrumbs copy them.
- **navigation.test:**
  - Org B also has a "Project One", so the sign-out test now proves the separation through org A's "Project Two" and org B's address.
  - The clipboard on Windows gives CRLF back.
  - A seeded error needs its request id.
  - The "no application yet" step named `APP_START` in its words, so it now has its own words.

## Deviations and decisions

The rulings, each with what it costs if wrong, are in the run's ledger and are carried into the session report. In short:

- **P-162:** the existing button names are kept, and so are the project row's buttons (no row menu). The secrets row's menu holds only Open and History.
- **Moved tests:** the 360 by 740 test moved to `navigation.test.ts`, with the new screens. The first-run guide test now runs over `/help/getting-started`, `/help` and `/help/api-reference`, with the same checks.
- **Connect an application:** the runbooks are bundled as a generated module, not by importing the `.md` files. Importing them would add two `COPY` lines to `apps/api/Dockerfile`, which D-69 does not allow.
- **Palette sign-out test:** it uses two browser contexts, not one page signed in twice. A cache kept across a second sign-in on one page is covered by the canary scan's sign-out pass, not by this test.
- **Not watched red:** `connect-commands.test.ts` was written beside `commands.ts`. Its controls (token shapes, the refusals of unsafe values) were checked to fail on bad input.

## Open issues

- Task I is done; it is recorded below.
- The screenshots (`docs/evidence/session-9/screens/`) are for the reviewer of Task I.

## Task I — The freeze, the review, the claims walk, the releases, OWN-UX (22 Nov 2026)

- **The diff check against D-69** (host-v0.8.1..HEAD). Outside apps/web, docs, tests, scripts, tools and infra/hosts, the diff touches only:
  - the restore code (apps/ops restore.ts, restore-verify.ts, index.ts), which D-69 allows;
  - `WEB_ROUTES` in packages/contracts;
  - the root devDependency axe-core.
    That is the ledgered ruling.
- **The release review** (`review-release.md`, one fresh reviewer on `host-v0.9.0`'s candidate):
  - RR-1 (High: `--open` revoked the only root token before writing custody) was reproduced in `tests/fault/restore/interrupted.test.ts` and fixed in `a323998`;
  - RR-9 is fixed;
  - RR-3 is partly fixed;
  - RR-5's three-block token step later failed in real use (`run-9.2.md`, F-9.2-1);
  - the rest are carried (the review's Disposition).
- **The claims walk** (`claims.md`): 263 rows at `6233002`; 36 corrections, applied in `a323998`.
- **`host-v0.9.0`** (`a3239986ed4f`) was built once and deployed to staging (epoch 331).
- **OWN-UX** (`task-test.md`):
  - On `host-v0.9.0` the owner could not find machine credentials, and the test stopped before task 1.
  - The owner chose "fix now". `b19ca66` put Secrets, Machine credentials and Connect on every environment row, and the sidebar lists an open project's environment sections (browser 108/108).
  - **`host-v0.9.1`** was built once (`b19ca6671e14`) and deployed to staging through the owner's journey (`--owner-confirmed`, epoch 336, after `tunnel verify --browser` was written for it).
  - All seven tasks were then found unaided.
- **Staging on `host-v0.9.1`:** workspace 1/1 after its heading fix, api 12/12, status 3/3, identity 15/15, sweep 10/10. The staging test owner was re-established after the test.
- **Production:** push, timers and `deploy --stay-closed` of `host-v0.9.1` with the owner's yes. Every status check was `ok` and the gate closed. Run 9.1 opened it.
- **The candidate:** `docs/evidence/session-9/candidate.json` (`--session 9`), with staging's deploy recorded and four tooling paths.
