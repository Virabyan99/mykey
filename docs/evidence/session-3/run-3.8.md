# Run 3.8 — Organization provisioning

**Result: DONE on 13 Nov 2026.** The operator provisions an organization's namespace with compare-then-act and a read-back; killed at any of 39 points and run again it ends with one correct namespace; the provisioner process provisions environments and sweeps for drift; on staging the organization is active, and a machine policy removed with the root token sent its environment to review, answered `503` to the owner and raised the probe's `review_open`, which resolved once the drill was undone.

FR-1.08 SPIKE_PASS — product code, real stores: one operation id however often `provision-organization` runs; `tests/integration/provisioning/organization.test.ts` (13) and `tests/fault/provisioning/boundaries.test.ts` (39 kill points + 1).
FR-1.12 SPIKE_PASS — product code, real stores: environments provisioned by the provisioner process, compare-then-act, killed at 11 points, two workers, foreign object, lost credential, OpenBao away, gate closed (`environment.test.ts`, 7).
FR-1.55 SPIKE_PASS — product code, real stores: drift sweep per scope, one audit row per detection, nothing changes while OpenBao is away (`drift.test.ts`, 7); staging drill.
AC-1.06 SPIKE_PASS — product code, real stores: every kill point followed by a clean run ends active with one namespace, every object equal to the plan, one accessor per role and only the last credential working.
AC-1.09 SPIKE_PASS — staging: machine policy deleted → `needs_review` within a sweep, owner's `secrets.list` `503 backend_inconsistent`, `environments.list` still answers, `reviewOpen` +1, probe `review_open` opened and resolved (`tests/staging/provisioning.staging.test.ts`, 5).
PO-4 SPIKE_PASS — product code, real stores, staging: the API holds no provisioner or root credential, the provisioner reaches only PostgreSQL and OpenBao, every AppRole is bound to its container's address (the runtime credential is refused from the tunnel), and the skeleton test proves neither process reaches `@mykey/openbao/admin`.

## What was done

- **Task A** — M13: `kvRead(path, 0)` refused before any request, `revoke-self` a change (5xx → unknown); D-17 amendment. Provisioner policy reads the three organization policies, `sys/mounts/kv`, `kv/config` (authority matrix regenerated, 935 cells). Admin: bound AppRoles, `readAppRole`, `readRoleId`, secret-id accessor list/destroy, namespace/mount/config/auth reads, `putKvConfig`, `mountKvOnly`, `deletePolicy`. `@mykey/openbao/provisioner`: `ProvisionerClient` with `Answer` results.
- **Task B** — `@mykey/operations/operator`: `organizationPlan`, `configDigest`, `provisionOrganization`, `verifyOrganization`; `ops provision-organization` / `verify-organization`; `provisionTestOrganization` in the harness; audit actions `operator.organization_provision`, `system.environment_provision`, `system.drift_detected`.
- **Task C** — `apps/provisioner` (worker, sweep, health check, Dockerfile); `@mykey/operations/provisioner` (`provisionEnvironment`, `sweepOrganization`, `sweepAll`); the gate reader moved to `@mykey/operations`; migration `0008_provisioner_jobs`; the pg-boss adapter passes multi-statement results through; the API self-check; the probe's `review_open`; skeleton rules.
- **Task D** — compose service `provisioner`, credential delivery over SSH, bound addresses, the `provisioner_runtime` password on the host, `status.sh` `reviewOpen` and `provisioner`, the heartbeat's `reviewOpen`, `probe.ts` through `redact` (M4), `MYKEY_SWEEP_SECONDS` by `host.ts up`, the staging owner harness (`stagingOwnerSession`), four public-name checks in `api.staging.test.ts`.
- Docs: `provisioning.md`, `credential-custody.md`, `custody-map.md`, `probe.md`, D-32, the D-17 amendment.

## Commits

- `feat(openbao): provisioner reads for verification, bound AppRoles, M13`
- `fix(auth): reset completion locks the account before its token`
- `feat(ops): durable organization provisioning with read-back`
- `feat(provisioner): environment provisioning worker and drift sweep`
- `feat(hosts): provisioner service, credential delivery, review status`
- `build: the provisioner and the policy templates in the image context`
- `fix(provisioner): write grant for its sweep state; status reads the review count …`
- `fix(hosts): the provisioner reaches OpenBao by its certificate name; the sweep log counts unread organizations`
- `feat(hosts): provisioner on staging, review alert through the heartbeat` (this commit, with the docs and this note)

## Staging window

