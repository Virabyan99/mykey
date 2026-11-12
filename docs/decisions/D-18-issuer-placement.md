# D-18 — Issuer placement

**Date:** 2026-11-11

**Status:** DECIDED by the executing agent in Run 2.2, on measurements against OpenBao 2.7.2 (local stack). Evidence: `tests/integration/openbao/issuance.test.ts`, `docs/evidence/session-2/run-2.2.md`.

## Decision

The first choice of Doc 10 §8.1 holds: **the issuer lives inside the API process**, logs in with its own AppRole for 60 s, mints machine tokens only through the fixed token role `machine-env-<eid>`, and revokes itself after use. The issuer policy is exactly the one rendered in Run 2.1 (`infra/openbao/policies/issuer.hcl`, six path blocks, no `sudo`, no generic `auth/token/create`); it was not changed in this run. The fallback — a separate private issuer process holding the issuer credential — is **not** taken.

The issuance sequence Run 5.1 builds on, all through the typed client:

1. `appRoleLogin(target, org-<id>, issuer role id, fresh secret id)` → a 60 s issuer token;
2. `tokenCreateFromRole(machineName(eid), ttl, correlation)`, which sends exactly `{ "ttl": "<n>s", "policies": ["machine-env-<eid>"], "no_default_policy": true }` to `auth/token/create/machine-env-<eid>`;
3. `tokenLookupAccessor(accessor)` to verify the token before it is handed out;
4. `tokenRevokeSelf()` of the issuer.

## What was proven

Each line is one test of `issuance.test.ts`, run on the pinned image with real tokens; every refusal states its exact status and error text and has a control (the same request without the offending part, or by an identity that may, succeeds).

| Property                                                                                                                                                                                                                           | Test                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Lookup by accessor and lookup-self agree: `orphan: true`, `renewable: false`, `type: service`, policies exactly `["machine-env-<eid>"]`, namespace `org-<id>/`, TTL 2,592,000 s                                                    | `issued token has the required shape`             |
| No request parameter widens the token (table below)                                                                                                                                                                                | `the issuer cannot widen anything`                |
| `auth/token/create`, `create-orphan` and a role outside the family are 403 for the issuer; the root token mints with the same requests                                                                                             | `the issuer has no other way to make a token`     |
| The token keeps reading after its issuer's login expires (3 s test role), after the issuer's `revoke-self`, and after the root token revokes the issuer by accessor                                                                | `the token outlives its issuer`                   |
| `revoke-accessor` → the next read is 403 and the accessor lookup is 400 "invalid accessor"                                                                                                                                         | `revoking the accessor kills it`                  |
| A 2 s token is refused (403) once its TTL has passed, without anyone revoking it                                                                                                                                                   | `a short token expires by itself`                 |
| The token reads and lists its environment and looks itself up; write, soft delete, undelete, destroy, metadata delete, renew-self, token create, another environment, the project list and the same read in organization B are 403 | `the machine token can only read its environment` |
| An issued token whose answer was thrown away is found in `LIST auth/token/accessors` of its namespace, and only there                                                                                                              | `an operator can find a token nobody recorded`    |

## Request parameters: what the issuer may and may not influence

Sent by the issuer to `auth/token/create/machine-env-<eid>` on top of the normal body (test `the issuer cannot widen anything` and `what the issuer may still choose (D-18)`).

