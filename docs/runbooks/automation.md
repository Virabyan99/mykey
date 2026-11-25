# Automation: provisioning by a script

How a script creates projects, environments, secrets and runtime credentials without a person, and what the owner does to allow it, rotate it and stop it (Session 11; D-80, D-82, D-83).

Every example below uses `https://mykey.example` for the service's address and holds no real value.

## What an automation credential is, and is not

- **It is the secret a provisioning script holds:** `mkac.<credential id>.<secret>`, sent as a bearer credential to the ten routes under `/v1/automation`.
- **It acts only in projects its chain created.** A project a person made, a project of another chain, an id of nothing and a text that is no id all answer the same `404 not_found`.
- **It never reads a value.** No route gives it a secret's value or a digest of one, and none lets it change, delete, rename or archive anything.
- **It can reach values in two steps, when you give it the right.** With `runtime_credentials.manage` it can issue a runtime credential, and a runtime credential reads the values of its environment. Each step is audited, and the runtime credential shows in the owner's inventory with its issuer. Give that right only to a script that sets up servers.
- **It is not a person's session.** It needs no second factor, so it is bound to source networks and lives a week unless you say otherwise.
- **MyKey keeps a keyed digest of the secret, never the secret.** The digest also covers the credential's rights, networks and chain: a row changed in the database no longer matches.

## Issue it

In the workspace: **Automation** in the organization's menu, then **New automation credential**. Only the owner or an admin can, with a code from the authenticator of the last ten minutes.

| Right                        | It allows                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `projects.create`            | creating projects, and environments in the projects its chain manages               |
| `secrets.create`             | writing new names into those environments; an existing name is `409 already_exists` |
| `runtime_credentials.manage` | issuing, listing and revoking runtime credentials of those environments             |

- **At least one right.** Reading comes with any: the list of its projects, one project with its environments, the names in an environment, and its own chain's operations.
- **Lifetime:** 1 hour to 365 days, 7 days unless you say otherwise. The workspace asks in whole days. It cannot be renewed: a credential that replaces it takes over (below).
- **Networks:** 1 to 8, in CIDR form, with no bit set after the prefix. A request from anywhere else is `401`. The address compared is the one the edge reports: a credential bound to an IPv4 network refuses the same caller over IPv6.
- **Replaces:** leave it empty for a script's first credential. Name an earlier credential to continue its chain.
- **The secret is shown once.** Start the command of the next section first, then issue the credential and paste the secret at its prompt. If the secret was lost or shown to anyone, revoke the credential and issue one that replaces it.

By the API it is `POST /v1/organizations/<org>/automation-credentials` with `{ "name", "rights", "ttlSeconds", "cidrs", "replaces"? }`, a person's session and an `Idempotency-Key`. The same request again never shows the secret: `409 credential_not_replayable`.

## Store it

The script reads the secret from a file only its own user can read. The secret is never a command's argument, never in a file that is committed, and never in a log.

For the `curl` examples below, the file holds one header line. On the machine that runs the script, run this one line **before** you issue the credential, then paste the secret at its prompt. It is the command that stores a machine token (`machine-credentials.md`, "Store a token"), with its file and its words changed, and it writes `~/.config/mykey/automation-auth` (mode 0600):

```sh
bash -c 'f="$HOME/.config/mykey/automation-auth"; d="${f%/*}"; trap "stty echo 2>/dev/null" EXIT; stty -echo 2>/dev/null; t=; while [ -z "$t" ] && IFS= read -rs -p "Paste the secret, then press Enter: " t; do echo; done; while IFS= read -rs -t 1 -n 4096 x; do [ -n "$x" ] && t=; done; [ -n "$x" ] && t=; case "$t" in ""|*[^A-Za-z0-9._-]*) echo "Nothing was stored: that was not one secret. If a secret was shown on the screen, revoke its credential."; exit 1;; esac; umask 077; if mkdir -p "$d" && chmod 700 "$d" && { [ ! -e "$f" ] || chmod 600 "$f"; } && printf "Authorization: Bearer %s\n" "$t" > "$f" && chmod 600 "$f"; then echo "Secret stored."; else echo "Nothing was stored: the file could not be written."; exit 1; fi'
```

- **Paste only when the terminal shows `Paste the secret, then press Enter:`.** Nothing pasted is shown. `Secret stored.` means it is stored.

The examples then need two names:

```sh
API="https://mykey.example"
AUTH="$HOME/.config/mykey/automation-auth"
```

## The ten routes

The full contract, with every body and error, is the reference page of the service: `/v1/reference`. `<project>`, `<environment>`, `<credential>` and `<operation>` are ids.

**Its projects** (any right):

```sh
curl -sS -H @"$AUTH" "$API/v1/automation/projects"
```

**Create a project** (`projects.create`). Its first environment, `development`, comes with it, as in the workspace:

