# D-17 — OpenBao identity model

**Date:** 2026-11-11

**Status:** DECIDED by the executing agent in Run 2.1, on measurements against OpenBao 2.7.2 (local stack). Evidence: `docs/evidence/session-2/authority-matrix.md` (rendered from `authority-matrix.json`), `tests/integration/openbao/authority.test.ts`, `docs/evidence/session-2/run-2.1.md`.

## Decision

Each organization is one namespace `org-<organization_id>` with one KV v2 mount `kv` and four kinds of identity inside it, plus one in the root namespace. Their rights are exactly the path blocks of `infra/openbao/policies/*.hcl` (Doc 06 §5):

| Identity      | Where                | How it authenticates                                                       | Rights                                                                                                 |
| ------------- | -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `runtime`     | `org-<id>`           | **inline AppRole authentication** on every request (PO-3, below)           | read and write `kv/data/p/*`, read and list metadata, soft delete and undelete a named version         |
| `issuer`      | `org-<id>`           | AppRole login inside the namespace, 60 s token, revoked after use          | mint from the `machine-env-*` token roles, read those roles and policies, look up and revoke accessors |
| `provisioner` | `org-<id>`           | AppRole login inside the namespace, 300 s token                            | create, read and update the `machine-env-*` policies and token roles                                   |
| machine       | `org-<id>`           | orphan service token from `auth/token/create/machine-env-<eid>`, ≤ 30 days | read one environment's data, list that environment, look itself up                                     |
| `backup`      | root namespace       | a token with only the `backup` policy                                      | `sys/storage/raft/snapshot`                                                                            |
| operator      | root namespace, root | off-host only                                                              | bootstrap, namespaces, accessor inventory, restore (not held by any process)                           |

**PO-3 — runtime authentication.** The runtime identity uses OpenBao's inline authentication (`X-Vault-Inline-Auth-Path: auth/approle/login`, `X-Vault-Inline-Auth-Namespace: org-<id>`, `X-Vault-Inline-Auth-Parameter-*` carrying `role_id` and `secret_id`) instead of a stored 15-minute login token. It was chosen because both conditions of the plan hold on the pinned release:

- **It removes the stored login token.** After five inline reads the namespace's accessor list is unchanged; one standard login adds one accessor (test `PO-3: inline authentication stores no token and puts no secret id in the audit file`). No token is ever returned to the process.
- **It adds no right.** All 172 runtime cells of the matrix were sent again with inline authentication. 168 answered exactly as with the login token; the other four are `token.lookup_self` (200 with a token, 403 inline): the unstored inline token cannot look itself up. No cell is allowed inline that the token is denied (test `PO-3: inline AppRole authentication adds no right to the runtime row`).

What it does not change: the process still holds the AppRole secret id, which must be protected and rotated on restore (Doc 06 §5). The secret id now travels on every request instead of once per 15 minutes (always over TLS); the audit file does not contain it (same test; the clear-text audit of these headers was CVE-2026-46358, fixed in 2.5.4). Every inline request counts as one use of the secret id, so `secret_id_num_uses` must stay 0.

### The documentation check (Task C Step 4)

The pinned documentation was read from the `openbao/openbao` repository at tag `v2.7.2`:

- `website/content/docs/auth/index.mdx`, section "Inline Authentication": "inline authentication is sent with the main, authenticated request. No ahead-of-time token acquisition occurs; an ephemeral token is created but not persisted to storage so authenticated operations which incur leases will not work … This token will not be returned to the client application." Headers: `X-Vault-Inline-Auth-Path` (required), `X-Vault-Inline-Auth-Operation` (default `update`), `X-Vault-Inline-Auth-Namespace` (defaults to `X-Vault-Namespace`), `X-Vault-Inline-Auth-Parameter-*` (URL-safe base64 JSON `{key, value}`). "If an auth method imposes a number of uses on source identity information, such as AppRole's `secret_id_num_uses`, each request with inline authentication will count against those limits separately."
- `website/content/community/rfcs/inline-auth.mdx`: the design; a request that carries both inline headers and a token is rejected.

The runtime's KV and metadata operations create no lease, so the restriction on leased operations does not touch it.

## What the matrix showed

860 cells (5 identities × 45 actions × the targets that apply), each sent with a real token; every denial paired with a control. Every surprise was resolved as one of: a wrong template, a wrong expectation, or an exposure.

