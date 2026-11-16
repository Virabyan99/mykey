# Run 5.4 — Machine API

**Result: DONE on 15 Nov 2026.**

- **Machine authentication** (P-93): a bearer token is checked by asking OpenBao about itself (`lookup-self` with the presented token). It is then bound to one catalog row and to the path's own project and environment. Malformed headers are refused before OpenBao is asked. A cookie beside a bearer is `400 mixed_authentication`. Selectors are `400 forbidden_selector`, and an OpenBao outage is never a 401.
- **`keys` and `resolve`** (P-94) read with the presented token itself. If the token dies in the middle of a read, the answer is 401 and nothing is closed. A live token whose policy cannot read is drift.
  - `resolve` is one generation's complete live set, with its audit row committed before the body leaves.
  - `keys` returns the live names.
  - Both are buffered with `content-length` and `cache-control: no-store`.
- **Native scope**: a product-issued token used directly against OpenBao reads and lists only its own environment's path. Every other call is denied, each with a root control. One finding, recorded before any change (none was made): `lookup-self` answers in another namespace with the token's own record.
- **Staging**, through the public name:
  - The machine journey: one issuance took 697 ms, and one resolve of ten values took 287 ms. The token was found in no log, dump or access log.
  - Archive and reactivation: both accessors answered 400 on the host after the archive, and a new token resolved after the reactivation.
- Decisions: D-42.

FR-1.44 SPIKE_PASS — machine keys and resolve: `tests/integration/machine/authentication.test.ts` (14), `keys.test.ts` (2), `resolve.test.ts` (10), `tests/integration/authz/matrix.test.ts` (machine routes × seven human sessions → 401), `tests/staging/machine.staging.test.ts`.
FR-1.45 SPIKE_PASS — the residual asserted as it is: `tests/integration/machine/native-scope.test.ts` (`?version=1` answers 200 directly in OpenBao; no product request selects a version), `machine-credentials.md` "What a machine token can read", D-42.
FR-1.40 SPIKE_PASS — native scope of a product-issued token: `tests/integration/machine/native-scope.test.ts` (5), `docs/evidence/session-5/native-scope.md`.
AC-1.19 SPIKE_PASS — machine reads only the bound current values via its own token: `resolve.test.ts` (the digests equal the owner's export; the API with a refused runtime identity still answers 200), `keys.test.ts`, the selector cases of `authentication.test.ts`, `tests/staging/machine.staging.test.ts`.
PO-2 SPIKE_PASS — with the product's issuer: a token issued through `POST …/credentials` has exactly its environment's read in OpenBao, and `renew-self` does not extend it (`native-scope.test.ts`). It stays SPIKE_PASS until the integrated proof at the gate.

FR-1.17 and FR-1.18 (Run 5.3) gain their staging proof in `tests/staging/archive.staging.test.ts`.

## What was done

- **Contract** (`contract: machine keys and resolve`):
  - `machine.keys` answers `200 {apiMajor, environmentId, generation, count, names, complete: true}`;
  - `resolve.generation` becomes a decimal string, as in the human routes;
  - both routes list the errors of P-93 and P-94, plus the errors every route has;
  - `resolve` gains `capacity_exceeded`;
  - `openapi.json` is regenerated.
- **Audit**: events `machine.keys` and `machine.resolve`, each with `{names, generation}`.
- **`@mykey/operations`**:
  - `read-environment.ts` is split into `refusalOf`, `clientOf`, `admit`, `compareNames`, `commitRead` and `underLock`;
  - `userId` goes;
  - `reader?: {client, alive}` is added;
  - the denied-read rule sits in one helper;
  - `readEnvironmentNames` is new.
  - `provisioning/digest.ts` holds `policyDigest` and `readableRole`, so the API no longer reaches the provisioner's client (the fix of Run 5.3's skeleton break).
- **API**:
  - `pipeline/machine.ts`: `authenticateMachine`, `bearerOf`, `hasSelector`.
  - `pipeline/route.ts` handles the machine auth class:
    - no validation, Origin check, authorization, replay or freshness;
    - a body is read only to refuse it as a selector;
    - `buffered` results are sent with `content-length` and `no-store`.
  - `pipeline/authn.ts`: `UserPrincipal` and the `Principal` union. `ApiContext.machine` is added.
  - `routes/machine.ts`: the recheck, `machineKeysHandler`, `machineResolveHandler`.
  - Log events `machine_unauthenticated` and `machine_last_used`.
- **Harness**:
  - `tests/harness/machine.ts`: `machineCall`, `exportDigests`, `resolveDigests`;
  - `tests/harness/staging-machine.ts`: `machineRequest`, `resolvedDigests`, `exportedDigests`, and `accessorStatusesOnHost`. On the host, PostgreSQL's accessors are piped into a short script in the API container, which looks them up with the issuer identity and prints status codes only.
- **Docs**: D-42; `machine-credentials.md` gains "What a machine token can read"; `native-scope.md`.
- **Staging** (Task D Step 1): API `5d1a76ec9e29` and the matching provisioner, migration `0014` applied. Selfcheck: `runtimeLogin ok`, `issuerLogin ok`. Gate open, `reviewOpen 0`, `operationsUnresolved 0` before and after the tests.

