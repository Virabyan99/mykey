# D-33 — Projects and environments: replayable operations, keyset lists, no deletion

**Date:** 2026-11-13

**Status:** DECIDED in the Session 3 plan (P-58, P-59), recorded by the executing agent in Run 3.9. Evidence: `tests/unit/operations/replay.test.ts`, `tests/unit/api/cursor.test.ts`, `tests/integration/resources/{projects,environments,listing,readiness,no-delete}.test.ts`, `docs/evidence/session-3/run-3.9.md`.

## Decision

- **Every mutation route** (`idempotent` in the contract) requires an `Idempotency-Key` that is a UUID (`422 precondition_required` otherwise). After authentication, validation, visibility and action, the pipeline looks the key up: the operation's unique key is (principal, action = route id, target = the deepest id of the path, key). Found with the same intent → its stored outcome is answered with the status it had (201 or 200; 202 while unfinished) **before** the state and freshness checks, so a completed request replays even after its scope was blocked; found with another intent → `409 idempotency_conflict`.
- **The intent fingerprint** is HMAC-SHA-256 under the `replay-fingerprint` ring over the canonical JSON of principal, action, target and the validated body (sorted keys, NFC strings), stored with its key id and compared under that key id. Never in an answer.
- **One transaction per mutation:** `beginOperation` (insert-or-find on the unique key; a concurrent first request with the same key waits and then replays or conflicts) → for a create, the organization's `resource_generation` is raised first → the admission recheck under locks (parents `FOR SHARE`, the renamed row `FOR UPDATE`) → the repository call → the operation `succeeded` with its `result` and a replay expiry of 30 days → audit (`project.create|rename`, `environment.create|rename`, details: the name's length in code points, never the name) → commit. A taken name rolls everything back: `409 already_exists`, nothing of the operation remains. Lock order matters: a share lock later raised to an update lock deadlocked two creates (organization row) and two renames (the renamed row) in the race tests.
- **A project create** also creates its `development` environment, both `pending`, and one system operation `environment.provision` with its outbox row; **an environment create** the same for one environment, under a `pending` or `active` project. The provisioner (D-32) makes them active; the first verified environment activates its project.
- **Names:** the contract's schemas (project names NFC, 1–64 code points, no control characters, not only spaces; environment names `^[a-z][a-z0-9-]{0,62}$`); uniqueness is the database's, exact after NFC (`Api` ≠ `api`, spaces count). A rename changes the name only; a rename to the current name is `unchanged` (200, no audit row).
- **Lists** are keyset pages in id order (50 by default, 100 at most). The first page reads the organization's `resource_generation` and signs it into the cursor with the route, the scope and the filter (`cursor-mac` ring); a later page whose generation moved is `409 listing_changed`; a cursor that fails its MAC, belongs to another route or scope, or does not parse is `400 malformed_request`. Renames do not move the generation. A member sees the projects of its grants (an environment grant shows its project) and, in a project without a project grant, only its granted environments.
- **No deletion:** no route has `DELETE`, no repository function deletes a project or an environment, and neither runtime role holds `DELETE` on those tables.
- Migration `0009_resource_generation`: `organization.resource_generation` (the API may update it), and `created_at` on `project` and `environment` (the lists need it; it did not exist).

## What would change this decision

- Archive and reactivate (Run 5.3) add `revoking`/`archived` transitions; they reuse the same mutation frame.
- A listing filter (Run 4.3) puts the filter into the cursor's binding, which the cursor already carries.
