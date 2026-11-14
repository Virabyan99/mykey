# Provisioning

How an organization's OpenBao namespace comes into being, how environments are provisioned, what "review" means and how to reconcile (Run 3.8, D-32).

## The organization (operator)

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops provision-organization --organization <id>
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops verify-organization --organization <id>
```

`host.ts` opens the PostgreSQL tunnel (as `maintenance`) and, on a host with OpenBao, the OpenBao tunnel with the root token from `~/.mykey/custody/<host>/openbao-init.json` (registered, never printed).

`provision-organization` runs one operation per organization (`organization.provision`, one id however often it runs) under an advisory lock. Thirteen steps, each recorded before and after: owner binding (exactly one active owner), namespace, KV mount and `kv/config`, AppRole auth, three policies, three AppRoles (with their bound addresses), read-back with the configuration digest, secret ids, activation. Every step reads its object first: equal → nothing written; absent → written and read back; **different → stop, never overwrite**.

| Exit | Output                                                          | Meaning                                                                                          |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 0    | `active organization <id> operation <id>`                       | Every object equals the plan; one secret id per role, delivered.                                 |
| 1    | `retry: <step> (<cause>); run the command again`                | An answer did not say whether a write happened. Run the same command: its comparison settles it. |
| 2    | `refused: no_owner \| several_owners \| no_organization`        | Nothing was sent to OpenBao.                                                                     |
| 2    | `already running`                                               | Another run holds the lock.                                                                      |
| 3    | `review: <step> differs from the plan; nothing was overwritten` | The organization is `needs_review` / `backend_inconsistent`; the probe raises `review_open`.     |

`verify-organization` is the read-only half: it reads every object with the root token and prints `equal` (exit 0) or `differs: <objects>` (exit 3). It writes nothing.

### Where the credentials go

The `secret-ids` step destroys every secret id of each AppRole and issues one; `host.ts` installs it over SSH on stdin:

- `/etc/mykey/secrets/api/runtime-role-id`, `runtime-secret-id`, `issuer-role-id`, `issuer-secret-id`, `organization-id` — for the API;
- `/etc/mykey/secrets/provisioner/provisioner-role-id`, `provisioner-secret-id`, `organization-id` — for the provisioner.

Each AppRole works only from its container's bao address (`runtime`, `issuer`: 10.78.3.3; `provisioner`: 10.78.3.4). Running the command again rotates every secret id; restart the API (`host.ts <host> up`) so it reads the new runtime id at start (the provisioner reads its files on every job). A host serves one organization in Stage 1.

## Environments (the provisioner)

The `provisioner` container takes each `environment.provision` job: it claims the operation (a claim older than 60 s may be taken over), reads `kv/config`, the machine policy and the machine token role, writes only what is absent, reads it back, and makes the environment `active` with `kv_ready` and its policy digest in one transaction (the project too, if it was `pending`).

- A different object already present → environment `needs_review` / `backend_inconsistent`, the object untouched.
- No credential for the organization, or OpenBao refusing the provisioner → `needs_review` / `provisioning_failed`.
- OpenBao unreachable, sealed, or an unclear answer → the job is retried (5 times, backoff); the environment stays `pending`; after the last retry → `needs_review` / `provisioning_failed`.
- The service gate closed → the job is deferred (retried) and nothing is done.

## The drift sweep

Every `MYKEY_SWEEP_SECONDS` (300; 60 on staging; written by `host.ts up`) and at start, for every active organization the host serves: KV mount, `kv/config` and the three policies against `config_digest`; for each active environment its machine policy and token role against `policy_digest`. A difference or an absence sends that scope (and only it) to `needs_review` / `backend_inconsistent` with one audit row `system.drift_detected` `{ scope, object }`. OpenBao away or sealed changes nothing; the log line `{"event":"sweep","reviewed":n,"unread":m}` counts the organizations it could not read.

## What review means for the owner

A scope in review stays visible (lists, `organizations.list` with `reviewReason`), but its secret and credential routes answer `503 backend_inconsistent` and its metadata changes `409 state_conflict` (state table, D-31). The host's `status` reports `reviewOpen`; the probe raises `review_open` once and resolves it once.

## Reconciling

1. Find the object: `ops verify-organization` for the organization; for an environment, the audit row's `object` (`machine_policy`, `machine_token_role`).
2. Remove the foreign object (or put the planned one back) with the root token.
3. Organization: run `ops provision-organization` again — it is the reconciliation and ends `active`.
4. Environment: once its objects equal the plan, `ops reconcile-environment --environment <id>` rebuilds its index and sets it `active` (`reconciliation.md`). Never through the superuser.

## Health

The provisioner image's health check fails when the last sweep tick is older than three intervals; `status` reports `provisioner: healthy | unhealthy | absent`.
