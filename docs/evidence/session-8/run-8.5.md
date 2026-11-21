# Run 8.5 — Independent review

_20 Nov 2026. Plan: `docs/plans/session-8-plan.md`, Run 8.5 (D-06, P-153)._

## What was done

**The review commit** is `7494401adeda38be90a62617c6ef3eb2012c5bfb`, the commit of Run 8.4 Task A. Before the reviewers started, everything of Runs 8.0, 8.2 and 8.4 Task A was pushed, and the draft pull request's run on it was green.

**Six reviewers, started in one message.** Each was a fresh context on the most capable model. Each got:

- its area, its paths and its negative tests;
- `docs/runbooks/known-limits.md`;
- the rules of Doc 10 §4.1, copied;
- its questions (reviewer 4 also got the text of D-66);
- the form of the answer;
- the three limits: read only, run nothing, reach no host.

They got nothing else: no plan, no run note, no opinion.

**Sent back once.** Every reviewer listed paths of its area as unread, or read only by title. Each was sent back to them once with `SendMessage` (P-153), not replaced. Every second answer is saved under the first, in the same file. Reviewer 6 reports one breach of the limits: in its second pass it ran a single read-only `cat` of repository files. The command wrote nothing and reached no host, and it printed what the file tools would have shown, so its findings are unaffected. This is recorded in `review-6-edge.md`.

**The six files.** Each holds the text as it came, then `## Disposition` with one row per finding.

| file                   | area                                  | Critical | High | Medium | Low |
| ---------------------- | ------------------------------------- | -------- | ---- | ------ | --- |
| `review-1-auth.md`     | auth and sessions                     | 0        | 0    | 2      | 3   |
| `review-2-mutation.md` | mutation and reconciliation           | 0        | 0    | 1      | 10  |
| `review-3-tokens.md`   | token issuance and revocation         | 0        | 0    | 2      | 5   |
| `review-4-backup.md`   | backup, restore and the gate          | 0        | 0    | 6      | 9   |
| `review-5-cli.md`      | the CLI                               | 0        | 0    | 3      | 7   |
| `review-6-edge.md`     | the edge, the hosts, the supply chain | 0        | 0    | 1      | 10  |

There are 15 Mediums. Two pairs are one defect each, R1-2 with R4-1 and R2-7 with R3-3. **No Critical or High.**

**What the reviewers confirm.** Answers of "none found":

- No secret value, token or reset link reaches the edge's log, the heartbeat, the probe's state or an alert (6).
- No replay is readable by someone who may not read it (2).
- No write lands without its version and state tag (2).
- Nothing is reported done before the backend confirmed it (2).
- No read returns part of a set (2).
- Nothing says "revoked" before OpenBao has proven it (3).
- No pair becomes eligible without its checks (4).
- Retention never deletes the newest eligible pair (4).
- No workflow hands a secret to code from a pull request (6).

**The two questions carried from Session 7:**

- **"The action was not performed" on `audit_unavailable`:** true for the requested action, on every path reviewer 2 read. A review mark can land without its audit row (R2-4).
- **What the edge's log holds:** page paths, so secret names, and nothing else of value. Reset tokens travel in the fragment; machine and session tokens travel in headers and cookies, which are not logged (6, answer 3).

**M1 (P-148).** Reviewer 3 rates the custody root token Medium and says it does not block real, non-critical secrets (R3-1). So D-65 stands: no root token per use is made in Run 8.6. Gate R's report names it above the signature line.

**The list for Run 8.6** (Step 1: every Critical and High, and a Medium whose fix is under half an hour):

- **R1-1:** an attempt is counted against the account when it is admitted.
- **R1-2 / R4-1:** after a restore, only an `mfa` reset; fixed in the reset path, not in `restore*`.
- **R5-1, R5-2 and R5-3,** with the Low **R5-4**: one new CLI version.
- **R6-6:** the Worker refuses a version 1 heartbeat. A Low, taken because the fix is cheap and removes a false "resolved".
- **R4-12, and the false statements behind R6-1:** wording.

**Accepted, and named in Gate R's report:**

- R2-1, R3-1 and R3-2;
- R4-2, R4-3, R4-4 and R4-10 (restore code, P-150; carried to Session 9);
- R4-5 and R6-1.

Every other Low gets a line in `known-limits.md`.

## Commits

- `docs: six independent reviews`: the six review files and this note.

## Commands and results

- `gh run list --branch session-8 --limit 2`: the draft run on the review commit, and the run after it, are both `success`.
- Reviewers: six in one message, then one `SendMessage` to each for its unread paths. Nothing was run by me on their behalf.
- `pnpm run check`: green.

## Deviations and decisions

- **Every reviewer was sent back, not only those that skipped a path.** Each listed some given paths as unread or read only by title. P-153 sends back "a reviewer that did not read a path it was given", so all six went back once.
- **Reviewer 6's `cat`:** recorded, and not treated as a reason to redo the review. It ran only on the working tree's own files, so the read-only intent of the limits held.
- **Severities:** none changed. Each stands as the reviewer gave it (P-153).
- **CLI fixes in one version.** R5-1, R5-2 and R5-3 are each under half an hour, so Step 1 takes them. Their cost is the new CLI version and its three proofs (P-145). R5-4 rides along at no extra proof cost.

## Open issues

- Run 8.6 makes the fixes above, test first, one commit per finding, then a fresh reviewer reads `git diff 7494401..HEAD`.
- The known-limits lines of every accepted finding are written in Run 8.6 Step 1.
- Carried to Session 9 with the restore drill (Run 9.7): R4-2, R4-3, R4-4, R4-7, R4-10, R4-13 and R4-14.
