# Document 04 — MyKey Stage 1 Functional Specification

**Working product name:** `mykey` (placeholder)  
**Product shape:** Stage 1 — **MyKey Private**  
**Version:** 0.3 — final pre-implementation functional-contract audit  
**Date:** 7 November 2026  
**Intended engineering start:** week beginning 9 November 2026 (not approval of proof-dependent implementation or a release deadline)  
**Governing proposed product:** Document 03 — *MyKey Stage 1 Mission Brief* v0.3 pre-implementation audited  
**Strategic context:** Document 01 — *MyKey Project Northstar* v0.2 (unchanged); Document 02 — *Project Stage Breakdown* v0.3 pre-implementation audited  
**Inherited functional baseline:** `1-02_stage_1_functional_specification_v2.1_audited(1).md`  
**Inherited mission:** `1-01_stage_1_mission_brief_v2.1_audited(1).md`  
**Technical source documents:** inherited `1-03` Technical Audit v2.0 and `1-04` Technical Specification v2.1  
**Next:** Document 05 — Technical Audit; then Document 06 — Technical Specification  
**Status:** **FINAL PRE-IMPLEMENTATION AUDIT REVISED — CANDIDATE FOR GOVERNING APPROVAL, NOT IMPLEMENTATION-APPROVED.** This edition preserves the supplied 88 inherited FR texts and 44 inherited AC texts without weakening or renumbering them, preserves the 24 named proof IDs as OPEN, and retains the proposed 14 additional FRs/16 additional ACs. It updates authority references, clarifies independent KMS seal-key loss and storage-lock/backup maintenance as binding interpretations, and makes release versus post-release acceptance accounting unambiguous. Governing P-01/P-02/P-03 and original inherited `1-01`–`1-04` texts were not among the files independently reviewed in this final pass. Their authoritative comparison and approval remain blockers. No technical proof is represented as passed, and the approximately 400-hour target remains unverified.

> **Functional contract:** MyKey Private is a complete, self-managed, single-real-owner application secrets product. The owner can authenticate, manage projects/environments and versioned values, use and revoke one-environment machine credentials to launch supported applications without routine plaintext dotenv files, understand actual operation and credential state through an excellent interface, and recover the service safely after host loss. A separate, tightly controlled agent-initiated validation exercise uses this same shipped machine path. Each included workflow covers setup, legitimate execution, denial, interruption, status, lifecycle, and recovery. No included feature may be called complete while an essential path is mocked, disabled or deferred to a future stage.

## Audit and authority disposition

The prior v0.2 audit reports a side-by-side reconciliation against inherited `1-02` v2.1. In the **present** final pass, the uploaded v0.2 Document 04 and locally available revised Documents 01–03 were inspected in full, the numbered inventories and acceptance gates were checked, and selected external technical claims were verified against vendor documentation. **The 88 inherited functional requirement identifiers (FR-1.01–FR-1.88), 44 inherited acceptance identifiers (AC-1.01–AC-1.44), and 24 inherited proof identifiers (PO-1–PO-24) are all present once in their registers.** This pass did **not** receive the original `1-02` or P-series records for a fresh verbatim side-by-side comparison; prior provenance claims must not be mistaken for an independently repeated comparison. The 14 proposed FRs and 16 proposed ACs remain, with narrowly amended proposed text. All technical proofs remain **OPEN**. This is a functional/contract-consistency audit, not an executed proof or a verified 400-hour estimate.

**Critical gate distinction:** Stage 1 has a **controlled-use release** of a fully functioning product and a **later stage-completion gate** for actual first-real-consumer onboarding evidence, 28-day field observations, the bounded agent-initiated experiment, and any explicitly assigned long-aging evidence not source-required before release. Later observations cannot be prerequisites for releasing the product that must generate them. All approved requirements must close by stage completion, while every **release-applicable** requirement, acceptance scenario and proof must pass before real application secrets are introduced. AC-1.52 is **release-only, synthetic**; AC-1.58 verifies subsequent **real-consumer** onboarding and daily use. Retention/lock-aging proofs must be allocated from the authoritative P-series and inherited contracts, never moved after release solely because they take time. See §12.2.

## How to interpret and approve this document

- **Authority hierarchy.** Project strategy is in Documents 01–02 (using audited Document 02 v0.3). Document 03 v0.3 determines Stage 1 product mission and boundaries. This document defines **observable** Stage 1 behavior. Document 05 independently verifies component and vendor assertions; Document 06 prescribes protocols, routes, schemas, platform pins and implementation mechanisms. Document 07 derives session-sized workloads and dependency order; Document 08 contains executable session runbooks. Any conflict with authoritative P-01/P-02/P-03 must be resolved explicitly rather than guessed away.
- **Preservation rule.** Requirements **FR-1.01–FR-1.88** and scenarios **AC-1.01–AC-1.44** are inherited intact in substance from the audited v2.1 source, including their exact security and operational commitments. Their original identifiers are not reassigned. This draft makes no implicit deletions. **FR-1.89–FR-1.102** and **AC-1.45–AC-1.60** are *proposed additions* implementing the new mission emphasis; they become mandatory only when this revised functional baseline is approved. A future approved reduction must identify each displaced FR/AC/PO, replacement, residual risk and synchronized document changes.
- **Behavior vs mechanism.** Descriptions of backend state or storage are binding externally observable invariants (e.g. no recoverable token in application storage); algorithms, database schema, choice of cryptographic adapter, operational commands and measured feasibility belong in Documents 05–06. Legacy mentions of a specific component are **conditional design constraints requiring proof**, not assertions that integration works.
- **Complete means closed.** The product functionality offered at controlled-use release includes direct authorization/negative-path verification and operator recovery steps. The release is not permitted to contain nonfunctional buttons, sample-only credentials, untested manual recoveries, fictitious green health, or silently retried mutations. **Synthetic credentials are permitted only in test fixtures; the shipping credential lifecycle is real and tested.** Stage completion additionally requires at least 28 days/four weeks of actual daily field use, the bounded agent validation exercise and a recorded go-forward decision.
- **Evidence statuses.** `PLANNED`, `SPIKE-PASS`, `INTEGRATED-PASS`, `FIELD-OBSERVED`, `FAILED`, `BLOCKED` and `DEFERRED` have the precise meanings in Document 03 Appendix B. `SPIKE-PASS` never satisfies a release acceptance case; a `DEFERRED` item may not be visible as a shippable feature.
- **Budget.** Approximately 400 hours is a **soft scoping target**, not a waiver. A bottom-up estimate in Document 07 must include the full accepted scope, proof execution, security review, documentation, cross-platform validation, recoverability, integration, DX, and field correction. If infeasible, amend whole capability slices with governing approval or approve an overrun; do not ship a work in progress.

### Contract inventory

| Source / proposal | Numbered items | Interpretation |
| --- | ---: | --- |
| Inherited v2.1 functional requirements | 88 (FR-1.01–FR-1.88) | Preserved as candidate binding baseline; source-provided security details remain explicit |
| Proposed Stage 1 mission additions | 14 (FR-1.89–FR-1.102) | Owner DX, truthful information and analytics, operator boundary, agent experiment, validation records |
| **Total candidate functional requirements** | **102** | Every approved FR must receive a test or documented acceptance mapping |
| Inherited v2.1 acceptance cases | 44 (AC-1.01–AC-1.44) | Retained; tested against real services and synthetic credentials |
| Proposed acceptance cases | 16 (AC-1.45–AC-1.60) | DX, operator disclosure, agent and evidence gate additions |
| **Total candidate acceptance cases** | **60** | 56 controlled-use release cases (44 inherited + 12 added); 4 added stage-completion cases (AC-1.53, -1.54, -1.58, -1.59). AC-1.58 alone owns the first-real-consumer follow-up |
| Inherited technical proof obligations | 24 (PO-1–PO-24) | **OPEN**, until verified or formally replaced; owned by Documents 05–08 |

**Gate safeguard:** The approved release manifest closes release-specific acceptance and all applicable security/integration proof obligations before real-secret use, **including inherited AC-1.36 and AC-1.44 by default**. It lists the four post-release field/agent cases as **NOT YET DUE**, never PASS, and records their owners/closure conditions. The first real non-critical consumer must be connected and documented *after* this authorization and *before* the 28-day observation period is credited; that evidence is tested by AC-1.58, not by an incomplete release acceptance case. As presently classified, **inherited AC-1.36 and AC-1.44 are release cases**, so their genuine lock-aging/cleanup and oldest-eligible-pair evidence are release blockers to the extent demanded by their wording; a later gate is permitted only through an explicit signed source reconciliation and change to the acceptance register—not a fifth tacit post-release waiver. A later-stage case may not conceal an unfinished security or usability feature offered at release.

**Scope safeguard:** One real owner, one real organization, external operator tooling, a supported first non-critical consumer and synthetic multi-tenant test fixtures are the declared Stage 1 deployment. This does not offer public signup, invitation/team management, a hosted multi-tenant commercial SaaS, workload federation, delegated agent policy, arbitrary agent execution, automated rotation/dynamic secret engines, HA or an integrated external-agent observability platform.

---

## 1. Domain and authority

One operator/owner and one organization use Stage 1 daily. Additional organizations and roles exist only as synthetic test fixtures. The product scope remains the mission brief’s scope; requirements below make its failure and recovery behavior explicit. There are no invitation, membership-management, grant-management, or public organization-creation routes.

| Entity | Meaning and source of truth |
| --- | --- |
| Organization | Tenant boundary in PostgreSQL; maps to one OpenBao namespace |
| Membership | One user’s owner/admin/member role in an organization; PostgreSQL |
| Project / environment | Immutable scope identifiers with editable display names; PostgreSQL |
| Grant | Reader/editor authority for a project or environment; PostgreSQL |
| Secret / version | Named application value and its revision history; OpenBao only |
| Machine credential | Read-only OpenBao token; PostgreSQL stores accessor, binding, lifecycle, and attribution, never the token |
| Operation | Durable record of accepted work, expected state, outcome, and reconciliation; no values |
| Audit event | Attributable action/outcome; application and OpenBao audit, no sensitive payload |

Identifiers are opaque, immutable, and never reused. Project/environment display names never determine backend paths; immutable secret names remain part of secret addressing. Renaming preserves grants, history, and credential bindings. PostgreSQL is authoritative for application authorization; OpenBao is authoritative for token validity and secret contents. Neither store’s availability permits bypassing the other.

### 1.1 Authorization matrix

This matrix applies only when resource state permits the action.

| Action | Owner/admin | Member: editor | Member: reader | Member: no grant | Machine |
| --- | --- | --- | --- | --- | --- |
| Manage projects/environments | Organization | No | No | No | No |
| List names; read current values; export | Organization | Granted scope | Granted scope | No | Bound environment, current values only |
| Read history/historical values | Organization | Granted scope | Granted scope | No | No |
| Create/update/delete/undelete/restore/import | Organization | Granted scope | No | No | No |
| Issue/list/revoke machine credentials | Organization | No | No | No | No |
| View application audit | Organization | No | No | No | No |
| Provision organizations; reset accounts; restore service | No web role | No | No | No | No |

Project grants cover all environments; grants combine by union. An environment grant cannot narrow a project grant. Readers can see plaintext. Infrastructure operator authority is separate from every web role.

### 1.2 State precedence

The service gate overrides all other state. Otherwise authenticate and establish resource visibility before returning resource-state errors. Organization state restricts project state, then environment state, then credential/key state. A child cannot bypass a restrictive parent. Revocation and operator reconciliation remain available as access-reducing actions when their identity, audit, and backend prerequisites can be met; they never reopen a blocked scope.

| Resource / state | Permitted behavior |
| --- | --- |
| Service `quarantined` | Public product/auth/reference routes refuse; health says down; maintenance shell contains no protected data. Operator-only recovery verification is permitted |
| Organization `provisioning`, `failed`, `needs_review` | No ordinary product access; operator inspection/reconciliation only |
| Organization `active` | Apply child states and authorization matrix |
| Project/environment `pending` | Authorized human secret workflows allowed once the KV scope is verified; no machine access or credential issuance |
| Project/environment `active` | Apply authorization matrix |
| Project/environment `revoking`, `archived` | Authorized human reads/history/export only; no writes, imports, restores, issuance, or machine access |
| Project/environment `needs_review` | No secret access or issuance; authorized users may inspect non-secret status |
| Credential `issuing`, `revoking`, `revoked`, `expired`, `needs_review` | Never authenticates to the product API |
| Credential `active` | Requires valid backend token, unexpired binding, active parents, and open service gate |
| Key `needs_review` | Status/history metadata visible; value reads and mutations refused; whole-environment resolution/export fails |
| Current secret version deleted | Name shown as recoverable to humans; omitted from ordinary current values and machine keys; human historical reveal/undelete follows version rules |

## 2. Accounts and sessions

