# D-81 — The runtime credential, its exchange, and what a hostile API holds

**Date:** 2026-11-25

**Status:** DECIDED (P-185 to P-190; Run 11.3), on the owner's answers 2 and 5 of `docs/evidence/session-11/owner-requests.md` (D-80). Evidence:

- `docs/evidence/session-11/measurements.json`, `run-11.3.md`;
- `tests/integration/credentials/{runtime,runtime-everywhere,surfaces,reconcile}.test.ts`;
- `tests/integration/machine/{exchange,metadata,fleet}.test.ts`, `tests/integration/limits/machine.test.ts`;
- `tests/integration/openbao/issuance.test.ts` ("the token of an exchange");
- `tests/integration/restore/{invalidate,full}.test.ts`;
- `tests/unit/operations/credential-secret.test.ts`, `tests/unit/openbao/authority.test.ts`.

## Context

A server that restarts unattended needs a credential that outlives 30 days. A 30-day machine token is an OpenBao token: it cannot be made to live a year without giving the API a right it does not have, and a year-long token that reads values is a year-long exposure. Session 11 (D-80) adds a second kind beside it. Nothing new is created in OpenBao: no identity, no policy, no right.

## Decision

1. **The secret is a verifier in PostgreSQL** (P-185).
   - The client secret is 32 random bytes, presented as `mkrc.<credential id>.<43 characters>`. It is shown once, in the answer of its issuance.
   - PostgreSQL holds `HMAC-SHA-256(key, label + presented + what the credential is bound to)` with the key's id. The key is of the existing `resetVerifier` ring; the label `mykey:credential-secret:v1` keeps this use apart from a reset link's.
   - **What it is bound to** (added in Task D, below): the kind, the organization, the project, the environment and the bound networks. A row whose environment or networks were changed no longer verifies.
2. **A runtime credential is a row of `app.machine_credential`** with `kind = 'runtime'` (P-186): no accessor for its whole life, a verifier, `bound_cidrs` (0 to 8 networks), `issued_by_kind`. It lives at most 365 days (D-83).
   - It is issued by its own route, `runtime_credentials.issue`, with a fresh second factor, in one transaction: the operation, the row and the audit row. A replay never shows the secret again (`credential_not_replayable`).
   - It is listed by `credentials.list` and revoked by `credentials.revoke`. An archive revokes it in the archive's own transaction; a restore revokes it with every other row.
3. **The exchange mints through the issuer and stores nothing** (P-187). `POST /v1/machine/exchange`, bearer the client secret:
   - the pipeline verifies the secret, then the row's state, its expiry, its networks and its parents;
   - the issuer creates a token from the environment's `machine-env` role: 900 seconds, not renewable, an orphan, with `meta` naming the credential and saying it was exchanged;
   - the credential is read again in the transaction that writes the audit row `machine.exchange`, and only then does the token leave. If the credential was revoked meanwhile, or the audit row cannot be written, the token is revoked and nothing is answered;
   - a lost answer is `503`. The caller exchanges again. Nothing is blocked and nothing goes to review.
4. **A machine token is attributed by accessor, or by its `meta`** (P-188). A token that says it was exchanged is attributed to the runtime credential it names, and only when its policy is exactly that credential's environment role. The credential's networks are checked at the exchange and on every machine request.
5. **Revoking is one transaction** (P-189). The product refuses the credential's next exchange and every token it was exchanged for at once. OpenBao still accepts such a token until it expires, at most 900 seconds later; OpenBao is reachable only from the host's private network.
6. **`reconcile-credentials` leaves an exchanged token alone** while the runtime credential it names is active and unexpired (P-190). After the revocation the same command revokes it as unrecorded.

## Measured (Run 11.3, local stack, OpenBao 2.7.2)

- **The token of an exchange:** `ttl` at most 900, `renewable` false, an orphan, policies exactly the environment's role, `meta` with `credential_id` and `exchange`.
- **It cannot be renewed:** `renew-self` is refused (403) and the expiry is unchanged; the issuer's renew by accessor is refused too.
- **It ends by itself:** a 2-second token reads, and 3 seconds later it is refused (the control, a 60-second token, still reads).
- **The issuer cannot widen it:** a create that asks for a policy outside the role is refused (400), with or without `meta`.
- **After its credential is revoked:** refused by the product at once (401 on `machine.keys` and `machine.resolve`); in OpenBao it was still accepted, with 899 of its 900 seconds left when measured.
- **One exchange** took 234 ms.

## What a hostile API holds (D-17's form)

- **What a taken-over API process can do that is new: nothing in OpenBao.**
  - It could already mint a 30-day token for any environment of its organization with the issuer's identity. A 900-second token is less.
  - The authority matrix is byte-equal: no identity, no policy and no right was added (`tests/unit/openbao/authority.test.ts`).
- **What is new outside OpenBao:**
  - It holds the verifier ring, so it can write a credential row for a secret of its own. That gives it nothing it lacked: it mints tokens directly.
  - It sees every client secret that is presented to it. A 30-day token it sees is dead in 30 days; a client secret it kept works for up to a year, until it is revoked. **After a suspected takeover of the API, every runtime credential is issued again**, as every token is.
- **What it cannot do:** anything outside the `machine-env-*` family, as before.
- **A reader of a database dump or a pair** finds verifiers, key ids, names, networks and times. No secret can be made from them: the ring is in no database and in no pair, and the secret is 256 random bits.
- **A writer of the database alone** (no key ring, no OpenBao, no API process):
  - **cannot make a credential:** a verifier needs the ring;
  - **cannot move one or free it of its networks:** the verifier is made over the environment and the networks, so a changed row is refused (`exchange.test.ts`, "a row a writer of the database alone moved…");
  - **can undo a revocation or an expiry.** State and times are columns. Whoever holds a revoked or expired client secret **and** can write the database can exchange it again, for its own environment and from its own networks.
  - **The difference from today, as it is:** the same writer cannot bring a revoked 30-day token back (OpenBao has revoked it), and cannot make a session, a second factor or a reset link (each is keyed by a ring outside the database). It can already change memberships and grants, which gives any person who can sign in any role. So the new residual is narrow, and it is real: it is a line of `known-limits.md`.

## Consequences

- **Rotation is yearly at most, and it is the owner's:** issue a new credential, deploy it, revoke the old one. The inventory warns 7 days before the expiry.
- **A revoked credential's last token can read in OpenBao for up to 15 minutes,** only from the host's private network. `known-limits.md` says so.
- **`cli-v0.1.2` cannot use a runtime credential.** The CLI learns the exchange in `0.2.0` (Run 11.4).
- **The automation credential (D-82) reuses the verifier,** with its own prefix `mkac` and its own binding.

## Amends

Doc 10 §4.2 and Doc 04 FR-1.39, by addition only (D-80): the 30-day machine token is unchanged.
