# Run 7.6 — Import, export, first-run guide (D08-S35)

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Requirements:** FR-1.31 to FR-1.37, FR-1.89 (the guide). **Decision:** D-60 (P-138).

## What was done

- **The client sends a file** (`api/client.ts`): a route whose body is a dotenv file gets the file's bytes as they are. `import.preview`, `import.apply` and `import.resume` are sent by `callSecret`.
- **Import** (`screens/import.tsx`): a file is chosen or its text pasted. The bytes are read once into a ref of the screen and removed from the form. They are sent for the preview and again for the apply, and dropped when the server has answered the apply and whenever the screen goes.
  - A file over 1 MiB is refused in the form, with the limit and the file's size, and nothing is sent.
  - The preview shows the server's classification per name and its counts, the format's problems by line and rule, and the loader warnings. It holds no value.
  - Apply uses one idempotency key per preview.
  - The result names every entry with its outcome and says how many were written, how many were unchanged and how many were not. The state is the server's word: `succeeded`, `partial`, `awaiting input`.
  - An import the server stopped is listed under "Imports waiting for their file" (from `operations.list`), with Resume. Resume asks for the same file again and says the page did not keep it. Another file is refused by the server, and the page says what that refusal means.
- **Export** (`api/export.ts`, `screens/export.tsx`): behind the typed confirmation and a fresh code (the step-up dialog of Run 7.2; the owner then asks again). The page reads the whole answer, compares the number of bytes with `content-length` and their SHA-256 with `content-digest`, and only then offers "Save the file". Until it is saved the file is in the forgetting holder. Saving goes through a `blob:` address that is revoked right after. An answer that did not arrive whole is "incomplete. Nothing was saved".
- **The guide** at `/help` (`screens/help.tsx`): six steps from an empty workspace to a started application, each naming its screen or its runbook, and a reference list with `/v1/reference`. No address, token or value of any deployment.
- **The navigation** says "Import and export" for the screen that now holds both.

## Commit

- `feat(web): import, export and the first-run guide`

## Commands and results

| Command                                                                                            | Result                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm exec vitest run --project browser tests/browser/import-export.test.ts`                       | red first: 8 failed (no screen); then 8 passed                      |
| `pnpm exec vitest run --project browser tests/browser/shell.test.ts tests/browser/secrets.test.ts` | 16 passed (rerun: the navigation and the client changed under them) |
| `pnpm test`, `pnpm run check`                                                                      | 1425 passed; `check` green                                          |

CI after Run 7.5's push: green in 2 min 10 s (`check` and `secret-scan`).

## Deviations and decisions

- **A file with an invalid name has no preview of its other entries.** The plan's first test expected "8 new, 2 changed, 1 unchanged and 1 invalid". The server's parser refuses the whole file for an invalid name: the answer has the problem with its line and rule, and no entry. The test asserts that (line 12, `invalid_name`, no Apply), then previews the same file without that line as 8 new, 2 changed and 1 unchanged, and applies it: exactly ten keys are written and the unchanged one keeps its version.
- **The export has no end marker; the page checks the digest.** `dotenv-format-v1.md` defines none. The server sends `content-digest` (SHA-256 of the body), and the page checks that and the length. A cut answer whose headers survive is caught by the digest.
- **No per-entry progress while an import waits.** An operation in `awaiting_input` carries no result. The page shows the state and the operation id; the entries appear with the final answer. What was written so far is visible in the secrets list.
- **Resume lives in a list, not on the result.** The page does not keep the file, so after a reload the only way back to a waiting import is the server's list of unfinished operations.
- **Runbooks are named by path.** The workspace serves no documentation, so the guide shows `docs/runbooks/<file>` as text. The test checks that every such file exists.
- **Export and import share the screen at the `import` address.** The page table of Run 7.1 has no address for an export and is not changed.
- **One more test than the plan:** the 1 MiB refusal in the form.

## Open issues

- A waiting import can be resumed only by the member who started it (the server's rule). Another member sees nothing of it on this screen; an operator sees it in the operations list (Run 7.8).
- The export's file is kept for 30 seconds before it must be saved. An owner who waits longer exports again, which writes a second audit row.