| ID | Required behavior |
| --- | --- |
| FR-1.01 | **Bootstrap.** Operator tooling creates the owner account and membership idempotently. Every HTTP account-creation path is disabled server-side. Bootstrap is unavailable in the public process. |
| FR-1.02 | **Authentication.** Password success alone grants no product access. The session must have completed TOTP or a valid recovery-code challenge. Checking that an account has MFA enabled is insufficient. Trusted-device bypass is disabled server-side. Cookies are Secure, HttpOnly, host-only, and SameSite=Strict. Sign-out invalidates the server session. |
| FR-1.03 | **Enrollment/recovery codes.** Enrollment-pending accounts may only finish password authentication, enroll/verify MFA, or sign out. Password-reset redemption remains available under FR-1.04. TOTP uses six digits and a 30-second step; enrollment requires a valid code. Accept a TOTP step at most once per user/enrollment across processes; reuse of a recent verification follows FR-1.77. Issue ten one-time recovery codes, persist verifiers only, and consume atomically. Regeneration requires fresh TOTP and invalidates the old set. If one-time display is lost, regenerate after verification; never recover old codes. Disabling MFA is not public. |
| FR-1.04 | **Operator reset.** Host tooling initiates reset, atomically marks the account recovery-pending, invalidates sessions/login challenges, and supersedes prior reset links. Ordinary sign-in/product access stays blocked until recovery completes, even if a link expires. Password reset prints a single-use 15-minute link locally, never email. Redemption over HTTPS only completes that reset; it cannot initiate reset or create an account. Keep the token out of server request URLs/logs/referrers. Password-only recovery retains the current MFA requirement; MFA reset invalidates its seed/codes and requires enrollment. Completion invalidates interim credentials and requires fresh authentication. Record the action without tokens. |
| FR-1.05 | **Password change.** Requires the current password and fresh TOTP verification. Revoke all other sessions. A recovery-code login alone does not satisfy fresh TOTP. |
| FR-1.06 | **Session lifecycle.** List creation, last use, and client description; revoke one or all. Expire after 30 minutes without authenticated user activity or 12 hours from authentication, whichever comes first. Automatic background polling must not keep an unattended session alive; the client explicitly signals user activity and the server caps absolute lifetime. State the activity convention in the API contract. Revocation/sign-out takes effect on the next new request. |
| FR-1.07 | **Throttling.** Limit failed password and second-factor attempts per source and account across API processes. Recovery-code attempts share second-factor protection. Within each authentication phase, failure responses do not disclose account existence or distinguish incorrect, expired, or replayed credentials. |
| FR-1.76 | **Browser protection.** Cookie-authenticated state changes require validated origin/CSRF protection; reject credentialed cross-origin use. Serve CSP with no inline or third-party scripts, no framing, and no referrer leakage. Assets are local; no runtime third-party code or telemetry. Missing or forged origin metadata is not a bypass. |
| FR-1.77 | **Fresh verification.** Starting human export, credential issuance, password change, or recovery-code regeneration requires successful TOTP verification within ten minutes, bound to the current session and current MFA enrollment. A recent session alone does not qualify. Otherwise return 403 `fresh_verification_required`; after verification retry under the operation/replay rules. Status inspection or replay of a completed non-secret result does not start a new effect and does not require a new TOTP challenge. |

### 2.1 Permitted authentication storage

This table is part of FR-1.02–FR-1.06 and FR-1.80. The technical audit must prove compatibility with the selected Better Auth/Drizzle integration; unsupported behavior is a blocker, not an implicit relaxation.

| Material | Permitted persistent representation / removal |
| --- | --- |
| Password | Password verifier only; replaced on change/reset |
| TOTP seed | Authenticated encryption under protected authentication key material outside the database; replace/remove on MFA reset |
| Recovery code | One-way verifier only; consumed atomically; old set removed on regeneration/reset |
| Reset token | One-way verifier, purpose, owner, expiry, consumption state; remove verifier at consumption/expiry |
| Session credential | Non-recoverable verifier preferred; authenticated encryption permitted if required by the proven adapter integration. No plaintext bearer credential in database/backups. Revoke immediately; remove usable representation at expiry/revocation |
| Session/challenge metadata | Identity, authentication phase, expiry, last activity, fresh-TOTP time; no codes. Incomplete login/enrollment challenges expire within ten minutes |
| Machine token | OpenBao only; no application persistence, including encrypted copies |
| Service authentication keys | Protected operator-managed secret storage, never application tables, jobs, or logs; off-host recovery arrangements documented |

Browser session cookies and transient enrollment/reset displays are intentional delivery surfaces, not permission to copy credentials into localStorage, sessionStorage, IndexedDB, caches, or diagnostics. Expired authentication records may retain non-secret audit metadata; daily cleanup removes expired credential representations not already removed at use/revocation. Application audit retention is FR-1.81. Backups retain encrypted authentication records/verifiers until backup expiry; removal from the live database is not erasure from backups, and restored records remain subject to FR-1.86.

## 3. Organization and resource lifecycle

| ID | Required behavior |
| --- | --- |
| FR-1.08 | **Organization provisioning.** Operator-only tooling creates namespace, required KV configuration, scoped identities, and owner binding. One operation ID survives interruption/retry. Set `active` only after read-back proves the complete configuration; otherwise remain non-serving and retryable without duplicate namespaces or broader rights. |
| FR-1.09 | **Tenant resolution.** Resolve organization/project/environment ownership on the server. Reject caller-supplied OpenBao namespaces, raw paths, policies, or selectors. Never derive access from a client role claim. |
| FR-1.10 | **Current authorization.** Every protected request reads current membership, grants, and parent/resource state. No cached authorization. Revocation committed before a request starts must deny that request. Work already authorized may finish; no promise recalls previously disclosed data. Mutations recheck state at their admission boundary so they cannot begin new effects after archive/revocation has taken precedence. |
| FR-1.11 | **Hidden resources.** An authenticated caller unable to access a resource receives the same 404 code/message shape as for an absent resource; only correlation metadata differs. No names, tenant IDs, versions, or other existence clues are returned. No claim of identical network timing is made. |
| FR-1.12 | **Backend inconsistency.** Missing or mismatched required namespace, mount, policy, or token role produces 503 `backend_inconsistent`, a review state on the narrowest safe scope, and an alert. No fallback to a broader identity or cached values. If the scope cannot be established safely, block the organization. |
| FR-1.13 | **Privilege separation.** Public processes hold no root/global provisioning authority. Per-organization runtime, issuer, and provisioner rights are bounded and tested directly against OpenBao. Operator tooling alone holds infrastructure-level authority. |
| FR-1.14 | **Projects.** Owners/admins create/rename projects. Normalize names to NFC; allow 1–64 Unicode code points, excluding control characters and whitespace-only names. Uniqueness is case-sensitive after normalization; preserve other whitespace. Creation durably records the project and its `development` environment as one application operation; backend provisioning may complete asynchronously. |
| FR-1.15 | **Environments.** Owners/admins create and rename environments with names matching `^[a-z][a-z0-9-]{0,62}$`, unique within the project. IDs and paths never change on rename. |
| FR-1.16 | **Readiness.** New environments are `pending` until their machine policy/token role is verified. Human secret management is allowed only after the organization/KV scope is verified. A provisioning failure becomes `needs_review` and alerts; no credential is issued while pending. |
| FR-1.17 | **Archive.** Confirmation identifies affected scopes and active/unfinished credential issuance. Enter `revoking` before further machine access or mutations can be admitted. Finish or reconcile previously admitted effects, revoke every affected credential in OpenBao, and verify absence before `archived`. Interrupted archive resumes safely; failed verification remains non-serving to machines and alerts. Project archive includes every environment; concurrent environment creation/issuance cannot escape it. |
| FR-1.18 | **Reactivate.** Owner/admin reactivation verifies backend readiness before writes resume. Revoked credentials never return. Project reactivation preserves environments that were independently archived before the project archive; only those archived by that project operation are eligible for automatic reactivation. |
| FR-1.19 | **No deletion.** No Stage 1 route deletes projects, environments, or their entire history. Automatic version retention remains permitted. |

## 4. Secret lifecycle and operation safety

| ID | Required behavior |
| --- | --- |
| FR-1.20 | **Values.** Names match `^[A-Z][A-Z0-9_]{0,127}$`; `SECRETS_` prefix is reserved. Names are unique per environment and cannot be renamed. Values are valid UTF-8, at most 65,536 encoded bytes, multiline allowed, no NUL. Empty values are valid. Validation errors never echo values. |
| FR-1.21 | **Metadata.** Bounded name-only search/listing shows current version, opaque state tag, live/deleted/review state, and change time. Human listings retain recoverable names. Search never examines values. Define stable ordering/cursor semantics; changed pagination must not silently be used as a coherent complete-environment read. |
| FR-1.22 | **Reveal.** Mask by default; reveal one current or historical value only by explicit action. `no-store`; no values in URLs, browser persistence, query/mutation caches, telemetry, or errors. Keep values only in the displaying component and clear on hide, navigation, sign-out, or 30 seconds, whichever comes first. Clearing state is not a memory-zeroization guarantee. |
| FR-1.23 | **Copy.** Copy only by explicit action; state that clipboard contents cannot be recalled. Never put values in confirmation text or toasts. |
| FR-1.24 | **Create.** Creation succeeds only for a name with no version history, including deleted history. Existing history returns 409; never interpret creation as overwrite. |
| FR-1.25 | **Update.** Require expected current version and state tag. Missing precondition returns 422; stale version/tag returns 409 with safe current metadata. Update requires a live latest version; a deleted key must first be explicitly undeleted or restored. No last-writer-wins or force-overwrite control. |
| FR-1.26 | **History.** Show version, time, actor, and state; value reveal is separate. Retain the last 20 versions. Older versions become unavailable. Attribute reconciled operations from their durable records; label out-of-band changes as unknown/operator-external rather than inventing an application actor. |
| FR-1.27 | **Soft-delete.** Require confirmation, expected current version, and state tag. Delete only that live version and verify before success. A deleted latest version never falls back to an older live value. A second delete with a new operation key conflicts; a replay of the original operation follows FR-1.83. |
| FR-1.28 | **Undelete.** Require the expected deleted latest version and state tag; reject a newer version, live current state, or stale tag. Restore that same version after verification and advance the state tag, without creating another version. |
| FR-1.29 | **Restore version.** Require the source historical version and expected current version/state tag. Write the available source as a new current version, whether the current version is live or deleted. Deleted/destroyed/unavailable sources cannot be restored through this action. Advance the state tag on success. |
| FR-1.30 | **Concurrency.** Serialize key mutations across processes; recheck resource state and preconditions inside that boundary. State tags must change after every successful update/delete/undelete/restore and after reconciliation, even if version and visible state return to earlier values. Never derive the tag solely from version or live/deleted state. A stale/conflicting operation gets 409; capacity exhaustion gets 503 `busy`. Backend check-and-set additionally protects supported writes. Direct operator changes require maintenance quarantine and reconciliation. |
| FR-1.31 | **Unknown result.** A timeout, lost connection, or interrupted process after a possible backend effect never becomes a definite “not applied.” Return 503 `outcome_unknown` with operation ID where a response is possible; expose the durable operation as unresolved after recovery. Mark the affected scope for review, block conflicting work, and do not automatically repeat the effect. |
| FR-1.32 | **No destruction interface.** Users cannot permanently destroy versions or metadata. Retention is configured by the operator, not bypassed through an API selector. |
| FR-1.82 | **Durable operation lifecycle.** Before an application-driven OpenBao mutation/token effect, durably record actor, target, preconditions, and replay identity without values. Use the operation states below. Admission, concurrent retries, execution ownership, and resource exclusion must agree across processes. Record outcome/audit linkage durably; an external effect cannot be tracked only in a transaction lost on crash. Covers secret changes, issuance/revocation, provisioning, and archive; product metadata-only changes commit their outcome with their database change. |
| FR-1.83 | **Replay contract.** Product mutations supply a principal/action/target-scoped idempotency key; operator workflows use a durable operation ID. Read-like POSTs and auth challenges are excluded. Bind intent to a protected fingerprint with no offline secret-guessing oracle. Authenticate and authorize before replay/status lookup. Same-key retries never repeat completed effects; changed payload/preconditions get 409. An eligible import may explicitly resume safe unattempted entries. Retain terminal records for at least 30 days and unfinished records until resolved; expose the replay expiry. Do not retry after expiry automatically or substitute a new key after an uncertain result. Credential tokens are never replayed. |
| FR-1.88 | **Reconciliation.** Operator-only tools correlate durable intent, backend state, and audit. Mark success only from attributable evidence; mark no-effect rejection only after excluding both a completed effect and a request/worker that can still complete later. A single absent read after timeout is insufficient. Do not release exclusion or admit a replacement while old execution can act. Keep scope blocked if evidence is insufficient. Record references, never values. Executing work with no progress for two minutes alerts; intentional `awaiting_input` is not a stuck execution. Recovery handles unfinished work before conflicting traffic. |

### 4.1 Operation states

| State | Meaning / permitted next step |
| --- | --- |
| `accepted` | Intent durable; no effect started. Execution or verified no-effect rejection may follow |
| `executing` | An executor owns the operation; duplicate requests return status, never start another executor |
| `awaiting_input` | Import paused without retained file bytes; no child effect remains uncertain or executing. An authorized exact-file resubmission may resume |
| `uncertain` | A backend effect or completion record cannot be established; operator reconciliation required before conflicting work |
| `succeeded` | Terminal; all intended effects verified, including an import whose entries all succeeded or were unchanged |
| `partial` | Terminal import only; some entries completed and others were rejected/conflicted or explicitly abandoned; every outcome is known |
| `rejected` | Terminal; no intended effect occurred and none can occur later |

Awaiting input holds no mutation exclusion; later changes may cause a conflict on resumption. A crash does not prove rejection. Reconcile executing children before moving an interrupted import to `awaiting_input`; resume using the original per-key preconditions. A completed `partial` import is not resumed: preview remaining work as a new operation. If any outcome is unknown, the parent remains `uncertain`. Operator tooling may close abandoned work only after proving no pending effect; preserve completed entries and report `partial` where applicable.

The operation status API requires the same scope authorization as the operation and returns no request payload or fingerprint. Revoked callers do not regain status access through a known operation ID. HTTP timeout, client disconnect, or cancellation is not evidence that an operation stopped. Operator writes outside the service are maintenance actions: close the affected service access first and reconcile before reopening.

## 5. Dotenv and complete-environment reads

