# Run 4.9 — Human export

**Result: DONE on 14 Nov 2026.**

- `export.create` returns the environment as a dotenv attachment, read completely under the lock (Run 4.8), with the `secret.export` row committed before the bytes leave.
- The file survives an export → import → export round trip byte for byte, both locally and on staging.
- The authorization matrix holds on the real handlers.
- On staging, 1,000 names (7 MiB) export in at most 19.8 s, so inline authentication stays (D-34).
- Decisions: D-37, new section "Export"; D-34, new paragraph "The bound".

FR-1.37 SPIKE_PASS — export of an environment as a dotenv attachment: `tests/integration/export/export.test.ts` (10), `tests/unit/api/export-headers.test.ts` (3), `tests/staging/export.staging.test.ts` (3).
AC-1.17 SPIKE_PASS — the round trip is byte-identical: `tests/integration/export/roundtrip.test.ts` (2), `tests/staging/export.staging.test.ts` ("round trip on staging").

## What was built

- **Route `export.create`** (`apps/api/src/routes/export.ts`): `human_fresh_totp`, `{ confirmed: true }`, inside the large gate.
  - It calls `readEnvironment` with the audit row `secret.export {names}`.
  - The body comes from `serializeDotenv`; the headers come from `exportHeaders` (D-37 "Export").
- **Pipeline:** `HandlerResult.raw {bytes, contentType}` is allowed only on a `dotenv-attachment` route; on any other route it answers `output_invalid`. The pipeline sets `content-type` and `content-length`.
- **Harness:**
  - `publicRequest` (staging) takes a `text` body and returns `bytes`.
  - The live matrix test `tests/integration/authz/matrix-live.test.ts` (P-80).
- **CI:** the integration job runs in two shards by file (ruling below).
- **Runbook** `network.md`: the API build command now carries `--build-arg MYKEY_BUILD=…`. Without it the image refuses to start (finding below).

## Commands and results

| Command                                                                                                        | Result                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export/export.test.ts` (written before the handler)                                                           | RED                                                                                                                                                                                                                                                                 |
| the same after                                                                                                 | 10 passed. **The 8 MiB export (1,000 × 8,388 bytes) took 5.72 s.**                                                                                                                                                                                                  |
| `export/roundtrip.test.ts`                                                                                     | 2 passed: twelve awkward values (including 64 KiB, four-byte characters, CRLF and a trailing backslash) survive byte for byte; an export above 1 MiB is refused by the import body limit (`400 malformed_request`, the known limit)                                 |
| `export/surfaces.test.ts` (two API processes, one provisioner)                                                 | 1 passed. Six canaries (created, updated, restored, revealed, imported, exported) appear in their responses only: in no API or provisioner log, `pg_dump`, PostgreSQL log or OpenBao audit device. Positive controls: names in the dump, paths in the audit device. |
| mutation: a value logged in the export handler                                                                 | `surfaces` failed (exported canary in the API log); restored                                                                                                                                                                                                        |
| `authz/matrix-live.test.ts`                                                                                    | 1 passed in 119 s: 15 routes × 8 cells, with allow, denied and hidden all present                                                                                                                                                                                   |
| mutation: `authorizeOperation` no longer hides another member's operation                                      | failed: five `operations.get` cells answered 200 instead of the 404 of a random id; restored                                                                                                                                                                        |
| `authz/matrix.test.ts`                                                                                         | unchanged                                                                                                                                                                                                                                                           |
| `pnpm run check`                                                                                               | exit 0                                                                                                                                                                                                                                                              |
| staging deploy: `push`, `image api`, `image provisioner`, `db-init` (applied nothing), `up`, `probe.ts deploy` | first API image refused to start (finding); rebuilt with `MYKEY_BUILD=81a9aea56f0a` (`sha256:94dce22f…`), provisioner `sha256:12dbdd82…`; gate open, `reviewOpen: 0`, `operationsUnresolved: 0`                                                                     |
| `vitest --project staging tests/staging/export.staging.test.ts`                                                | 3 passed in 231 s                                                                                                                                                                                                                                                   |

**The live matrix (P-80).**

- The cells: 15 routes (the eight `secrets.*`, the three `import.*`, `export.create`, `operations.get`, `operations.list`, and `environments.list` as the unchanged control), by the seven members in environment 1a, plus `envEditorA` in 1b.
- The expectation comes from `decide` on current rows. For `operations.get` it is the operation scope's rule applied to the owner's operation: a manager or the author may see it.
- Allowed → a valid request prepared for that member answers 2xx.
- Denied → `403 action_denied`.
- Hidden → a 404 equal to the 404 of a random id.
- Every cell that is not allowed writes no operation row for that member. It also makes no KV change in A's namespace while its request runs. Positive control: the allowed writes are counted.
- No difference was found.

## Staging (14 Nov 2026, UTC)

Project `s4-export-0162944e` (`3082a30a-2e78-4746-b254-603f24c7bb4d`). It stays, because projects cannot be deleted. Environments:

- `development` `3c96e49d-1e54-4eb4-8d58-200a11480cc1`
- `copy` `5bd73f3d-9556-4c4b-8bd1-15277921dcfd`
- `full` `f3a8e3da-377b-45e3-b3b5-e090e22f8f1d`

Numbers are in `run-4.9-staging.json`.

- **Through the edge:**
  - `content-length` equals the body (66,408 bytes) and `content-digest` verifies;
  - with `Accept-Encoding: gzip, br`, the answer has no `content-encoding`;
  - `cache-control: no-store`;
  - the 20 names parse with equal digests.
- **Round trip:** 20 names, `development` → import into `copy` (20 `created`, `succeeded`) → export. The two files have the same length and digest.
- **The measurement of P-62:**

  | Step                                                                    | Result                                                                    |
  | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
  | 8 imports × 125 entries of 7 KiB (preview to final answer)              | 9.8, 13.1, 9.2, 9.2, 9.1, 9.7, 9.4, 9.1 s; none answered `awaiting_input` |
  | 3 exports of the 1,000 names (7,182,000 bytes, through the public name) | 10.6, 18.8, 19.8 s; equal digests                                         |
  | the ceiling                                                             | 60 s. The slowest export is 19.8 s, so the fallback is **not taken**      |

- **Alert window:** 09:35:44–09:43:46.
  - `health_failing` opened at about 09:38:26 and resolved at about 09:43:26 (both delivered).
  - Cause: the first API image restarted in a loop (finding below), not a product fault.
  - The test run ran from 09:43:58 to 09:47:51 with no alert.

## Findings and rulings

- **Deploy (mine):** I built the API image without `--build-arg MYKEY_BUILD`. The runbook's command left it out. The container logged `startup_refused {missing: MYKEY_BUILD}` and restarted for five minutes, longer than the probe's grace, so the probe raised an alert. The runbook is fixed, and the rebuilt image started at once.
- **CI:** run `43578932232`'s integration job hit its 30-minute limit after 89 of 98 files had passed, none failed. This session's bulk tests made the suite longer (the 1,000-entry import with resume takes 220 s alone). **Ruling:** two shards by file (`vitest --shard`), each with 30 minutes, instead of a longer timeout. Cost if wrong: a file that depends on another file's state fails in one shard, and the split is undone.
- **Ruling:** `operations.get` in the live matrix uses the owner's operation. The author path for members is covered by Run 4.1.

## Not done here

- The canary sweep on staging is Run 4.10 Step 5.
- The 1,000-entry import of 100 bytes through the public name is Run 4.10 Step 5.
