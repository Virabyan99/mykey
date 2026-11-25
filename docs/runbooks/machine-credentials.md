# Machine credentials

How a machine token is issued, listed and revoked, what the in-between states mean, and what to do when a token's delivery was lost (Runs 5.1–5.2, P-85 … P-90, D-40; FR-1.39 … FR-1.45).

A machine credential is one OpenBao token of the role `machine-env-<environmentId>`: it reads its environment's current values and nothing else. PostgreSQL keeps the record (name, state, expiry, the token's accessor). **The token itself is stored nowhere**, not even encrypted: it is shown once, in the answer to the issuance.

## Two kinds

A machine credential is one of two kinds (Session 11, D-81). Both read the complete current secret set of one environment and nothing else, and both are stored on the consumer by the same command ("Store a token").

| Kind                 | Choose it for                                                              | Lives                                  | What the consumer holds                                            | Needs                     |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| A 30-day token       | a workstation, or a job that a person restarts and can give a new token    | at most 30 days, which is the default  | the token itself, an OpenBao token                                 | any CLI release           |
| A runtime credential | a server that must start by itself for longer than a month, with nobody by | at most 365 days, which is the default | a client secret; each start exchanges it for a token of 15 minutes | the CLI from `cli-v0.2.0` |

"Issue" to "Unknown issuance" below are about the 30-day token. "Runtime credentials" says what differs for the other kind. "Archive and reactivate", "What a machine token can read" and "Never" hold for both.

Paths below are under `/v1/organizations/<org>/projects/<project>/environments/<environment>`. Only the owner and admins may use them.

## Issue

`POST …/credentials` with `{ "name": "deploy", "ttlSeconds": 86400 }` (`ttlSeconds` 1 … 2,592,000; absent: the maximum), an `Idempotency-Key`, and a session whose second factor was verified in the last minutes (`fresh_verification_required` otherwise).

- `201` `{ operationId, credential, token }` with `cache-control: no-store`. Copy the token now: it is never shown again. `credential.expiresAt` is OpenBao's expiry (a role maximum may make it shorter than asked).
- `409 state_conflict` with an `operationId`: an earlier issuance in this environment has an unknown outcome (below), or the environment or project is not `active`.
- `503 outcome_unknown` with an `operationId`: the token may or may not exist. No token is delivered. See "Unknown issuance".

The same request again (same key and body):

- while the first runs → `202` with the operation's state;
- after it succeeded → `409 credential_not_replayable` with `{ credentialId, state }`: never the token;
- after a definite failure → that failure again.

## Store a token

On the machine, run this one line **before** you issue the token, then paste the token at its prompt (Run 10.1, D-76). It runs in `bash`, whatever your shell is, and writes `~/.config/mykey/machine-token` (mode 0600) in place:

```sh
bash -c 'f="$HOME/.config/mykey/machine-token"; d="${f%/*}"; trap "stty echo 2>/dev/null" EXIT; stty -echo 2>/dev/null; t=; while [ -z "$t" ] && IFS= read -rs -p "Paste the token, then press Enter: " t; do echo; done; while IFS= read -rs -t 1 -n 4096 x; do [ -n "$x" ] && t=; done; [ -n "$x" ] && t=; case "$t" in ""|*[^A-Za-z0-9._-]*) echo "Nothing was stored: that was not one token. If a token was shown on the screen, revoke it."; exit 1;; esac; umask 077; if mkdir -p "$d" && chmod 700 "$d" && { [ ! -e "$f" ] || chmod 600 "$f"; } && printf "%s\n" "$t" > "$f" && chmod 600 "$f"; then echo "Token stored."; else echo "Nothing was stored: the file could not be written."; exit 1; fi'
```

- **Paste only when the terminal shows `Paste the token, then press Enter:`.** If it shows anything else, do not paste: a paste that reaches the shell goes to its history and the screen.
- Nothing pasted is shown. `Token stored.` means it is stored. A paste of several lines, an empty line, or anything with a character a token never has is refused: `Nothing was stored`, exit 1.
- `consumer-local.md` §8 is this command's source; `tests/unit/runbooks/token-step.test.ts` keeps every copy equal to it.
- A runtime credential's client secret is stored by this same command, into the same file. The CLI tells the two kinds apart.

## Inventory

`GET …/credentials` lists the environment's credentials, newest first: id, name, state, expiry, issued at, last use (when known). Never a token or an accessor.

