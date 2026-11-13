# Run 4.4 — Delete, undelete and restore

**Result: DONE on 14 Nov 2026.**

- **Delete** soft-deletes the current version.
- **Undelete** brings back the same version with a new tag.
- **Restore** writes an older version's value as a new version, also over a deleted current version.
- A stale tag changes nothing.
- After every step of a key's life, the environment's live bytes, name count and generation are exact.

FR-1.27 SPIKE_PASS — product code, real stores: delete under the protocol (`delete.test.ts`, 8).
FR-1.28 SPIKE_PASS — product code, real stores: undelete returns the same version (`undelete.test.ts`, 4).
FR-1.29 SPIKE_PASS — product code, real stores: restore as a new version, over a deleted current version too; deleted and trimmed sources are 409 (`restore.test.ts`, 7).
FR-1.32 SPIKE_PASS — no route and no runtime client method destroys or deletes metadata (`tests/unit/contracts/no-destroy.test.ts`, 2). The runtime policy's denial of `kv/destroy` and metadata deletion is proven on real OpenBao by the authority matrix (Run 2.1).
AC-1.15 SPIKE_PASS — local stack, two API processes: delete × delete, delete × update and undelete × restore races each give exactly one 200, one 409 and one backend change (`delete.test.ts`).
PO-7 SPIKE_PASS — product code, real stores: state tags and cas under the protocol across create, update, delete, undelete and restore.

The staging proof of these routes follows with Run 4.5's deploy (plan, Run 4.4 "Registry").

## What was done

- **The protocol's plan is per action.** Each action has:
  - **One change:** `kvWrite`, `kvSoftDelete` or `kvUndelete`.
  - **Its read-back:** the new version's envelope carries the operation id; the metadata shows the version current and deleted; the version reads again and gives its length.
  - **Its finalize:** final state, kept byte count, counter change, version event.
- **Checks shared by the versioned actions** (`versionedRow`), in order: `not_found`, `key_under_review`, `state_conflict`, `version_conflict` with details. Each action then checks the pre-read and capacity as P-74's table says.
- **Restore's source** is read under the lock before admission, and the value stays in memory only. Restore's audit rows carry `sourceVersion`. A `sourceVersion` at or above `expectedVersion` is `422` in the handler.
- **Handlers** `secrets.delete`, `secrets.undelete`, `secrets.restore`. D-36 gained the paragraph on delete and undelete without a backend marker.
- **Fixture:** `act(env, name, kind, expected, opts)`.

## Commands and results

| Command                                                                       | Result                                                                                                                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.test.ts -t "already deleted"`                                         | passed at once: it records OpenBao's behaviour (a repeated soft delete and an undelete of a live version answer ok), not product code                                 |
| `delete`, `undelete`, `restore`, `lifecycle` before the code                  | 18 failed (RED: the terminal 404)                                                                                                                                     |
| the same after                                                                | 17 passed, 1 failed: the test expected 400 for a missing `confirmed`; the pipeline answers 422 (Zod reports a missing literal as a rule, not a type) → test corrected |
| `tests/integration/secrets` + `client.test.ts` + routes-mounted               | 13 files, 118 passed (create, update, reveal unchanged by the refactor)                                                                                               |
| the history case through the routes (Run 4.3's promise), in `restore.test.ts` | passed                                                                                                                                                                |
| `no-destroy.test.ts`; the AC-1.15 race cases in `delete.test.ts`              | passed **at once**: written after the code, to back the registry claims; never seen RED                                                                               |
| `tests/integration/secrets` after the lint edits                              | 11 files, 83 passed                                                                                                                                                   |
| `pnpm run check`                                                              | exit 0                                                                                                                                                                |

## Deviations and decisions

- **AC-1.15's title** is "race lifecycle mutations across processes". The plan tied it to restore over a deleted version. The race cases were added so that the status rests on what the title says.
- **Order of checks:** a state conflict is decided before a version conflict, as for update. Two deletes with one tag therefore give one 200 and one `409 state_conflict`.
- **Missing `confirmed`** is 422 like `confirmed: false`, as the plan said; the test's first guess was wrong.

## Open issues

- Delete and undelete have no backend marker. An uncertain delete or undelete is settled by the reconciliation of Run 4.5, which needs the rule D-36 now states.
