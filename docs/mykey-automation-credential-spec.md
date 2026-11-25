# MyKey — automation access and long-lived runtime credentials (input specification)

**Status:** an INPUT to a MyKey session plan, not a MyKey decision. Written 2026-11-25
against MyKey `472cda4` (41 routes, Stage 1 open under Gate F HARDEN). Where this
document and the tree disagree, **the tree wins** and the planner records the difference.
Every OpenBao behaviour named here is a hypothesis to be measured on the pinned release,
never assumed.

**What this is.** These are general product capabilities for MyKey, for any application,
platform or pipeline that uses it. **No feature is shaped for one consumer.** After this
work MyKey remains a complete, general secrets service: what exists keeps working
unchanged, and the additions are documented in the API reference, the runbooks and the
workspace like every other feature.

Today MyKey has one non-human principal, the 30-day, read-only machine token bound to one
environment. That serves "start my application with its secrets" well. It cannot serve
three common needs, and this work adds them:

1. **An automation credential.** A non-human principal that can provision (projects,
   environments, secrets, runtime credentials) within a scope the owner chooses, and that
   can never read a secret value.
2. **A long-lived runtime credential.** It is exchanged for short-lived read tokens, so a
   long-running server does not need a person to re-issue its access every 30 days.
3. **Per-secret metadata for machines**: version, created and updated times, never a
   value.

Plus one property of the whole: **after a restore, the automation a person re-authorises
can bring every consumer back. The human cost is one action, not one per consumer.**

---

## 0. Use cases (what each requirement is checked against)

| #   | Use case                                                                                                                                                                                                   | Needs            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| U1  | **A platform that creates a project per customer or tenant.** It makes a project and environment, writes generated secrets, and hands its own workload a read credential, all without a person per tenant. | A1–A9            |
| U2  | **Infrastructure-as-code or CI that bootstraps environments.** It creates an environment, writes values it generated, and must never overwrite a value that already exists.                                | A4–A6            |
| U3  | **Automated rotation.** A job replaces a secret's value with a new one, guarded by the version it last saw.                                                                                                | A6u              |
| U4  | **A long-running server.** It reads its environment at every start for a year without a person in the loop, and its access can still be revoked at once.                                                   | 1.2, M1, the CLI |
| U5  | **Secret-age monitoring.** A consumer reports which values are old, without ever holding them.                                                                                                             | M2, A5           |
| U6  | **Disaster recovery of the consumers.** After MyKey is restored, a person re-authorises once and the automation re-issues every consumer's access.                                                         | §4               |
| U7  | **A fleet boot.** Many servers on one host restart at once, each exchanging and resolving.                                                                                                                 | §2.4 limits      |

---

## 1. Principals

### 1.1 The automation credential (new)

- **Born from a person.** The owner issues it in the workspace with a **fresh TOTP**,
  like `credentials.issue`. Its secret is shown ONCE. It is listed, labelled and
  revocable in the workspace.
- **Scope: within the organization, only the projects it OWNS.** A project it creates is
  owned by it, and the owner may assign an existing project to it or take one back. A
  project it does not own answers the same `404 not_found` as an absent one (§4.1 rule
  5). This matters because a host serves one organization (D-34): automation for one
  purpose must not see the owner's other projects.
- **Rights are chosen at issue from a fixed list** (least privilege; the planner fixes
  the names):
  - `projects.create`: create projects (owned by it) and environments in them.
  - `secrets.create`: write a name that does not exist yet (create-only).
  - `secrets.update`: replace an existing value, ONLY with the expected version (§4.1
    rule 7: there is no force-overwrite). **Optional for the planner**: include it, or
    defer it with a reason.
  - `runtime_credentials.manage`: issue, list and revoke runtime credentials in owned
    environments.
  - Listing owned projects, environments and secret metadata comes with any right.
- **Never grantable:**
  - reading a value, an export or a value in history;
  - delete, undelete, restore or archive;
  - issuing or seeing another automation credential;
  - acting on a project it does not own;
  - reading the organization's audit beyond its own operations.
- **Lifetime:** chosen at issue, within an owner-decided range (recommended 1 hour to
  365 days, default 7 days).