| ID | Required behavior |
| --- | --- |
| FR-1.33 | **Format v1.** UTF-8 without BOM; LF/CRLF lines; `NAME=value`. Accept empty values, whole-line `#` comments, and empty lines. Unquoted values have no leading/trailing whitespace and none of `#`, quotes, backslash, or tabs; interior spaces are accepted. Double-quoted values accept only `\n`, `\r`, `\t`, `\\`, and `\"` escapes; no raw CR/LF. Reject `export` prefixes, single-quoted syntax, duplicate names, invalid UTF-8, NUL, unknown escapes, and trailing inline comments. `$` is literal data: never evaluate interpolation. Canonical export double-quotes every value, sorts names, uses LF, and ends with newline. |
| FR-1.34 | **Loader compatibility.** Document and test canonical output with pinned Next.js and python-dotenv loaders. Warn by key name when either loader changes the value, including expansion or escape differences. Canonical export remains lossless for this service’s parser; do not claim universal dotenv compatibility. |
| FR-1.35 | **Preview.** Parse in memory for one environment; show validated names, classifications/counts, and line/rule errors without echoing invalid input. Classify create/update/unchanged/invalid/duplicate/conflict. Bind actor, environment, exact file bytes using the protected fingerprint contract, and observed per-key versions/state tags. Expire after 15 minutes. Persist no values/files; delete unused preview metadata after expiry. Invalid/duplicate entries block apply until corrected/re-previewed; existing deleted/review keys are conflicts. |
| FR-1.36 | **Apply.** Resend the bound file; reject mismatch, expired/unowned preview, or unauthorized scope before acceptance. Apply valid entries with preview preconditions through the common mutation contract. Report created/updated/unchanged/conflict/rejected/uncertain/not-attempted per key. Recheck even unchanged entries. Deleted names are conflicts, never implicit undeletes. On interruption, reconcile started entries, then allow explicit same-operation resumption of safe unattempted entries; never replay uncertain/completed effects. Preview expiry blocks new apply, not an already-accepted operation; resumed work requires current authorization and exact bound bytes. Parent status follows §4.1; partial is never presented as complete success. |
| FR-1.37 | **Export.** Human export requires fresh TOTP, explicit confirmation, `no-store`, attachment disposition, a sanitized filename, and a plaintext warning. No reusable download URL. The service writes no plaintext export file. |
| FR-1.38 | **Round trip.** Export and re-import into an empty environment reproduce all live names and values exactly, including empty values, Unicode, quotes, backslashes, and literal dollar sequences. Deleted keys are excluded. |
| FR-1.84 | **Complete read.** Machine resolution and human export produce a coherent live environment set; an empty environment yields an empty set. Coordinate with mutations or detect change and return 409 `environment_changed`. Resolve/validate every key and required audit before releasing values; any key/review/backend/capacity failure rejects the set. Do not deliberately return a partial set. Transport can truncate a response: CLI/browser must verify full completion and discard it without launch/export. Import is not atomic; a completed subset between entries is a valid point-in-time state. |

Limits on bytes, entries, total returned values, and concurrent work are specified before implementation under FR-1.60. “Complete” never means unlimited memory use; an oversized environment fails with a capacity error before CLI launch or export.

## 6. Machine credentials

| ID | Required behavior |
| --- | --- |
| FR-1.39 | **Issue.** Owner/admin with fresh TOTP issues for an active environment. Lifetime is a positive whole number of seconds, maximum/default 30 days, non-renewable; zero, negative, and excessive values fail validation. Durably record issuance before creation and verify policy/role. Return the token only in the original successful response with `no-store`, after accessor/binding/state are durable. Activation and archive are ordered so no token becomes usable after archive takes precedence. The expiry displayed is the effective backend expiry, which may be shorter than requested. |
| FR-1.40 | **Native scope.** OpenBao permits data reads and name listing for the bound environment, plus only the token’s self-lookup needed by the API. Deny writes, deletes, renewal, token creation, policy administration, and other environments/namespaces. The self-lookup exception is explicit; no default policy may silently broaden it. |
| FR-1.41 | **Inventory.** Show name, environment, issuer, issue/expiry times, lifecycle state, and last use where known; never return token values. Highlight expiry within seven days. Last-use metadata is informational, not an authorization source. |
| FR-1.42 | **Revoke.** Confirmation sets a durable denied state before backend revocation. Revoke by accessor and verify backend invalidity before displaying `revoked`. Transport errors, permission failures, or sealed backend do not prove revocation. Unverified state remains `revoking`/`needs_review`, denies product access, and alerts. Repetition is safe and resumable. |
| FR-1.43 | **Uncertain/lost issuance.** Unknown creation blocks new issuance for the environment until inventory identifies and invalidates unrecorded tokens and excludes delayed issuance. No retry returns a token again or creates another. Concurrent unfinished retries return operation status. A confirmed successful issuance replay returns 409 `credential_not_replayable` plus credential ID/state, even if expired/revoked. After lost delivery, revoke that credential and issue a replacement with a new key. A confirmed no-effect rejection returns its recorded rejection; delivery is never inferred from an HTTP write. |
| FR-1.44 | **Machine routes.** Bearer token only; human and machine authentication are separate. Reject a request presenting both. Resolve scope from product IDs, validate token/accessor binding, expiry, credential state, all parent states, and service gate on every request. Read OpenBao using the presented token itself, never the human runtime identity. Serve current values only; reject version/history selectors with 400. No machine endpoint exposes the token or raw backend response. |
| FR-1.45 | **Residual.** State that native KV read authority can also cover older undeleted versions of a key. The product API restricts machines to current values; OpenBao is private. Do not claim that native policy alone enforces current-version-only access. |

## 7. CLI and credential setup

```text
secrets keys   --project <id> --env <name>
secrets run    --project <id> --env <name> -- <command> [args...]
secrets export --project <id> --env <name> --output <new-file>
```

| ID | Required behavior |
| --- | --- |
| FR-1.46 | **Credential input.** Accept `SECRETS_MACHINE_TOKEN`; accept explicit stdin input only for `keys`/`export`. Never accept a token as a positional argument or flag value. Reject simultaneous credential sources. Never print, persist, or forward the token to the child. `run` preserves stdin for the child. |
| FR-1.47 | **keys.** List live names in the bound environment only. No values/history. Errors use the CLI contract below. |
| FR-1.48 | **run.** Fetch/validate the complete response before spawning. Launch arguments without a shell and without a plaintext file. Remove `SECRETS_*` variables and close token-source handles before launch. Inherited-name collisions fail unless `--override`; reserved names remain forbidden. Check supported argument/environment limits. Forward SIGINT/SIGTERM/SIGHUP/SIGQUIT under tested platform rules, avoid double delivery, and return the child status (128 + signal number for signal termination). Cancellation before spawn launches nothing; an unexpected spawn failure reports a safe category. |
| FR-1.49 | **Failure.** Authentication, scope, archived/review state, quarantine, sealed backend, network/TLS, version mismatch, malformed/incomplete data, and capacity failures launch no child. No cache, partial set, or environment fallback. Report category and server request ID when one exists; locally detected errors say `requestId: none`. The CLI does not automatically retry a mutation or issue a credential. |
| FR-1.50 | **export.** Resolve/validate fully before file creation. Require a trusted destination directory, refuse symlink traversal, and exclusively create a new mode-0600 file; refuse existing paths. On failure remove only this invocation’s partial file when safe ownership/path identity is established. If a concurrent local actor invalidates that assumption, do not unlink a replacement; report cleanup required without content. Never weaken file permissions to complete export. Warn that output is plaintext; success requires complete write, flush, and close. |
| FR-1.51 | **Platforms.** Support Linux x64/arm64 with glibc and macOS x64/arm64; test the chosen distribution on each. Native Windows and other targets fail explicitly. WSL is not a separate support promise; Linux requirements still apply. Signal/file protections cannot be silently weakened. |
| FR-1.79 | **Connection.** Resolve API URL from `SECRETS_API_URL`, else a documented configuration file containing no credential. HTTPS and certificate verification are mandatory; no skip-verification flag. Refuse known runtime options disabling TLS verification or injecting code into the CLI; document the limits of protecting an already-compromised launcher. Check compatible API major version and refuse credential-bearing cross-origin redirects. |
| FR-1.85 | **Setup/rotation.** Provide and execute one complete local-development setup and one first-consumer deployment procedure: install, verify endpoint, issue token, supply through protected host/process configuration, test, rotate, revoke old token, and replace after restore. Do not embed tokens in repository files, shell history, command arguments, images, or logs. Document where the bootstrap credential is held and who can read it. This service replaces application dotenv workflows; it does not eliminate the need to protect its own machine credential. |

**CLI result contract:** launch failures use 64 usage, 65 malformed data, 69 unavailable/network/environment-changed, 73 unsafe export target/write failure, 75 capacity/rate limiting, 76 API incompatibility, 77 authentication/scope/resource denied, or 78 unsupported configuration/platform. `keys`/`export` success returns 0. After a child starts, `run` returns its status; a child may use these same numbers, so an exit code alone does not identify a CLI failure. Signal exits follow FR-1.48. Diagnostic text never includes response bodies, resolved values, or credentials.

## 8. API, browser, and audit

| ID | Required behavior |
| --- | --- |
| FR-1.52 | **Contract.** Product routes are versioned under `/v1`; auth component routes are explicitly inventoried. Generate OpenAPI 3.1 from runtime validation schemas. UI and CLI use the same product contract; detect incompatible changes before release. Publish a non-sensitive version endpoint. |
| FR-1.53 | **No passthrough.** Never accept raw OpenBao paths, namespace selectors, policies, or token administration requests. One-time machine-token issuance is the only product response containing an OpenBao bearer token. |
| FR-1.54 | **Reference.** OpenAPI document and read-only Scalar require a fully authenticated owner/admin. No request execution, public operator routes, live values, telemetry, CDN, or third-party requests. A proof-driven fallback requires a recorded decision before removing Scalar. |
| FR-1.55 | **Operator surface.** Provisioning, account-reset initiation, recovery, reconciliation, and gate control are absent from public service entry points, not merely hidden in documentation. Verification access during restore is private and restricted to operator tooling. |
| FR-1.56 | **Coverage.** Audit authentication success/failure, enrollment/reset/recovery, session revocation, password change, denied access, resource changes, all secret lifecycle actions/reveals, import/export, credential issue/revoke/machine reads, provisioning, reconciliation, backup eligibility, restore, quarantine, and retention jobs. Record timestamp, actor or unauthenticated source category, action, target where safely known, outcome, request ID, and operation ID where applicable. No value, token, code, reset link, or file content. |
| FR-1.57 | **Backend audit.** OpenBao audit writes to an operator-only sink. If required audit cannot record access, the affected access fails closed and an off-host alert fires. Rotation must not silently drop records. |
| FR-1.58 | **Audit view.** Owners/admins filter their organization’s events by resource, actor, action, time, and outcome. Global infrastructure events remain operator-only. Pagination is bounded. |
| FR-1.59 | **Correlation.** Every application-generated HTTP response carries a request ID also used by logs/audit. Proxy-generated HTTP errors are correlated where configured; TLS failures and failures before an HTTP response cannot promise a server ID. Never log a raw incoming request ID without validation. |
| FR-1.80 | **Secret-free diagnostics.** Logs/traces/errors/crash diagnostics never capture request/response bodies containing secrets, auth headers/cookies, codes, reset links, dotenv content, or raw backend payloads. Redaction is defense in depth, not permission to log arbitrary objects. Production diagnostic features that retain process memory or sensitive requests are disabled or excluded from the supported configuration. |
| FR-1.81 | **Audit integrity/retention.** Runtime roles may append/read allowed events, never update/delete. Retain application/OpenBao audit for 365 days; restricted purge is itself audited. Before sensitive action, durably record intent; completion failure after an effect leaves unresolved operation evidence. Before releasing read values, record access authorization/outcome. An interrupted delivery is not proof the caller received values. If audit is unavailable, deny sensitive action and alert; do not claim an audit event was stored when it was not. Operational denial logs are best-effort and secret-free. |

The web interface must expose every owner workflow, including recovery setup, status, conflicts, uncertain operations, partial imports, one-time credential delivery, and maintenance. It displays operator-required recovery instructions but cannot invoke operator-only actions. Reload/cancel is offered for conflicts; no hidden overwrite path. Only metadata may be cached in browser memory. Secret-bearing actions bypass persistent query/mutation caches; sign-out clears application state. Export downloads may persist at the user’s explicit destination, with a warning.

### 8.1 Error envelope

Product API errors use `{error: {code, message, requestId, operationId?, details?}}`; safe metadata only. Better Auth may retain its pinned native response shape for client compatibility: inventory those routes/shapes and provide a tested web-client mapping. Universal auth safety, safe messages, headers, and correlation still apply; do not pretend a wrapper is transparent without proving it. API/auth responses use `Cache-Control: no-store`. A reverse proxy may produce a documented transport-level error instead; clients must fail safely on unexpected bodies.

| HTTP | Stable case |
| --- | --- |
| 400 | Malformed request; forbidden selector; mixed authentication; unsupported history parameter |
| 401 | Missing/invalid/expired authentication; incomplete MFA for a protected route |
| 403 | Known permitted-to-disclose action denied, CSRF/origin failure, fresh verification required |
| 404 | Resource absent or hidden from this authenticated caller |
| 409 | Version/state conflict, environment changed, idempotency conflict, unreplayable token, unresolved key blocking mutation |
| 422 | Valid request shape but invalid name/value/format or missing expected version/state tag |
| 429 | Rate limit; safe retry hint; never indicates that a mutation is safe to replay with a new key |
| 503 | Busy, sealed backend, quarantine, inconsistent state, audit failure, dependency unavailable, or unknown outcome; distinguish by code and operation state |
| 507 | Configured storage/memory/output capacity exceeded |

Accepted/executing/awaiting-input mutation submissions return 202 with operation ID/status location; an unknown-effect response remains 503 `outcome_unknown`. A successful status lookup returns 200 with the actual operation state, never translating `uncertain` into success. Terminal successful or partial import results return 200 with explicit operation state and per-key counts/outcomes; 200 alone is not full import success. Replays return non-secret status; successful credential-issuance replay follows FR-1.43. Authentication/resource checks still run before replay; fresh TOTP is required to start an effect, not merely inspect its status. Inaccessible resources take 404 precedence over revealing their state. Malformed unauthenticated requests do not disclose protected state. Clients never infer success from an HTTP connection close or timeout.

## 9. Limits, health, and recovery