```sh
curl -sS -H @"$AUTH" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"name":"Tenant 42"}' "$API/v1/automation/projects"
```

**One project with its environments** (any right). An environment can take secrets when its `state` is `active` and `kvReady` is `true`:

```sh
curl -sS -H @"$AUTH" "$API/v1/automation/projects/<project>"
```

**Create an environment** (`projects.create`):

```sh
curl -sS -H @"$AUTH" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"name":"production"}' "$API/v1/automation/projects/<project>/environments"
```

**The names in an environment** (any right): name, state, version and times, never a value. `?prefix=` narrows it:

```sh
curl -sS -H @"$AUTH" "$API/v1/automation/projects/<project>/environments/<environment>/secrets"
```

**Create a secret** (`secrets.create`). The body `{"name":"DATABASE_URL","value":"…"}` is read from a file of mode 0600, so that the value is in no command's arguments:

```sh
curl -sS -H @"$AUTH" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d @"$BODY_FILE" "$API/v1/automation/projects/<project>/environments/<environment>/secrets"
```

**The runtime credentials of an environment** (`runtime_credentials.manage`): never a 30-day token, and never a secret:

```sh
curl -sS -H @"$AUTH" "$API/v1/automation/projects/<project>/environments/<environment>/runtime-credentials"
```

**Issue a runtime credential** (`runtime_credentials.manage`). The answer holds the client secret once, so it goes into a file of mode 0600 and not onto the screen:

```sh
( umask 077; curl -sS -H @"$AUTH" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"name":"web-1"}' -o "$ANSWER_FILE" \
  "$API/v1/automation/projects/<project>/environments/<environment>/runtime-credentials" )
```

**Revoke a runtime credential** (`runtime_credentials.manage`):

```sh
curl -sS -H @"$AUTH" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{"confirmed":true}' \
  "$API/v1/automation/projects/<project>/environments/<environment>/runtime-credentials/<credential>/revoke"
```

**One of its chain's operations** (any right):

```sh
curl -sS -H @"$AUTH" "$API/v1/automation/operations/<operation>"
```

## The rules a client must keep

- **One `Idempotency-Key` per step, kept across retries of that step.** The examples make a new key on every run, which is right for a first try and wrong for a retry: a script stores the key before it sends.
- **On `202`, and on `503 outcome_unknown`, read the operation.** The answer names an `operationId`. Read `/v1/automation/operations/<operation>` until its state is `succeeded` or `rejected`. Never send the change again under a new key: it may already have happened. A state of `uncertain` is the operator's to settle (`reconciliation.md`).
- **Honour `retry-after`** on `429 rate_limited` (120 requests a minute for each credential) and on `503 busy` (a backup is being captured).
- **Wait for `kvReady`** before the first secret of a new environment: read the project until the environment is `active` and `kvReady` is `true`.
- **Treat `409 already_exists` on a secret as "it is there".** Automation cannot change a value: a person does, or the script writes a new name.
- **`401` is final for that secret:** it is revoked, expired, called from another network, or not a credential at all. `403 action_denied` means the right was not given. `404` means the project is not its chain's.

`tests/fixtures/automation/tenant-provisioner.ts` is a complete client that keeps these rules, written against the HTTP contract alone. It has two functions: `provision` (a project, an environment, its secrets, one runtime credential) and `reissue` (a runtime credential for every environment of every project of the chain).

## Rotate it

1. Issue a new credential and choose the old one under **Replaces**. Both now manage the same projects.
2. Put the new secret into the script's file (the command of "Store it").
3. Check that the script works with it: its first read answers.
4. Revoke the old credential.

The inventory warns 7 days before a credential expires.

## Revoke it

**Automation**, the credential's row, **Revoke**, then its name.

- **It stops that credential:** its next request is `401`.
- **It leaves everything the credential made.** The projects stay managed by the chain, the secrets stay, and every runtime credential it issued keeps starting its server. A leaked provisioning secret is revoked without stopping one server.
- **To stop a server,** revoke its runtime credential: on Machine credentials of its environment, or by the script's revoke route.
- **A chain with no active credential** still manages its projects. Nobody can act for it until the owner issues a credential that replaces one of the chain. The owner keeps every right over those projects throughout.

## After a restore

A restore revokes every credential: both kinds of machine credential and every automation credential (`restore.md`). The projects keep their chains.

1. After the opening, the owner issues **one** automation credential per chain, with the lost one under **Replaces**. A credential issued without it starts a new chain and manages nothing.
2. The script's `reissue` lists the chain's projects and issues a runtime credential for every environment.
3. Each server gets its new client secret and starts.

Measured on the integration stack (Run 11.5): three tenants with six environments had their runtime credentials again 2.8 s after the owner's one issuance. A drill of this on a host has not been done yet (`known-limits.md`).
