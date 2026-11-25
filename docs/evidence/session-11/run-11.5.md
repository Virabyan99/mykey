# Run 11.5 — The automation credential (D-82)

**Date:** 25 and 26 Nov 2026. **Branch:** `session-11`. P-191 to P-194, D-82.

## What was done

- **The owner issues, lists and revokes automation credentials** (Task A). `automation_credentials.issue` needs a fresh second factor and shows the secret (`mkac.<id>.<secret>`) once; the list shows rights, networks, expiry, last use and the number of projects the chain manages; a replayed issuance never shows the secret again.
- **The automation auth class** (Task B). The bearer is the secret and nothing else. A request is recognised by its row and its verifier, which covers the row's chain, rights and networks. Then: state, expiry and source networks; the credential's own 120 requests a minute; the path; the right.
  - A project is reachable only when the caller's chain manages it. Everything else is one 404: another chain's project, a person's, an absent id, a text that is no id.
  - A withheld right is `403 action_denied`.
  - A secret nobody can attribute is 401 with no audit row and counts as a miss of its source.
- **The ten routes** (Task C). A change by automation is the person's handler with a machine actor: the same protocol, operation, audit action and idempotency rule. A project made by automation is managed by its maker's chain.
  - Automation reads names, versions and times, never a value; runtime credentials, never a 30-day token; its own chain's operations.
  - Inside every change the credential, its right and the project's chain are read again.
- **The generic script** `tests/fixtures/automation/tenant-provisioner.ts`, written against the HTTP contract alone: `provision` and `reissue`. One key per step; an unknown outcome is settled by reading the operation.
- **A restore revokes both new kinds** (Task D). `restoreInvalidate` revokes the rows of both credential tables in its transaction, and `restore-verify` counts both. One automation credential issued with `replaces` takes the chain up again, and the script re-issues a runtime credential for every environment.
- **D-82** records the design, the rights table, the 404 rule, what a revocation leaves, and what a holder of the secret can do.

## Commits

- `feat(automation): the owner issues, lists and revokes automation credentials`
- `ci: the exchange test's synthetic token is assembled at run time`
- `feat(api): the automation auth class — rights, managed projects, one 404`
- `feat(automation): projects, environments, secrets and runtime credentials by automation`
- `feat(restore): both new kinds are revoked, and one credential brings the consumers back`

## Measured (the owner's workstation, the integration stack; `measurements.json`)

- **One tenant by the script:** 6.3 s. The project 60 ms, the environment 54 ms, 2.0 s until the provisioner had built the environment, 25 secrets 4.1 s (about 165 ms each), the runtime credential 37 ms. One request per change.
- **Recovery after the restore's revocation:** three tenants, six environments. From the owner's one issuance to the last server's resolve: 2.8 s, six runtime credentials.

## Commands and results

| Command                                                                                                  | Result                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/automation/issue.test.ts`, before the handlers                                        | 11 failed as intended (the terminal 404)                                                                                                    |
| `tests/integration/automation/boundary.test.ts`, before the auth class                                   | 10 of 11 failed as intended (the terminal 404)                                                                                              |
| `tests/integration/automation/provisioning.test.ts`, before the ten handlers                             | failed as intended (the script's first step: `404 not_found`)                                                                               |
| `tests/integration/automation/recovery.test.ts`, before the restore's step existed                       | failed as intended (`fn is not a function`)                                                                                                 |
| `tests/integration/automation` (four files)                                                              | 4 files, 37 tests passed (11, 11, 14 and 1)                                                                                                 |
| Task B's walk run: automation, authz, api, limits, capture barrier, reference, machine and others        | 32 files: 31 passed; `routes-mounted` had 10 stale cases, fixed and rerun green (14 tests)                                                  |
| Task C's proof run: automation, secrets, resources, imports, operations, credentials, machine, the walks | 70 files, 636 tests passed                                                                                                                  |
| `tests/integration/restore` whole (five files)                                                           | 5 files, 33 tests passed; with the automation statements taken out, `invalidate` and `verify` each failed in their new case, and only there |
| `pnpm test` (unit)                                                                                       | 143 files, 1630 tests passed                                                                                                                |
| `pnpm run check`                                                                                         | green                                                                                                                                       |
| CI on the draft pull request (#27)                                                                       | green after Task B's push (`check` and `secret-scan`); red once before it, for the secret scan below                                        |

## Deviations and decisions

- **The changes by automation are the person's handlers themselves,** not copies. The handler takes its actor and its recheck from the request. One function cannot drift from itself.
- **An operation is "the caller's own" at the level of the chain.** A replacement can settle an operation its predecessor left unknown.
- **The plan's 428 is the contract's 422** (`precondition_required` has one status).
- **"With OpenBao stopped" is tested with the protocol's fault after the send.** A stopped OpenBao before the send is `dependency_unavailable`: nothing was sent, so nothing is unknown.
- **Recovery is proven twice, at two sizes.**
  - `recovery.test.ts` applies the restore's credential step (`revokeEveryCredential`, the function `restoreInvalidate` runs) to a product with three provisioned tenants. The whole command cannot run against a live fixture: it expects a restored pair, deletes every session and rotates every AppRole.
  - `tests/integration/restore/full.test.ts` restores a pair into a new cluster and a new OpenBao, goes through the owner's recovery and the gate, and then: the lost automation credential is refused, a new chain manages nothing, one credential with `replaces` manages the lost one's project again, and the script's runtime credential is exchanged and read.
- **`counts.credentials` of the invalidation is the sum of both tables.** The report's shape is unchanged.
- **The secret scan went red once** (commit `603fe27`): a synthetic token-shaped literal in a unit test. It is assembled at run time now, and the old commit's fingerprint is in `.gitleaksignore` with its reason. No real value was involved.
- **Three walks changed their expectation of this class twice:** 404 for everyone (Run 11.2), then 401 for a session (Task B), then handlers (Task C).

## Open issues

- **A staging restore drill of the new kinds is not in this session** (D-80's cut 7). The integration suite's restore is local.
- **Two residuals for `known-limits.md` (Run 11.7):** a holder of an automation secret with `runtime_credentials.manage` can read its chain's values in two audited steps; a writer of the database alone can move a project into a chain.
- **The workspace does not show any of this yet** (Run 11.6), and the runbook `automation.md` is Run 11.7's.
