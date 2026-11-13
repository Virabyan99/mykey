# Run 4.6 — Fault suite

**Result: DONE on 14 Nov 2026, except Step 4's run inside the whole integration suite (see below).** The secret protocol passed every fault case of the suite: real API processes killed at each of its six points for each of the five actions, answers held, requests held and released, connections cut, PostgreSQL and OpenBao restarted, sealed and stopped, a process dying while another serves, a provisioner job alongside. Every case ended in a truthful state with at most one audited backend change and the index equal to the backend. No product code had to change.

AC-1.38 SPIKE_PASS — product code in real processes, real stores: `tests/fault/secrets/boundaries.test.ts` (30) and `delays.test.ts` (13).
PO-16 SPIKE_PASS — G-EFFECT for the KV actions of the product (create, update, restore, soft delete, undelete) under crashes and delays. Soft delete and undelete leave no backend marker and are settled under exclusion (D-38). The effects of Session 5 (issuance, revocation, archive) are still owed.
FR-1.82 SPIKE_PASS — a crash at any point leaves an operation the sweep and the operator settle truthfully; the client's replay tells the truth at every stage.
FR-1.83 SPIKE_PASS — at most one backend change per operation under every fault, counted in OpenBao's audit device.

## What was done

- `tests/fault/secrets/fixture.ts` (`faultFixture`):
  - a private stack;
  - the secret fixture's in-process API and one child-process API that really dies (SIGKILL in the fault hook), both behind the TLS relay;
  - helpers `prepare(env, kind)`, `child(fault)`, `settle(id, { excluded })` (Run 4.5's library call as `maintenance`), `excludeExecutors()` (kill the child, restart OpenBao), `changes(id)`, `sweepNow()`, `operationOf(name)`.
- **The TLS relay:**
  - takes a target function, so it follows OpenBao to its new port after a restart;
  - `holdRequests(on)` keeps request records and releases them later;
  - `setMode` switches to `drop` at run time.

## The boundaries table (30 cases)

Each case asserts:

- the row after the crash;
- `409 key_under_review` naming the operation for a new key, and `202` for the original key;
- the sweep's move;
- the replay after it;
- the settlement;
- the backend changes;
- the index equal to the backend;
- no value in the dead process's output.

The verdict and the change count of every row are exact assertions.

| Crash at                                                  | Actions                 | Row after the crash  | After the sweep                                          | Settlement                                                        | Changes |
| --------------------------------------------------------- | ----------------------- | -------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| `after_admission`                                         | all 5                   | accepted, slot held  | rejected, slot free; replay `503 dependency_unavailable` | none                                                              | 0       |
| `after_dispatch_marker`                                   | all 5                   | executing, slot held | uncertain; replay `503 outcome_unknown`                  | undetermined without exclusion, **rejected** with it; replay 503  | 0       |
| `after_send`, `after_read_back`, `before_finalize_commit` | create, update, restore | executing, slot held | uncertain                                                | **succeeded without exclusion**; replay 200/201                   | 1       |
| the same three points                                     | delete, undelete        | executing, slot held | uncertain                                                | undetermined without exclusion, **succeeded** with it; replay 200 | 1       |
| `after_finalize`                                          | all 5                   | succeeded, slot free | unchanged                                                | none; replay 200/201 with the operation                           | 1       |

## The delays file (13 cases)

| Case                                                                                      | Outcome                                                                                                   | Changes |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------- |
| each action: the answer held past the deadline                                            | `503 outcome_unknown` → succeeded (writes without exclusion, delete/undelete with)                        | 1 each  |
| the request held, executors excluded (child killed, OpenBao restarted), the relay lets go | after 15 s the backend is still at version 1 → **rejected**                                               | 0       |
| the request held, no exclusion                                                            | undetermined; released, the write lands → succeeded; the original key 8 × `503 outcome_unknown` meanwhile | 1       |
| the connection cut after the request went out                                             | `503 outcome_unknown` → succeeded                                                                         | 1       |
| PostgreSQL restarted between the send and the finalize                                    | `503 outcome_unknown`; sweep → uncertain → succeeded                                                      | 1       |
| OpenBao sealed before dispatch                                                            | `503 backend_sealed`, no operation                                                                        | 0       |
| OpenBao stopped                                                                           | `503 dependency_unavailable`, no operation                                                                | 0       |
| one process dies in a write to env X                                                      | the other serves env Y (201); X answers `409 key_under_review` naming it; settled succeeded               | 1       |
| a provisioner job alongside twenty updates                                                | the new environment becomes active; every update 200                                                      | 20      |

## Commands and results

| Command                                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest --project integration tests/fault/secrets/boundaries.test.ts`                              | 30 passed **at once** (312 s)                                                                                                                                                                                                                                                                                                                                                                                                                |
| the product broken on purpose: `finishOperation` without its condition (`executor_boot_id`, state) | boundaries: still 30 passed; `tests/integration/reconcile/sweep.test.ts` › "a swept executor cannot finalize" **failed** → restored (no diff)                                                                                                                                                                                                                                                                                                |
| `vitest --project integration tests/fault/secrets/delays.test.ts`                                  | 13 passed **at once** (193 s)                                                                                                                                                                                                                                                                                                                                                                                                                |
| `tests/fault/secrets` three times in a row                                                         | 43 passed each time (390 s, 339 s and the first run)                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm run test:integration`                                                                        | **not completed**: stopped by Claude Code when the workstation ran critically low on memory. Before the stop, the partial log showed failures in `fault/provisioning/boundaries` (17 of 40), `fault/secrets/boundaries` (11 of 30), `fault/effects/exclusion` (1) and `ops/bootstrap` (1), with no error text (the report was never printed). Eight private stacks were left running and were removed. Unexplained until the run is repeated |
| `pnpm run check`                                                                                   | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Deviations and decisions

- **The plan's mutation check** expected the boundaries table to catch a `finishOperation` without its condition. It cannot: an executor killed at a point never comes back to call `finishOperation`. The case that catches it is Run 4.5's "a swept executor cannot finalize", where a live executor returns after the sweep. The table proves the crash course; that test proves the late executor.
- **Every case passed at once.** The protocol of Runs 4.2–4.5 already held under these faults, so no `fix(secrets)` commit was needed.
- **"A second child-process API for answers after a crash"** is the in-process API of the secret fixture: it answers the replays while the child is dead.
- **Exclusion in the table** is the dead child itself (the only executor of the operation). `excludeExecutors()` (kill and OpenBao restart) is used where a request is still held in flight.

## Open issues

- **Step 4 is owed:** the whole integration suite with the fault suite inside it. Its partial run under memory pressure failed 30 cases in four heavy files whose errors were never printed; the secret boundaries passed three times alone. Per the plan, a case that fails only under the whole suite is a finding, so the run must be repeated (with less parallelism, or more memory) before Run 4.6 counts as done.
