# Run 7.4 — Secrets: list, edit, reveal (D08-S34)

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Decisions:** P-138, recorded as D-60 (`docs/decisions/D-60-secrets-in-the-page.md`).

## What was done

- **`callSecret` and `SECRET_BEARING`** (`apps/web/src/api/client.ts`, `api/secret-routes.ts`): a route whose request or answer carries a secret is sent by `callSecret` only. `call` refuses such a route and `callSecret` refuses any other, by type and at run time. The reset screen's `auth.reset.complete` moved to it.
- **The source rule** (`tests/unit/web/sources.test.ts`): no listed route, no `callSecret` and no secret-bearing auth function inside anything that fills the query cache (eight functions, from `useQuery` to `setQueryData`); no `useMutation` anywhere; a control.
- **The list** (`screens/secrets.tsx`): names, state, version and last change from the index, 50 at a time in the server's order, with "More". A prefix narrows it by name and stays out of the address. A list that changed between two pages is read again from its first page, and the page says so.
- **Create:** the contract's own checks before the request leaves, each message under its field. The value field is a text area (a value may have several lines).
- **The secret's page** (`screens/secret.tsx`): state, current version and last change. The value is hidden until Reveal. A revealed value shows its version and a countdown, and is forgotten after 30 s, when the tab is hidden, on a change of address and at sign-out. A reveal that answers while the tab is hidden is not kept.
- **Copy** is its own button; revealing copies nothing. The warning now also says the copy cannot be taken back (FR-1.23).
- **Edit** sends `expectedVersion` and `expectedStateTag` of the row the form was opened on. On a conflict the form and what was typed are removed, and the page offers Reload or Cancel. Reload opens a new, empty form on the current version.
- **Refusals that changed nothing** (507 `capacity_exceeded`, 503 `busy`) leave the form and its value in place.
- **An environment that is not active** offers no write: no "New secret", no "Edit value". An archived one can still be listed and revealed.

## Commit

- `feat(web): secrets — list, edit and a reveal that forgets`

## Commands and results

| Command                                                                                                                         | Result                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/web/sources.test.ts`                                                            | red first: 2 failed (`SECRET_BEARING` did not exist) |
| `pnpm exec vitest run --project browser tests/browser/secrets.test.ts`                                                          | red first: 11 failed (no screen); then 11 passed     |
| `pnpm exec vitest run --project unit tests/unit/web`                                                                            | 155 passed                                           |
| `pnpm exec vitest run --project browser tests/browser/shell.test.ts tests/browser/auth.test.ts tests/browser/resources.test.ts` | 18 passed (rerun: the app changed under them)        |
| `pnpm test`, `pnpm run check`                                                                                                   | 1425 passed; `check` green                           |

CI after Run 7.3's push: green in 2 min 4 s (`check` and `secret-scan`).

`tests/unit/web/ephemeral.test.ts` was written in Run 7.2 with the holder and already holds the three cases this run's plan names (30,000 ms; hidden, navigated, signed out and clear; a second value restarts the time). It was not changed.

## Registry

FR-1.22 SPIKE_PASS — a value is masked until an explicit Reveal, held only by the displaying component, and gone from the page after 30 s, when the tab is hidden, on a change of address and at sign-out. No secret-bearing route goes through the query cache (`tests/browser/secrets.test.ts`, `tests/unit/web/sources.test.ts`, `tests/unit/web/ephemeral.test.ts`). A historical version's reveal is Run 7.5's; the scan of the browser's storages is Run 7.10's.

FR-1.23 SPIKE_PASS — a value reaches the clipboard only by the Copy button, and the page then says the clipboard is outside MyKey and the copy cannot be taken back. No value is in a notice or an error text (`tests/browser/secrets.test.ts`).

## Deviations and decisions

- **The server's 422 names no field.** `validation_failed` carries no details. After it, the create form shows the rule under both fields, and the edit form under its one field.
- **The secret's page reads its facts from the index** (`secrets.list` with the name as prefix and a limit of 1), not from `secrets.history`. The history is Run 7.5's and is read from the secret store.
- **The pagination test seeds index rows only** (52 names through `seedIndex`) and removes them afterwards. A list needs no value.
- **The value field is a text area**, visible while typed. A password field cannot hold several lines.
- **A 507 and a 503 keep the idempotency key** of the form (their status is 5xx). The server recorded nothing for either, so the same key sent again is a new request. The test sends the same form three times and gets 507, 503 and 201.
- **Run 7.3's open half is closed:** an active environment offers "New secret" and "Edit value"; an archived one offers neither and still reveals.

## Open issues

- Delete, undelete, restore, the history and the reveal of an older version are Run 7.5's. A deleted secret's page says only that it is deleted.
- An environment in `pending` shows its notice and no list. The server would answer a list there; nothing can be in it yet.
