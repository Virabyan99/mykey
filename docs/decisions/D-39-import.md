# D-39 — Import

**Date:** 2026-11-14

**Status:** DECIDED in the Session 4 plan (P-76, P-77), recorded by the executing agent in Run 4.7. Evidence: `tests/unit/operations/classify.test.ts`, `tests/integration/imports/{preview,apply,resume}.test.ts`, `tests/fault/secrets/imports.test.ts`, `docs/evidence/session-4/run-4.7.md`. Scope valve 3 was **not** taken: resume is built.

## Preview

- **What happens.** The file is parsed first; a file the parser refuses answers `200 applicable: false` with its issues and stores nothing. Then, under the environment's lock:
  - the caller's access and the states are read again;
  - the index rows of the file's names and the counters are read;
  - when the caller may read (`decide` for `secrets.read`), the current value of every live name is read, eight at a time, and compared with the file's value in memory, in constant time.
- **Classifications:** `create`, `update` (with the row's version and tag as the precondition), `unchanged`, `conflict` (deleted, in review, or the key an occupied slot names), `invalid` (returned without its name), `duplicate`. An `invalid` or `duplicate` entry, or no entry at all, means not applicable: nothing is stored.
- **Capacity.** A 1,001st projected name, or projected live bytes above 8 MiB, is `507 capacity_exceeded` with the limit named.
- **Stored.** One transaction stores the preview and its `import.preview` audit row. The preview holds names, lines, classifications, versions and tags, plus the HMAC of the exact bytes (`HMAC-SHA-256(key, "import-file" ‖ 0x00 ‖ bytes)` under the replay-fingerprint ring). It holds no value, no digest of a value and no length. It expires after 900 s on database time.
- **Bytes.** The dotenv body reaches the handler as its exact bytes, a byte-order mark included. UTF-8 is still checked by the body reader.

## Apply

- **Acceptance** is one transaction:
  - the parent `import.apply` is inserted, `executing` under this process;
  - the caller's own, unexpired, unclaimed preview of this environment is claimed;
  - the file's HMAC is checked under the preview's key;
  - the entries are copied into `app.import_entry`;
  - `import.apply` is audited as intent.
- **Refusals at acceptance** roll everything back, leaving no parent and the preview unclaimed: another member's or another environment's preview is `404`; expired or already applied is `409 state_conflict`; other bytes are `422`.
- **Entries** are applied one at a time. `unchanged` and `conflict` touch nothing. `create` and `update` each run as a child of the mutation protocol, keyed `<parent>:<ordinal>`. The child takes and drops the lock itself, so the lock is free between entries.
- **Outcomes** (seven): `created`, `updated`, `unchanged`, `conflict`, `rejected`, `uncertain`, `not_attempted`.
  - A key that moved since the preview is `conflict`: version or tag changed, a name now exists, a key in review, or the slot of this key.
  - Capacity is `rejected`, and so is a child that was admitted and then rejected, because its key would only replay that rejection.
  - A refusal before admission leaves the entry without an outcome. Examples: busy, the slot of another key, sealed or unreachable backend, the gate, lost authority or a state.
- **The answer.**
  - When the request's budget is spent (the large deadline less 20 s, 100 s), the parent becomes `awaiting_input` and the answer is `202`.
  - An unknown child stops the import: entry and parent `uncertain`, `503 outcome_unknown` with the parent's id.
  - With no entry left: `succeeded` when every outcome is `created`, `updated` or `unchanged`, otherwise `partial`, with the outcomes as the result.
- **Large requests.** Preview, apply and resume share a gate of two per process; a third is `503 busy` and is never queued.

## Resume, the sweep, settlement

- **Resume** accepts only the caller's own parent in this environment; anyone else, the owner included, gets `404`.
  - It takes the same file (the HMAC check) and claims `awaiting_input` → `executing` under a new executor. A concurrent resume gets `202`.
  - Entries keep the preview's preconditions, so what changed in between becomes `conflict`.
  - A child that already finished replays through its key; no entry is written twice.
- **The sweep.** A stale `import.apply` parent becomes `uncertain` when a child is unresolved; that child's entry is marked `uncertain` and `system.operation_stuck` is audited. Otherwise it becomes `awaiting_input`. The sweep also removes previews that expired unclaimed or whose import has finished.
- **Settlement.** An uncertain import is settled through its child. `reconcile-operation` accepts the child or the parent id. In the same transaction:
  - the entry takes the verdict (`created`/`updated`, `rejected`, or `uncertain` when closed unknown);
  - the rest become `not_attempted`;
  - the parent is settled `succeeded` or `partial`.
- **No resume after uncertainty.** The owner previews the file again; what was applied shows as `unchanged`.

## Deviations from the plan and Doc 06

- An import whose entries are all `conflict` or `rejected` ends `partial`, not `rejected` as Doc 06 §8 says for "a fully no-effect rejected import". A rejected envelope carries only its error code and would hide the per-entry outcomes.
- 1,001 entries within the byte limit are not a body-limit refusal. They answer `200 applicable: false` with the parser's `too_many_entries` issue, before any backend read.
- An audit failure at preview answers `dependency_unavailable`, because `audit_unavailable` is not in `import.preview`'s error list.