| State          | Meaning                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `active`       | The token works until `expiresAt`.                                                                                          |
| `expired`      | Past its expiry; OpenBao refuses it. (An `active` row past its expiry is shown as `expired` at once; the sweep writes it.)  |
| `issuing`      | An issuance is running.                                                                                                     |
| `needs_review` | The issuance's outcome is unknown: a token may exist. It blocks new issuance for the environment (`reconcile-credentials`). |
| `revoking`     | The product denies it; OpenBao has not yet been proven to. Never read as revoked.                                           |
| `revoked`      | OpenBao answered that the token no longer exists.                                                                           |

## Revoke

`POST …/credentials/<credentialId>/revoke` with an `Idempotency-Key` (fresh second factor).

1. The credential becomes `revoking` in a committed transaction: from then on the product denies it.
2. OpenBao revokes the token by accessor; up to three lookups must answer "no such token".
3. Only then is it `revoked`, and the answer is `200` with `result: { credentialId, state: "revoked" }`.

- `503 outcome_unknown`: the revocation may have happened but was not proven. The credential stays `revoking`. **Send a new revoke request** (a new key): it re-sends the revocation and proves it; the earlier operation then reads `succeeded` too.
- `503 backend_sealed` / `backend_inconsistent` / `dependency_unavailable`: OpenBao refused or could not be reached. The credential stays `revoking`; send a new request once OpenBao answers (`status`).
- `409 state_conflict` with an `operationId`: another revocation of it is running, or the credential is `issuing` / `needs_review` (settle the issuance with `reconcile-credentials`).
- Revocation works in an environment that is in review or archived.

## Lost delivery (FR-1.43)

The issuance succeeded but the token never reached you (the connection broke, the window closed):

1. Send the same request again (same key and body). It answers `409 credential_not_replayable` with the `credentialId`.
2. Revoke that credential (above).
3. Issue a new one with a **new** idempotency key.

No retry ever returns a token again or creates a second one.

## Unknown issuance