## Commits

- `32b6780` contract: machine keys and resolve
- `b9c1b7e` fix(operations): the policy digest lives apart from the provisioner's job
- `dd99842` feat(api): machine authentication by the presented token
- `adae38b` feat(api): machine keys and resolve read with the machine's own token
- `5d1a76e` test(openbao): native scope of a product-issued machine token
- this commit: test(staging): machine access, archive and reactivation

## Commands and results

| Command                                                                                   | Result                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/machine/authentication.test.ts` before the code                        | RED (14 failed: 404s; selectors answered `malformed_request`)                                                                                                                                            |
| the same after                                                                            | 14 passed                                                                                                                                                                                                |
| mutation: the path comparison removed                                                     | the concealment case failed; reverted                                                                                                                                                                    |
| mutation: any token characters accepted                                                   | the malformed case failed (OpenBao asked 4 times); reverted                                                                                                                                              |
| `tests/integration/machine/{keys,resolve}.test.ts`                                        | 12 passed on their first run (the code came with Task A; see "TDD")                                                                                                                                      |
| mutation: every read through the runtime identity                                         | the broken-runtime case failed (503), and the dead token got 200 with values; reverted                                                                                                                   |
| mutation: the alive rule removed                                                          | the dead token answered `503 backend_inconsistent` and closed the environment; reverted                                                                                                                  |
| `tests/integration/machine/native-scope.test.ts`                                          | RED first (the PATCH control 400 without `cas`; namespace 404/200; drift from a leftover scratch key), then 5 passed                                                                                     |
| integration: machine, api, authz, read, export, provisioning, resources, auth, reactivate | 44 files, 370 tests passed (`--maxWorkers=2`)                                                                                                                                                            |
| `pnpm test` (unit)                                                                        | 901 passed                                                                                                                                                                                               |
| `tests/staging/machine.staging.test.ts`                                                   | 1 passed (64.6 s): issue 697 ms, resolve of ten values 287 ms, 401 after the revocation, accessor 400; token found 0 × in 3 searches, each control found                                                 |
| `tests/staging/archive.staging.test.ts`                                                   | 1 passed (49.9 s): accessors 200, 200 before; archive 200 `archived` in 878 ms with 2 revoked; 401 on both routes for both tokens; accessors 400, 400; reactivation 200; old tokens 401; a new token 200 |
| `host.ts staging status` after                                                            | gate open, `reviewOpen 0`, `operationsUnresolved 0`, provisioner healthy                                                                                                                                 |
| `pnpm run check`                                                                          | exit 0                                                                                                                                                                                                   |

## TDD

- **Task A:** RED first. The handlers of Task B had to be written to make the 200 case pass, so Task B's tests met code that already existed. Their reach was proven by the two mutations above. Task B's commit holds the tests and the remaining code.
- **Task C:** RED first, from the controls and the leftover scratch key.
- **Task D:** each staging file passed on its first run. The control of the accessor check is the 200, 200 before the archive: the same helper reads 400 only after the revocation.

## Deviations and decisions (rulings in the ledger)

- The machine routes keep the errors every route has (`malformed_request`, `rate_limited`) besides the plan's list.
- `generation` is a decimal string in both machine bodies.
- `ApiContext` keeps `principal: UserPrincipal | null` and gains `machine`. A machine principal at a human helper is a type error.
- The audited machine denials are the ones the product decides itself. A token OpenBao refuses is logged only.
- A machine route with a body reads it only to refuse it as a selector. An empty body and `{}` pass.
- "OpenBao stopped" in the authentication test is the relay's drop mode, because the stack is shared by parallel suites.
- The writer race accepts `busy` and `environment_changed`, and asserts that every 200 is one generation's set.
- **Finding:** `lookup-self` answers 200 in another existing namespace and in the root namespace, with the token's own record. The plan expected 403. No policy was changed. The test asserts the record names the token's own namespace, and an organization without a namespace answers 404.
- The staging archive test belongs to this run (P-102), not to 5.3.
- `accessorStatusesOnHost` uses the API container's issuer identity (the plan says "`sshExec`, ids only"). Only credential ids cross the command line; the accessors stay on the host, and only status codes come back.

## Open issues

- Run 6.3 owns the rate limit of 60 requests a minute per credential (P-93).
- Each staging run rewrites `run-5.4-staging-{machine,archive}.json`. They are committed as evidence of this run.

## What Run 5.5 must know

- The machine routes are `GET …/keys` and `POST …/resolve` under `/v1/machine/projects/:project/environments/:envName`. Send no query and no body (or `{}`), and exactly one `Authorization: Bearer` header. `generation` is a string.
- `401 unauthenticated` means the token is dead or not a credential. `403 action_denied` means a closed parent. `404 not_found` means a path that is not the token's own. `503` with any code is retryable, and never a reason to drop the token.
- On staging, the public name answers both routes. `tests/harness/staging-machine.ts` has `machineRequest` for the CLI's staging test.