- **No template was wrong.** No policy file changed in this run.
- **Wrong expectation — self operations.** `lookup-self` (runtime, machine) and `revoke-self` (runtime, issuer, provisioner) of a namespace token answer 200/204 when the request names organization B through the header, through the path prefix, or the root namespace. OpenBao applies them to the caller's own token under the policies of the token's own namespace. All 15 cells are checked one by one in test `hostile: every self operation sent to B or the root namespace acts on the caller's own token`: each lookup returns the caller's own accessor, `namespace_path` `org-<A>/` and policies; after each revoke the caller's token is refused (403) on a request it was allowed a moment before, while a token living where the request was sent (B's runtime token, or a root-namespace token) still works. The issuer, whose policy has no `lookup-self`, is refused in every column. The 15 cells are `allow` with that reason. Not an exposure: nothing of B or the root namespace is read or changed.
- **Answered before policy.** In a namespace, `sys/storage/raft/snapshot`, `sys/audit`, `sys/config/auditing/request-headers`, `sys/seal` and `sys/raw/…` answer 400 ("operation unavailable in namespaces" / "operation only available in root namespace") to every identity and to the root token. Those cells carry `expectStatus: 400`. In the root namespace the same requests are 403 for every namespace identity (backup excepted for the snapshot).
- **Controls that are not 2xx.** `sys/raw` is not enabled in the server configuration: the root token gets 404, so nobody can use it; the identities' 403 is the policy answer given before routing. `auth/token/renew-self` cannot be controlled by the root token (it has no lease: 400 "invalid lease ID"), so in each column a 120 s renewable token with the `default` policy, minted by the root token in that namespace, renews itself: 200. The root token's `sys/seal` control runs on a stack of its own and answers 204, because sealing the shared stack would stop the other suites.
- **Known property, kept.** A raw machine token reads retained versions (`?version=1`) of its own environment (Doc 06 §5); the product API will not.

## What a hostile API process holds (Doc 06 §1.2 item 5, §17.4)

With the runtime and the issuer token of organization A together, a compromised API process **can**:

- read and write every environment of A — test `hostile: runtime reads and writes every environment of A`;
- mint a 30-day, orphan, non-renewable read token for any environment of A — test `hostile: the issuer mints a 30-day read token for any environment of A`;
- revoke any accessor of A it knows, the runtime token's included — test `hostile: the issuer revokes any accessor of A it knows, the runtime token's included`.

It **cannot**:

- reach anything in organization B, nor change any policy or role — test `hostile: neither token changes a policy or role, or reaches organization B`, and every `other org` column of the matrix;
- look up or revoke an accessor of B or of the root namespace through its own `lookup-accessor` / `revoke-accessor` in A, the one route that takes a caller-supplied identifier. OpenBao refuses all four requests with **HTTP 500** and the error "cannot lookup token in different namespace" (the root token in A gets the same answer, so this is the token store's namespace wall, not the issuer policy); both tokens keep working, and the root token in B (and in the root namespace) revokes the same accessor with 204 — test `hostile: the issuer of A cannot look up or revoke an accessor of B or of the root namespace`. Not an exposure. The refusal arrives as a 500, not a 4xx: the client maps it to `invalid`, status 500;
- mint a token outside the `machine-env-*` role family: `auth/token/create` and `create-orphan` are 403, a role outside the family is 403, and a machine role refuses a policy it does not allow with 400 — test `hostile: the issuer cannot mint a token outside the machine-env role family`.

With a **provisioner** token the process can write any policy text under a `machine-env-*` name and the token role that grants it; together with the issuer that is every right inside the namespace (auth methods, the accessor inventory under `sudo`, any policy), and still nothing in B or in the root namespace — test `hostile: the provisioner writes any policy under machine-env-*, and with the issuer holds every right in A`. The provisioner therefore must not live in the API process (Doc 06: `apps/provisioner` is a separate process).

## Other observations kept for later runs

- Two concurrent writes of the same object (here `kv/config`, once through the header and once through the path) make OpenBao answer 500 "transaction commit failed" to one of them, reproducibly (30 of 30 pairs on the dev stack). The client maps that to `invalid`, status 500; Run 2.4 decides whether it is a retryable, not-applied outcome.
- `lookup-accessor` / `revoke-accessor` with an accessor of another namespace answer 500 "cannot lookup token in different namespace" (above). Whoever maps OpenBao answers for the issuer (Run 2.2) should treat that 500 as "not this namespace's token", not as a server fault.
- A token role read returns `token_num_uses` only when it is not 0 (Run 2.1 Task A had reported it as never returned).

## What would change this decision

- Inline authentication turns out to cost too much per request under load (Session 4/5 measurements): the runtime returns to the standard AppRole login of P-22, and the stored 15-minute token is accepted as the residual risk.
- A later OpenBao release changes the self-operation behaviour or the inline restrictions: the matrix is re-run on the new pin before it is adopted.
- The co-resident runtime + issuer blast radius above is judged too large at the Session 8 review: a separate private issuer process is promoted (Doc 06 §17.4).
