# D-37 — Reading secrets: list, history, reveal

**Date:** 2026-11-13

**Status:** DECIDED in the Session 4 plan (P-67, P-73), recorded by the executing agent in Run 4.3. Runs 4.8 (complete reads) and 4.9 (export) add their sections. Evidence: `tests/integration/secrets/{list,history,reveal}.test.ts`, `docs/evidence/session-4/run-4.3.md`.

## List

- **Source.** The list answers from `app.secret_index` only. It never calls OpenBao and takes no lock, so it answers while OpenBao is unreachable.
- **Items.** Exactly `{ name, version, stateTag, state, changedAt }`. Names in state `deleted` and `needs_review` are listed with their state.
- **Order and prefix.** Order is bytewise (`COLLATE "C"`). The `prefix` follows the secret-name pattern and is matched literally (`starts_with`), so `_` and `%` are never wildcards. `db`, `D%` and the empty string are `422`.
- **Pages** are signed cursors: route, scope `org/project/env`, the prefix, the last name, and the first page's `metadata_generation`. `listIndex` reads rows and generation in one statement, so both come from one snapshot. A write in between is `409 listing_changed`. A cursor of another route, environment or prefix is `400 malformed_request`.

## History

- **Source.** One `kvMetadata` read and one read of the version events, joined. No lock, no value. A version's `written` is its event with a write action (create, update, restore). A version written past the product has `{ action: null, actor: unknown }`. `lastChange` is the newest delete or undelete of that version.
- **At most twenty versions**, newest first: what OpenBao keeps. After 21 writes, version 1 is gone.
- **States.** A key in review answers `200` with its state, because metadata stays visible (Doc 04 §1.2). `key_under_review` in the route's error list is therefore unused.
- **Drift.** History judges no drift: a difference between the index and the backend is for the next writer under the lock to find. A failed metadata read goes through `backendRefusal`: `sealed`, `denied` (environment to review, drift audited), or otherwise `dependency_unavailable`. A name in review with no backend history (an uncertain create) answers an empty version list.
- **Query.** Any query parameter is `400 unsupported_history_parameter`. The pipeline answers it for any route that has no query schema and lists that code.

## Reveal

- **Under the environment's lock**, on the lock's connection:
  1. **Transaction:** the caller's access and the states re-read (the same recheck as a mutation); the slot; the index row. A slot blocks a reveal only when its operation names this key or no key (P-67): `409 key_under_review` with its `operationId`. No row → `404`. In review → `409 key_under_review`. Deleted, with no version asked → `409 state_conflict`. A version above the current → `404`.
  2. **One backend read:** the latest version for the current value, or the version asked for. A requested version that is gone (deleted, destroyed, trimmed) → `409 state_conflict`. For the current value, the backend's version must equal the index's, and the envelope must be format 1; otherwise the key goes to review and the answer is `503 backend_inconsistent`.
  3. **Second transaction:** the row's tag is checked again, and `secret.reveal` (`{ name, version }`, outcome `success`) is committed.
- **Only after that commit does the value leave the function.** If the audit write fails while the lock's session still answers → `503 audit_unavailable`. If the session is gone → `503 dependency_unavailable`. Either way the value is dropped and nothing is audited.
- **The answer** is `{ name, version, value, stateTag }` with `cache-control: no-store`. A denied caller leaves `access.denied` and no `secret.reveal`.
- **Body shape.** `{ version: "1" }` is `400 malformed_request` (wrong type); `{ version: 0 }` is `422`.

## Complete read (Run 4.8)

`readEnvironment` (P-78, FR-1.84) answers every live value of one metadata generation, or nothing. The environment's lock is held for the whole read, on the lock's connection. A writer of that environment waits two seconds for it and answers `503 busy`.

1. **Transaction:**
   - the caller's access and the states are read again;
   - any slot → `409 key_under_review` with its holder's `operationId`;
   - every index row is read, and a row in review → `409 key_under_review`;
   - the generation `G` is taken.
2. **The backend's list** of the environment's names (`kvList`; `not_found` is the empty set) must equal the index's names, live and deleted alike. A deleted name is still listed by the backend and is no drift. A difference sends the environment to review, is audited as `system.drift_detected` (`kv_data`), and is answered `503 backend_inconsistent`.
3. **Every live value,** eight at a time. Each must carry the index's version, be a format-1 envelope, and have the index's byte length; otherwise the key goes to review and the answer is `503 backend_inconsistent`. Any other failed read ends the whole read through `backendRefusal`. Nothing partial is ever returned.
4. **Size.** Values plus names plus 64 bytes per entry above `completeResponse.maxBodyBytes` → `507 capacity_exceeded { limit: "response" }`.
5. **Transaction:**
   - the generation must still be `G` and no slot held, else `409 environment_changed`;
   - the caller's audit row is written through the `audit` callback and committed.
   - If the audit write fails while the session answers → `503 audit_unavailable`. If the lock session is lost → `503 dependency_unavailable`. The values are dropped in both cases.

**Measured** (workstation, Run 4.8):

- 1,000 names of 8 KiB read in 5.3 s.
- The race run, where every read equals the set of its generation exactly, is in `docs/evidence/session-4/run-4.8.md`.

**Fallback.** The fallback of Doc 10 §8.1 (refuse while any write is in flight) was not needed.

## Export (Run 4.9)

`export.create` (P-79, FR-1.37) is the complete read with a file around it.

- **Who and when:** a human with a fresh TOTP (`human_fresh_totp`), `{ confirmed: true }`, the action `secrets.read`. It runs inside the large gate (two per process; a third answers `503 busy`).
- **Read:** `readEnvironment` with the audit row `secret.export` (the names, never a value), committed before a byte leaves. Every refusal of the read answers as JSON, and no value is in it.
- **Body:** `serializeDotenv`: one `NAME="escaped"` line per live name, in bytewise name order. An empty environment answers 200 with length 0.
- **Headers** (`exportHeaders`):
  - `content-type: text/plain; charset=utf-8`;
  - `content-disposition: attachment; filename="mykey-<name>.env"` (lower case, `[^a-z0-9-]` → `-`, at most 63 characters);
  - `content-length`, and `content-digest: sha-256=:<base64>:`;
  - `x-content-type-options: nosniff` and `cache-control: no-store`;
  - `mykey-export-warnings`: base64url JSON of the loader warnings `{ name, loader, kind }`, cut to `{ truncated: true, count }` above 8,192 bytes.
- **No compression:** the API never sets `content-encoding`, and the edge adds none, even when the request accepts `gzip, br` (staging, Run 4.9 Task D).
- **Raw answers** (`HandlerResult.raw`) are allowed only on a route whose response is `dotenv-attachment`. Elsewhere they answer `output_invalid`.
- **Known limit:** an export above 1 MiB cannot be imported again (the import body limit), and the import refuses it as `400 malformed_request`.
