# Run 4.8 — Consistent whole-environment read

**Result: DONE on 14 Nov 2026.** `readEnvironment` returns every live value of one metadata generation, or nothing. A read racing writers on two processes and an import always returned exactly the set of its generation. The fallback of Doc 10 §8.1 was not needed. Decisions: D-37, section "Complete read".

FR-1.84 SPIKE_PASS — complete read under the lock; every refusal refuses the whole read: `tests/integration/read/complete.test.ts` (13), `limits.test.ts` (3).
AC-1.41 SPIKE_PASS — race: every read equals the set of its generation exactly, five runs in a row: `tests/integration/read/race.test.ts`.
PO-19 SPIKE_PASS — G-RESOLVE, human path; machine resolve is Run 5.1.

## What was built

- **`@mykey/operations` `readEnvironment`** (`packages/operations/src/secrets/read-environment.ts`):
  - **Under the lock, first transaction:** the recheck, the slot, every index row (in review → `key_under_review`), the generation.
  - **The backend's list** compared with the index's names; a difference means drift and the environment goes to review.
  - **Live values** read eight at a time, with version and byte length checked (the key goes to review on a mismatch).
  - **The response size limit.**
  - **Final transaction:** generation unchanged and no slot, then the caller's audit row, committed before anything leaves.
- **The harness.**
  - The test-only route `test.read` (digests only; its audit row is `secret.export`, as the export of Run 4.9 writes) runs inside its own large-request gate.
  - `seedEnvironment(env, names, bytesEach)`.
  - `relay.dropAfter(n)` makes the Nth backend call fail.
  - `@mykey/api` exports `readDeps`, `recheckOf`, `refusedOf`.

## Commands and results

| Command                                                                         | Result                                                                                          |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `vitest --project integration tests/integration/read/complete.test.ts` (before) | RED: 13 failed (`readEnvironment` missing)                                                      |
| the same after the implementation                                               | 13 passed                                                                                       |
| `tests/integration/read/limits.test.ts`                                         | 3 passed; **1,000 names of 8 KiB read in 5.32 s**                                               |
| `tests/integration/read/race.test.ts`, once                                     | passed: 96 reads, 203 mutations in 49.7 s                                                       |
| the product broken on purpose: the read reports generation − 1                  | race **failed** → restored                                                                      |
| `race.test.ts` five times in a row                                              | 5 × passed: 98/203 (45.3 s), 98/203 (45.9 s), 98/203 (45.9 s), 96/203 (47.5 s), 98/203 (47.5 s) |
| `pnpm run check`                                                                | exit 0                                                                                          |

## Deviations and decisions

- **The race runs until its minimum counts.** It lasts at least the plan's twenty seconds, then until 50 reads and 200 mutations have succeeded (cap 120 s). With four readers holding the lock, the writers reach 200 mutations in about 45 s here. Below the minimum at the cap, the test fails as empty.
- **Writers own disjoint keys.** Each writer owns its own quarter of the thirty keys, so it knows each key's version and tag exactly. The import writes ten new names. A writer retries `busy` with the same key. A reader may be refused only with `busy`; nothing else was ever seen.
- **G-RESOLVE has no registry item of its own.** It is the name Doc 10 gives PO-19, so it is recorded in PO-19's note.
- **No `recheckAccess` exists** (as in Run 4.7). The read takes the handler's `recheck`.
- **The format-1 check is in the client.** A version that is not a format-1 envelope reads as `invalid` 200 in the OpenBao client and goes to review with the missing-value case, so the read has no separate format check.

## Open issues

- **The cost of the lock.** The lock is held for the whole read (5.3 s for 1,000 × 8 KiB here). Writers of that environment answer `busy` for that long. That is the design of Doc 06 §8; the staging measurement of P-62 is in Run 4.9.