| ID | Required behavior |
| --- | --- |
| FR-1.60 | **Limits.** Bound request bodies, imports, entries, environment resolution size, lists, rates per source/principal, and concurrency. Auth limits apply before expensive work. Counter/limiter failure cannot bypass protection. Initial operational values and overload behavior must be fixed and tested in Document 06; no unbounded endpoints. |
| FR-1.61 | **Disk pressure.** At configured free-space/inode thresholds, refuse state-expanding/content mutations with 507 and alert. Keep reserved capacity for audit and access-reducing operations (sign-out, revocation, archive denial); these still require durable outcomes and cannot claim success on failed writes. Reads continue only while auditing/dependencies remain healthy; otherwise return 503. No audit capacity means fail closed, not unaudited access. |
| FR-1.62 | **Health.** Public health exposes only up/down. Readiness is down when sealed, quarantined, or essential dependencies/audit are unavailable. Operator-only status includes backend/KMS condition, certificate expiry, backup age, disk headroom, audit health, quarantine, and unresolved operations. |
| FR-1.63 | **Alerts.** Off-host delivery covers sealed backend, KMS unreachable, certificate ≤30 days remaining, newest eligible backup capture age >26 hours, freeze >10 minutes, disk threshold, audit failure, unresolved/stuck work, credential ≤7 days remaining, and externally unreachable service. Failure of the host/checker itself must alert through missing heartbeats. Alerts contain no sensitive content; test delivery on demand. |
| FR-1.64 | **Auto-unseal.** Restart OpenBao/container and host against real OVHcloud KMS; unseal without manual key entry. If KMS access is unavailable during unseal, remain sealed and refuse secret access with 503. A KMS outage alone is not claimed to seal an already-unsealed process; alert its health separately. No silent manual-key fallback. |
| FR-1.65 | **Certificate recovery.** Replace/reissue the KMIP client certificate using off-host authority without the old host; verify unseal and remove superseded access as appropriate. |
| FR-1.66 | **Paired backup.** At least daily establish a consistent boundary for application authorization/resource changes and all OpenBao effects. Drain/reconcile executing work; block new effects during capture. Uncertainty preventing consistency blocks eligibility. Reads/audit and informational last-use updates may continue; they must not change restored access semantics. Capture both stores with commit/version/schema, authoritative capture time, key identities, and checksums. Encrypt/upload and verify decryption/integrity before eligibility. Read availability still requires healthy audit. Freeze recovery must handle crashes without admitting effects before consistency is established. |
| FR-1.67 | **Restore quarantine.** Restore an eligible pair onto a clean host under a gate independent of restored data, closed by default and on missing/unreadable gate state. No public auth/product/reference access until verified. Operator recovery may use a private verification interface. Gate opening requires a successful report for this host, restored pair, and current restored instance; a stale report cannot reopen a later restore. |
| FR-1.68 | **Access revalidation.** Before reopening: invalidate restored sessions, login/reset challenges and recovery codes; revoke restored machine/runtime tokens including unrecorded tokens, rotate service authentication material, verify namespaces/mounts/policies, reconcile unfinished jobs/operations, and pass negative-access tests. Restore no job that blindly replays an uncertain backend effect. A failed step keeps the gate closed. New machine credentials are issued only after reopening; replacement operator/service credentials and human enrollment are permitted privately during revalidation. |
| FR-1.69 | **Measurements.** Record backup capture time, age at restore, elapsed restore/revalidation time, result, and evidence reference. Do not present a measured duration as an SLA. |
| FR-1.70 | **Staging.** Run destructive drills on a separate staging host with synthetic data and separate provider keys/credentials. Use the deployed release configuration and versions. Never wipe production or bring real production secrets into ordinary CI/drill fixtures. |
| FR-1.78 | **Retention/key custody.** Retain daily pairs for 30 days from capture, not upload/reverification. Expire restore eligibility and perform physical cleanup under verified backend retention rules; specify and test any bounded deletion lag before implementation. Audit archives use a separate 365-day policy. Keep KMS key versions while any retained/restorable artifact requires them; tooling refuses destructive changes while referenced. Hold backup keys and recovery authority off-host. Losing access to a provider-held key is not solved by possession of an encrypted snapshot. |
| FR-1.86 | **Human recovery after restore.** Restored password/MFA state is not evidence of current authority. From off-host operator authority, force a new password, new TOTP enrollment, and new recovery codes through a private recovery flow while quarantined. Revalidate the sole owner membership and permitted organization state; remove synthetic/unexpected restored grants. Old password, TOTP seed, codes, reset links, and sessions must not authorize before or after reopening. Test seed invalidation rather than claiming a six-digit code can never coincidentally recur. Record the procedure without credential values. |
| FR-1.87 | **Restore readiness.** Prove recovery with only the documented off-host material and retained artifacts, including required authentication encryption keys or an explicit reset procedure. No step may depend on a secret fetched from the unavailable service. Demonstrate backup maintenance and oldest-retained-pair restore under the actual retention controls; timestamp manipulation alone is not evidence that object locks expired. |

Backup verification does not replace a clean-host restore drill. Retention applies separately to restore pairs and 365-day audit archives. The technical design must reconcile deduplicated storage, locks, eligibility markers, and retention without promising deletion earlier than the storage mechanism can deliver.

**Binding recovery and backup-lifecycle interpretation of FR-1.64–FR-1.68, FR-1.78 and FR-1.87:**

- **Seal key and recovery material are distinct.** A valid OpenBao/PostgreSQL backup, OpenBao *recovery-key shares*, and a new KMIP client certificate do **not** independently recover a cluster whose required external auto-unseal KMS wrapping key has been permanently deleted or made irretrievable. A temporary KMS outage or a lost/revoked client certificate is a separately testable recoverable condition **only while the original required key and its authorized access can be restored**. Until then, OpenBao stays sealed and the service stays closed. A genuinely lost seal key is recorded as an unrecoverable incident for that encrypted dataset—not represented as a successful restore or repaired by initializing an empty replacement cluster. Controls against accidental key deletion, off-host key identifier/authorization custody, certificate renewal and any supported key migration must be documented and proven in the actual deployment.
- **Storage protection must coexist with repository operation.** For the chosen backup format on Cloudflare R2, exercise initial capture, repeated capture, integrity verification, retained-oldest-pair restore, failed/interrupted maintenance, object-lock conflict behavior, expiration and physical pruning/cleanup, while preserving every still-eligible pair. A locked/deleted/repacked object must never silently make an eligible backup unrestorable. Where repository deduplication requires rewriting or deleting shared objects, apply a verified compatible retention/repository design rather than disabling protection or treating an upload check as proof. R2 lock rules may be changed by suitably authorized bucket administrators: disclose that operational trust boundary and restrict/audit those privileges; do not claim irreversible WORM against the controlling account.
- **Elapsed proof assignment cannot be guessed.** Document 05 must identify which provider-aging behaviors can be proved with a genuinely aged disposable fixture, which integrated proofs must be rerun on release pins, and which require calendar time. The current register makes **AC-1.36 and AC-1.44 release-due**. Their lock-aging, cleanup and oldest-retained-pair subproofs cannot silently migrate to stage completion. Authoritative P-01/P-02/P-03 and inherited guarantees must be reconciled before any formally approved change of gate. Every prerequisite has a reproducible, time-stamped evidence record or remains BLOCKED. Synthetic timestamp manipulation, a short lock-duration smoke test, or a restore of only the newest backup must not be relabeled as a 30-day retention proof.

## 10. Platform and release behavior

| ID | Required behavior |
| --- | --- |
| FR-1.71 | **Transport.** Public application access is HTTPS with HSTS; no plain HTTP listener. Internal service connections use TLS and verified certificates, including database, OpenBao, and KMS hops. Operator VPN traffic is separately encrypted. Certificate failure is never ignored. |
| FR-1.72 | **Host boundary.** Public application exposure is TCP 443 only; authenticated operator WireGuard access is an explicit UDP exception, with SSH reachable only through that interface and keys only. Database, OpenBao, and private verification listeners are not publicly reachable. Restrict container privileges and egress. Synchronize clock; TOTP permits one step of drift, not two. |
| FR-1.73 | **Supply chain.** Pin lockfiles, images by digest, and CI actions by commit. Disable install scripts except reviewed exceptions. Dependency/image and secret scans block releases on findings above the mission’s severity threshold unless an explicit, verified mitigation applies. Record build inputs and artifact provenance; do not infer bit-identical builds solely from lockfiles. |
| FR-1.74 | **Runbooks/upgrades.** Every alert has an executable operator runbook. Rehearse deploy, schema migration, rollback, certificate/key recovery, token inventory, reconciliation, backup, restore, and advisory response on staging. Migrations follow one reviewed Drizzle workflow including custom SQL and auth changes. Prove previous-version compatibility or a documented restore path; do not assume every database/backend downgrade is safe. |
| FR-1.75 | **Honest use.** UI/CLI/user docs disclose operator trust, owner/admin visibility, native historical-read residual, bootstrap credential custody, plaintext exports/processes/clipboard, version retention, and outage consequences. No HA, zero-knowledge, immediate erasure, or universal dotenv claim. Field use and advisory windows follow Document 03 and the retained `1-01` v2.1 obligations. |

## 11. Developer experience, truthful product intelligence, agent test and validation (proposed additions)

The following additions are the explicit translation of Document 03 §§6–7, 9 and 12. They are **observable product obligations**, not mandates to build an elaborate monitoring subsystem or release an agent runtime. For every screen/status, API/CLI consumer and exported report, access to metadata is separately authorized; absence of plaintext values does **not** make tenant, actor, secret name or operational metadata public. The browser's owner account and the infrastructure operator's private authority are distinct even when controlled by the same person.