A `503 outcome_unknown` from an issuance leaves the credential `needs_review` (the sweep does it within about two minutes when the API process died) and blocks new issuance for the environment. The probe raises `operations_unresolved`. Settle it with the operator command:

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops reconcile-credentials --environment <environmentId>
```

| Output (exit)                                                                | Meaning                                                                                                                                   | Next                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `unrecorded-revoked <n> revocations-completed <n> issuances-settled <n>` (0) | Every token of the environment that no live row names was revoked and proven gone; every `revoking` row finished; every issuance settled. | Done; issue again if needed.        |
| `nothing to change` (0)                                                      | The catalog and OpenBao already agree.                                                                                                    | Done.                               |
| `left <credentialId> needs_exclusion` (3)                                    | An issuance whose token was not found: a create that was sent may still arrive (D-20).                                                    | `reconciliation.md`, "Credentials". |
| `left <credentialId or -> unproven` (3)                                      | A revocation OpenBao did not prove.                                                                                                       | Make OpenBao answer; run it again.  |
| `refused busy` (3)                                                           | A request held the environment's lock for 2 s.                                                                                            | Run it again.                       |

The command prints ids and counts only, never an accessor or a token, and writes one audit row `operator.reconcile_credentials` per run. The AppRole login tokens of the namespace are listed by OpenBao too; they carry no machine policy and are left alone.

## Runtime credentials

A runtime credential is a row of PostgreSQL and nothing in OpenBao: no token exists until a consumer asks for one. Its client secret is `mkrc.<credential id>.<secret>`. MyKey keeps a keyed digest made over the secret, the environment and the bound networks, and never the secret.

- **Issue:** in the workspace, **New credential** on Machine credentials, with the kind "A runtime credential". By the API it is `POST …/runtime-credentials` with `{ "name", "ttlSeconds"?, "cidrs"? }`, an `Idempotency-Key` and a fresh second factor.
  - `ttlSeconds` is at most 365 days; absent: the maximum. `cidrs` is at most 8 networks; with none, the client secret works from any network.
  - `201` `{ operationId, credential, clientSecret }` with `cache-control: no-store`. The client secret is never shown again: the same request again answers `409 credential_not_replayable`.
  - There is no unknown issuance. The row, the operation and the audit row are one transaction, and OpenBao is not asked.
- **Store:** with the command of "Store a token", into the same file. It needs the CLI from `cli-v0.2.0`: an older CLI presents the client secret as a token and is refused (`known-limits.md`).
- **The exchange:** at each start the CLI sends the client secret to `POST /v1/machine/exchange`. The service checks the secret, the credential's state and expiry, its networks and its environment. It answers with a token of 15 minutes that cannot be renewed and reads that one environment. The CLI reads the set with it and keeps neither. Each exchange writes an audit row `machine.exchange`. A credential allows 10 exchanges a minute (`429 rate_limited` beyond that).
- **Inventory:** the same list, `GET …/credentials`, with each row's `kind`, its bound networks and who issued it: a person or an automation credential. A runtime credential is only ever `active`, `expired` or `revoked`.
- **Revoke:** the same route as a token's. It is one transaction, with nothing to prove in OpenBao.
  - **In the product,** the next exchange is `401`, and every token the credential was exchanged for is refused at once (`401` on both machine routes).
  - **In OpenBao,** nothing is revoked, because no accessor is stored. OpenBao keeps accepting such a token until it expires, at most 15 minutes later. It was measured with 899 of its 900 seconds left (Run 11.3). OpenBao is reachable only from the host's private network.
- **Archive, restore, reconcile:**
  - an archive revokes it in the archive's own transaction;
  - a restore revokes it with every other credential;
  - `reconcile-credentials` leaves the token of an exchange alone while its credential is active, and revokes it as unrecorded afterwards.
- **Rotate:** issue a new one, store it on the server, restart, check, then revoke the old one. The inventory warns 7 days before the expiry.
- **By a script:** an automation credential with the right `runtime_credentials.manage` issues, lists and revokes the runtime credentials of the projects its chain manages (`automation.md`).

## Archive and reactivate

An archive of an environment or a project (`POST …/archive` with `{"confirmed": true}`) is the revocation of every machine token of its scope. Rules in D-41.

- **`revoking`** means: the resource is closed, and its tokens are being revoked.
  - No change, import, issuance or machine request is admitted (`409 state_conflict`).
  - Humans keep their reads (reveal, export).
  - The archive ends `archived` only when every credential of the scope is `revoked` and OpenBao has proven each token gone (lookup → 400).
- **200** means archived. **202** means the archive is still running: the operation is `executing`, and the API's tick drives it again every 30 s once it is older than the stuck-alert time. Follow it with `ops operations` or the operation route.
- **An archive that cannot finish keeps the alert `operations_unresolved` up.** It stays up until the archive ends. Reasons:
  - OpenBao is unreachable or sealed (the tick finishes the archive once it is back);
  - an issuance is in `needs_review`: run `ops reconcile-credentials --environment <id>` (see "Unknown issuance"); the next tick then finishes the archive;
  - the environment's lock stays busy.
    The alert stays up because "archived" is a promise that no token of the scope works. Until it is proven, the operator must know.
- **Reactivate** (`POST …/reactivate`) only reads OpenBao. First it checks, for each environment it brings back:
  - the machine policy and token role against the stored digest;
  - the names OpenBao holds against the index;
  - that every credential is `revoked` and each accessor answers 400.

  A failure answers `503 backend_inconsistent`; the resource stays `archived`, and the operation is recorded `rejected`. Find the drift (`ops verify-organization`, `ops reconcile-environment`, `ops reconcile-credentials`), then send it again.

- An environment archived because its project was archived comes back only with the project. An environment archived on its own stays archived when its project comes back, and needs its own reactivation.
- **Tokens never come back.** Reactivation creates, renews and re-activates nothing. Every old token stays dead, and machines need a new issuance.

## What a machine token can read (FR-1.45)

- **Through MyKey** (`/v1/machine/projects/<project>/environments/<name>/keys|resolve`, D-42), the token reads only the **current** values of its own environment. No query parameter or body key selects anything (`400 forbidden_selector`). The reads are made with the token itself, so they never go beyond its OpenBao policy.
- **Directly in OpenBao**, the token's policy allows reading and listing its environment's path and `lookup-self`, and nothing else (`docs/evidence/session-5/native-scope.md`). Writes, deletes, other environments, token creation, renewal and the system paths are all denied.
- **What OpenBao allows that MyKey does not:** older versions of a key that are not deleted (next section). OpenBao is reachable only from the service's private network, not from where machines run.
- `lookup-self` with the token also answers in another namespace, with the token's own record. It reveals nothing beyond what the token already says about itself.

## Residual: older versions (FR-1.45)

The machine policy grants OpenBao's native KV read on the environment's path. In OpenBao that read authority also covers **older versions of a key that are not deleted**. The product API gives machines current values only, and OpenBao is not reachable from outside the host. Native policy alone does **not** enforce current-version-only access: a machine token used directly against OpenBao could read an older undeleted version.

## Never

- Paste a token or a client secret into a ticket, a log, a chat or a commit. If one leaks, revoke its credential at once.
- Edit `app.machine_credential` by hand, or revoke a token with the root token without running `reconcile-credentials` afterwards.
- Give `--executors-excluded yes` without `quiesce`.