**Refused, no token made** (HTTP 400; the namespace's accessor list is unchanged):

| Parameter                                                                  | Error text                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `policies: ["runtime"]`, `["default"]`, `["machine-env-<eid>", "default"]` | `token policies (…) must be subset of the role's allowed policies (…)` |
| `period: "1h"`                                                             | `root or sudo privileges required to create periodic token`            |
| `id: "chosen"`                                                             | `root or sudo privileges required to specify token id`                 |
| `entity_alias`                                                             | `invalid 'entity_alias' value`                                         |

The role of another organization is 403 (in B's namespace and through the root namespace with B's path prefix; B's own issuer mints with both requests). A role name inside the `machine-env-` family that does not exist is 400 `unknown role …` (the policy lets it through; the token store refuses); a name outside the family is 403.

**Accepted, without effect** (the token is looked up):

| Parameter                                                    | Result                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `ttl: "2592001s"`                                            | `creation_ttl` 2,592,000; warning `TTL of "720h1s" exceeded the effective max_ttl of "720h"; … capped` |
| `explicit_max_ttl: "9000h"` (with or without `ttl: "9000h"`) | `creation_ttl` 2,592,000; warning `… using the lesser value of 2592000 seconds`                        |
| `renewable: true`                                            | `renewable: false`; the root token's `renew-accessor` of it answers 400, of a renewable token 200      |
| `no_parent: false`                                           | `orphan: true`                                                                                         |
| `no_default_policy: false`                                   | policies still `["machine-env-<eid>"]`, no `default`                                                   |
| `type: "batch"`                                              | `type: service`                                                                                        |

The token mount's own maximum is 768 h (2,764,800 s). A request above 720 h ends at 720 h, so the cap is the role's `token_explicit_max_ttl`, not the mount's.

**Accepted, with effect — narrowing or labelling only:** a shorter `ttl`, `num_uses` (a token with `num_uses: 3` has 3 uses), `meta`, `display_name` (stored as `token-<name>`), and `policies` omitted (the role's policy is used). None of them adds a right or a day. Run 5.1's verification step must still check `num_uses: 0`, because a hostile issuer can mint a token that dies after a few reads.

## Surprises for later runs

- **`explicit_max_ttl` in a lookup is not the cap.** A token minted from the role reports `explicit_max_ttl: 0` although the role holds 2,592,000 (the brief expected 2,592,000). When the request names `explicit_max_ttl: "9000h"`, the lookup reports 32,400,000 — the request's value — while the token's TTL is still cut to 2,592,000. The cap shows in `creation_ttl`, `ttl` and `expire_time − issue_time` (30 days to the second). Run 5.1 verifies the lifetime from those fields; `TokenInfo.explicitMaxTtlSeconds` proves nothing and should not be used as evidence (or should be replaced by `creation_ttl` when Run 5.1 owns the client).
- **Revoking an accessor that no longer exists answers 200** (a live one answers 204). The answer to `revoke-accessor` therefore does not tell whether a token was alive. The verification after a revoke is a lookup: 400 `invalid accessor` (the typed client returns `invalid`, status 400).
- **An expired or revoked token is refused with 403 `permission denied`**, the same answer as a policy denial. A caller cannot tell "token dead" from "not allowed" by the read alone.
- **Renewing a non-renewable token** answers 400 with only `invalid request`.
- **An expired token is refused before it is gone.** Once its TTL has passed a token is refused at once (403), but under load its accessor can still be looked up (200) for a moment, until the expiration manager removes it (seen in 2 of 4 full integration runs, with the other suites loading the stack; `the token outlives its issuer` now polls for the 400). An inventory taken right after an expiry may therefore list accessors of tokens that no longer work; revoking them is harmless (200).
- **Enumeration is per namespace.** `LIST auth/token/accessors` (operator, `sudo`) shows only the tokens of the namespace it is sent to: a token of `org-A` is not listed in `org-B` nor in the root namespace, and a token of B is not listed in A. Together with Run 2.1's observation (an accessor of another namespace is refused with 500 "cannot lookup token in different namespace"), an operator who must find every machine token walks **every organization namespace**. Run 5.2 (inventory and revocation of unrecorded tokens after a lost issuance answer) does this for the one namespace concerned; Run 6.8 (invalidate every accessor after a restore) must list the namespaces from OpenBao itself (`LIST sys/namespaces`), not only from PostgreSQL, so that a namespace the restored database does not know is not missed.

## What a hostile API process holds (addition to D-17)

D-17 states that the runtime and issuer tokens together can mint a 30-day read token for any environment of their organization. This run bounds that sentence: such a token is always orphan, non-renewable, a service token, without `default`, with exactly one environment's policy and at most 30 days; it cannot be periodic, carry a chosen id, outlive 720 h or read another environment or organization. The issuer cannot mint outside the `machine-env-` family at all.

## Later runs

The fallback is not taken, so no run changes shape. The observations above land in:

- **Run 5.1** — use the sequence above; verify `orphan`, `renewable: false`, `type`, policies, `num_uses: 0` and the lifetime from `creation_ttl`/`expire_time`, never from `explicit_max_ttl`.
- **Run 5.2** — revoke, then verify by lookup (400 `invalid accessor`), not by the revoke answer; the inventory of unrecorded tokens is per namespace.
- **Run 5.3** — archive verification per accessor by lookup, as in 5.2.
- **Run 6.8** — walk every namespace OpenBao lists when invalidating accessors.

Had the fallback been needed, Runs 5.1, 5.2 and 5.3 would have moved issuance, revocation and archive revocation behind a private issuer process.

## What would change this decision

- A later OpenBao release changes any row of the tables above: `issuance.test.ts` is re-run on the new pin before it is adopted.
- The Session 8 review judges the co-resident runtime + issuer blast radius too large (D-17): the separate private issuer process of Doc 10 §8.1 is promoted.