Announced alerts: `health` during restarts, `review_open` during the drill. Window 13 Nov 2026 08:57 – 09:45 UTC. API image `e3447192754f` (`sha256:90d0242b…`), provisioner image `5396210` (`sha256:e9d34c0b…`); `db-init` applied `0005`–`0008`; probe Worker redeployed; `ops provision-organization --organization e2350312-420b-4fde-84c5-d582a008080b` → `active`, operation `722c0c63-715f-4a8e-9600-185d746ebaeb`; `verify-organization` → `equal`; `up`; gate open throughout. `review_open` opened and resolved three times (the first failed drill, the stopped drill, the passing drill).

Synthetic drill rows (organization `e2350312-…`), kept for Run 3.10, all `active`:

| Project                                | Environment                            | History                                                                                                |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `c8fc2ce3-eb5e-45a1-8726-5a30bac1b420` | `8aa9a53b-7294-4bbf-888e-741cac54d638` | ended `provisioning_failed` (wrong OpenBao URL), re-driven to `active` after the fix                   |
| `f537f8aa-fd54-4d60-b976-4472487d497d` | `aed7291d-e7f5-4455-bea7-643445354df9` | drill stopped at the probe check (test read the wrong field); policy put back and set `active` by hand |
| `ea6aa148-2a11-4dee-9089-f7af91b8c81f` | `7e7f6828-08de-4c95-95a4-7489ca00cc12` | the passing drill                                                                                      |

The staging owner enrolled TOTP through the public name on first use; seed, recovery codes and last step are in `~/.mykey/secrets/hosts/staging/` (0600).

## Commands and results

| Command                                                        | Result                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `client-answers.test.ts` M13 cases before the fix              | 2 failed (RED)                                                                           |
| `vitest --project integration tests/integration/openbao`       | 6 files, 49 passed                                                                       |
| `organization.test.ts`                                         | 13 passed                                                                                |
| `tests/fault/provisioning`                                     | 40 passed; without destroying old accessors: the `secret-ids:after-effect` point fails   |
| `pnpm run test:integration` (after Task B)                     | 57 of 58 files; `reset-race` deadlock (fixed, then 3 of 3 green)                         |
| `environment.test.ts`, `drift.test.ts`                         | 7 and 7 passed; the sweep treating "unreachable" as drift fails the OpenBao-stopped case |
| database + jobs + provisioning + selfcheck                     | 12 files, 163 passed                                                                     |
| `pnpm test`                                                    | 813 passed                                                                               |
| `tests/staging/provisioning.staging.test.ts` before the deploy | 2 failed (organization `provisioning`, no provisioner)                                   |
| the same after                                                 | 5 passed                                                                                 |
| `tests/staging/api.staging.test.ts`                            | 12 passed                                                                                |
| `pnpm run check`                                               | exit 0                                                                                   |

## Deviations and decisions

- Migration `0008_provisioner_jobs` is new (not in the plan); Run 3.9's `resource_generation` becomes `0009`.
- M13 tests live in `client-answers.test.ts` (the stub TLS server needs the stack's certificate).
- `createOrgFixture` is not rebuilt on `provisionOrganization` (staging and the fault-effects suites use it without a database); a test proves its namespace verifies equal to the plan.
- `ProvisionResult` gains `refused` and `busy`; a KV mount with OpenBao's fresh defaults is configured, any other difference is a mismatch.
- Operator provisioning sits behind `@mykey/operations/operator`, the provisioner's code behind `@mykey/operations/provisioner`, so neither the API nor the provisioner reaches `/admin`.
- The fault test of the environment job re-sends the job after a kill (the queue would hand it out again only after pg-boss's 15-minute expiry).
- The Task A tests of the admin calls and the provisioner client were written after the code; commit `5cbc043` carried the staged move of the gate reader without its API re-export (fixed in the next commit).

## Findings

- OpenBao 2.7.2 reads `secret_id_bound_cidrs` back as written but `token_bound_cidrs` with a `/32` as the bare address.
- With Run 3.1's rights a failing job stayed `active` for ever (pg-boss's failure path and supervisor need more); and the pg-boss adapter returned no rows for multi-statement texts.
- The reset initiation and completion could deadlock (opposite lock order), seen once in the full integration run.
- On staging: Node's permission model refused the provisioner's state file (a directory grant does not cover files created later); `status.sh`'s psql needed the superuser password on the local socket; the provisioner's OpenBao URL must be the certificate's name (`openbao`), not the address.

## Open issues

- A job held by a killed provisioner waits for pg-boss's expiry (15 minutes) before it is handed out again.
- The environment's reconciliation is a superuser step until Run 4.5.
- The obsolete workstation copy of the `provisioner_runtime` password (`~/.mykey/secrets/hosts/<host>/provisioner_runtime`) may be shredded.
