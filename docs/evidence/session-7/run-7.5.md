# Run 7.5 — History, delete, undelete, restore (D08-S34)

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Requirements:** FR-1.26 to FR-1.29.

## What was done

- **The history** (`screens/secret-history.tsx`): the versions the secret store keeps, newest first, each with its time, what wrote it (created, updated, restored), who, and its state (current or earlier, deleted, destroyed, and the last delete or undelete with its actor). The actor is shown as the server gives it. A version nobody of the product wrote says "unknown" for the action and for the actor.
- **Delete and undelete** behind the typed confirmation of Run 7.3, each naming the version and the state tag the page last read.
- **Restore** from a row of the history: the confirmation names the version it copies and the version it comes on top of. The result is a new version.
- **A stale change** (409 `version_conflict`) closes the dialog and shows the same panel as a stale edit: Reload or Cancel.
- **Reveal of an older version** uses the holder of the current value (`screens/secret-value.tsx`, `useReveal`). The page shows at most one value, and it says which version it is.
- **A key under review** shows its state and the fixed text, and no button: no reveal, no edit, no delete, no restore. Its history is still shown.
- **`secret.tsx` is three files now:** the page and the edit form, the value panel, the history with its dialog.

## Commit

- `feat(web): history, delete, undelete and restore`

## Commands and results

| Command                                                                                              | Result                                                           |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm exec vitest run --project browser tests/browser/history.test.ts`                               | red first: 6 failed (no history on the page)                     |
| `pnpm exec vitest run --project browser tests/browser/history.test.ts tests/browser/secrets.test.ts` | 17 passed (6 and 11; the secret's page changed under the second) |
| `pnpm test`, `pnpm run check`                                                                        | 1425 passed; `check` green                                       |

CI after Run 7.4's push: green in 1 min 59 s (`check` and `secret-scan`).

## Deviations and decisions

- **Undelete brings the secret back at the same version.** The plan's test title said "at the next version". FR-1.28 says no new version is made, and the server does that: after delete and undelete of version 1 the secret store holds one version, not deleted. The test asserts that.
- **The history says "restored from an earlier version", without the number.** `secrets.history` gives the action `restore` and not the version it copied. The plan's test title said `restored from 1`. The page names both numbers where it knows them: in the confirmation, and in the notice after the owner's own restore ("Version 1 was restored as version 3."). The test compares the two values by revealing both.
- **The confirmations ask for the secret's name**, like an archive. The plan says "the fixed confirmation".
- **A key under review offers no reveal of an older version either.** The server refuses every value of such a key (`key_under_review`).

## Open issues

- **The source of a restore is not in the history.** The server keeps it with the operation and does not put it in `secrets.history`. Adding it is a change of the contract and of Session 4's history reader. It goes to `known-limits.md` in Run 7.9 and to the session report.
- A version written past the product leaves the index one version behind the secret store until an operator reconciles. The page then shows the index's version in the facts and the store's versions in the history. Both are what the server says.