- **Bound source addresses:** a list of CIDRs at issue (recommended mandatory). Any other
  source is refused before a backend is asked.
- **Revoking it revokes nothing it made.** Its projects, secrets and runtime credentials
  keep working, so an automation credential can be replaced without an outage for what it
  provisioned.
- **Owned projects stay the owner's.** The owner keeps every human right on them. The
  workspace shows such a project as "managed by <credential name>".

### 1.2 The runtime credential (new kind, beside today's 30-day machine credential)

- **Bound to ONE environment and read-only**, exactly as today's machine credential.
- **A client secret, shown once at issue.** It is exchanged (M1) for a SHORT-LIVED,
  non-renewable machine token. Recommended TTL 15 minutes, never above 60. That token
  works on the **existing, unchanged** `machine.keys` / `machine.resolve`, and on M2.
- **Lifetime of the credential:** chosen at issue, up to an owner-decided maximum
  (recommended 365 days; "no expiry" is the alternative to decide on). It shows in the
  existing `credential_expiring` warning path.
- **Bound source addresses:** optional at issue, recommended.
- **Issued and revoked** by the owner in the workspace, or by an automation credential
  with `runtime_credentials.manage` on that project.
- **Revocation is immediate at the product**: every machine request already re-reads the
  catalog row (D-42 step 4). Tokens already minted are revoked by accessor, or their TTL
  bounds them. The planner measures which, and says so.
- **The 30-day machine credential stays exactly as it is.** Both kinds are supported, and
  the workspace explains when to choose which.

### 1.3 Where the credential material lives (a design choice for the planner, recommended answer given)

§4.1 rule 1 says "machine tokens are stored nowhere, not even encrypted". **Recommended:**
make both new secrets OpenBao **AppRole secret ids**, one role per credential inside the
organization's namespace, bound by CIDR. Then OpenBao owns the credential material, and
the API proves a presented secret by logging in with it. That is "the token is asked
about itself", as D-42 does today.

- An automation role carries no KV policy. Its login proves identity, and the catalog row
  decides authority (rule 5).
- A runtime role carries exactly `machine-env-<eid>`, so its login IS the short-lived
  machine token.

The alternative is a verifier (a keyed hash) in PostgreSQL, the way recovery codes are
stored. Either way, the planner re-runs the D-17 authority matrix for every new right
and records the hostile-API blast radius in D-17's form.

---

## 2. Surfaces

All new routes go through D-15's `contract:` commit: `ROUTES`, the route test table (41
→ 41 + N), the generated OpenAPI file, the D-15 record, and `AUDIT_COVERAGE`. Every
mutation takes an `Idempotency-Key` and answers with the existing operation envelope;
`uncertain` is resolved by reading the operation, never by a blind retry (§4.1 rule 3).
Paths are illustrative; the planner fixes them.

### 2.1 Automation (auth class `automation`, new)

| Id                                         | Method and path                                 | Right                        | Notes                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A1 `automation.projects.create`            | `POST /v1/automation/projects`                  | `projects.create`            | Owned by the caller. 201 with its id. `already_exists` as today.                                                      |
| A2 `automation.projects.get`               | `GET /v1/automation/projects/:project`          | any                          | By id. Owned only, otherwise 404. State and environments.                                                             |
| A3 `automation.projects.list`              | `GET /v1/automation/projects`                   | any                          | Owned only, paged as today.                                                                                           |
| A4 `automation.environments.create`        | `POST …/projects/:project/environments`         | `projects.create`            | The provisioner builds the scope as today (D-32).                                                                     |
| A5 `automation.secrets.list`               | `GET …/environments/:env/secrets`               | any                          | Names with `version`, `createdAt`, `updatedAt`. **No value, no digest.**                                              |
| A6 `automation.secrets.create`             | `POST …/environments/:env/secrets`              | `secrets.create`             | **Create-only.** An existing name answers `409 already_exists` and changes nothing. Value rules as today.             |
| A6u `automation.secrets.update`            | `PATCH …/secrets/:name`                         | `secrets.update`             | Expected version required; a stale version is refused as today's human update is. Optional (§1.1).                    |
| A7 `automation.runtime_credentials.issue`  | `POST …/environments/:env/runtime-credentials`  | `runtime_credentials.manage` | Name, lifetime, optional CIDRs. 201 shows `{credentialId, clientSecret}` once. D-40's uncertain-issuance rules apply. |
| A8 `automation.runtime_credentials.list`   | `GET …/runtime-credentials`                     | `runtime_credentials.manage` | No secret material.                                                                                                   |
| A9 `automation.runtime_credentials.revoke` | `POST …/runtime-credentials/:credential/revoke` | `runtime_credentials.manage` | D-40's revocation protocol.                                                                                           |
| A10 `automation.operations.get`            | `GET /v1/automation/operations/:operation`      | any                          | Its own operations only.                                                                                              |