| ID | Required behavior |
| --- | --- |
| FR-1.89 | **Owner information architecture.** After fully completed MFA, the authenticated owner has discoverable navigation for organizations (only visible membership), projects, environments, secret inventory/lifecycle, import/export, machine credential inventory/actions, operation status, permitted audit events, session/security workflows and supported reference/help. Every owner-permitted Stage 1 action in §§2–8 has an operable UI path, not only a raw API. Explicit empty, loading, pending, blocked, archived, expired, uncertain and error states accurately reflect server state. Navigation never implies unavailable permission or feature. No public admin/restore control is created by this requirement. |
| FR-1.90 | **Project and environment overview.** The owner can inspect authorized project/environment names and immutable IDs, current lifecycle/readiness, last known update, bounded counts of current live/recoverable/review keys where available, and the next valid actions. Counts never represent a coherent complete-value snapshot unless obtained under FR-1.84; their time and status are identified, and uncertain or unavailable figures display `unknown` or `not available`, never fabricated zero. Archived/pending/review resources render safely without offering forbidden actions; human-visible secret values are masked except FR-1.22. |
| FR-1.91 | **Credential understanding.** Per credential, a clearly identified, authorization-filtered view shows name, bound organization/project/environment, effective backend expiry, issuance provenance, `active`/`issuing`/`revoking`/`revoked`/`expired`/`needs_review` state, last-use timestamp only when actually known, and the available next step. A seven-day expiry warning is informational and cannot substitute for actual expiry enforcement or alert delivery. One-time token display, lost-delivery instructions, explicit revocation confirmation and replacement guidance conform to FR-1.39–FR-1.43; no token is redisplayed. |
| FR-1.92 | **Operation and activity timeline.** Owners/admins can inspect bounded, paginated, tenant-scoped activity from allowlisted audit and operation metadata, including time, action, principal/source class, resource where authorized, request/operation correlation, known terminal/unfinished result and safe diagnostic code. The view distinguishes `accepted`, `executing`, `awaiting_input`, `uncertain`, `succeeded`, `partial` and `rejected`; it does not reclassify uncertain work as failed/no-effect. The interface offers status inspection and documented operator-escalation guidance but cannot run infrastructure-only reconciliation. Exported activity, if supported, follows identical filtering and never includes payloads or value fingerprints. |
| FR-1.93 | **Actionable cross-surface errors.** Every core UI workflow and documented CLI/API path maps the stable error envelope and actual operation state to an explanation, a safe next action and a request/operation identifier when available. Distinguish absent/hidden resources from permitted-to-disclose state errors, expired/revoked tokens, MFA freshness, conflict, pending/archived/review, backend unavailable/sealed, audit unavailable, `outcome_unknown`, capacity and incomplete resolution. Display no raw exception, unsafe backend response or secret-bearing retry token. Do not encourage retrying an uncertain mutation with a new idempotency key or bypassing TLS. |
| FR-1.94 | **Truthful, useful product-local measurements.** The owner workspace **provides** at least one current, authorized activity/operation-outcome summary and a usable time-ordered timeline, plus a scoped machine-credential expiry/status view. A summary must distinguish success, denial, unresolved/unknown and missing-source intervals using allowlisted facts; timelines/tables/appropriate graphics are acceptable, with accessible textual equivalents. Any additional aggregate (such as error categories or latency) must genuinely aid a decision, identify its organization/resource scope, measurement window, capture/as-of time, freshness and known limitations. No application secret values, token material, raw headers, reset links, unconstrained actor/name labels or unauthorized cross-tenant metadata enter telemetry. Derived figures must be provenance-linked and authorized server-side. `Not measured`, incomplete coverage, outdated samples and no observed events are meaningfully distinct from zero or verified healthy. A decorative or misleading chart never satisfies this requirement. |
| FR-1.95 | **Private operator status.** An independently authenticated, VPN/private operator channel provides verified backend seal/readiness, KMS reachability separately from unseal, certificate expiry, audit delivery, free capacity, off-host alert condition, currently unresolved/stuck work, service quarantine, and newest **eligible verified backup pair** capture timestamp and age. Stale/missing checks are displayed as unknown/down and identify observation time. Ordinary web owner/admin access never obtains privileged infrastructure diagnostics solely by virtue of its organization role; public `/health` remains minimal. Private reporting may be a well-documented operator CLI/status view rather than a public web dashboard; it must be executable and usable. |
| FR-1.96 | **Interaction quality.** Every owner workflow in FR-1.89 has usable labels and instructions, logical keyboard order, visible focus, keyboard-operable controls, explicit confirmation for destructive/export/token effects, accessible validation error associations, textual status/error equivalents for visual indicators, readable dense data, and functional narrow-screen layout. No claim of certification or conformance to an untested standard is made. No delayed/optimistic UI display labels a security-relevant effect completed before verified server state. Secret reveals obey FR-1.22 even when navigating, hiding, refreshing or signing out. |
| FR-1.97 | **First-run and integration instructions.** Before controlled-use release, **synthetic-only** execution proves operator bootstrap, MFA/recovery boundaries, environment and secret entry/import, protected machine-token supply, supported CLI installation, endpoint verification, complete fixture-app launch, denial/diagnosis, replacement by revoke-and-reissue (not token renewal), incident/runbook lookup and restore credential replacement. Instructions additionally describe onboarding the declared first real, non-critical consumer, but real application secrets are not entered and its actual connection is not claimed tested **until after release authorization**. During field use, execute and record that real-consumer onboarding under **FR-1.100 and AC-1.58**, not as a partial pre-release pass of AC-1.52. Commands/examples contain only placeholders or synthetic data, distinguish operator from web-owner authority, and accurately state supported platform, loader, signal, export, and outage limitations. No hidden engineer-only step is required for the declared setup path. |
| FR-1.98 | **Controlled agent-initiated execution fixture — stage-completion evidence.** A **separate staging/synthetic-only** trusted executor accepts one explicitly allowlisted deterministic request from an external test agent, fixes the project/environment and approved executable/argument vector independently of agent input, obtains its already-issued synthetic machine token from protected executor configuration, invokes the **shipping** CLI and returns only approved result state and safe correlation/diagnostics. The agent cannot provide arbitrary commands, paths, scope IDs, environment variables, token material or code executed in the credential-bearing context; it cannot issue credentials or invoke operator routes. The executor records the distinct **requesting test-agent identity** (attested only to the test harness's limited fidelity) and **actual executing machine identity**, without claiming delegated workload identity or a cryptographically authenticated agent principal. Use the exact declared fixture and no real user's/project's production credentials. This is an executed validation fixture, not a general shipping agent runtime, SDK, gateway, sandbox or hosted integration. |
| FR-1.99 | **Agent denial and leakage observation — stage-completion evidence.** Use synthetic canaries to run an allowed request and distinct denials for unapproved scope, unsafe request fields, revoked/expired credentials, incomplete environment resolution and dependency outage. Fail before credential use or process launch where applicable. Inspect test agent model input/output, tool transcripts, executor and CLI logs, outputs, telemetry, files/images, argument vectors and approved child-output boundary, with documented inspection coverage/limitations. The executor must not forward raw child stdout/stderr or environment values to the agent; only allowlisted status/correlation is returned. A test that has no visibility into an examined surface cannot claim that surface is leak-free. An arbitrary agent-controlled process sharing the secret-bearing runtime remains explicitly out of scope. |
| FR-1.100 | **Field-use observation — stage completion only.** Following authorized controlled-use release and connection of at least one real non-critical consumer, record a **minimum 28-day daily-use observation period** with an entry for every calendar day. Each day's record distinguishes meaningful real task/use, attempted-but-blocked operation, outage/suspension, or absent activity; outage or blank days are **not credited as successful use**. If daily-use evidence is interrupted, extend the observation interval until the mission's four-week daily-use commitment is credibly demonstrated, recording the variance and reason rather than silently resetting history. Record weekly backup capture age and restore result, sample-qualified P50/P95 latency, resource headroom, CLI errors, defects, UX task friction/time-on-task, operator effort, security advisories and approximate infrastructure expenditure. Observations contain no secret values or sensitive credentials. Elapsed time is not billed as engineering hours; actual remediations and reviews are. |
| FR-1.101 | **Two distinct evidence gates.** The **controlled-use release** manifest binds exact tested commit, schema, pin/image/configuration identities, **all approved release-applicable ACs**, their mapped FR behaviors, **all release-applicable POs or explicitly approved and tested replacements**, negative/fault/recovery tests, independent security review, first-run usability and off-host alert/restore drills. **Do not require or mark PASS the four post-release ACs** (AC-1.53, -1.54, -1.58, -1.59) or observational FR-1.98–FR-1.100 before controlled-use; record them `NOT YET DUE` with owner and later closure condition. AC-1.52 is exclusively a pre-release synthetic first-run test; the first real-consumer connection is an AC-1.58 post-release prerequisite. In the current register, inherited AC-1.36 and AC-1.44 (including applicable real-aging and oldest-pair checks) are **release-due**; changing that requires a signed authoritative source decision, replacement acceptance, and synchronized manifest. No default deferral is allowed. No real application secrets before signed release authorization. The **stage-completion** manifest adds FR-1.98–FR-1.100 and all four post-release ACs, follow-up staging restore, hypothesis interpretation and a signed `ADVANCE`, `HARDEN–RE-SCOPE`, `PIVOT` or `STOP` decision. A `STOP`/retirement decision does **not** excuse a never-completed promised Stage 1 service: the service must have independently passed its release contract before voluntary retirement. Outstanding broken functionality remains a defect or failed stage, not future-stage scope. |
| FR-1.102 | **Evidence/provenance, release boundary and honest claims.** Every displayed state, product metric, feature claim and test status has traceable source evidence and a declared freshness/evidence level. UI, CLI, API and docs never imply zero-knowledge, universal secure execution, guaranteed availability, retrospective erasure, arbitrary agent-code protection, tenant-selective Raft restoration, or untested recovery/retention, a recovery-key workaround for permanent external seal-key loss, or immutable R2 protection against an administrator able to remove lock rules. Owner-visible limitation/help information is accessible without infrastructure source code. **Test-only stage-completion harnesses are not advertised as deployed product functionality.** Only approved amendments can defer an included capability, with corresponding FR/AC/PO and stage-gate updates; no placeholder, hidden flag or future-stage note counts as a completed feature. |

### 11.1 Minimum screens and information boundaries

The following are **functional information surfaces**, not a prescription for a certain number of pages, charts, components or UI framework. A single screen can satisfy multiple surfaces when it remains understandable.

| Surface | Real owner can see/do | Excluded or private |
| --- | --- | --- |
| Authentication/security | Sign in, complete MFA/enrollment and recovery-code workflow, manage sessions and supported password changes, follow private reset instructions | No public bootstrap/reset initiation or MFA disable |
| Workspace and environment | Authorized project/environment overview, readiness and archive/reactivate actions with correct permission/state | No direct namespace/policy editor |
| Secrets and versions | Bounded name search, safe explicit reveal/copy, version/history, edit/delete/undelete/restore and import/export | No persistent values in page, charts, browser store or telemetry |
| Machine credentials | Scope/expiry/status/issuer/last-use-if-known, one-time issuance, revoke and replacement help | No redisplay or recovery of previously issued token bytes |
| Activity and diagnostics | Authorized audit/operation timeline, explicit unknown/partial states, correlation and human-readable resolutions | No global infrastructure audit, raw backend traces, or operator reconciliation buttons |
| API and CLI help | Protected read-only Scalar, example API/CLI workflows, supported platforms, safe configuration and error reference | No interactive API execution containing real credentials, CDN or third-party telemetry |
| Private operator diagnostics | **Only through private operator authority:** KMS/unseal distinction, eligible backup age, capacity, audit health and alerts | No corresponding privileged fields exposed through the owner role or public health |
| Agent experiment | Separate staging/synthetic test-run instructions and reviewed stage-completion evidence, not a production end-user UI | No general agent console, production agent credential path or claim of verified agent identity |

### 11.2 Time/unknown-state and accessibility conventions

- Use server-proven status for security-sensitive workflow conclusions. A request accepted for background work is `accepted`/`executing`/`awaiting_input`, not `succeeded`.
- Timestamp displays distinguish event time, observation time and last successful check. A displayed countdown does **not** authorize use after expiry and does not substitute for a backend check.
- For disabled/restricted actions, display a concise reason when authorization permits; do not reveal a hidden resource merely to explain a refusal.
- Any safe analytic summary must be derived from filtered/authorized source records or from a separately access-controlled aggregate. Do not reconstruct a tenant's data by querying all tenants and filtering only after returning results to the browser.
- Prefer a readable tabular equivalent to inaccessible purely visual charts; use semantic labels, focus management and non-color status signaling.
- A metric or status failing due to collection lag, missing permission or incomplete backend inspection stays explicitly `unknown`, never green or `0` by default.

## 12. Acceptance register (inherited scenarios and new mission additions)

All scenarios use synthetic secrets. Direct API calls bypassing the UI are mandatory for security rules; use real OpenBao/PostgreSQL for their enforcement. “Pass” means captured results, pinned environment, and reproducible command, not a checkbox supported only by code review. Destructive cases run on staging. Browser/CLI checks supplement backend tests.

| ID | Required evidence | Requirements |
| --- | --- | --- |
| AC-1.01 | Inventory every account-creation path and call it directly: all refuse; operator bootstrap interrupted/retried yields one owner | FR-1.01 |
| AC-1.02 | Password-only and MFA-enabled-account/unverified-session states deny product access; enrollment and step-up work with real codes; concurrent reuse of a TOTP step or recovery code succeeds once across processes; trusted-device bypass fails; lost-code display requires regeneration | FR-1.02, FR-1.03 |
| AC-1.03 | Reset initiation blocks ordinary sign-in and invalidates sessions/challenges; only one link redeems, old links fail, expiry never reopens the account; password-only completion still requires MFA, MFA reset reenrolls; no HTTP initiation; no tokens in server URLs/logs | FR-1.04 |
| AC-1.04 | Sign-out/revocation/password change end intended sessions; 30-minute inactivity and 12-hour absolute expiry hold; automated polling alone cannot keep an unattended session alive | FR-1.02, FR-1.05, FR-1.06 |
| AC-1.05 | Password/TOTP/recovery-code abuse throttled per account/source across two API processes; error responses disclose no account existence | FR-1.07 |
| AC-1.06 | Interrupt provisioning at every boundary; retry yields one verified namespace/owner binding, never broader rights or prematurely active state | FR-1.08, FR-1.13 |
| AC-1.07 | Guessed foreign IDs and forged backend selectors reveal no tenant data; organization A’s runtime/issuer/provisioner/machine identities cannot access B directly in OpenBao | FR-1.09, FR-1.10, FR-1.11, FR-1.13, FR-1.40 |
| AC-1.08 | Exercise every authorization-matrix cell and parent-state override; grants combine correctly; revoked grant/session/token denies new requests; document in-flight behavior | FR-1.10, FR-1.11 |
| AC-1.09 | Remove or alter a required policy/mount/role on staging: 503, narrow review state, and alert; no fallback identity | FR-1.12 |
| AC-1.10 | Create project/development environment; test NFC/case/length/whitespace rules and environment names; renames preserve bindings; pending denies machines; provisioner failure enters review | FR-1.14, FR-1.15, FR-1.16 |
| AC-1.11 | Archive racing creation/issuance cannot leave a usable token; restart resumes revocation; humans retain allowed reads; reactivation restores no token and preserves independently archived children; no delete route | FR-1.17, FR-1.18, FR-1.19 |
| AC-1.12 | Boundary names and 65,536-byte multiline/empty/Unicode values pass; oversized/NUL/reserved names fail without echo; search is name-only; version 21 makes version 1 unavailable | FR-1.20, FR-1.21, FR-1.26 |
| AC-1.13 | Canary sweep after reveal/copy/export/issuance/reset/sign-out: no values or credentials in prohibited browser/server/database/job/diagnostic surfaces; hide/navigation timer clears visible state; permitted auth records satisfy §2.1 | FR-1.22, FR-1.23, FR-1.56, FR-1.80 |
| AC-1.14 | Two valid updates using the same version/tag: exactly one succeeds; stale/missing preconditions fail; creation over deleted history conflicts; direct update of a deleted key fails | FR-1.24, FR-1.25, FR-1.30 |
| AC-1.15 | Race lifecycle mutations across processes; capture a tag, delete and undelete the same version, then reject the old tag. Metadata must reflect every verified outcome; unavailable restore sources fail; no fallback/destroy interface | FR-1.26, FR-1.27, FR-1.28, FR-1.29, FR-1.30, FR-1.32 |
| AC-1.16 | Timeout after a real backend write yields uncertain status, operation ID, blocked key, and no automatic replay | FR-1.31 |
| AC-1.17 | Property-test codec boundaries/literal dollars/loader warnings; previews hide values, bind protected fingerprints and state tags, and expire; conflicts including deleted or changed-then-restored keys are explicit; partial completion is not full success | FR-1.33, FR-1.34, FR-1.35, FR-1.36, FR-1.37, FR-1.38 |
| AC-1.18 | Issue once; inspect persistence; positive TTL enforced, actual expiry displayed, nonrenewal and seven-day alert tested; verify expiry/revocation; unknown creation blocks issuance | FR-1.39, FR-1.41, FR-1.42, FR-1.43, FR-1.63 |
| AC-1.19 | Machine reads only bound current values via its own token; history selector fails; native write/delete/token creation/renewal/foreign scope fail; permitted self-lookup works; OpenBao private | FR-1.40, FR-1.44, FR-1.45 |
| AC-1.20 | CLI supplies complete values to Next.js/FastAPI fixtures without files or credentials; test argument vectors, collisions, stdin/source handles, size limits, pre-spawn cancellation, and signals without double forwarding on each supported platform | FR-1.46, FR-1.47, FR-1.48, FR-1.49, FR-1.51 |
| AC-1.21 | Export creates, flushes, and closes a new 0600 file; existing paths/symlink traversal refused; own partial file cleaned under trusted directory assumptions; substitution never deletes a replacement and reports cleanup required; round trip passes | FR-1.38, FR-1.50 |
| AC-1.22 | Product OpenAPI matches validation; auth-route inventory/native shapes and web mapping tested; breaking change detected; reference requires role/MFA, cannot execute/egress; no public operator functions | FR-1.52, FR-1.53, FR-1.54, FR-1.55 |
| AC-1.23 | Coverage and safe correlation verified; runtime cannot change audit; tenant/global separation and 365-day purge enforced; audit outage blocks sensitive access and alerts without fabricated stored outcomes | FR-1.56, FR-1.57, FR-1.58, FR-1.59, FR-1.81 |
| AC-1.24 | Input/output/list/rate/concurrency limits reject before exhaustion; failed limiter denies; low disk blocks expanding mutations but preserves audited denial/revocation where durable writes remain possible; audit exhaustion blocks reads | FR-1.60, FR-1.61 |
| AC-1.25 | Simulate every listed condition plus stopped host/checker, DNS failure, and invalid public certificate; alerts arrive off-host without secrets; public status remains minimal | FR-1.62, FR-1.63 |
| AC-1.26 | Restart container and host with real KMS; unavailable KMS during restart and revoked certificate prevent unseal; running KMS outage is separately detected; certificate reissued without old host | FR-1.64, FR-1.65 |
| AC-1.27 | Capture while reads/audit continue and auth/resource/token/provisioning changes compete; paired state remains consistent. Crashes during freeze/capture/upload/verification never yield invalid eligibility; freeze recovery is safe; old capture time cannot be refreshed by reupload | FR-1.66 |
| AC-1.28 | Restore stays closed despite active rows; failed step/stale report rejected; private service credential rotation and human enrollment can complete while public access stays closed; new machine issuance remains blocked until opening; record age/time | FR-1.67, FR-1.68, FR-1.69, FR-1.70 |
| AC-1.29 | Product errors match envelope; native auth responses match documented web mapping; safe HTTP/CLI categories and correlation; proxy/truncated/non-JSON replies fail safely; hidden state remains hidden | Error contract, FR-1.49, FR-1.59 |
| AC-1.30 | Public HTTPS/HSTS; no HTTP listener; internal plaintext/unverified TLS rejected; CLI cannot bypass TLS | FR-1.71 |
| AC-1.31 | External exposure matches HTTPS plus WireGuard exception; SSH is VPN-only/key-only; private services unreachable; privilege/egress restrictions verified; clock drift of one TOTP step accepted, two refused | FR-1.72 |
| AC-1.32 | Seeded dependency/image vulnerability and seeded secret block release; reviewed exceptions trace to verified mitigation; lockfiles/digests/action pins/provenance checked | FR-1.73 |
| AC-1.33 | Execute alert and recovery runbooks on staging; rehearse migrations, upgrade and supported rollback; compare documentation claims with evidence and field-use requirements | FR-1.74, FR-1.75 |
| AC-1.34 | Cross-site state changes rejected even through direct auth routes; inline/third-party scripts and framing blocked; no referrer leaks | FR-1.76 |
| AC-1.35 | Stale fresh-verification time or new session without recent TOTP gets 403 for every sensitive action; valid current TOTP permits it; recovery-code login alone does not | FR-1.77 |
| AC-1.36 | Eligibility and physical retention match documented rules; referenced KMS key destruction refused; oldest retained pair restores; audit archives maintain independent 365-day retention | FR-1.78, FR-1.81 |
| AC-1.37 | CLI rejects HTTP, invalid certificate, unsafe runtime configuration, incompatible API major, and credential-bearing cross-origin redirect; none launches a child | FR-1.49, FR-1.79 |
| AC-1.38 | Kill executors at intent/dispatch/backend-success/final-commit boundaries; also delay a backend request past timeout and attempt reconciliation/retry. Old execution must be unable to act before exclusion is released; no untracked effect, duplicate executor, or false no-effect rejection | FR-1.82, FR-1.88 |
| AC-1.39 | Concurrent replay yields one effect; changed intent conflicts and unauthorized replay/status denies. Interrupted imports enter uncertain or awaiting_input correctly; resumption skips completed entries; terminal partial requires new preview; replay expiry is visible/tested | FR-1.36, FR-1.83 |
| AC-1.40 | Lose issuance response at each boundary; unfinished retry returns status, successful replay returns no token and creates none, verified rejected replay remains rejected. Exclude delayed creation before inventory completion; replacement/archive races leave no escaped active token | FR-1.39, FR-1.42, FR-1.43, FR-1.83 |
| AC-1.41 | Resolve/export during mutations/import: coherent set or explicit failure. Empty set succeeds. Backend/audit/review/limit errors release no deliberate partial set; truncate transport mid-response and prove neither CLI launch nor export completes | FR-1.84 |
| AC-1.42 | Execute installation, endpoint verification, protected token supply, rotation, revocation, and post-restore replacement in local development and first-consumer deployment; inspect args/history/files/logs for leaks | FR-1.85 |
| AC-1.43 | Restore a stale pair containing old password/MFA/codes/reset links and obsolete grants; private recovery re-establishes current owner access; every old credential fails before/after opening; interrupted recovery stays closed | FR-1.86, FR-1.68 |
| AC-1.44 | Recover using documented off-host material only, with unavailable old host/service; perform storage-lock/maintenance/expiry checks against actual backend semantics, not only altered snapshot timestamps | FR-1.87 |


### 12.1 Additional release and validation acceptance scenarios (proposed)

The following scenarios supplement rather than replace AC-1.01–AC-1.44. Each scenario shall record the applicable date/configuration, synthetic fixture data, authorization identity, precise expected and actual results, screenshots or terminal transcripts with sensitive material removed, and a reviewer where required. **Release cases** must pass before real-secret use; **field cases** are Stage 1 completion conditions after release.

| ID | Required reproducible evidence | Requirements | Gate |
| --- | --- | --- | --- |
| AC-1.45 | From fully authenticated owner entry, exercise every declared owner operation end to end through the installed UI, including onboarding, empty state, normal states, MFA freshness, secret lifecycle, import partial/conflict, credential issue/revoke, history, sessions and protected reference. Compare actual backend result with displayed status; no backend-only included action or inert control remains. | FR-1.89, FR-1.96, FR-1.97 and inherited §§2–8 | Release |
| AC-1.46 | Create active, pending, archived, revoking and review fixture resources and exercise visibility, counts, last-observed times and permissible actions across them. Changed key inventory and unavailable counters show accurate staleness/unknown, not complete-value claims or fake zeros. Check a second organization cannot inspect names/counts/state. | FR-1.90, FR-1.94, FR-1.102; FR-1.09–FR-1.12 | Release |
| AC-1.47 | Display active, expiring, expired, issuing, revoked, revoking and needs-review credentials using backend-confirmed fixtures. Verify exact scope, backend effective expiry, unknown last-use indication, seven-day warning and lost one-time token guidance. Revoke during display; reload confirms subsequent denial, no token redisplay and truthful status. | FR-1.91; FR-1.39–FR-1.43 | Release |
| AC-1.48 | Force a delayed secret mutation, unknown issuance and interrupted import. Operation/activity UI distinguishes accepted/executing/uncertain/awaiting_input/partial/terminal outcomes; safe IDs and operator escalation shown without authorized web ability to reconcile. Cross-tenant operation/status searches and direct requests deny without metadata disclosure. | FR-1.92, FR-1.93; FR-1.82–FR-1.83, FR-1.88 | Release |
| AC-1.49 | As web owner/admin, request private diagnostic routes directly and verify denial. As authorized VPN/private operator, retrieve eligible backup capture age and proof status, KMS reachability separately from unseal, audit and disk health, alert delivery freshness and unresolved work. Simulate stale/missing check; `unknown/down` must be displayed, public health contains no protected internals. | FR-1.95; FR-1.62–FR-1.63 | Release |
| AC-1.50 | Seed labeled synthetic secrets and identifiers; execute all owner UI reveals/exports, auth/enrollment/recovery, credential issue/revoke, CLI, analytics and status views; inspect retained browser stores, logs, audit, metrics/traces, jobs, crash diagnostics and collected analytics. Verify no prohibited value/token/challenge appears and that metadata query scope cannot leak tenant data. | FR-1.94, FR-1.102; FR-1.22–FR-1.23, FR-1.56, FR-1.80–FR-1.81 | Release |
| AC-1.51 | Perform keyboard-only main flows and narrow-layout interaction with actual forms, modal confirmations, tables, status and errors. Inspect labels, focus placement/return, spoken-text alternatives and contrast/readability; document and fix any defect that blocks the supported owner tasks. Do not claim formal accessibility certification without its own testing. | FR-1.96 | Release |
| AC-1.52 | Before real-secret onboarding, independently execute the documented clean operator/owner/consumer path using **synthetic only**: install/deploy, bootstrap, MFA, create environment/values, safely supply a test token, run a supported fixture app, diagnose deliberate denial and inspect restore-credential instructions. Observe executed results without real credentials in evidence. All steps and results in **this** acceptance case are synthetic and due before release; **AC-1.58** separately verifies the real non-critical consumer onboarding after authorized release and before field-use credit begins. | FR-1.97; FR-1.46–FR-1.51, FR-1.85 | Release |
| AC-1.53 | An external test agent makes one predetermined instruction request to the separate **staging-only synthetic** trusted executor. The executor fixes scope, command and arguments, supplies a protected preissued synthetic machine credential and launches the fixture through the actual shipped CLI. Record requesting test-agent identity distinctly from executing machine identity; disclose that the former has only harness-level attribution. The agent receives only allowlisted status, correlation and safe diagnostics; prompt/tool output contains no secret. | FR-1.98–FR-1.99 | Stage completion |
| AC-1.54 | Use staging synthetic canaries to test agent requests for unauthorized scope, arbitrary command/arguments, expired/revoked token, incomplete resolution, and backend/network outage. Verify denials and no inappropriate child launch. Inspect prompts, transcripts, executors, argument vectors, logs, files, telemetry and child output boundary. The agent never receives raw child stdout/stderr. Record inspection limits and acknowledge no arbitrary-code security guarantee. | FR-1.98–FR-1.99; FR-1.49 | Stage completion |
| AC-1.55 | Display a **real, useful** owner-scoped operation/outcome summary, chronological event timeline, and credential expiry/status grouping from actual allowlisted server data. Simulate stale/missing intervals, delayed events, zero activity and an unresolved operation, demonstrating distinct `zero`, `not measured`, `unknown` and verified success; show source/scope/time as appropriate. Verify tenant metadata is not leaked through aggregate dimensions, timeline filters or charts, and inspect accessible textual equivalents. | FR-1.90, FR-1.92, FR-1.94, FR-1.102 | Release |
| AC-1.56 | Assemble the **controlled-use** evidence manifest from pinned release artifacts: identify each **currently approved** requirement and AC, flag all **release-applicable** ACs (in this draft: all inherited AC-1.01–1.44 and proposed AC-1.45–1.52, -1.55–1.57, -1.60 = 56), and link them to reproducible results plus all applicable security/integration proofs PO-1–PO-24 or explicitly tested replacements. Separately list AC-1.53, -1.54, -1.58 and -1.59 `NOT YET DUE` with owner and completion criteria, **never PASS**. Verify the release AC-1.52 contains synthetic onboarding only, while the real-consumer follow-up is assigned exclusively to AC-1.58; include a source-approved gate classification for each calendar-aging retention proof. Verify no mandatory release item remains FAIL/BLOCKED and independent security reviewer differs from author; the original P-02 guarantees must be reconciled before release. The final stage-completion manifest must later close the remaining four ACs. | FR-1.101–FR-1.102; document approval gates | Release |
| AC-1.57 | Before any real-secret onboarding, prove completed synthetic end-to-end scope, denial, interruption, clean-host quarantine restore, current-owner recovery, external alerts, and privileged/private monitoring. Test temporary loss of KMS reachability and replacement of client certificate without the old host while **retaining the required external seal key**; with an independent disposable staging key, demonstrate that unavailable required seal-key material prevents unseal and is never misreported as recoverable with recovery shares. At release, demonstrate real R2 lock-conflict and repository-maintenance behavior in a disposable provider-backed repository and verify an eligible pair remains restorable; additionally satisfy **release-due inherited AC-1.36 and AC-1.44** including actual aging/oldest-pair evidence unless formally amended. Do not describe a short lock-duration smoke test as the entire aged proof. Use no destructive test against production/shared keys. Confirm signed approval, then connect only the declared non-critical first consumer. Any change to a release-critical component repeats affected proofs. | FR-1.101; FR-1.66–FR-1.70, FR-1.86–FR-1.87 | Release |
| AC-1.58 | After signed controlled-use release, **execute and independently verify the documented first real non-critical consumer connection** (protected credential delivery, real application launch, working revocation/replacement and no prohibited local persistence); record the exact enrollment/first-use evidence without values. Only then capture at least 28 consecutive calendar-day entries; distinguish actual daily use, blocked attempts, outage/suspension and no activity. Extend the observation period if needed to substantiate four weeks of genuine daily use, without concealing failed dates. Include weekly backup/latency/headroom/errors/defects/operator-cost observations and a separate synthetic-data staging restore. Close an additional retention-lock aging proof at this gate **only if** the inherited release obligations AC-1.36/1.44 have been formally amended and the alternative, approved acceptance is explicitly recorded; otherwise all release-due aging evidence must already have passed before onboarding the consumer. Report sample counts, meaningful UX task evidence and baseline limitations; do not generalize from a single user to market adoption. | FR-1.100–FR-1.101 | Stage completion |
| AC-1.59 | Review the final evidence report: implemented-and-tested vs observed vs unknown vs failed vs deferred, agent fixture outcomes and security boundaries, operational cost, open risks, and an explicit `ADVANCE`/`HARDEN–RE-SCOPE`/`PIVOT`/`STOP` decision. Verify the Stage 1 **complete-product release was actually achieved** and remains independently operable; an optional secure retirement plan may follow that fact, but cannot substitute for delivering the promised product. | FR-1.100–FR-1.102 | Stage completion |
| AC-1.60 | Walk through every published UI/API/CLI and error/help/documentation claim: no sham status, hidden nonfunctional feature, security capability that is assumed but not tested, missing Stage 1 repair deferred to Stage 2, or dishonest claims about agent sandboxing, key erasure, backup retention/restore, lost external auto-unseal keys, R2 lock administrator powers, offline launch or tenant isolation. Demonstrate a user-accessible disclosure of real limitations. | FR-1.97, FR-1.102; FR-1.75 | Release |

### 12.2 Two-gate coverage and result classification

| Gate | What must be complete | Cases in this candidate baseline | Meaning of evidence |
| --- | --- | --- | --- |
| **Controlled-use release** | The **entire claimed application product**: human and machine credential path, recovery, owner DX, private operator diagnostics, alerts, audit, supported CLI/API, negative and fault tests, all critical proofs | **56 ACs:** inherited AC-1.01–1.44 plus added AC-1.45–1.52, AC-1.55–1.57 and AC-1.60; AC-1.52 is fully synthetic and fully release-due | Each release-applicable AC is `INTEGRATED-PASS` on release pins or formal, proven replacement; reviewer and evidence recorded. No field observations can excuse failed release controls. |
| **Stage completion** | The already-released complete product has produced adequate post-release evidence and may remain in service without any further stage | **4 ACs:** AC-1.53, AC-1.54 (executed agent fixture), AC-1.58 and AC-1.59 (field use/decision); AC-1.58 includes the real-consumer onboarding check and its subsequent 28-day field use | Mark `NOT YET DUE` at controlled release, then close with executed `FIELD-OBSERVED`/verified results as applicable. Failed cases mean the stage is not complete; a repair is reassessed against release requirements. |

`NOT YET DUE` is a **gate-specific manifest label**, not a substitute for the underlying evidence-status vocabulary; it is applicable **only** to explicitly post-release observational tests and source-authorized calendar proofs. Every release-due AC is all-or-nothing: it cannot be marked PASS while reserving an untested component for the stage-completion gate. POs governing security, platform support, recovery or any feature provided at release **cannot** be shifted to the later gate simply because their proof is difficult or calendar-dependent. A field-discovered release-critical defect is remediated or controlled use is suspended; it is not reclassified as an allowed Stage 2 omission. This table is automatically updated when formal change control revises any FR, AC, proof or stage gate.

**Independent review requirement:** identify the reviewer before approving the work plan. Review of failure evidence, risk acceptance and release security gates must be by a distinct qualified person, not the author marking their own work or an unverified automated review alone. This is a cost/scheduling dependency for Document 07, not a reason to waive independent verification.

## 13. Traceability, inherited obligations and technical handoff

### 13.1 Stage 1 mission outcomes to requirements and acceptance

| Governing outcome | Primary retained requirements | Added requirements | Primary evidence |
| --- | --- | --- | --- |
| A — Human first use and secret management | FR-1.01–1.38, FR-1.76–1.77, FR-1.82–1.84, FR-1.88 | FR-1.89–1.90, FR-1.92–1.93, FR-1.96–1.97 | AC-1.01–1.17, AC-1.34–1.35, AC-1.38–1.39, AC-1.45–1.46, AC-1.48, AC-1.51–1.52 |
| B — Machine issuance and complete CLI launch | FR-1.39–1.51, FR-1.79, FR-1.84–1.85 | FR-1.91, FR-1.93, FR-1.97 | AC-1.18–1.21, AC-1.37, AC-1.40–1.42, AC-1.47, AC-1.52 |
| C — Incident, diagnostic and clean-host recovery | FR-1.31, FR-1.56–1.75, FR-1.78, FR-1.80–1.83, FR-1.86–1.88 | FR-1.92–1.95, FR-1.100–1.102 | AC-1.16, AC-1.23–1.33, AC-1.36, AC-1.38, AC-1.43–1.44, AC-1.48–1.50, AC-1.56–1.59 |
| D — Agent-initiated bounded validation (**stage-completion experiment**) | FR-1.39–1.50, FR-1.79–1.80, FR-1.84–1.85 | FR-1.98–1.99, FR-1.101–1.102 | AC-1.20, AC-1.37, AC-1.41–1.42, AC-1.53–1.54 |
| Exceptional DX and product-local intelligence | FR-1.52–1.59, FR-1.62–1.63, FR-1.75–1.76 | FR-1.89–1.97, FR-1.102 | AC-1.22–1.25, AC-1.29, AC-1.33–1.34, AC-1.45–1.52, AC-1.55, AC-1.60 |
| Two distinct Stage 1 gates | FR-1.66–1.75, FR-1.78, FR-1.81, FR-1.86–1.87 | FR-1.100–1.102 | AC-1.27–1.33, AC-1.36, AC-1.43–1.44, AC-1.56–1.59 |

### 13.2 Inherited Stage 1 security properties

| Source property | Primary acceptance coverage |
| --- | --- |
| M-01 — Honest trust model | AC-1.08, AC-1.19, AC-1.33, AC-1.42, AC-1.53–1.54, AC-1.60 |
| M-02 — One persistent authority per fact | AC-1.07, AC-1.13, AC-1.18, AC-1.27, AC-1.50 |
| M-03 — Privilege separation | AC-1.06–1.07, AC-1.19, AC-1.22, AC-1.31, AC-1.49, AC-1.54 |
| M-04 — Fail-closed current access | AC-1.02–1.04, AC-1.08–1.11, AC-1.24, AC-1.46–1.49 |
| M-05 — Plaintext containment | AC-1.13, AC-1.20–1.22, AC-1.34, AC-1.37, AC-1.42, AC-1.50, AC-1.54 |
| M-06 — Durable mutation integrity | AC-1.14–1.17, AC-1.38–1.41, AC-1.48 |
| M-07 — Recovery cannot restore old access | AC-1.28, AC-1.36, AC-1.43–1.44, AC-1.57 |
| M-08 — Accountable and operable service | AC-1.23–1.33, AC-1.36, AC-1.44, AC-1.49, AC-1.56–1.59 |

**Important limitation:** The original `P-02` baseline is referenced but **not available** in the supplied project files. An apparent fifteen-item mapping from the inherited specification is a secondary summary, **not verification that the actual governing text contains no additional constraints or conflicting interpretation**. Before approving this document, retrieve and compare P-01, P-02 and P-03 in their authoritative versions, recording each guarantee and any supersession decision explicitly.

### 13.3 Exact operating values retained from the inherited contract

| Requirement | Value retained | Primary enforcement/evidence |
| --- | --- | --- |
| Real users | One actual owner; synthetic multiple organizations and human roles for tests | FR-1.01, FR-1.08–1.13; AC-1.01, AC-1.06–1.08 |
| Session inactivity / absolute | 30 minutes / 12 hours | FR-1.06; AC-1.04 |
| Fresh TOTP for sensitive start | Verified within 10 minutes, bound to session/current enrollment | FR-1.77; AC-1.35 |
| TOTP step and recovery codes | Six-digit / 30-second step; step single-use; ten independent one-time recovery codes | FR-1.03; AC-1.02 |
| Reset delivery | Operator initiates; 15-minute single-use link; never public/email | FR-1.04; AC-1.03 |
| Secret sizes/retention | UTF-8 at most 65,536 bytes; last 20 versions | FR-1.20, FR-1.26; AC-1.12 |
| Import preview | 15-minute expiry | FR-1.35; AC-1.17 |
| Credential lifetime | Positive TTL, 30 days maximum/default; nonrenewable; warning near seven days | FR-1.39, FR-1.41, FR-1.63; AC-1.18 |
| Replay records | Terminal >=30 days, unfinished until resolved | FR-1.83; AC-1.39 |
| Paired backups | At least daily; newest eligible *verified capture* older than 26 hours alerts | FR-1.63, FR-1.66; AC-1.25, AC-1.27 |
| Recovery pairs | 30-day recoverable retention from capture; restore oldest eligible pair under actual backend rules | FR-1.78, FR-1.87; AC-1.36, AC-1.44 |
| Application/OpenBao audit | 365-day separately protected retention | FR-1.78, FR-1.81; AC-1.23, AC-1.36 |
| KMIP certificate alert | <=30 days to expiry | FR-1.63; AC-1.25–1.26 |
| Stuck work / capture freeze | Alert after 2 minutes without operation progress / freeze >10 minutes | FR-1.88, FR-1.63; AC-1.25, AC-1.38 |
| Security advisories | Critical contain <=24 h and patch <=72 h; high patch/verified mitigation <=7 days; medium/low address <=30 days, starting at disclosure | Document 03 §8 and retained `1-01` §8; FR-1.74–1.75; AC-1.33, AC-1.56 |
| Real field use | Daily for at least 4 weeks and >=28 elapsed days following controlled release | FR-1.100–1.101; AC-1.58–1.59 |

### 13.4 Proof register carried forward **without passing claims**

These 24 IDs originate in inherited Technical Audit v2.0 and remain **OPEN**. Document 05 will validate whether each proof is appropriate for the revised mission and identify added proof obligations for the UI/agent surface; Document 06 will document mechanisms, exact testable contracts and dependencies. Documents 07–08 assign owners, effort, evidence and execution order. A mock, source-code inspection, compatibility claim or vendor reference cannot substitute for required real integration/fault/storage testing.

| Proofs | Required domain | Release dependency |
| --- | --- | --- |
| PO-1–PO-4, PO-13 | OVH KMS/native KMIP, scoped runtime/issuer/provisioner and snapshot identity | Real provider interoperability; distinguish lost host/certificate from required external seal-key loss; direct OpenBao permission/escape tests |
| PO-5–PO-6, PO-15 | Bootstrap-only auth, protected sessions, MFA/recovery reset, adapter storage | Real persisted-state inspection, concurrent replay/freshness/expiry tests |
| PO-7, PO-16–PO-19 | KV state tags/CAS, delayed effects, replay, issuance races and coherent complete reads | Actual fault injection with blocked replacement until old effect excluded |
| PO-8, PO-20 | Multi-platform CLI and credential setup/replacement | Linux/macOS matrix, guarded token supply, no unsafe launch |
| PO-9, PO-21–PO-22 | Backup/retention/paired capture/oldest-eligible restore | Real R2 lock-vs-repository pruning/maintenance compatibility, aged eligibility, externally available seal key, and clean-host quarantine recovery at their authoritative gates |
| PO-10–PO-12 | Local Scalar, browser CSP, Node permission behavior | Browser/network/runtime evidence without false sandbox guarantee |
| PO-14, PO-23 | Off-host probe/alerts, runtime grants/audit/pressure | Independent fault/host-outage testing, audit failure denial, secret canaries |
| PO-24 | Compatible source/toolchain baseline | Reviewed stable pins, generated auth schema, migration clean-room, scans |

### 13.5 Scope exclusions (no partially implemented placeholders)

- No invitations, additional actual users, public registration, self-service tenant signup, billing, payment, organization offboarding/suspension, or public membership/grant administration. Synthetic role coverage remains required.
- No public raw OpenBao administration, globally privileged runtime, or operator recovery/reconciliation route.
- No HA/SLA, general availability architecture, active multi-region backup/failover claim, or offline secret cache. Already-running child processes may keep previously injected values.
- No workload federation, attestable agent identity, user-to-agent delegation chain, autonomous issuance/rotation, dynamic secret broker, SDK portfolio, unrestricted MCP token/value tool, general agent runtime, arbitrary code execution in credential context, or broad observability console.
- No native Windows CLI support, and no universal dotenv-dialect support, unless a future approved closed scope explicitly adds them.
- No promise to prevent application/host/operator access to plaintext, claw back disclosed values, delete every physical historical copy instantly, or provide tenant-specific selective OpenBao Raft restoration.

### 13.6 Required source reconciliation and implementation handoff

**Before adopting Document 04 as binding:**

1. Obtain P-01/P-02/P-03 and reconcile purpose, confidentiality/credential storage, release guarantees, key/retention/ops controls, Drizzle supersession and provider substitutions. Document conflicts and approvals; do not infer governing authority from an uploaded secondary summary.
2. Approve the Stage 1 functional scope and proposed new identifiers FR-1.89–FR-1.102 / AC-1.45–AC-1.60. Preserve the 88 inherited FR and 44 inherited AC unless an explicit approved change lists removals and compensating security/evidence consequences.
3. Document 05 independently audits the technology choices and mutable claims, particularly protected Better Auth adapter/session behavior, real KMIP and provisioner boundaries, delayed backend effects, complete resolution and Restic/R2 retention. Preserve PO-1–PO-24 as unpassed until tested.
4. Document 06 specifies runtime/auth/backend contracts, permission matrices, operation transitions, effect exclusion, complete-read coordination, exact bounded limits, dotenv/CLI implementations, schemas, public/private routes, recovery procedures, provider configuration and traceable proof hooks. A mechanism unsupported by pinned APIs is a blocked design decision.
5. Document 07 enumerates **all currently approved FRs, ACs, POs and new DX/agent proof needs** (102 FR / 60 AC / 24 inherited PO in this candidate), assigns each to the correct gate and maps them to complete mini-project sessions. Estimate low/likely/high engineering hours **including independent reviewers**, and model calendar duration separately for retention aging, release, and the 28-day field observation. The approximately 400-hour envelope is not verified. If infeasible, submit an explicit closed-capability scope amendment or seek a justified overrun before implementation, never waive recovery or finish half a feature.
6. Document 08 supplies each session's entry prerequisites, complete TODO sequence, intermediate checkpoints, exact commands/configuration/test evidence and next-session handoff. It must distinguish the 56 release-applicable ACs from the 4 post-release ACs and the staged real-consumer follow-up. Any open exit remains open. The week beginning 9 November 2026 is the intended engineering start window, not pre-approval of proof-dependent feature work. Synthetic, isolated prerequisite feasibility checks may begin within that window while governing approval and prerequisite results are tracked.

**Acceptance of this draft** does not mean the service is built, secure, production-approved or scheduled to finish in a fixed calendar window. It means the chosen complete product has a candidate observable contract, with unverified dependencies and governance blockers identified rather than concealed.

---

## Appendix A — Source and change ledger

| Input | Treatment in Document 04 | Verification limit |
| --- | --- | --- |
| `doc_03_mykey_stage_1_mission_brief_v0.3_preimplementation_audited.md` | Governs Stage 1 product, trust limits, UX/agent experiment, two gates, external KMS-key and retention proof boundaries | Document is a proposed audit-revised baseline, not execution evidence |
| `doc_02_mykey_project_stage_breakdown_v0.3_preimplementation_audited.md` | Stage 1 evolutionary position, recovery/retention critical-path risks, full-product completeness and 400-hour constraint | Stage hours are illustrative, not estimated from task inventory |
| `doc_01_mykey_project_northstar_v0.2_audited.md` | Future agent-native strategy, DX differentiation and trust direction | Future product features are explicitly excluded from Stage 1 without approval |
| Inherited `1-02` Functional Specification v2.1 | Preserves FR-1.01–1.88 and AC-1.01–1.44 with identifier continuity and original behavioral specificity | Inherited terms `1-01`/`1-04` are historical references, not the new authority hierarchy |
| Inherited `1-03` Technical Audit v2.0 | Keeps PO-1–PO-24 OPEN as critical proof inventory | No actual executable proof has been provided |
| Inherited `1-04` Technical Specification v2.1 | Technical candidate and unresolved gates to independently reevaluate in Docs 05–06 | Neither vendor compatibility nor safe integration proved by a document audit |
| P-01, P-02, P-03 | Governing records still referenced | Original contents not supplied; no supersession or comprehensive guarantee-mapping asserted |

**Proposed additions and v0.3 clarifications:** New FR-1.89–FR-1.102 and AC-1.45–AC-1.60 remain the proposed addition set (unchanged count). v0.3 adds binding interpretation notes covering externally held seal keys, R2 lock/repository operation and calendar proof classification, and corrects the release-only status of AC-1.52 while assigning real-consumer evidence to AC-1.58. The old inherited numbered FR/AC entries are preserved unchanged in this edition; no future SaaS feature has been introduced as an active Stage 1 endpoint.

## Appendix B — Open decisions before executable technical design

| Decision | Owner document | Required resolution |
| --- | --- | --- |
| Governing P-01/P-02/P-03 priority and explicit supersession | Document 03 approval + governing decision log | No hidden conflicting retention/security scope; decide whether old `1-01` mission remains separate reference only |
| CLI binary name (`secrets` in inherited source vs working product name `mykey`) | Documents 04 approval and 06 CLI contract | Preserve `secrets` for v1 compatibility unless formally choosing/documenting a tested new canonical command and acceptance changes |
| Operator-private diagnostic interface form | Document 06 | Tested VPN-bound authenticated CLI/status is acceptable; web owner role must not implicitly gain operator authority |
| Browser/frontend implementation and supported responsive ranges | Documents 05–06 | Usable responsive/keyboard/focus behavior without speculative certification claims |
| Agent trusted-executor harness details | Documents 05–06/07 | Deterministic allowlist, fixed scope, no arbitrary agent code or secret/model-context overlap |
| Product metrics provenance, privacy/cardinality controls and retention | Documents 05–06 | Minimal reliable instrumentation/aggregates and ACLs; no third-party uncontrolled telemetry |
| Exact per-endpoint limits, retries and timeouts | Document 06 | Bound and test every relevant API/machine/auth/CLI path; no inferred transactional behavior |
| Auth/KMS/retention feasibility failures and alternatives | Document 05, then approved Document 06 | Failing prerequisite blocks dependent work; no weaker-security substitute |
| Auto-unseal wrapping key custody, unavailability and key-loss nonrecoverability | Documents 05–06 plus release proof registry | Document actual seal key ID/version/controls; distinguish temporary KMS/cert outage from irreversible deleted-key loss, and verify closed failure in disposable staging |
| R2 lock policies versus repository pruning and physically expired pairs | Documents 05–06 and source-authorized gate ledger | Test operations on actual backend and aging; verify no still-eligible backup is damaged by maintenance |
| Calendar-dependent proof due dates | P-series reconciliation + Document 04 acceptance approval; execute via Documents 07–08 | Enumerate every aging-dependent test and assign release versus completion per governing contract before starting work |
| Stage budget | Document 07 | Bottom-up proof+delivery+hardening+field-remediation estimate; approved overrun or formally closed capability cuts |

**Audit disposition:** **v0.3 final pre-implementation audited candidate for governing approval**, subject to authoritative P-01/P-02/P-03 and original baseline comparison, explicit elapsed-proof gate mapping, and subsequently executed proofs. The complete Stage 1 functional contract remains a candidate containing **102 FRs and 60 ACs**, not a promise that these fit 400 hours or an assertion of passed security/infrastructure testing.

## Appendix C — Exhaustive inherited-ID reconciliation register

The following is an **identifier-by-identifier proposed disposition**, not a passing-test claim or authorization to replace P-01/P-02/P-03. `RETAIN` means the complete requirement or scenario remains in this draft, with no scope reduction; `OPEN` means the technical proof has not been executed/accepted. All inherited identifiers still require project approval and accurate mapping to later-session evidence. Proposed changes to the short external-document reference wording are editorial and do not relax the operational rule. Any future `AMEND`, `REPLACE` or `REMOVE` decision must name the exact ID, security implication, replacement behavior/test, governing authority and updated downstream tasks.

### C.1 All 88 inherited functional requirements

| Inherited ID | Proposed disposition | Location here / responsibility |
| --- | --- | --- |
| FR-1.01 | **RETAIN** — no substantive deletion | §2; test under §12 |
| FR-1.02 | **RETAIN** — no substantive deletion | §2; test under §12 |
| FR-1.03 | **RETAIN** — no substantive deletion | §2; test under §12 |
| FR-1.04 | **RETAIN** — no substantive deletion | §2; test under §12 |
| FR-1.05 | **RETAIN** — no substantive deletion | §2; test under §12 |
| FR-1.06 | **RETAIN** — no substantive deletion | §2; test under §12 |
| FR-1.07 | **RETAIN** — no substantive deletion | §2; test under §12 |
| FR-1.08 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.09 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.10 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.11 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.12 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.13 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.14 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.15 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.16 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.17 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.18 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.19 | **RETAIN** — no substantive deletion | §3; test under §12 |
| FR-1.20 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.21 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.22 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.23 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.24 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.25 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.26 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.27 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.28 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.29 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.30 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.31 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.32 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.33 | **RETAIN** — no substantive deletion | §5; test under §12 |
| FR-1.34 | **RETAIN** — no substantive deletion | §5; test under §12 |
| FR-1.35 | **RETAIN** — no substantive deletion | §5; test under §12 |
| FR-1.36 | **RETAIN** — no substantive deletion | §5; test under §12 |
| FR-1.37 | **RETAIN** — no substantive deletion | §5; test under §12 |
| FR-1.38 | **RETAIN** — no substantive deletion | §5; test under §12 |
| FR-1.39 | **RETAIN** — no substantive deletion | §6; test under §12 |
| FR-1.40 | **RETAIN** — no substantive deletion | §6; test under §12 |
| FR-1.41 | **RETAIN** — no substantive deletion | §6; test under §12 |
| FR-1.42 | **RETAIN** — no substantive deletion | §6; test under §12 |
| FR-1.43 | **RETAIN** — no substantive deletion | §6; test under §12 |
| FR-1.44 | **RETAIN** — no substantive deletion | §6; test under §12 |
| FR-1.45 | **RETAIN** — no substantive deletion | §6; test under §12 |
| FR-1.46 | **RETAIN** — no substantive deletion | §7; test under §12 |
| FR-1.47 | **RETAIN** — no substantive deletion | §7; test under §12 |
| FR-1.48 | **RETAIN** — no substantive deletion | §7; test under §12 |
| FR-1.49 | **RETAIN** — no substantive deletion | §7; test under §12 |
| FR-1.50 | **RETAIN** — no substantive deletion | §7; test under §12 |
| FR-1.51 | **RETAIN** — no substantive deletion | §7; test under §12 |
| FR-1.52 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.53 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.54 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.55 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.56 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.57 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.58 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.59 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.60 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.61 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.62 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.63 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.64 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.65 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.66 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.67 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.68 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.69 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.70 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.71 | **RETAIN** — no substantive deletion | §10; test under §12 |
| FR-1.72 | **RETAIN** — no substantive deletion | §10; test under §12 |
| FR-1.73 | **RETAIN** — no substantive deletion | §10; test under §12 |
| FR-1.74 | **RETAIN** — no substantive deletion | §10; test under §12 |
| FR-1.75 | **RETAIN** — no substantive deletion | §10; test under §12 |
| FR-1.76 | **RETAIN** — no substantive deletion | §2; test under §12 |
| FR-1.77 | **RETAIN** — no substantive deletion | §2; test under §12 |
| FR-1.78 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.79 | **RETAIN** — no substantive deletion | §7; test under §12 |
| FR-1.80 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.81 | **RETAIN** — no substantive deletion | §8; test under §12 |
| FR-1.82 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.83 | **RETAIN** — no substantive deletion | §4; test under §12 |
| FR-1.84 | **RETAIN** — no substantive deletion | §5; test under §12 |
| FR-1.85 | **RETAIN** — no substantive deletion | §7; test under §12 |
| FR-1.86 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.87 | **RETAIN** — no substantive deletion | §9; test under §12 |
| FR-1.88 | **RETAIN** — no substantive deletion | §4; test under §12 |

### C.2 All 44 inherited acceptance cases

| Inherited ID | Proposed disposition | Evidence owner |
| --- | --- | --- |
| AC-1.01 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.02 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.03 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.04 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.05 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.06 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.07 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.08 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.09 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.10 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.11 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.12 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.13 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.14 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.15 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.16 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.17 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.18 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.19 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.20 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.21 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.22 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.23 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.24 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.25 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.26 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.27 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.28 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.29 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.30 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.31 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.32 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.33 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.34 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.35 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.36 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.37 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.38 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.39 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.40 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.41 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.42 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.43 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |
| AC-1.44 | **RETAIN** — exact scenario retained | §12; Documents 07–08 assign session/evidence |

### C.3 All 24 inherited technical proof obligations

| Inherited ID | Proposed disposition | Technical audit / execution owner |
| --- | --- | --- |
| PO-1 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-2 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-3 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-4 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-5 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-6 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-7 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-8 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-9 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-10 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-11 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-12 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-13 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-14 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-15 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-16 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-17 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-18 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-19 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-20 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-21 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-22 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-23 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |
| PO-24 | **OPEN** — no proof result asserted | Document 05 reassessment; Document 06 mechanism; Documents 07–08 execution |

**Closure rule:** This register is complete for the *inherited* numbered inventory (88 + 44 + 24). The proposed **14 added FRs and 16 added ACs** already appear individually in §11 and §12.1. Added technical proofs, if warranted by Document 05, receive new noncolliding IDs, test owners and downstream evidence links. The presence of `RETAIN` does **not** imply that the 400-hour envelope is realistic or that a feature has been implemented.



## Appendix D — 7 November 2026 final pre-implementation audit delta

**This appendix is a change ledger for v0.2 → v0.3, not an executed technical audit.** The preceding imported baseline, original inherited numbered FR-1.01–FR-1.88, original inherited acceptance rows AC-1.01–AC-1.44 and source proof-ID inventory have not been narrowed or removed. Changes are principally to proposed FRs/ACs, document authority, a binding interpretation of the unchanged recovery clauses, and the documentary gate register.

| Finding | Severity | Treatment | Follow-through |
| --- | --- | --- | --- |
| D04-01: obsolete 2 November start and references to superseded 02/03 editions | Low | Header, Appendix A and handoff now point to the week beginning 9 November and v0.3 parents | Confirm approved release/doc baseline in worktree before implementation |
| D04-02: AC-1.52 was counted as a release case while containing an unexecuted real-consumer post-release follow-up | High (acceptance integrity) | AC-1.52 is exclusively a pre-release synthetic onboarding proof; AC-1.58 explicitly owns actual first-real-consumer onboarding and subsequent 28-day observation | Preserve 56-release/4-stage-completion counts; evidence manifest tests the **whole** case at its stated gate |
| D04-03: correct backup does not imply recoverable OpenBao if KMS seal/wrapping key is permanently lost | High (disaster recovery) | Added binding interpretation of FR-1.64–1.68/1.78/1.87 and negative disposable-key evidence to proposed AC-1.57 | Doc 05 validates provider mechanics and Doc 06 specifies key custody/migration and closed-failure test |
| D04-04: R2 retention protection may interfere with backup repository maintenance/cleanup, and lock rules have administrator trust limits | High (recoverability) | Added provider-specific behavior and actual lock/prune/oldest-pair test requirement, with safe handling of shared repository objects | Doc 05 establishes a feasible backup layout; Doc 06/07/08 specify and execute aged and fault-injected proofs |
| D04-05: elapsed-time lock/retention proofs had no unambiguous due-date treatment | High (release integrity) | AC-1.36 and AC-1.44 are release blockers **by default** under this inherited 44-AC release register; reclassification needs an explicit authoritative signed amendment | Begin genuinely aged disposable retention fixtures early; no simulated aging pass or implicit deferral |
| D04-06: old audit prose could be misread as proof the current audit re-compared unavailable inherited documents | Medium (provenance) | Current-pass inventory is explicitly limited to supplied documents; original inherited contracts/P-series must be fetched and reconciled before governing approval | Retrieve and diff source texts and produce signed FR/AC/PO and P-series disposition ledger |

**Primary-source background checked (not a substitute for runtime proof):**

- [OpenBao auto-unseal and recovery keys](https://openbao.org/docs/concepts/seal/) — auto-unseal recovery shares do not replace a lost external KMS wrapping key.
- [OpenBao KV v2 and version lifecycle](https://openbao.org/docs/secrets/kv/kv-v2/) — configurable version retention, CAS and soft-delete semantics must be matched to the pinned implementation.
- [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) — locks override lifecycle deletion, but privileged administrators can change/remove lock rules.
- [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) — physical expiry may lag configured eligibility; prove rather than assume.

**Approval boundary:** Doc 04 v0.3 can be approved for downstream specification **only after governing-source comparison and the indicated source-required calendar gate decisions**. Actual engineering release, real application secrets and any security assurance remain contingent on executed, pinned end-to-end proof and independent review.
