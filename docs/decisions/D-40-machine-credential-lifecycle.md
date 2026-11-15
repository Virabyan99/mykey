# D-40 — Machine credential lifecycle

**Date:** 2026-11-15

**Status:** DECIDED in the Session 5 plan (P-85 … P-90), recorded by the executing agent. Issuance part: Run 5.1. Revocation, the sweep and `reconcile-credentials`: Run 5.2 (sections below added there). Evidence: `tests/integration/openbao/issuance.test.ts` ("token metadata, lifetime and issuer sessions"), `tests/unit/operations/credentials-verify.test.ts`, `tests/integration/credentials/{protocol,issue,inventory,surfaces}.test.ts`, `docs/evidence/session-5/run-5.1.md`.

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

## Observed on OpenBao 2.7.2 (Run 5.1)

- `meta` given at `auth/token/create/<role>` comes back unchanged from `lookup-accessor` and `lookup-self`; a token made without it reads `meta: null`.
- A token role has no `token_max_ttl`; its cap is `token_explicit_max_ttl`, and a request above it gives a token whose `creation_ttl` is the cap.
- `lookup-accessor` of an accessor already revoked answers 400 (absent); of a string that was never an accessor of the namespace it does not answer 400, so nothing proves its absence.
- A revoke whose answer is lost on the way back has been applied: the token is dead although the product could not prove it (`unproven`).