### 2.2 Machine

| Id                    | Method and path                                                    | Notes                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 `machine.exchange` | `POST /v1/machine/exchange` (new auth class)                       | Presents a runtime credential: id plus client secret, in a header or the body, never the URL. Answers the short-lived token, its `expiresAt`, the project id and the environment name. Rate-limited, audited as `machine.exchange`. A refused secret is a 401 with no attribution, as D-42 does for unknown tokens. |
| M2 `machine.metadata` | `GET /v1/machine/projects/:project/environments/:envName/metadata` | `{apiMajor, environmentId, generation, count, entries: [{name, version, createdAt, updatedAt}], complete: true}`. No value. Readable by either machine kind. A **new route, not a change to `machine.keys`**, whose strict body shipped CLIs parse.                                                                 |

### 2.3 Human (the owner, in the workspace)

- **Automation credentials:** issue (`human_fresh_totp`: name, rights, lifetime, CIDRs;
  the secret shown once), list (state, rights, expiry, last use, owned projects), revoke,
  assign and unassign projects.
- **Runtime credentials:** issued, listed and revoked beside today's machine credentials.
  The planner chooses between a `kind` on `credentials.issue` and a new route.
- **"Connect an application"** (the existing page) shows both credential kinds and when
  to use each, and never fills in a secret.
- **Owned projects** are labelled with their automation credential.

### 2.4 The CLI, the reference and the runbooks

- **The `secrets` CLI accepts a runtime credential**: it exchanges, then resolves, with
  the same all-or-nothing start and the same exit codes. It also keeps accepting today's
  token. The token step (D-76) gains a matching one-command form for the client secret.
  It is a new CLI release, distributed as D-44 does. **Existing installs and tokens keep
  working unchanged.**
- **The API reference** (`/v1/reference`, the OpenAPI file) documents the automation and
  machine routes for a client in any language, with examples that contain no real value.
- **Runbooks:**
  - `machine-credentials.md` covers both kinds;
  - a new `automation.md` covers issue, rights, ownership, rotation, revocation and
    recovery after a restore;
  - `known-limits.md` names every new residual;
  - the agent guide (D-79) and its consistency test cover the runtime credential if the
    CLI does.
- **Limits** go in `limits.ts`: exchange per credential and per source, automation
  requests per credential, and credential issuance. The fleet boot (U7) must pass under
  the defaults, or the defaults move by decision.

---

## 3. Rules this work must keep (MyKey Doc 10 §4.1, each mapped)

| Rule                                   | How                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 One owner per fact                   | Values stay in OpenBao only. Credential material lives in OpenBao (§1.3) or as a verifier, never as a stored token.                                            |
| 2 No secret on a forbidden surface     | The automation secret, client secret and exchanged token stay out of logs, job payloads, URLs, evidence and Git. The canary sweeps cover the three new shapes. |
| 3 A timeout is not a failure           | Every automation mutation is an operation with an idempotency key, and `uncertain` is resolved through A10.                                                    |
| 4 All or nothing                       | Unchanged. M1 only mints the token, and delivery stays `machine.resolve`. The CLI's start stays all-or-nothing.                                                |
| 5 Checked on the server, every request | Rights, ownership, expiry and CIDRs are re-read from current rows on every request. A non-owned project answers the same 404 as an absent one.                 |
| 6 Password alone grants nothing        | Issuing an automation credential needs a fresh TOTP.                                                                                                           |
| 7 No stale writes                      | A6 is create-only. A6u requires the expected version.                                                                                                          |
| 8 Audit before release                 | Every new route is in `AUDIT_COVERAGE`. The exchange audit row is committed before the token leaves.                                                           |
| 9 A restore starts closed              | Both new kinds are revoked by a restore (D-55). See §4.                                                                                                        |
| 11 Say `unknown`                       | Expiry and last-use readings of the new kinds show `unknown` when they cannot be read.                                                                         |

