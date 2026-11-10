# D-14 — Error code list

**Date:** 2026-11-10

**Status:** DECIDED by the session planner, recorded by the executing agent in Run 1.6

## Decision

The API returns exactly thirty error codes. Each code has exactly one HTTP status. The list lives in `packages/contracts/src/errors.ts` (`ERROR_CODES`); a handler may return no other code. Every error body is the envelope `{ "error": { code, message, requestId, operationId?, details? } }` and nothing else — an unknown key is rejected by `errorEnvelopeSchema`.

Ten codes are named literally by Documents 04 and 06 (marked ★). The other twenty are planner-assigned names for cases Document 04 §8.1 describes only by HTTP class.

| HTTP | Code                            | Meaning                                                                             |
| ---- | ------------------------------- | ----------------------------------------------------------------------------------- |
| 400  | `malformed_request`             | The request cannot be parsed: bad JSON, bad header, body or depth over the limit.   |
| 400  | `forbidden_selector`            | A machine request tried to select something a machine credential may not choose.    |
| 400  | `mixed_authentication`          | A session cookie and a bearer token arrived together.                               |
| 400  | `unsupported_history_parameter` | The history route received a parameter it does not support.                         |
| 401  | `unauthenticated`               | No valid session or token.                                                          |
| 401  | `mfa_incomplete`                | The password step passed but the TOTP step has not.                                 |
| 403  | `action_denied`                 | The caller is authenticated but may not do this.                                    |
| 403  | `origin_rejected`               | A state-changing browser request came from an origin that is not allowed.           |
| 403  | `fresh_verification_required` ★ | The action needs a TOTP verification inside the last ten minutes.                   |
| 404  | `not_found` ★                   | The resource does not exist, or the caller may not learn that it exists.            |
| 409  | `version_conflict`              | `expectedVersion` or `expectedStateTag` no longer matches.                          |
| 409  | `already_exists`                | A resource with that name already exists.                                           |
| 409  | `state_conflict`                | The resource is in a state that does not allow the action (archived, deleted, …).   |
| 409  | `key_under_review`              | The key, its environment or a parent is under review after an uncertain outcome.    |
| 409  | `environment_changed` ★         | The environment changed while a whole-environment read or import was running.       |
| 409  | `listing_changed` ★             | The listing changed since the cursor was issued.                                    |
| 409  | `idempotency_conflict` ★        | The same `Idempotency-Key` was used with a different request.                       |
| 409  | `replay_expired` ★              | The replay record for this `Idempotency-Key` has expired.                           |
| 409  | `credential_not_replayable` ★   | The credential was issued; its token is never shown a second time.                  |
| 422  | `validation_failed`             | The request parses but a field breaks a rule. `details` names the field and rule.   |
| 422  | `precondition_required`         | A required precondition is missing, for example the `Idempotency-Key` header.       |
| 429  | `rate_limited`                  | A rate limit was reached.                                                           |
| 503  | `busy` ★                        | A bounded capacity (connections, slots, concurrency) is exhausted.                  |
| 503  | `outcome_unknown` ★             | The outcome of the operation is not known. The envelope carries the `operationId`.  |
| 503  | `backend_inconsistent` ★        | A required namespace, mount, policy or role is missing or does not match.           |
| 503  | `backend_sealed`                | OpenBao is sealed.                                                                  |
| 503  | `quarantined`                   | The quarantine gate is closed. Every route except `/health` can answer this.        |
| 503  | `audit_unavailable`             | The required audit record cannot be written, so the action is refused.              |
| 503  | `dependency_unavailable`        | PostgreSQL or OpenBao cannot be reached.                                            |
| 507  | `capacity_exceeded`             | A stored-size limit (names per environment, live value bytes, disk reserve) is hit. |

## Rules

- A message never contains a secret value, a token, or the input that failed validation.
- `precondition_required` uses status 422, as the plan's table states, not 428.
- Adding, renaming or removing a code is a contract change: it needs a commit titled `contract: …` and an update of this record.

## Proof

`tests/unit/contracts/errors.test.ts`: the code set equals this table exactly; the ten ★ codes keep their statuses; the envelope rejects an unknown code, a missing `requestId` and unknown keys.

## Amends

Nothing in Documents 04 or 06. It names what Document 04 §8.1 leaves unnamed.
