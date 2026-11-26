# Run 11.7 — The documents: `automation.md`, both credential kinds, the new limits said plainly

**Date:** 26 Nov 2026. **Branch:** `session-11`. Spec §2.4; D-80 to D-83.

## What was done

- **`docs/runbooks/automation.md`** (new): what an automation credential is and is not, issue, store, the ten routes with one `curl` example each, the rules a client must keep, rotate, revoke, and after a restore.
- **`machine-credentials.md`:** a section "Two kinds" with the table of when to choose which, and a section "Runtime credentials": issue, store, the exchange, inventory, what a revocation does in the product and in OpenBao (as measured in Run 11.3), archive, restore, reconcile, rotation. The token block is untouched.
- **`known-limits.md`:** the plan's nine lines, and five more that the session's decisions left:
  - an automation secret with the right to manage runtime credentials reads its chain's values in two steps;
  - revoking an automation credential stops nothing it made;
  - a writer of the database alone can move a project into a chain and undo a revocation;
  - the API sees every automation secret presented to it;
  - the workspace names a project's chain only to an owner or an admin.
- **`restore.md`:** what the restore does to both kinds, and the owner's one issuance per chain after the opening.
- **`credential-custody.md`:** two rows, names and places only.
- **`consumer-local.md`, `consumer-deploy.md`, `start-here.md`, `README.md`:** one sentence and a pointer each. `apps/web/src/connect/runbooks.ts` was generated again.
- **The agent guide:** a part "A server that runs longer than 30 days" in section 8, and the runtime credential's lifetime among the limits. `llms.txt` is unchanged.
- **`limits.md`:** one line that said "from Run 11.5" in the future now says what is enforced.

## Commit

- `docs: automation.md, both credential kinds, the new limits said plainly`

## Commands and results

| Command                                                                                         | Result                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `tests/unit/runbooks/automation.test.ts` and `guide.test.ts` against the documents as they were | 10 failed as intended (the two tests of `machine-credentials.md`, seven limit lines, the guide's new part) |
| `tests/unit/runbooks`, `tests/unit/agents`, `tests/unit/web`                                    | 19 files, 249 tests passed                                                                                 |
| `pnpm test` (unit)                                                                              | 144 files, 1656 tests passed                                                                               |
| `pnpm run check`                                                                                | green                                                                                                      |
| CI on the draft pull request (#27), after Run 11.6's push                                       | green (`check` and `secret-scan`)                                                                          |

## What the new tests hold

`tests/unit/runbooks/automation.test.ts`:

- the rights table of `automation.md` is `AUTOMATION_RIGHTS`, in the contract's order;
- its `curl` examples are the ten automation routes of `ROUTES`, each once, with its method;
- every example reads the secret from the file, sends a key with a change, and names no host but the example's;
- the step that stores the secret is the token step itself under five replacements;
- every limit `automation.md` and `machine-credentials.md` name is `LIMITS`'s;
- `known-limits.md` holds the nine lines;
- no runbook, guide, `llms.txt` or README holds anything of a client secret's or an automation secret's shape, with a control.

`tests/unit/agents/guide.test.ts`: the guide's new part names `LIMITS`'s numbers, sends the agent to `store-token`, and holds no command.

## Deviations and decisions

- **The automation secret is stored by the token command, with its file and its words changed.** A simpler `read` would show a pasted second line. `token-step.test.ts` now lets that one block hold `stty` too, and `automation.test.ts` proves it to be the token block under five replacements. The token block's own bytes and its test are unchanged.
- **`tools/agent-runner` still holds `cli-v0.1.2`'s files.** They are copies of a release, and `cli-v0.2.0` is built in Run 11.8: they move there.
- **"`cli-v0.1.2` given a runtime credential exits 77" is stated as what follows from two rules,** and the line says so: the released `0.1.2` was not run against one.
- **The production line names `host-v0.10.0`,** not the release production runs. The plan's `host-v0.9.3` was not built: Run 11.1 is deferred.
- **The guide's new part is a part of section 8, not a section of its own:** the guide's tests name sections by number.

## Open issues

- **`node scripts/web-runbooks.ts --check` reports "stale" on this branch and on its parent.** The formatter rewrites the generated module, and the flag compares bytes. Nothing runs the flag: `tests/unit/web/connect-commands.test.ts` compares the module's two texts with the runbooks, and it is green. Not changed in this run.
- **The download steps of the consumer runbooks name `cli-v0.2.0`,** which exists from Run 11.8.
- **The staging journey of the new documents** (`test:consumers`) is Run 11.8's.