## 4. Restore

A restore revokes every automation and runtime credential (rule 9 holds). **Recovery of
the consumers costs the owner one action per automation credential**: issue a new one.
Its holder then re-issues the runtime credentials of every project it owns, with no
further person.

The restore runbook names that step. `reconcile-credentials` covers both new kinds, and
the restore window's cost (today about 16 s per environment against a 2-hour root-token
window) is re-measured with them included.

## 5. Not in scope

- Folders or paths in an environment; any change to the secret or environment name rules.
- Any non-human principal reading values except through a runtime or machine credential.
- Delete, undelete, restore or archive by automation.
- A second organization per host; multi-tenant and team features (Stage 2's
  hypothesis).
- Changes to the bodies of `machine.resolve` or `machine.keys`.
- Workload-identity federation (OIDC from CI providers, cloud identities). It is a later
  stage in Doc 02's map, and nothing here may block it.
- OpenBao Agent, a second queue, a workflow engine, Redis (Doc 10 §4.2).

## 6. Acceptance: what "done" means

Each item is a test or a staging measurement, with a control. Fixtures are synthetic and
generic: a "tenant provisioner" script and a sample server, not any real consumer.

1. **Issue.** The owner issues an automation credential with a fresh TOTP, with chosen
   rights. The secret is shown once, and a second view shows nothing. Issuing without a
   fresh TOTP is refused.
2. **Provisioning (U1).** With the automation credential only, a script makes a project
   and an environment, writes 25 synthetic secrets create-only, and issues a runtime
   credential. Each step is timed.
3. **Create-only and update (U2, U3).** Re-writing an existing name answers 409, and the
   value is unchanged. If A6u is built: an update with the current version succeeds, and
   with a stale one it is refused and the value is unchanged.
4. **Least privilege.** For each right withheld at issue, the matching route is refused,
   and a credential that holds the right succeeds.
5. **The boundary.** The automation credential:
   - reading any value → refused;
   - delete or archive → refused or no route;
   - acting on a project it does not own → 404, the same bytes as for an absent id;
   - from a non-bound address → refused before OpenBao is asked.

   Each is paired with a control that succeeds.

6. **Runtime (U4).** Exchange, then `machine.resolve` returns all 25 with
   `complete: true`. The exchanged token is refused after its TTL. A wrong client secret
   answers 401 with no audit attribution. The CLI starts a sample application from a
   runtime credential, and starts nothing when the exchange is refused, with the
   documented exit code.
7. **Metadata (U5).** M2 and A5 return version and times for every name, and no value.
   The sweep finds no value in either body.
8. **Fleet boot (U7).** 10 runtime credentials from one source, each doing exchange +
   resolve twice within 20 s, all succeed under the default limits.
9. **Revocation.** Revoking a runtime credential makes its next exchange 401, and a token
   it already minted is refused at the product immediately (and in OpenBao, as measured).
   Revoking an automation credential leaves its runtime credentials resolving.
10. **Uncertain issuance.** The D-78 trigger places a fault inside an automation
    issuance; the next issuance is blocked; `reconcile-credentials` settles it.
11. **Restore (U6).** A staging restore revokes both kinds. One issuance, then an
    automation-only script re-issues every runtime credential. The time is recorded.
12. **No regression.** Today's 30-day credentials, CLI `cli-v0.1.2`, and every existing
    route and test behave exactly as before.
13. **No leak.** The three new secret shapes are found zero times in logs, a `pg_dump`,
    the access log and the CI logs, with a control found each time.
14. **The authority matrix**, regenerated, with every new identity and right.
