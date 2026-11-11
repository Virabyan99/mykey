# Run 2.1 — OpenBao tenancy and permissions spike

**Result: DONE on 11 Nov 2026.** Every identity's rights were sent as real requests with real tokens against OpenBao 2.7.2 and match the policy templates; the runtime identity moves to inline AppRole authentication (D-17).

PO-3 SPIKE_PASS — 860-cell authority matrix of runtime, issuer, provisioner, machine and backup verified with real tokens on OpenBao 2.7.2 (local stack), every denial with a control; inline runtime authentication adds no right and stores no token (`docs/evidence/session-2/authority-matrix.md`, D-17).

PO-4 and FR-1.13 stay `OPEN`; this run note is contributing evidence for both (scoped identities, privilege separation measured in D-17 "What a hostile API process holds").

## What was done

- **Task A** (commit `1c7a2fc`, details in its report): `packages/openbao` gained `paths.ts` (the only builder of namespaces, KV paths and machine names, with validators the client enforces), `policies.ts` (templates in `infra/openbao/policies/*.hcl`, machine token role, P-22 TTLs), `client.ts` (`OpenBaoClient`, `appRoleLogin`; one HTTPS request per call, never retried; deadline → `unknown/timeout`, refused or untrusted TLS → `invalid/0`) and `admin.ts`, reachable only as `@mykey/openbao/admin`. The dev stack declares the file audit device (P-21) on the `baoaudit` volume and the harness registers the two correlation headers. `tests/harness/org-fixture.ts` bootstraps one organization and reads every object back.
- **Task B — audit evidence** (commit `4779155`): `tests/integration/openbao/audit.test.ts` proves one `request` and one `response` entry per dispatch id with `x-mykey-operation-id` / `x-mykey-dispatch-id` in clear and namespace `org-<id>/`; no run-time canary value and no client token in the raw file; a denied machine-token write is recorded too; a header smuggled through a correlation id is refused before any request, and the audited headers equal the `Correlation` passed. `client.test.ts` gained a real 403 through the typed client (control: the runtime token's same call) and a committed check that a role's `token_num_uses` reaches the minted token. `readAuditLog` skips a final line without its newline (parallel suites share the stack).
- **Task C — authority matrix** (this commit): `packages/openbao/src/authority.ts` (`AUTHORITY_MATRIX`, 860 cells: 5 identities × 45 actions × the targets that apply; `expectStatus`/`reason` for answers given before policy; `ROOT_CONTROLS`; `controlOf`). `tests/unit/openbao/authority.test.ts` checks the structure (own cell per identity × action, no duplicates, allows equal a hand-written list from the templates, every denial has a control, the root token never revokes itself). `tests/integration/openbao/authority.test.ts` sends every cell with a real token, every control, the inline-authentication pass and the hostile-process measurements, and writes `authority-matrix.json`. `scripts/authority-matrix.ts` renders `authority-matrix.md`; `authority:check` is part of `check`.
- **PO-3 documentation check:** inline authentication exists in 2.7.2 (`website/content/docs/auth/index.mdx` at tag `v2.7.2`). Tested against the same matrix and chosen for the runtime identity — see D-17.
- **D-17** records the identity model, the PO-3 choice, every surprise and the hostile-process sentences with their test names.

## Commits

- `1c7a2fc` feat(openbao): narrow client, policy templates, audit device and organization fixture
- `4779155` test(openbao): audit correlation headers, no value and no token in the audit file
- this commit: feat(openbao): authority matrix verified with real tokens (PO-3)

## Commands and results

| Command                                                                                          | Exit | Proof line                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/openbao/authority.test.ts` (first)               | 1    | `runtime token.revoke_self other_organization: expected 'token.revoke_self' not to be …` (RED)                                   |
| `pnpm exec vitest run --project integration tests/integration/openbao/authority.test.ts` (first) | 1    | 22 mismatches: 15 self-operation cells, 1 control 500, 3 renew-self controls 400, 3 refused root controls; inline: 4 differences |
| same, with the machine template widened to `kv/metadata/p/{{pid}}/*` (mutation, reverted)        | 1    | `machine kv.list_project own: expected 403, observed 200` and 3 more                                                             |
| same, with the client sending a fixed operation id (mutation, reverted)                          | 1    | audit.test.ts: 3 of 3 failed                                                                                                     |
| `pnpm run check`                                                                                 | 0    | `authority matrix: 860 cells current and proven.` · `evidence: registry ok (191 items).`                                         |
| `pnpm test`                                                                                      | 0    | `Test Files 20 passed (20)` · `Tests 425 passed (425)`                                                                           |
| `pnpm run test:integration`                                                                      | 0    | `Test Files 13 passed (13)` · `Tests 296 passed (296)` · 82.8 s                                                                  |

The matrix cells themselves take about 4 s (eight requests at a time); the private stack for the seal control about 20 s.

## Deviations and decisions

- **Runtime authentication is inline AppRole** (PO-3, D-17), not the stored 15-minute login of P-22. `OpenBaoClient` still takes a token; the run that wires `apps/api` to OpenBao adds the inline credential mode.
- **Self operations.** A namespace token's `lookup-self` and `revoke-self` succeed when the request names another organization or the root namespace; they act on the caller's own token. Wrong expectation, fixed as 15 `allow` cells with that reason (D-17), and proven not to touch B by a test.
- **Columns.** `other_organization` is two columns (`X-Vault-Namespace: org-<B>`, and the root namespace with the path prefixed `org-<B>/`); the prefixed form is told apart by the `{ns}/` placeholder at the start of the path, so `AuthorityCell` needed no field for it. KV and environment actions are not sent to the root namespace (there is no `kv` mount there).
- **Rendering.** The Markdown has one table per identity with actions as rows and targets as columns, not one table with 45 action columns.
- **Controls.** Where no identity is allowed, the root token sends the same request. Destructive requests act on objects made for that request (`{victim}`, `{fresh}`, `{accessor}`); writes of policies and roles send the canonical text, so a root control changes nothing. Root controls run one at a time.
- **`token_num_uses`.** OpenBao 2.7.2 returns it on a role read when it is not 0 and omits it when it is 0. The Task A report said "never returned"; the comments are corrected, `readTokenRole` is unchanged (the machine roles hold 0).
- **The root package** depends on `@mykey/openbao` (workspace) so that `scripts/authority-matrix.ts` can import the matrix.
- The registry is not edited in this run (ruling R6): the gate run moves PO-3.

## Open issues

- Concurrent writes of the same object answer 500 "transaction commit failed" to one writer (30 of 30 pairs reproduced on `kv/config`). The client maps it to `invalid`, status 500. Run 2.4 decides whether this is a "not applied, may retry" outcome.
- Inline authentication cost per request is not measured; Session 4/5 measure it under load (D-17 "What would change this decision").
- A machine token minted with `ttl: 60s` from a role with `token_explicit_max_ttl` reports `explicit_max_ttl: 0` (Task A observation); whether the role still caps the TTL is Run 2.2's question. In this run a 30-day request returned a token with a TTL just under 30 days.
- The provisioner together with the issuer holds every right inside its namespace (D-17). It must stay out of the API process.

Verdict: GO
