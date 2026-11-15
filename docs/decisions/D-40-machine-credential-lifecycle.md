# D-40 — Machine credential lifecycle

**Date:** 2026-11-15

**Status:** DECIDED in the Session 5 plan (P-85 … P-90), recorded by the executing agent. Issuance part: Run 5.1. Revocation, the sweep and `reconcile-credentials`: Run 5.2 (sections below added there). Evidence: `tests/integration/openbao/issuance.test.ts` ("token metadata, lifetime and issuer sessions"), `tests/unit/operations/credentials-verify.test.ts`, `tests/integration/credentials/{protocol,issue,inventory,surfaces,revoke,sweep,reconcile}.test.ts`, `tests/fault/credentials/{issuance,revocation}.test.ts`, `tests/staging/credentials.staging.test.ts`, `docs/evidence/session-5/{run-5.1,run-5.2,fault-table}.md`.

## The issuer identity

- The API holds the organization's `issuer` AppRole beside `runtime`. `issuerBaoFromDirectory` reads `organization-id`, `issuer-role-id` and `issuer-secret-id` from the API's secrets directory, as `runtimeBaoFromDirectory` reads its files.
- One **issuer session** per issuance (and, from Run 5.2, per revocation and per environment of an archive): `appRoleLogin` (a token of 60 s), the step's calls, `tokenRevokeSelf` in `finally`. `close()` never throws; a failed revoke-self leaves a token that dies within 60 s.
- A login that fails is answered before any row is written: `backend_sealed` for a sealed OpenBao, `dependency_unavailable` otherwise.
- The start-up self-check logs `issuerLogin` beside `runtimeLogin` in its `selfcheck` line. It does not gate `/health`.

## The record

- States: `issuing → active → revoking → revoked`; `issuing → needs_review` (the issuance could not be proven); `active → expired` (written by the sweep, Run 5.2). A definite refusal of the create leaves the row `revoked` with a null accessor: it was never a token, and the inventory does not list it.
- Every check of a lifetime compares `effective_expires_at` with `now()` in the statement; a stored `active` past its expiry shows as `expired`.
- Migration `0013`: the partial unique index `machine_credential_unresolved_issuance_key (environment_id) WHERE state IN ('issuing', 'needs_review')` **is** the rule "an unresolved issuance blocks new issuance for that environment"; an index `(environment_id, state)`. `api_runtime` keeps `UPDATE` on `accessor`, `effective_expires_at`, `state`, `last_used_at` only (the other four columns of `0001` were revoked) and has no `DELETE`.
- PostgreSQL never holds a token, not even encrypted. The accessor is stored only on the credential row. Audit rows carry the credential id, the length of its name and the lifetime asked for: never an accessor, a token or a digest of one, and not the name itself (free text, like a project name).

## Issuance

All under the environment's advisory lock, on its own connection:

