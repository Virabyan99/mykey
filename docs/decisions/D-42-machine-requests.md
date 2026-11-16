# D-42 — Machine requests

**Date:** 2026-11-15

**Status:** DECIDED in the Session 5 plan (P-93, P-94), recorded by the executing agent in Run 5.4. Evidence:

- `tests/integration/machine/{authentication,keys,resolve,native-scope}.test.ts`;
- `tests/integration/authz/matrix.test.ts` (the machine routes with every human session → 401);
- `tests/staging/{machine,archive}.staging.test.ts`;
- `docs/evidence/session-5/{run-5.4,native-scope}.md`, `run-5.4-staging-{machine,archive}.json`.

## Authentication (P-93)

- **A pipeline step for auth class `machine`.** It runs after the mixed-credential check and the gate, and before validation. Machine routes take no Origin check, no `authorize` (the credential's binding is the authorization), no replay and no freshness.
- **The header.** Exactly one `Authorization: Bearer <token>`. The token is 1 to 4,096 bytes of `A-Za-z0-9._-`. Anything else is `401 unauthenticated`, decided before OpenBao is asked. A cookie beside the bearer is `400 mixed_authentication`.
- **The token is asked about itself.** `lookup-self` with the presented token, in the namespace of the process's own organization, which is never taken from the request.
  - `denied` or `invalid` → 401.
  - `sealed` → `503 backend_sealed`.
  - Anything else unclear → `503 dependency_unavailable`. An OpenBao outage is never a 401.
- **The catalog.** One statement reads the credential by `(organization, accessor)`, joined to its environment, project and organization. The row must be `active`, with `effective_expires_at` in the future on database time; otherwise 401. The path's `:project` and `:envName` must be the row's own; otherwise `404 not_found`, and the answer is the same for an absent target and a foreign one.
- **Parents.** A `revoking` or `archived` project or environment → `403 action_denied`. `needs_review`, or the organization in review → `503 backend_inconsistent`.
- **Selectors.** Any query parameter, and any body key, is `400 forbidden_selector`. An empty body and `{}` pass. A machine route reads a body as JSON only to refuse it.
- **The principal.** `ApiContext.principal` stays `UserPrincipal | null`, and `ApiContext.machine: MachinePrincipal | null` is added. `MachinePrincipal` carries `{kind: "machine", credentialId, scope, reader}`, and `reader` is a client built from the presented token for this request only. Every human helper takes `UserPrincipal`, so a machine principal reaching one is a type error, not a run-time branch.
- **`last_used_at`** is written at most once a minute per credential. It is written outside the request's outcome; a failed write is logged as `machine_last_used`.
- **Audit.**
  - The product audits as `access.denied`, with a machine actor and the credential id, the denials it decides itself: a path that is not the credential's own, a catalog row that is not active or is past expiry while OpenBao still accepts the token, and a closed parent.
  - A token OpenBao refuses cannot be attributed. It is logged as `machine_unauthenticated` and writes no audit row, so an unattributable 401 cannot fill the audit table.
- The rate limit of 60 requests a minute per credential is Run 6.3's.

## Reads (P-94)

- **The presented token reads.** `EnvironmentReadRequest.reader = {client, alive}`. With it, every backend list and read of `readEnvironment` and `readEnvironmentNames` uses `client`, and `deps.bao` is never asked. A broken runtime identity does not stop a machine read; the integration test runs the API with a refused runtime secret id to prove it.
- **A denied read asks `alive()`** (one `lookup-self`), in one helper shared by the list and the reads.
  - A dead token (revoked or expired mid-request) → `401 unauthenticated`. Nothing is marked and the environment stays `active`. Without this rule, anyone holding a dead token could close an environment.
  - A live token whose policy cannot read → the drift path, as for a human read: the machine policy is broken.
- **`machine.resolve`** is `readEnvironment` inside the large gate. Its recheck re-locks the parents, then re-reads the credential `FOR SHARE` (`active`, unexpired → otherwise 401) and the gate. Its `machine.resolve` audit row (machine actor, `names` count, `generation`, no secret name) is committed before the body leaves.
- **`machine.keys`** is `readEnvironmentNames`. It takes the same lock, recheck, slot and review checks and compares the names OpenBao lists (with the presented token) with the index's. It returns the `live` names in bytewise order and reads no value. Its audit row is `machine.keys`.
- **Bodies.** Both bodies carry `apiMajor`, `environmentId`, `generation` (a decimal string, as in the human routes), `count` and `complete: true`. Each is serialized once into a buffer and sent with `content-length`, `cache-control: no-store` and no compression.
- **Current values only.** No request selects a version, so the product API never returns an older one.

## What OpenBao itself allows the token (FR-1.40, FR-1.45)

The token was used directly against OpenBao 2.7.2 (`native-scope.md`, every denial with a root control on the same path).

- **Allowed:** read and list in its own environment's path, and `lookup-self`.
- **Denied:**
  - every write, delete, undelete, destroy or metadata change;
  - every other environment, project and parent listing;
  - token creation, lookup of another token, `revoke-accessor` and `revoke-self`;
  - policies, mounts, auth, AppRole, namespaces, `capabilities-self` and identity.
- **Not extended:** `renew-self` leaves the lifetime unchanged.
- **Finding:** `lookup-self` with the token answers 200 when the request names another existing namespace or the root namespace. OpenBao resolves the token wherever it is presented and returns the token's own record (`namespace_path` = its organization's). Every read in those namespaces is 403. The plan expected 403 there; the test now asserts that the record names the token's own namespace. No secret is reachable, and no policy was changed.
- **Residual (FR-1.45):** the native policy also lets the token read older versions of a key that are not deleted (`?version=1` answers 200 directly in OpenBao). Only the product API enforces current values. OpenBao is reachable only from the service's private network. The runbook says so (`machine-credentials.md`, "What a machine token can read").

## Staging (Run 5.4 Task D)

- **The machine journey:** ten values; one issuance in 697 ms; one resolve of ten values through the public name in 287 ms, with digests equal to the owner's export. Then `keys`. After the revocation, both routes answer 401 and the accessor answers 400 on the host. The token's bytes were found 0 times in the API log, a `pg_dump` and Traefik's access log, with every control found.
- **Archive and reactivation:**
  1. A project with two environments and a token each. Before the archive, both tokens read and both accessors answer 200 on the host (the control).
  2. The project archive answered 200 `archived` with two credentials revoked, in 878 ms.
  3. Both tokens then answered 401 on both routes, and both accessors answered 400.
  4. The reactivation answered 200 `{state: "active", environments: 2}`. The old tokens were still 401, and a new token resolved 200.

## Why

- **The token is the authority, and asking the token about itself is the only check that cannot drift from OpenBao.** The catalog then binds it to one environment.
- **Reading with the token itself** means a machine sees exactly what its OpenBao policy allows, no more. A fault in the runtime identity cannot widen or block it.
- **Dead-token reads are not drift.** Otherwise revoking a token, or letting it expire, would let its holder send the environment to review.
