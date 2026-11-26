# D-82 — The automation credential: three rights, managed projects, one 404

**Date:** 2026-11-26

**Status:** DECIDED (P-191 to P-194; Run 11.5), on the owner's answers 3, 4, 5 and 7 of `docs/evidence/session-11/owner-requests.md` (D-80). Evidence:

- `docs/evidence/session-11/run-11.5.md`, `measurements.json`;
- `tests/integration/automation/{issue,boundary,provisioning,recovery}.test.ts`;
- `tests/integration/limits/machine.test.ts` ("automation"), `tests/integration/authz/matrix.test.ts`, `tests/integration/isolation/cursors.test.ts`;
- `tests/integration/restore/{invalidate,verify,full}.test.ts`;
- `tests/unit/contracts/routes.test.ts` (no automation route reads a value or removes anything);
- `tests/fixtures/automation/tenant-provisioner.ts` (the generic script).

## Context

Until Session 11 every project, environment, secret and credential was made by a person in the workspace. A platform that gives each of its tenants a project needs a script to do that, and the script must hold something. A person's session is the wrong thing: it reads values, it deletes, and it needs a second factor. D-80 adds a second non-human principal beside the runtime credential (D-81): one that provisions and can never read.

## Decision

1. **An automation credential is a row of its own table and a verifier** (D-81's construction).
   - The secret is 32 random bytes, presented as `mkac.<credential id>.<43 characters>`, shown once in the answer of its issuance.
   - The verifier is made over the secret **and** the organization, the chain, the rights (in the contract's order) and the bound networks. A row whose rights were widened, whose networks changed or whose chain moved no longer verifies: it is nobody's.
   - Nothing is created in OpenBao, and OpenBao is not asked when the credential is presented.
   - The owner or an admin issues it with a fresh second factor, lists it and revokes it (`automation_credentials.*`). It lives 1 hour to 365 days, 7 days by default, and is bound to 1 to 8 source networks (D-83).
2. **It is a machine actor** (P-191). Its operations have `principal_kind = 'machine'` and its audit rows `actor.kind = 'machine'`, both with the credential's id. A secret's history names it the same way. A runtime credential it issues has `issuedByKind: "automation"` and `issuedBy` the credential.
3. **Its rights are three** (P-192). At least one is chosen at issue; reading comes with any.

   | Right                        | Routes                                                                                                        |
   | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
   | `projects.create`            | `automation.projects.create`, `automation.environments.create`                                                |
   | `secrets.create`             | `automation.secrets.create` (create-only: an existing name is `409 already_exists`)                           |
   | `runtime_credentials.manage` | `automation.runtime_credentials.issue`, `.list`, `.revoke`                                                    |
   | any                          | `automation.projects.list`, `automation.projects.get`, `automation.secrets.list`, `automation.operations.get` |

   **What no right gives,** because no route exists: reading a value or a digest of one, updating or deleting a secret, renaming, archiving, issuing or revoking a 30-day token, seeing a member, the audit or another automation credential.

4. **A project is managed by a chain, not by one credential** (P-193).
   - `project.managed_by` holds the chain: the id of its first credential (`owner_id`). A project made through `automation.projects.create` is its maker's chain's. A project a person made is managed by no chain.
   - A credential issued with `replaces` joins the chain of the credential it names, whatever that one's state. Without it, a credential starts a chain of its own.
   - Both then manage the same projects. That is rotation without an outage, and it is recovery after a restore (below).
5. **Everything outside the chain's projects is one 404** (rule 5).
   - `:project` must be a project of this organization that the caller's chain manages, and `:env` an environment of that project. An operation must be one a credential of the chain made.
   - Another chain's project, a project a person made, an id of nothing and a text that is no id are answered with the same status and the same body. Each is audited as `access.denied` with reason `hidden`.
   - Only then is the route's right looked at: `403 action_denied`, reason `action`.
6. **The request's order** is a person's, with another caller: the bearer and its row (a miss counts against the source, with the tokens nobody can attribute); state, expiry and source networks; the credential's own 120 requests a minute; the capture step; validation; the path; the right; the idempotency key and the replay; capacity; the states.
   - A secret nobody can attribute is `401` with a log line and no audit row (D-42). A recognised credential that is revoked, expired or outside its networks is `401` and audited.
   - **Inside every change the check is made again** (FR-1.10): the credential's row, its right, the project's chain and the states, in the change's own transaction. A credential revoked, or a project taken from the chain, after the pipeline looked changes nothing.
7. **A change by automation is the person's handler with a machine actor.** The same protocol, operation record, idempotency rule, audit action and `outcome_unknown` (rule 3). An unknown outcome is settled by reading `automation.operations.get`, never by sending the change again under a new key.
8. **Automation routes name the project and the environment by id** (P-194) and live under `/v1/automation`, with no `:org`: the organization is the process's own (D-34).

## What revocation leaves

- **Revoking an automation credential stops that credential.** Its next request is `401`.
- **It leaves everything the credential made:** the projects stay managed by the chain, the secrets stay, and every runtime credential it issued keeps exchanging. A leaked provisioning secret is revoked without stopping one server.
- **To stop a server, revoke its runtime credential** (the owner, or a credential of the chain with `runtime_credentials.manage`).
- **A chain with no active credential manages its projects still.** Nobody can act for it until the owner issues a credential with `replaces`. The owner keeps every right over the projects throughout.

## After a restore (spec §4)

- **A restore revokes both new kinds with every other credential** (D-55): `restoreInvalidate` revokes the rows of `app.machine_credential` and of `app.automation_credential` in one transaction, and `restore-verify`'s check `credentials_all_revoked` counts both tables.
- **Recovery costs the owner one action per chain:** issue one automation credential with `replaces` naming the lost one. Its holder lists the chain's projects and issues a runtime credential for every environment (`reissue` in the generic script), with no further person.
- **Measured** (local stack, three tenants of 25 secrets, six environments): see `measurements.json`, `automation_recovery_seconds`.
- A staging restore drill of the new kinds is not in this session (D-80's cut 7). The integration suite restores a pair into a new cluster and a new OpenBao and runs this recovery behind the reopened gate (`tests/integration/restore/full.test.ts`).

## What a holder of the secret can do, and cannot

- **Can:** make projects and environments up to the organization's limits, write new names into environments of its chain's projects, issue and revoke runtime credentials there. A runtime credential it issues reads the values of that environment. **So a holder of an automation secret with `runtime_credentials.manage` can read every value of its chain's projects, in two steps.** The first step is audited (`credential.issue`, a machine actor) and shows in the owner's inventory. It is why the right is separate and the networks are mandatory.
- **Cannot:** reach a project a person made or another chain's, whatever its rights; read a value with the credential itself; change or remove what exists; act from outside its networks; outlive its expiry.
- **A writer of the database alone** cannot make a credential or widen one (the verifier needs the ring and covers the rights, the chain and the networks). It can undo a revocation or an expiry, as for a runtime credential (D-81), and it can move a project into a chain by writing `managed_by`. Both are lines of `known-limits.md` (Run 11.7).

## Consequences

- **The owner's inventory is the control.** The list shows each credential's rights, networks, expiry, last use and the number of projects its chain manages.
- **Updating an existing secret by automation and assigning an existing project to a chain are not built** (D-80's cuts). A value is changed by a person; a tenant's secret is replaced by writing a new name.
- **No error code, no dependency and nothing in OpenBao was added.** The authority matrix is unchanged.

## Amends

Doc 04 and Doc 06, by addition only (D-80): no existing route, body or right is changed.
