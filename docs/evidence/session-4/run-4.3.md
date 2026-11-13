# Run 4.3 — Listing, history and reveal

**Result: DONE on 13 Nov 2026.** The list comes from the index and never from OpenBao. History joins OpenBao's metadata with the index's version events. Neither returns a value. A reveal reads one value under the environment's lock and releases it only after its `secret.reveal` audit row is committed.

FR-1.21 SPIKE_PASS — product code, real stores: pages under a signed cursor that carries the metadata generation; bytewise order; literal prefixes; deleted and in-review names listed with their state; answers with OpenBao unreachable (`list.test.ts`, 11).
FR-1.26 SPIKE_PASS — product code, real stores: who wrote each version and its last delete or undelete, at most twenty, no value and no canary in the body (`history.test.ts`, 7); delete, undelete and restore made by the fixture until Run 4.4.
AC-1.12 SPIKE_PASS — product code, real stores: boundary names and values written through create and read back through the operator client and through reveal with equal digests (`create.test.ts`, `reveal.test.ts`).

`FR-1.22` stays `OPEN`: its browser half is Run 7.x. The server half is proven here: `reveal.test.ts`, 11.

## What was done

- **Contract** (`contract: secret list, history, reveal`): bodies of `secrets.list`, `secrets.history` and `secrets.reveal`. The list prefix follows the secret-name pattern. Pending snapshot reduced; `openapi.json` regenerated.
- **Task A** (`feat(secrets): list from the index and version history`):
  - Repository: `listIndex` (rows and generation in one statement) and `versionEvents`.
  - `@mykey/operations`: `readHistory`, and `backendRefusal` (the pre-read mapping, now shared).
  - Handlers `secrets.list` and `secrets.history`.
  - The pipeline answers a query on a route that has no query schema and lists `unsupported_history_parameter` with that code.
  - Fixture: `seedIndex` and `unseedIndex`.
- **Task B** (`feat(secrets): reveal under the environment lock, audited before release`): `revealSecret`, the handler, `inTransaction` moved into `lock.ts`, and D-37. The fixture's answers carry their headers.

## Commands and results

| Command                                                                 | Result                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `vitest --project unit tests/unit/contracts` after the contract change  | 67 passed                                                                                                                       |
| `list.test.ts`, `history.test.ts` before the handlers                   | 17 failed, 1 passed (RED: the terminal 404; the passing case is the contract's 422 for bad prefixes)                            |
| the same after                                                          | 18 passed                                                                                                                       |
| `reveal.test.ts` before `revealSecret`                                  | 10 failed (RED)                                                                                                                 |
| the same after                                                          | 10 passed; with the boundary-value case added for AC-1.12, 11 passed                                                            |
| `tests/integration/secrets` + routes-mounted + `authz` + `factors-http` | 14 files, 168 passed                                                                                                            |
| `pnpm run check`                                                        | exit 0 (after formatting `authorization-matrix.md`, which the matrix test rewrites unformatted, and one unused-assignment lint) |

## Deviations and decisions

- **History's main case** makes delete, undelete and restore through the fixture (backend change, version event, index, counters): those routes arrive in Run 4.4, which proves the same case through them.
- **Reveal body shape.** `{ version: "1" }` is `400 malformed_request` and `{ version: 0 }` is `422` (Doc 06 §9 as the pipeline applies it). The plan said 422 for all three; `1.5` is accepted as either.
- **The admission recheck** of a reveal is the same callback the mutations use (`recheckOf` in the API), not a `recheckAccess` in `@mykey/operations`. This follows Run 4.2's ruling: the route state table stays in one place.
- **A reveal whose audit write fails** asks the lock's session `SELECT 1` to tell an audit failure (`audit_unavailable`) from a lost session (`dependency_unavailable`). `appendAudit` reports both as `AuditUnavailable`.
- **A name in review with no backend history** (an uncertain create) answers an empty version list instead of a backend refusal.

## Open issues

- `secrets.history` lists `key_under_review` and never sends it: a key in review answers 200 with its state (D-37).
- The matrix test writes `authorization-matrix.md` unformatted, so every run that executes it needs a `prettier --write` before `check`.
