# D-34 — The API's runtime identity in OpenBao

**Date:** 2026-11-13

**Status:** DECIDED in the Session 4 plan (P-62), recorded by the executing agent in Run 4.2. Evidence: `tests/integration/openbao/inline.test.ts`, `tests/integration/secrets/*.test.ts`, `tests/staging/secrets.staging.test.ts`, `docs/evidence/session-4/run-4.2.md`, `docs/evidence/session-4/run-4.2-staging.json`, `tests/staging/export.staging.test.ts`, `docs/evidence/session-4/run-4.9-staging.json`.

## Decision

- **Inline AppRole on every request (D-17).** The API calls OpenBao as the organization's `runtime` AppRole without holding a token: `OpenBaoClient` takes `auth: { token } | { inline: { roleId, secretId } }`. Inline auth sends `X-Vault-Inline-Auth-Path: auth/approle/login`, `X-Vault-Inline-Auth-Namespace`, and `X-Vault-Inline-Auth-Parameter-role` / `-secret`, each a base64url JSON `{ key, value }`. It never sends `X-Vault-Token`; a client given both refuses to call. Five inline calls create no accessor in the namespace, and an inline client cannot `lookup-self` (403).
- **One organization per process.** `runtimeBaoFromDirectory(target, directory)` reads `organization-id`, `runtime-role-id` and `runtime-secret-id` from the API's secrets directory (`MYKEY_API_SECRETS_DIR`, default `/run/mykey/secrets`). Until all three exist it reads them again on each call, then keeps them. It answers null for any other organization, and a null client answers `503 dependency_unavailable` on every secret route.
- **The start-up self-check** stays a log line (`selfcheck` / `runtimeLogin`). It does not gate `/health`.
- **A runtime call answered `denied` is drift:** `503 backend_inconsistent`, the environment goes to review and `system.drift_detected` (`kv_data`) is audited (P-72, D-36).
- **Observed:** a wrong secret id answers **400** (`invalid`), not the 403 the plan expected. The test follows the observation.
- **`kvMetadata`** gives `oldestVersion` and each version's `createdAt`, `deleted` and `destroyed`, which history (Run 4.3) and the protocol's pre-read need.

## Measurement (P-62)

Staging, 13 Nov 2026, API build `352889607d70`. Fifty sequential updates of one key, timed from the workstation through the public name over TLS, each answer included: **median 677 ms, slowest 1,150 ms, fastest 570 ms.** Each update makes three inline-authenticated OpenBao calls (pre-read, write, read-back), each with its own AppRole login. That was not yet the bound named in P-62.

**The bound (Run 4.9 Task D)** — staging, 14 Nov 2026, API build `81a9aea56f0a`, project `s4-export-0162944e` (environment `full`, `f3a8e3da-377b-45e3-b3b5-e090e22f8f1d`). Eight imports of 125 entries of 7 KiB built 1,000 names and 7,182,000 bytes of export. Each import took **9.1–13.1 s**, measured from preview to final answer, and none answered `awaiting_input`. That is 7–10 s per hundred entries, against 14.6 s on the workstation. Three exports of the 1,000 names took **10.6 s, 18.8 s and 19.8 s**, measured from the workstation through the public name with every byte received. The three files had equal digests. **The slowest is under the 60-second ceiling, so inline authentication stays and the fallback is not taken.** Evidence: `tests/staging/export.staging.test.ts`, `docs/evidence/session-4/run-4.9-staging.json`.

## What would change this decision

- The export of 1,000 names on staging taking more than 60 s (measured at 19.8 s in Run 4.9 Task D; Run 4.10 and later releases measure again). Then D-17's fallback applies: one AppRole login token held in memory for 15 minutes, revoked at shutdown, never written anywhere.