1. The issuer session.
2. **One** transaction, whose commit is the marker:
   - the operation is inserted directly as `executing` under this process (a key that exists → replay, or `idempotency_conflict`);
   - capture mode `idle`, the gate open, the caller's authority and the states re-read, `kv_ready`;
   - the credential row `issuing` (the unique index → `409 state_conflict` with the blocking operation's id, nothing kept);
   - a step whose target is the credential id, with the dispatch attempt id;
   - audit `credential.issue` `intent`.
3. `tokenCreateFromRole(machine-env-<environmentId>, ttl, correlation, meta { credential_id, operation_id })`, once.
4. `tokenLookupAccessor`, checked by `checkIssuedToken`: orphan, not renewable, `service`, policies exactly the machine policy, `num_uses` 0, `creation_ttl` positive and at most the request (the backend may give less), `meta` as sent, the organization's namespace.
5. **One** transaction: project and environment still `active` (`FOR SHARE`), the credential `active` with accessor and `effective_expires_at` from `expire_time`, the operation succeeded with `{ credentialId, state, effectiveExpiresAt }`, audit `success`.
6. Unlock; the 201 `{ operationId, credential, token }` with `cache-control: no-store`.

The answers to step 3:

| The create answered                      | Outcome                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `denied`                                 | definite: operation `rejected` `backend_inconsistent`, credential `revoked` (no accessor), environment to review, `system.drift_detected` |
| `sealed`                                 | definite: `rejected` `backend_sealed`                                                                                                     |
| `invalid` / `not_found`, 4xx or status 0 | definite: `rejected` `dependency_unavailable`                                                                                             |
| anything else (timeout, lost, 5xx)       | unknown: operation `uncertain`, credential `needs_review`, `503 outcome_unknown`                                                          |

A token that fails step 4, or a parent that is no longer `active` in step 5, is revoked by accessor and its absence proven (`revokeAndVerify`: one revoke, up to three lookups 200 ms apart, absence = 400). Proven: credential `revoked` (accessor kept), operation `rejected` — `backend_inconsistent` with the environment to review for a wrong token, `state_conflict` when an archive took precedence, `dependency_unavailable` when the lookup itself failed. Not proven: the accessor is stored, the credential is `revoking`, the operation `uncertain`.

After the marker the function never throws to its caller: any exception, or a lost lock connection, becomes `outcome_unknown` after one attempt to write `uncertain` / `needs_review` (on the lock's connection, or the main pool once it is lost). When that attempt fails too, the sweep does it (Run 5.2).

## Delivery and replay

- The 201 is the only response schema of the contract with a field that holds an OpenBao token (`tests/unit/contracts/token-fields.test.ts` walks every response schema).
- A replay never executes: `executing` → 202 with the envelope; `succeeded` → `409 credential_not_replayable` with details `{ credentialId, state }`, the state read now; `rejected` → its stored error; `uncertain` → `503 outcome_unknown`.

## Revocation (Run 5.2)

All under the environment's advisory lock, on its own connection. A revocation of the same credential whose heartbeat is younger than 120 s answers `409 state_conflict` with its id before the lock is taken (under the lock it would wait and answer `busy`).

1. The issuer session.
2. **One** transaction, whose commit is the marker: the operation inserted as `executing`; capture mode `idle`, the gate open, the caller's authority re-read; the credential `FOR UPDATE` — `active` or `expired` admitted, `revoking` admitted when no live revocation holds it; `revoked` → `409 state_conflict`; `issuing` / `needs_review` → `409 state_conflict` with the issuance's operation id. The credential becomes `revoking`, a step targets it, audit `credential.revoke` `intent`. From this commit the product denies the credential.
3. `revokeAndVerify`: one revoke by accessor, then up to three lookups 200 ms apart; only a lookup answering 400 proves absence.
4. Absent: **one** transaction — the credential `revoked`, this operation `succeeded` with `{ credentialId, state: "revoked" }`, every `uncertain` revocation of it `succeeded` too (`settleRevocations`), audit `success`; `200`.

| The revoke answered                     | Outcome                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| absent proven                           | `revoked`, `200`                                                                                      |
| `sealed` / `denied`                     | definite: operation `rejected` `backend_sealed` / `backend_inconsistent`; credential stays `revoking` |
| not sent (status 0)                     | definite: `rejected` `dependency_unavailable`; credential stays `revoking`                            |
| anything else (lost, timeout, no proof) | unknown: operation `uncertain`, credential `revoking`, `503 outcome_unknown`                          |

`revoking` is never shown as revoked. A new revoke request (new key) re-sends the revocation, which is idempotent, and its proof settles the earlier operations. A revocation works whatever the state of the project or environment (state class `lifecycle`).

## Unresolved work: the sweep (Run 5.2)

The API's 30 s sweep runs `sweepCredentials` after the secret rules; PostgreSQL only. Each rule is one conditional update that also clears `executor_boot_id`, so the executor that comes back late cannot finalize (`finishOperation` answers null):

- an issuance `executing` with a heartbeat older than 120 s → `uncertain`, its credential `issuing → needs_review`; `system.operation_stuck`;
- a revocation likewise → `uncertain`, its credential stays `revoking`; `system.operation_stuck`;
- an `active` credential past its expiry → `expired` (no audit row: it is not an operation).

Two sweepers at once write one audit row per operation. An optional environment limits a pass to one environment (the operator command uses it).

## Unresolved work: `ops reconcile-credentials` (Run 5.2)

`ops reconcile-credentials --environment <id> [--executors-excluded yes]` runs as `maintenance` with the operator's OpenBao token, under the environment's lock (2 s, else `refused busy`, exit 3):

0. The sweep for this environment (every executing credential operation when the executors are excluded).
1. Every accessor of the namespace is looked up; those whose policies name `machine-env-<environmentId>` are kept. The AppRole login tokens are listed too and are left alone.
2. Each kept accessor that is not the accessor of an `active`, unexpired row or of a `revoking` row is revoked and proven absent (`unrecorded-revoked`); its `meta.operation_id` is remembered.
3. Each `revoking` row is revoked again and proven → `revoked`, its revocations `succeeded`, an uncertain issuance of it `rejected`. A `revoked` row with uncertain revocations has them settled.
4. Each `needs_review` row → `revoked` (with the found token's accessor) and its issuance `rejected` `dependency_unavailable` — only when its token was found in step 2, or the executors are excluded. Otherwise it is left (`needs_exclusion`), and the command exits 3 after doing the rest. An `issuing` row still inside its heartbeat is left the same way.
5. One audit row `operator.reconcile_credentials` with the counts and the flag.

It prints ids and counts, never an accessor or a token. Without exclusion a create that was sent but whose token is not found may still arrive (D-20); only exclusion (`quiesce`) ends that.

## Observed on OpenBao 2.7.2 (Run 5.2)

- A request that reaches OpenBao more than about 10 s after its TLS connection opened is never served: a create delayed 15 s in the relay made no token, in two variants. A delayed create can only land inside that window. This is probably the listener's read-header timeout.
- A create held in the relay until 3 s after the API answered (about 13 s after its connection opened, the API waiting for its own `revoke-self` too), then released together with that `revoke-self`, made no token. Either the 10 s window above or `revoke-self` reaching OpenBao first explains it; which one was not established. A late create that arrives after `revoke-self` is refused and is harmless.

## Observed on OpenBao 2.7.2 (Run 5.1)

- `meta` given at `auth/token/create/<role>` comes back unchanged from `lookup-accessor` and `lookup-self`; a token made without it reads `meta: null`.
- A token role has no `token_max_ttl`; its cap is `token_explicit_max_ttl`, and a request above it gives a token whose `creation_ttl` is the cap.
- `lookup-accessor` of an accessor already revoked answers 400 (absent); of a string that was never an accessor of the namespace it does not answer 400, so nothing proves its absence.
- A revoke whose answer is lost on the way back has been applied: the token is dead although the product could not prove it (`unproven`).
