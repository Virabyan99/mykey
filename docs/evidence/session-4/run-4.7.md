# Run 4.7 — Import

**Result: DONE on 14 Nov 2026.** Import works end to end on the integrated product: preview, apply entry by entry through the mutation protocol, resume, and settlement through the child after an unknown outcome. It is truthfully non-atomic: every entry ends with one of seven outcomes, and a resumed import never writes an entry twice. Scope valve 3 was not needed. Decisions: D-39.

FR-1.35 SPIKE_PASS — preview classifies under the lock, compares values in memory only and writes nothing to the backend: `tests/integration/imports/preview.test.ts` (14).
FR-1.36 SPIKE_PASS — apply and resume entry by entry, seven outcomes, `partial` when not every entry applied: `apply.test.ts` (11), `resume.test.ts` (6).
AC-1.39 SPIKE_PASS — an unknown entry stops the import as uncertain and is settled through its child; killed processes leave a truthful parent: `apply.test.ts`, `tests/fault/secrets/imports.test.ts` (3).
PO-17 SPIKE_PASS — no entry is written twice: one audited OpenBao change per child in every resume and fault case.

## Commits

| Commit    | What                                                                                        |
| --------- | ------------------------------------------------------------------------------------------- |
| `e3c9053` | `contract: import preview` — the 200 body; the backend group in the error list              |
| `63d945e` | `feat(import): preview` — classify, preview, the large-request gate, dotenv bodies as bytes |
| `534107b` | `feat(import): apply entry by entry through the mutation protocol` — sweep and settlement   |
| `07fd283` | `feat(import): resume` — the route, and the fault file                                      |

## What was built

- **`classifyEntries`** (pure): `create`, `update` with the row's version and tag, `unchanged`, `conflict`, `invalid` (without its name), `duplicate`.
- **Preview** (`@mykey/operations` `previewImport`):
  - the parse comes first;
  - under the lock: the recheck, the slot, the rows, the counters; live values read eight at a time and compared in constant time;
  - the capacity projection;
  - one transaction for the preview row and `import.preview`.
- **Apply** (`applyImport`):
  - acceptance in one transaction: parent, claim, file HMAC, entries, intent audit;
  - then each entry as a child `secrets.create`/`secrets.update` with key `<parent>:<ordinal>`.
- **Resume** (`resumeImport`): the owner's own parent, the same file, `awaiting_input` → `executing`.
- **The sweep** moves stale import parents (`uncertain` with an unresolved child, else `awaiting_input`) and removes dead previews.
- **`reconcileOperation`** settles a child of an import, and in the same transaction its entry, the rest (`not_attempted`) and the parent. Given the parent's id, it settles the parent's uncertain child.
- **The API.**
  - `apps/api/src/large.ts` is a gate of two large requests per process; a third is `503 busy`.
  - `routes/imports.ts` holds the three handlers.
  - The body reader hands a dotenv body over as its exact bytes.
  - `intentOf` puts a byte body into the fingerprint as its SHA-256 digest; canonicalising 1 MiB byte by byte took 0.6 s.

## Commands and results

| Command                                                                            | Result                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `vitest --project unit tests/unit/operations/classify.test.ts` (before the export) | RED: `classifyEntries` missing → GREEN, 6 passed                                                                       |
| `vitest --project integration tests/integration/imports/preview.test.ts`           | RED 14 × 404 (no handler) → 14 passed                                                                                  |
| `vitest --project integration tests/integration/imports/apply.test.ts`             | RED 11 × 404 → 10 passed, the settlement case failed (entries left `uncertain`) → after the settlement, 11 passed      |
| `vitest --project integration tests/integration/imports/resume.test.ts`            | RED 6 × 404 → 6 passed                                                                                                 |
| `vitest --project integration tests/fault/secrets/imports.test.ts`                 | 3 passed                                                                                                               |
| `vitest --project unit tests/unit/api/{body,large,intent}.test.ts`                 | RED (missing exports; the BOM dropped; 1 MiB fingerprint 585 ms) → GREEN                                               |
| imports + reconcile + routes-mounted, `--maxWorkers=2`                             | 8 files, 79 passed                                                                                                     |
| reconcile + operations + secrets + routes-mounted (after Task B)                   | 19 files, 169 passed                                                                                                   |
| `pnpm test`                                                                        | 871 tests; two registry tests timed out at 5 s while the integration suite was loading the machine; alone 11/11 in 2 s |
| `pnpm run check`                                                                   | exit 0                                                                                                                 |

## 1,000 entries of 100 bytes

- **First run**, apply alone: 684 entries created in the 100 s budget (14.6 s per hundred), then `202 awaiting_input`.
- **With resume**: `202 awaiting_input → 202 awaiting_input → 200 succeeded`, 1,000 created, 220 s in all (22.0 s per hundred).
- **Cost per entry.** About 150–220 ms on this workstation (Windows, Docker): a lock connection, a metadata pre-read, three transactions, the write, the read-back and the parent's heartbeat. An import of a full environment needs about two resumes here. The web workspace (Run 7.x) must offer the resume.

## Deviations and decisions

All are recorded in the ledger, and the ones that matter are in D-39.

- **A dotenv body is bytes, not text.** The decoder dropped a byte-order mark, and the HMAC must bind the exact bytes.
- **1,001 entries** within the byte limit answer `200 applicable: false` with `too_many_entries`. 1 MiB + 1 byte is `400 malformed_request`. Both happen before any backend read: the test closes OpenBao.
- **A live name** whose backend value is missing or at another version during preview sends the key to review and answers `backend_inconsistent`, as reveal does.
- **A rejected child is final.** A child admitted and then rejected gives the entry `rejected`; a refusal by the recheck leaves the entry for a resume.
- **All conflict or rejected → `partial`.** An import whose entries are all `conflict`/`rejected` ends `partial`, not `rejected` as Doc 06 §8 says (D-39).
- **The warnings field is `kind`**, as the plan writes it here and at export, mapped from the library's `reason`.
- **No `recheckAccess` exists.** Preview takes the handler's recheck, as reveal does.
- **The authorization matrix test** rewrites `docs/evidence/session-4/authorization-matrix.md` without formatting each time it runs. The content was identical every time, and it was restored from Git.

## Open issues

- **Throughput.** 150–220 ms per entry on the workstation; staging is not measured yet (gate run).
- **The health suite's `afterAll`** timed out once while 11 integration files ran at once. It passes alone in 41 s; this is load, not the import.
