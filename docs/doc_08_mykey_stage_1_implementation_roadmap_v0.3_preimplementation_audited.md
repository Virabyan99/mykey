# 08 — MyKey Stage 1 Implementation Roadmap

| Field | Contract |
| --- | --- |
| Project | **MyKey** (placeholder name) |
| Product / scope | **MyKey Private**, Stage 1: complete single-operator secrets service and validation increment |
| Version / date | **v0.3 — final pre-implementation audited execution-runbook candidate**, 7 November 2026 |
| Planning input | Document 07 v0.3: **S01–S47**, 903 provisional person-hours + 136-hour uncertainty reserve |
| Normative product inputs | Documents 03 v0.3 (mission), 04 v0.3 (102 FR / 60 AC); Document 06 v0.3 (technical contracts), subject to unresolved gates |
| Technology evaluation | Document 05 v0.3 audited; native-first candidates are conditional until executable proofs |
| Release structure | **R**: 56 release ACs and integrated security/restore proof; **F**: 4 post-release ACs and measured use |
| Authority status | **Revised runbook candidate, not authorization to implement the unapproved 1,039-hour envelope**. S01 governance, upstream AC-1.42 wording, and early feasibility gates remain OPEN |
| Implementation start target | week commencing 9 November 2026 (governance and separately authorized synthetic feasibility only until gates are approved) |

> **Controlling result:** The complete sequence must deliver a secure, recoverable, independently useful MyKey Private service that can operate even if Stage 2 never begins. Every included feature must work end to end. No runbook may convert a known failing requirement into “future work,” and no late release test substitutes for implementing the required feature.

## Part I — Execution authority and operating rules

### 1. What this document can and cannot authorize

This is the most detailed **execution-level** document, but not a unilateral replacement for the functional requirements or technical architecture. The normative order is: accepted mission/scope and Documents 03–04; binding engineering design in Document 06 after its gates; verified decisions recorded in `docs/decisions/`; the approved workload and dependencies in Document 07; and **these runbooks for execution**. If two of those conflict, freeze the affected slice, record a decision and propagate a signed change to the governing documents and downstream tests. Do not resolve a contradiction through an undocumented coding guess.

**At authoring time, none of the following are approved or proven:** P-01/P-02/P-03 reconciliation; formal resolution of AC-1.42; engineering authorization beyond the nominal ~400 h target; Better Auth protected-storage integration; OVH/OpenBao KMS interoperability; external-effect exclusion; consistent resolution; machine token lineage; actual-time R2 retention; clean-host restored-access invalidation. All proof results in this document are *instructions to gather evidence*, never a claim that evidence already exists.

**S01 admission rule (Document 07 v0.3):** If the owner cannot obtain/reconcile governing records and authorize either the complete estimated program or a revised complete functional scope, S01 remains `BLOCKED`. Safe limited feasibility work may occur only when independently authorized and documented; dependent product feature work must not proceed by ignoring S01. A 903-hour provisional workload cannot be described as an approved 400-hour implementation.

### 2. Runbook statuses and evidence assurance

| State | Meaning / what is prohibited |
| --- | --- |
| `NOT_STARTED` | No session prerequisite inspected; execution has not begun. |
| `IN_PROGRESS` | Some tasks/checkpoints are underway; incomplete functionality is synthetic staging-only. |
| `BLOCKED` | Unmet authority, dependency, provider or proof condition; no dependent effect permitted. |
| `FAIL` | Executed proof/acceptance contradicted the selected design or security invariant; retain original evidence and replan. |
| `REPLAN_REQUIRED` | Scope, design, estimate, sequencing or risk premise changed; revise owning decision and applicable docs before more work. |
| `PASS` | Session-specific deliverable and negative tests verified, artifacts committed, required reviewer approvals and handoff recorded. |

**Immutable-release evidence rule:** A proof binds to an immutable **product source commit**, reviewed schema revision, resolved dependency manifest and deployed **image/build digests**. Session checkpoints, test results and signed release manifests are recorded separately as append-only evidence whose own hashes reference that fixed product identity. Committing evidence files may change the evidence-repository SHA without changing the deployed product; it must **not** create a false circular requirement to rebuild for every evidence note. Conversely, any actual executable code, dependency, migration, policy, image or material runtime configuration change invalidates affected proofs and requires a newly reviewed candidate. `product_source_sha` and `evidence_revision_sha` are separate fields in every release manifest. A missing product identity cannot be filled with an evidence-only Git commit.

**Separate proof maturity:** `DOCUMENTED` → `SPIKE_PASS` → `INTEGRATED_PASS` → `RELEASE_PASS`. A session `PASS` can establish an early **spike** without granting integrated release authority. Use `NOT_YET_DUE` for AC-1.53, AC-1.54, AC-1.58 and AC-1.59 until after R. AC-1.52 is wholly synthetic/pre-release; the first real consumer belongs to S47/AC-1.58. Inherited AC-1.42 requires a signed S01 interpretation or targeted approved amendment. `SUPERSEDED_WITH_TRACE` requires retained prior failure and replacement evidence. Evidence is invalidated (`STALE`) after security-relevant changes to pins, schema, policies, root of trust or restore mechanisms.

Security proofs require a non-author reviewer who examines negative cases. Never record a reviewer simply because CI is green; preserve reviewer identity, reviewed **product source commit and image/config digests**, separately hashed evidence revision, disposition and independent rerun or inspection. Maintain findings from failed trials rather than overwriting them.

### 3. Repository conventions and callable command contracts

The following **proposed** locations are derived from Document 06 and the Pre-Roadmap; they do **not** exist merely because this roadmap names them. **S02 owns their initial creation and validates the actual layout**. If real pinned packages require a different layout, record a reviewed path map and apply it consistently to later runbooks; do not silently edit historical evidence.

```text
apps/{api,provisioner,web,cli,ops}/
packages/{contracts,db,auth,openbao,operations,audit}/
infra/{compose,hosts,traefik,openbao,backup,recovery,release}/
workers/probe/
tests/{unit,integration,security,fault,browser,cli,restore,acceptance}/
docs/decisions/
docs/evidence/{sessions,proofs,acceptance,releases,field-use}/
docs/runbooks/
```

S02 must establish the following stable **repository command interface** as script entries (exact backing test runner and platform implementation selected by G-PINS). Every applicable command exits nonzero on failures, missing required tests, missing fixtures, invalid evidence schema or suite-selection errors. For tests requiring cloud services or a reviewer, a skipped test is **not** a PASS.

```bash
git status --porcelain
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm run check                # formatting, lint, typecheck, schema and contract checks
pnpm run test:session -- SNN  # registered positive, denied and failure tests for SNN
pnpm run evidence:verify -- SNN  # hashes, provenance, status, reviewer/handoff schema
```

`SNN` denotes a real session identifier such as `S07`, **not** the literal text to type. Tests with a cloud/provider dependency use the approved external fixture, not simulated `PASS` data. Each session creates or extends its registered test scope; `test:session` may run several native tools. When a session's required evidence cannot be machine-verified (for example, clean-host recovery or actual-time retention), its manifest must reference executed human/reviewer proof with hashes and observed outcomes. For a targeted rerun, first inspect the registered test list in the session manifest; if a test does not exist yet, creating it is part of the session's work.

Pre-release examples may use **only synthetic credentials and secrets**. Never store secret values, machine bearer tokens, password-reset links, recovery codes, seed material or sensitive request/response bodies in evidence, CI artifacts, logs, telemetry, screenshots, browser storage or Git. Avoid putting tokens in shell arguments, history or process listings. Use short-lived external injected credentials and secure file descriptors/permissioned files as proved by the relevant session. All credential-bearing operations require a bounded non-recording environment.

### 4. Mandatory entry procedure for *every* session

1. Read this runbook, the full normative FR/AC/PO text referenced in Document 04 and applicable Document 06 section. Do not rely on the trace label alone. Read the final handoff of each predecessor, including any `FAIL`, `BLOCKED`, `STALE` or undecided branch.
2. Verify git clean/approved branch and exact source SHA; compare `infra/dependencies.lock.json`, `pnpm-lock.yaml`, schema and image digests to the signed prior handoff. Never reuse a test result across changed security-sensitive pins without a new risk disposition.
3. Validate that **every** hard predecessor has a recorded `PASS` and that all applicable named early feasibility gates are `SPIKE_PASS` or later; a 29-proof register is mandatory, including KMS-L1, DB-G1, R2-L1, AGENT-B1 and COST-B1. A session PASS that produced no necessary gate evidence is insufficient.
4. Verify access to a staging-only fixture, nonauthor security reviewer where required and a safe rollback/abort procedure; record the security boundary and denied behavior for the session.
5. Create `docs/evidence/sessions/SNN/entry.md` with the timestamp, engineer, reviewer, branch, SHA, prerequisite evidence hashes, actual accepted scope, estimated hours and first test command. Mark state `IN_PROGRESS` only after entry checks pass.

**Pre-entry labor and calendar check:** Before starting S02–S47, enter a session-specific low/expected/high person-hour forecast and an allocation for implementation, test/integration, independent reviewer, and evidence/handoff labor. The expected figure is compared against Document 07's baseline; it is not silently treated as inclusive of unspecified external review. Enter provider charges, reviewer availability, real-time retention checks, and any calendar delays separately. A discrepancy requires an updated program forecast and signed scope/budget decision when authority is exceeded. S01 establishes the review staffing/cost rule. The risk reserve covers uncertainty, not knowingly omitted review work. The initial low/high bounds remain **unquantified** until grounded by S01 and early measured sessions; do not manufacture numerical confidence intervals.

**Bootstrap exception:** S01 may legitimately start without a repository, lockfile, schema or SHA; it must initialize the evidence repository and label absent deployment artifacts `NOT_YET_CREATED`, never invent hashes. S02 establishes the executable project tooling. For later sessions, compare actual source and pin hashes. If an entry prerequisite fails, leave the session `BLOCKED`, identify the exact prerequisite and return to its owner. Do not start dependent feature work under a waiver invented by the developer.

### 4.1 Concrete session-reference and test-manifest standard

The runbooks below now include **per-session FR/AC/PO accountable identifiers and exact governing section pointers**. An early experiment may *contribute* to a proof whose primary accountable closure is in a later session. Its record must distinguish `contribution`, `primary_closure`, and `integrated_release_replay`, rather than using a generic status called "proof passed". Every session must create `docs/evidence/sessions/SNN/tests.json` (or a schema-equivalent artifact approved in S02) listing **named positive, denied, crash/restart and cross-component cases as applicable**, target service/role, fixture, expected result, command or operator drill, and evidence path. The test runner must compare the manifest against actual registered cases; an empty manifest is a failure unless S01 explicitly documents that the software test runner is not yet available.

Every handoff records its **actual** next eligible dependency, not only the numerically next session: a parallel successor is actionable only when all its own prerequisites and gates pass. Every checkpoint records `resume_at` as an executable next action, not only a thematic description. The manually approved session evidence ledger—not this planning document—is the authoritative record of what has passed.

### 5. Checkpoint format and interruption recovery

Every session has three planned checkpoints `CP-01` (first implementation slice), `CP-02` (integrated slice) and `CP-03` (negative/failure proof and exit preparation). The checklist below names exact intended actions; checkpoint timing is determined by verified deliverables, not elapsed hours.

A checkpoint record (`docs/evidence/sessions/SNN/cp-0X.md`) must contain:

```yaml
session: SNN
checkpoint: CP-01
status: VERIFIED | IN_PROGRESS | BLOCKED | FAIL
source_sha: "<actual git SHA>"
dependency_manifest_sha256: "<actual hash>"
schema_revision: "<actual revision or NOT_APPLICABLE>"
artifacts: ["<tracked path and content hash>"]
commands: ["<exact executed command, redacted if necessary>"]
observed: ["<actual result or denial, no values>"]
open_effects: ["<operation ID / status only>"]
reviewer: "<identity or PENDING>"
resume_at: "<exact next checkbox/command>"
```

The sample values above are **schema exemplars**, not recorded execution. An interrupted session starts by rechecking live database/backend operation states; no external action with unknown outcome may be blindly replayed. Explicitly preserve partial code and an `IN_PROGRESS` handoff, not a fabricated PASS. If any critical action reveals sensitive data in evidence, quarantine and sanitize it through the approved incident procedure before proceeding.

### 6. Exit and independent review procedure

A runbook's `PASS` requires: every checked task and applicable scenario completed; targeted `pnpm run check`, `test:session` and `evidence:verify` command output recorded; expected **negative** results actually observed; no secret-bearing artifact; final migration/config diff reviewed; relevant FR/AC/PO evidence linked; unresolved effects explicitly reconciled or the session marked blocked; release-affecting issues closed; a non-author reviewer for security proof; and committed `exit.md` plus `handoff.md`.

Every handoff record must include actual Git SHA, dependencies/pins, image digests, schema revision, changed files, positive/negative/fault evidence paths, test counts, open backend operations, proof maturity, approved decisions and residual risk, next eligible session(s), and **the immediate next command/task**. A reference to “continue implementation” is not a valid next task. Reviewers must not accept “passed locally” without preserved outputs or proof references.

### 7. Program gates, milestones and time control

- **G-PINS:** S02 spike; final pin review S43/S45.
- **G-AUTH:** S07 spike; integrated S14/S44.
- **G-BAO:** S05/S06 spikes (including KMS-L1 disposable loss/custody); issuance S26/S29 and restore S42; final S44/S45.
- **G-EFFECT:** S08 spike; KV S21, issuance S27, archive S28, final S44.
- **G-RESOLVE:** S19 adversarial spike; full S24, CLI S30, final S44.
- **G-BACKUP:** S09 real-clock R2-L1 and COST-B1 START; S04/S11 DB-G1 globals/capture spike; S41 R2-L1/COST-B1 and S42 DB-G1/KMS-L1 full proof, S45 release.
- **G-CLIENT:** S10 public-beta AGENT-B1 comparison; S31 production parity/distribution, S32 API reference, S45 final.
- **G-OPS-DX:** S03 minimal independent alert; S37–S40 complete UX, audit and private diagnostics.
- **G-AGENT-FIELD:** **after** S45 only; S46 synthetic agent fixture and S47 real-consumer/28-day observation may begin independently; both must finish for F signoff.

**R release**: only S45 may authorize controlled real use, after 56 R ACs, all applicable 24 inherited and five supplemental technical proofs, independent S44 reviewer signoff, clean-host restore, provider-clock retention maturity and exact release evidence. **F stage completion**: S46 and S47 may commence independently after R; both close the four field ACs, and S47 final dossier requires S46 completion. R is not backdated. Changes after security review require affected reruns; unresolved critical defects block release. Native Windows, dynamic secrets, generic workload federation, SDKs, multiuser SaaS and general agent orchestration are outside Stage 1.

The target is **903 active engineering hours + 136 h uncertainty reserve = 1,039 h planning envelope**, not an approved budget. Track actual engineering and independent reviewer hours separately at each checkpoint; update time-to-complete estimates at S07–S10 and each major gate. Provider-clock aging, certificate cycle and 28 days of actual field use are **elapsed calendar constraints**, not full-time engineering-hour entries. A reduction in scope requires a complete formally amended product shape—never partially implemented included features.

## Part II — Navigation, cross-reference and milestone routing

The **hard dependency edges** are taken literally from Document 07 v0.3; the ordinal sequence is a valid topological ordering, not a mandate to postpone independent work. No downstream executor may infer that a predecessor passed because its estimated hours were consumed. For a requested session, search for `### SNN —` and open its runbook and prior session `handoff.md`.
### Session register and validated effort envelope

| Session | Coherent engineering mini-project | Hours | Hard predecessor(s) | Risk |
| --- | --- | ---: | --- | --- |
| **S01** | Authority reconciliation and executable evidence system | 13 | None — bootstrap | High |
| **S02** | Reproducible toolchain, pinning and build pipeline | 15 | S01 | High |
| **S03** | Hardened two-host network and service skeleton | 18 | S02 | High |
| **S04** | PostgreSQL roles, schemas and migration discipline | 19 | S02, S03 | High |
| **S05** | OVH–OpenBao real auto-unseal feasibility | 21 | S03 | Critical |
| **S06** | OpenBao tenancy, identities and native policy feasibility | 17 | S04, S05 | Critical |
| **S07** | Better Auth protected-storage and factor feasibility | 20 | S02, S04 | Critical |
| **S08** | Delayed backend effect and exclusion feasibility | 18 | S04, S06 | Critical |
| **S09** | Actual-time backup retention experiment launch | 14 | S03 + external R2/key-custody fixture; **not S05** | Critical |
| **S10** | OpenBao Agent versus MyKey CLI decision spike | 12 | S02, S06 | Medium |
| **S11** | Application persistence and early paired-capture feasibility | 26 | S04, S06, S08 | High |
| **S12** | Owner bootstrap, password phase and abuse protection | 17 | S07, S11 | High |
| **S13** | TOTP completion, enrollment and recovery codes | 19 | S12 | Critical |
| **S14** | Sessions, fresh TOTP, account reset and recovery | 18 | S13 | Critical |
| **S15** | Authorization, concealment and current-state gate | 17 | S11, S13 | High |
| **S16** | Operator-only organization provisioning and drift review | 18 | S06, S11, S15 | Critical |
| **S17** | Project/environment lifecycle and readiness | 17 | S15, S16 | High |
| **S18** | Durable operations and replay semantics | 21 | S08, S11, S15 | Critical |
| **S19** | Secret creation, update, indexing and version history | 25 | S17, S18 | Critical |
| **S20** | Secret deletion, undelete and version restoration | 17 | S19 | High |
| **S21** | Reconciliation, execution exclusion and fault suite | 23 | S18, S19, S20 | Critical |
| **S22** | Strict dotenv codec and loader evidence | 13 | S02 | Medium |
| **S23** | Import preview, apply and interrupted continuation | 19 | S19, S20, S21, S22 | Critical |
| **S24** | Coherent whole-environment snapshot/resolution | 20 | S19, S21, S23 | Critical |
| **S25** | Human export and sensitive response path | 12 | S14, S22, S24 | High |
| **S26** | Read-only machine issuance and token inventory | 21 | S06, S14, S17, S18 | Critical |
| **S27** | Revocation and uncertain issuance lifecycle | 22 | S21, S26 | Critical |
| **S28** | Project/environment archive and reactivation | 17 | S17, S21, S27 | Critical |
| **S29** | Machine API, direct OpenBao checks and scope | 16 | S15, S24, S26, S27 | Critical |
| **S30** | Shipping CLI: secure keys/run/export and error model | 23 | S10, S24, S29 | Critical |
| **S31** | Four-platform delivery and protected consumer setup | 21 | S30 | High |
| **S32** | Shared API/OpenAPI and local protected Scalar | 14 | S14, S19, S29 | Medium |
| **S33** | Owner frontend shell, MFA and resource navigation | 20 | S14, S15, S17, S32 | High |
| **S34** | Secret inventory, reveal, lifecycle and history UI | 22 | S19, S20, S21, S33 | High |
| **S35** | Import/export and safe first-run UI | 16 | S23, S25, S33 | Medium |
| **S36** | Credential inventory, issuance and revocation UI | 18 | S27, S33 | High |
| **S37** | Accessibility, browser security and actionable errors | 16 | S32, S33, S34, S35, S36 | High |
| **S38** | Full audit coverage, tenancy and retention | 17 | S11, S21, S29 | Critical |
| **S39** | Operations timeline, resource overview and safe analytics | 20 | S34, S36, S38 | Medium |
| **S40** | Limits, readiness, private diagnostics and off-host alerts | 19 | S03, S16, S38 | Critical |
| **S41** | Paired capture, immutable retention and aging verification | 32 | S09, S11, S21, S27, S38, S40 | Critical |
| **S42** | Clean-host quarantine restore and authority revalidation | 34 | S14, S27, S41 | Critical |
| **S43** | Supply chain, deployment/rollback and operator runbooks | 20 | S02, S03, S40, S41, S42 | High |
| **S44** | Independent security, fault and prohibited-surface suite | 24 | S24, S28, S31, S32, S34, S35, S36, S37, S38, S39, S40, S41, S42, S43 | Critical |
| **S45** | Controlled-use release, synthetic onboarding and evidence closure | 25 | S31, S32, S34, S35, S36, S37, S39, S40, S42, S43, S44 | Critical |
| **S46** | Bounded staging-only agent-initiated acceptance | 15 | S31, S40, S45 | High |
| **S47** | Four-week field observation, regression and stage-exit dossier | 22 | **Start:** S45 signed R; **Final F exit:** S46 independently PASS | Medium |

| Workstream | Session range | Active engineering hours |
| --- | --- | ---: |
| A — Governance, infrastructure, and early feasibility | S01–S10 | **167** |
| B — Foundational behavior and durable state | S11–S21 | **218** |
| C — Import, machine authority, CLI, and API | S22–S32 | **198** |
| D — Owner experience, security and operations | S33–S43 | **234** |
| E — Release and field validation | S44–S47 | **86** |
| **Total** | **47 sessions** | **903 h** |

**Budget authority:** +136 h rounded-up explicit uncertainty reserve = **1,039 h proposed planning envelope**; this is not approved merely because runbooks exist. Review/recalibrate from real measured sessions. Do not confuse engineering hours with retention-aging or ≥28-day field-use calendar time.

## Part III — Session-by-session executable runbooks

The steps below specify the intended implementation tasks. The first session must obtain authority; S02/S03 create the repository and runtime conventions. **Paths are assigned targets, not claims that a codebase already exists.** Exact observed commands, tool versions and source hashes are written to the live session record during execution; any commands dependent on the actual pins must be proven before adoption.

### S01 — Authority reconciliation and executable evidence system

**Plan:** 13 active hours · **Risk:** High · **Gate:** Governance approval required before dependent implementation · **Workstream:** A.

**Mini-project objective.** Establish the single governing baseline and a usable proof/evidence lifecycle before feature work.

**Included boundary.** Obtain P-01/P-02/P-03; reconcile with Docs 01 v0.2 and 02–06 v0.3; settle the literal inherited AC-1.42 versus revised synthetic AC-1.52 / real AC-1.58 interpretation through signed authority; record decisions DEC-01–DEC-15; establish independent reviewer roles, owner of all 29 proofs, evidence schema and approval-limited budget/scope. Create CI-readable 102-FR/60-AC/29-proof inventory, with a hard stop if governing records or economic authorization are missing. A bounded, separately approved proof-only work authorization is not an authorization to implement the uncut feature scope.

**Implementation/evidence targets.** `docs/decisions/, docs/evidence/, docs/runbooks/; governance manifest; no application changes`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] **Bootstrap exception:** no predecessor session exists; verify available source documents, an authorized decision-maker/custodian contact and a synthetic-only environment. Do not require S01 to pass itself.
- [ ] Evaluate the full Document 07 entry condition: **Access to the *available draft* Docs 01–06, the identified P-01/P-02/P-03 custodians or an authorized escalation path, and a synthetic-only workspace. Their reconciliation is S01’s deliverable, **not** an assumed prior approval.**
- [ ] Inspect the available governing sources and explicitly list absent repository/manifest/schema artifacts as `NOT_YET_CREATED` rather than inventing a source SHA or blocking the legitimate bootstrap.
- [ ] Record `docs/evidence/sessions/S01/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — prerequisite work; AC: none — contributing work; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§12–13 (acceptance, governance); Document 06 §§1, 15, 20 (gates, verification, decisions). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** S01 owns governance register entries for all five additional proofs; authority for implementation is not evidence that any passed. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Inventory all supplied Documents 01–07 by full file hash and authoritative version; record P-01/P-02/P-03 as **MISSING** until genuinely supplied, not as implicitly superseded.
- [ ] **02.** Obtain governing decisions from the authorized owner; compare confidentiality, authentication, recovery and stack assumptions against Documents 03–06 and write a signed conflict disposition per issue.
- [ ] **03.** Reconcile AC-1.42 in Document 04: distinguish synthetic-only first-consumer-host rehearsal before release from real consumer onboarding after signed R approval; update affected AC/proof references through change control.
- [ ] **04.** Publish the explicit 903 h baseline, 136 h reserve and 400 h target conflict for written scope/budget disposition; do not treat authoring runbooks as budget authorization.
- [ ] **05.** Initialize the versioned repository if absent, then establish `docs/decisions`, `docs/evidence/{sessions,proofs,acceptance,releases}` and evidence index templates; prohibit secrets and bearer tokens in these records.
- [ ] **06.** Define review independence, statuses, evidence provenance, change control and session/handoff file schemas; assign responsible owner and non-author proof reviewer roles.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] Reconcile the approved Docs 01 v0.2 and 02–07 v0.3 hierarchy, all 102 FRs, 60 ACs, and 29 technical proofs; establish `docs/evidence/proofs/{KMS-L1,DB-G1,R2-L1,AGENT-B1,COST-B1}` with primary owners and gated maturity.
- [ ] Obtain signed AC-1.42 interpretation/amendment without modifying the inherited AC implicitly; distinguish pre-release synthetic AC-1.52 from real-consumer AC-1.58 and the 28-day clock.
- [ ] Record an express 903-hour base, 136-hour reserve, 1,039-hour budget/scope decision versus the nominal ~400-hour objective, including reviewer resources; proof-only authorization does not authorize product feature development.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Identify and reconcile each governing decision; mark unavailable records explicitly BLOCKED. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S01/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Publish the explicit 903 h baseline, 136 h reserve and 400 h target conflict for written scope/budget disposition. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S01/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Define review independence, statuses, evidence provenance, change control and session/handoff file schemas. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S01/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run **document-governance validation rather than `pnpm` scripts that do not yet exist**: verify source file hashes, decision signatures, discrepancy ledger, authority matrix, and empty evidence schemas; preserve the actual check script/commands and reviewer disposition.
- [ ] Explicitly falsify this security/failure premise: **Missing governing authority or unsigned budget decision is BLOCKED, never inferred approval.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Signed reconciled baseline (including AC-1.42 disposition), named distinct evidence author/reviewer and either an approved stage budget near the updated estimate or an approved scope amendment plus revised WBS. If governance, reviewer capacity or budget authority is missing, dependent feature work is BLOCKED; an approved *proof-only* scope is logged separately. Mere "unresolved" is not PASS.**

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] **PASS only if** all governing conflicts are resolved, the full approved budget or a formally revised complete product scope is signed, the AC-1.42 amendment is reconciled, the independent reviewer is assigned and the versioned evidence repository exists. If any necessary authority is unavailable, record `BLOCKED`, never `PASS`.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Validate governance evidence with the S01 document-only schema/hash procedure, then commit `docs/evidence/sessions/S01/exit.md` with an independently reviewed PASS/BLOCKED disposition; do not assume the future S02 evidence runner exists.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S01/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S02 (only when all other predecessors also pass). **Next concrete action:** open S02 in this document, read its prerequisite and check `docs/evidence/sessions/S02/entry.md` eligibility, then execute its first ordered checkbox: **Choose exact supported Node/toolchain/TypeScript/package/image versions after peer-dependency, advisory, licensing and origin checks; record SHA/digest and review date.**

### S02 — Reproducible toolchain, pinning and build pipeline

**Plan:** 15 active hours · **Risk:** High · **Gate:** G-PINS early · **Workstream:** A.

**Mini-project objective.** Create the pinned, reproducible build/test/provenance foundation for subsequent executable spikes.

**Included boundary.** Monorepo, strict TS, pinned supported Node release (evaluate Node 26 Active LTS against Node 24 Maintenance LTS), stable PostgreSQL/OpenBao/Traefik/Better Auth candidates, pnpm/Vite+ integration, build/CI, reviewed Better Auth–Drizzle schema generation, package/image/action hashes, advisory/license evidence and incompatible-version rejection; create synthetic fixtures. Establish a *concrete route-contract inventory and schema-first freeze procedure* for every subsequent API vertical before handlers or clients are implemented; S32 assembles and validates the final reference, it must not invent routes after the fact.

**Implementation/evidence targets.** `package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig*, infra/dependencies.lock.json, .github/workflows/, apps/*, packages/*, tests/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S01**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S01.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S02/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — prerequisite work; AC: none — contributing work; PO: PO-24. **Exact source entry:** Document 04 §§8–10 (API/platform); Document 06 §§1–3, 15–16 (pins, repository, schema, evidence). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** S02 establishes the stable 29-proof manifest, exact pins/edition evidence and schema-first route contract freeze. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Choose exact supported Node/toolchain/TypeScript/package/image versions after peer-dependency, advisory, licensing and origin checks; record SHA/digest and review date.
- [ ] **02.** Scaffold pnpm workspace and the Document 06 monorepo boundaries, with shared contract and restricted operator-only entrypoints; no runtime root privilege.
- [ ] **03.** Generate Better Auth/Drizzle candidate schema against the pinned integration, review diffs and confirm a clean first migration path without production schema push.
- [ ] **04.** Create a deterministic CI workflow and task interface for typecheck, format, lint, unit/integration/CLI/browser/security tests and evidence verification; scripts must fail if required suites are missing.
- [ ] **05.** Pin workflow actions by commit, images by digest, source integrity and lockfiles; prohibit floating production tags and accidental prerelease versions.
- [ ] **06.** Run clean-room checkout/install/build/test and negative checks for incompatible engines, invalid signatures and migration drift; sign G-PINS spike evidence.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] Use the currently supported Node 26 Active LTS versus Node 24 Maintenance LTS as compatibility candidates; confirm all selected actual package/image release channels, advisories and deployment dates before pinning. Do not silently adopt a prerelease dependency.
- [ ] Register all 29 proof IDs with explicit field `gate`, `primary_owner`, `contributing_sessions`, `test_id`, `evidence_level`, `release_pin` and `reviewer`; failing fixture/missing proof file makes the registry validation fail.
- [ ] Establish a schema-first per-route method/path/auth/error/OpenAPI freeze *before* downstream handlers and clients; S32 will consolidate, not belatedly define routes.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Scaffold pnpm workspace and the Document 06 monorepo boundaries, with shared contract and restricted operator-only entrypoints. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S02/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Create a deterministic CI workflow and task interface for typecheck, format, lint, unit/integration/CLI/browser/security tests and evidence verification. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S02/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Run clean-room checkout/install/build/test and negative checks for incompatible engines, invalid signatures and migration drift. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S02/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S02` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Unsupported engine/pin, dependency drift, unreviewed schema generation or zero-test green CI must fail.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-PINS early spike PASS with fresh build, migrations dry-run, captured hashes; no claim that full release is pinned forever.**

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S02` and commit `docs/evidence/sessions/S02/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S02/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S03, S04, S07, S10, S22, S43 (only when all other predecessors also pass). **Next concrete action:** open S03 in this document, read its prerequisite and check `docs/evidence/sessions/S03/entry.md` eligibility, then execute its first ordered checkbox: **Provision independent staging and production-shaped hosts/accounts using synthetic staging data; document host/network identities and remote-access custody.**

### S03 — Hardened two-host network and service skeleton

**Plan:** 18 active hours · **Risk:** High · **Gate:** G-OPS-DX host boundary / PO-11 · **Workstream:** A.

**Mini-project objective.** Establish staging and production-shaped host deployment and independently test the trust boundary.

**Included boundary.** Separate OVH hosts, Compose topology, nonroot/read-only/resource envelopes, restricted egress, Traefik HTTPS/internal TLS, DNS/ACME, WireGuard-only SSH, private-service firewall and core-dump controls; prove host and role denial; install a minimal independent off-host probe/alert endpoint that remains useful if the staging host is completely unavailable (full alert catalog is S40).

**Implementation/evidence targets.** `infra/compose/, infra/hosts/, infra/traefik/, infra/wireguard/, workers/probe/, docs/runbooks/network.md`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S02**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S02.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S03/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.70, FR-1.71, FR-1.72; AC: AC-1.30, AC-1.31; PO: PO-11. **Exact source entry:** Document 04 §§9–10 (limits, platform); Document 06 §§2, 11–12 (runtime, limits, alerts). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Provision independent staging and production-shaped hosts/accounts using synthetic staging data; document host/network identities and remote-access custody.
- [ ] **02.** Build Compose service partitions, mounted secrets, read-only/non-root containers, capabilities, tmpfs, resource ceilings and explicit network connectivity.
- [ ] **03.** Configure Traefik OSS HTTPS, trusted upstream, internal mutual/verified TLS as required, WireGuard-bound administration, SSH keys and DNS-01 or approved TLS-ALPN issuance.
- [ ] **04.** Define default-deny egress with explicit DNS/ACME/KMS/R2/alert exceptions and verify actual host enforcement rather than assuming Compose networking blocks egress.
- [ ] **05.** Initialize minimal public `/health` and independent remote probe with off-host notification; verify a dead host produces an external alert.
- [ ] **06.** Run outside-in port scans, cross-network connection denials, proxy-header spoofing, TLS/certificate, core dump and container UID/capability tests.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Build Compose service partitions, mounted secrets, read-only/non-root containers, capabilities, tmpfs, resource ceilings and explicit network connectivity. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S03/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Define default-deny egress with explicit DNS/ACME/KMS/R2/alert exceptions and verify actual host enforcement rather than assuming Compose networking blocks egress. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S03/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Run outside-in port scans, cross-network connection denials, proxy-header spoofing, TLS/certificate, core dump and container UID/capability tests. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S03/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S03` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Spoofed `X-Forwarded-*`, public database/SSH, untrusted TLS and loss of off-host alert must fail.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Repeatable staging bring-up; direct external network probes confirm only allowed listeners; proxy trust, TLS and isolation evidence captured; one simulated host-down signal demonstrably reaches an off-host channel.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S03` and commit `docs/evidence/sessions/S03/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S03/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S04, S05, S09, S40, S43 (only when all other predecessors also pass). **Next concrete action:** open S04 in this document, read its prerequisite and check `docs/evidence/sessions/S04/entry.md` eligibility, then execute its first ordered checkbox: **Define PostgreSQL app, auth, coordination, jobs and append-audit schemas with composite tenant foreign keys and immutable IDs, using reviewed Drizzle plus explicit SQL.**

### S04 — PostgreSQL roles, schemas and migration discipline

**Plan:** 19 active hours · **Risk:** High · **Gate:** Required session-local integrated acceptance · **Workstream:** A.

**Mini-project objective.** Build a database boundary that can safely host application, auth, durable operation and audit schemas.

**Included boundary.** Reviewed Drizzle/custom-SQL migration stream, composite tenant FKs, role grants, advisory/transaction locking conventions, pg-boss schema ownership, migration checksum and rollback/restore plan. Inventory PostgreSQL **cluster-global roles, grants, tablespaces, extensions, TLS/pg_hba and owner/privilege dependencies** that a database-local dump cannot reconstruct; produce a synthetic globals export/rebuild and negative-privilege test plan, to be exercised in S11 and fully integrated in S42 (**DB-G1**).

**Implementation/evidence targets.** `packages/db/schema/, packages/db/migrations/, packages/db/roles/, tests/integration/database/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S02, S03**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S02, S03.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S04/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — prerequisite work; AC: none — contributing work; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§1–4 (ownership and states); Document 06 §§3, 6 (data and transactions). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** DB-G1 — inventory and off-host globals/configuration rebuild recipe; S11 spike, S42 primary closure. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Define PostgreSQL app, auth, coordination, jobs and append-audit schemas with composite tenant foreign keys and immutable IDs, using reviewed Drizzle plus explicit SQL.
- [ ] **02.** Create deployment-only migrator and separate API/provisioner/backup/maintenance/job roles; revoke `PUBLIC` and forbid runtime DDL and audit UPDATE/DELETE/TRUNCATE.
- [ ] **03.** Install reviewed migration checksum/version tracking and single-migrator locking with rollback/restore instruction; keep pg-boss migration privilege separate.
- [ ] **04.** Define transaction and lock conventions, pool connection ownership, bounded retry and deadlock policy; demonstrate connection-bound advisory lock safety.
- [ ] **05.** Create two-tenant synthetic fixtures; execute privileged/denied SQL tests and interrupted migration/retry tests.
- [ ] **06.** Preserve clean schema/export evidence and explicit permissions matrix without connection secrets.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] DB-G1: enumerate roles/memberships/grants, database and schema ownership, privileges/default privileges, extensions, tablespaces, TLS/pg_hba and server configuration; classify what `pg_dump` does *not* restore.
- [ ] Record independently held, nonsecret reconstruction instructions and protected off-host credentials; on a clean synthetic cluster replay globals/config and directly retest every negative runtime privilege; hand evidence to S11/S42.
- [ ] Refuse DB-G1 `RELEASE_PASS` in this session: this is inventory/procedural spike only, with clean-host final closure in S42.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Create deployment-only migrator and separate API/provisioner/backup/maintenance/job roles. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S04/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Define transaction and lock conventions, pool connection ownership, bounded retry and deadlock policy. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S04/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Preserve clean schema/export evidence and explicit permissions matrix without connection secrets. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S04/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S04` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **API, jobs and provisioner roles must fail DDL/audit mutation; concurrent migration does not corrupt schema.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Clean database migration, role-negative matrix, deliberate crash/retry and concurrent-migrator tests; no production schema push. A documented, independently held globals-and-configuration reconstruction inventory exists; this is **not yet DB-G1 release PASS**.**

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S04` and commit `docs/evidence/sessions/S04/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S04/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S06, S07, S08, S11 (only when all other predecessors also pass). **Next concrete action:** open S06 in this document, read its prerequisite and check `docs/evidence/sessions/S06/entry.md` eligibility, then execute its first ordered checkbox: **Create two synthetic OpenBao namespaces, KV mounts, policy templates, AppRole/runtime/issuer/provisioner/backup identities as candidates.**

### S05 — OVH–OpenBao real auto-unseal feasibility

**Plan:** 21 active hours · **Risk:** Critical · **Gate:** G-BAO seal · **Workstream:** A.

**Mini-project objective.** Settle native KMIP versus external OVH seal using the actual provider and lost-host constraints.

**Included boundary.** Real OVH KMS provisioning, sealed restart/host reboot, unreachable KMS, certificate failure/reissue and comparison with plugin fallback; preserve key/certificate custody evidence. For **KMS-L1**, inventory every seal key/version referenced by recoverable material, demonstrate authorized off-host custody and cert replacement, and on a **disposable isolated KMS key only**, prove that permanent loss of required wrapping-key access blocks unseal and is **not repairable with OpenBao recovery shares**. Never delete or destroy a production/shared key to produce test evidence.

**Implementation/evidence targets.** `infra/openbao/seal/, infra/ovh-kms/, tests/integration/unseal/, docs/decisions/DEC-kms.md`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S03**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S03.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S05/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.64, FR-1.65; AC: AC-1.26; PO: PO-1. **Exact source entry:** Document 04 §§9–10 (KMS, recovery); Document 06 §§5, 13–14, 17.1 (seal, custody, alternatives). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** KMS-L1 — disposable seal-key-loss proof and referenced-version/off-host custody inventory; S42 primary closure. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Provision test-only real OVHcloud KMS credentials and external key material with off-host custody; record endpoint, key-version and certificate lifecycle.
- [ ] **02.** Configure pinned OpenBao native KMIP seal and test from fully sealed process start and cold host restart, not just a pre-unsealed container restart.
- [ ] **03.** Inject KMS outage before startup, certificate expiry/rejection, restricted KMS rights and network timeout; independently record seal state versus KMS reachability.
- [ ] **04.** Reissue necessary client certificates without relying on unavailable host or MyKey service; test offline recovery of the required authority.
- [ ] **05.** If native KMIP fails, perform documented security/supply-chain comparison of the external OVHcloud seal plugin using actual supported OpenBao/pinned versions.
- [ ] **06.** Record passing option, failed experiments and irreversible blockers as G-BAO seal decision; no silent local key/seal fallback.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] KMS-L1: record provider-held seal key IDs and every retained referenced version, ownership, required permissions, version rotation limits and off-host certificate recovery; no key may be assumed to exist because a local cache survives.
- [ ] Use an isolated disposable KMS key/realm only to prove permanent missing-key access fails sealed restore and OpenBao recovery shares cannot decrypt the lost wrapping key. Never destroy shared or production key material.
- [ ] Link KMS-L1 synthetic negative and custody evidence to S42 full clean-host test; if actual key version/permissions are unavailable, stop dependent recovery claims.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Configure pinned OpenBao native KMIP seal and test from fully sealed process start and cold host restart, not just a pre-unsealed container restart. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S05/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Reissue necessary client certificates without relying on unavailable host or MyKey service. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S05/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Record passing option, failed experiments and irreversible blockers as G-BAO seal decision. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S05/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S05` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Sealed startup without KMS must fail, and a previously unsealed daemon must not be mistaken for cold unseal proof.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-BAO seal subgate: signed primary/fallback decision, observed restart/failure/reissue and disposable missing-key denial, key-version custody map. KMS-L1 full clean-host closure remains due in S42 and S45. If interop or custody cannot be shown, dependent backend/recovery work stays BLOCKED.**

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S05` and commit `docs/evidence/sessions/S05/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S05/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S06, S09 (only when all other predecessors also pass). **Next concrete action:** open S06 in this document, read its prerequisite and check `docs/evidence/sessions/S06/entry.md` eligibility, then execute its first ordered checkbox: **Create two synthetic OpenBao namespaces, KV mounts, policy templates, AppRole/runtime/issuer/provisioner/backup identities as candidates.**

### S06 — OpenBao tenancy, identities and native policy feasibility

**Plan:** 17 active hours · **Risk:** Critical · **Gate:** G-BAO identities · **Workstream:** A.

**Mini-project objective.** Prove scoped provisioning, runtime and issuer identities in two hostile synthetic tenants.

**Included boundary.** Namespace/mount model, policy and token-role effective behavior, AppRole alternatives, native audit, accessor visibility, self-lookup, direct namespace escape attempts and default-policy removal.

**Implementation/evidence targets.** `infra/openbao/namespaces/, infra/openbao/policies/, packages/openbao/, tests/security/openbao/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S04, S05**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S04, S05.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S06/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — prerequisite work; AC: none — contributing work; PO: PO-3. **Exact source entry:** Document 04 §§1, 3, 6 (tenancy, machine authority); Document 06 §§5, 7.3, 17 (OpenBao identities). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Create two synthetic OpenBao namespaces, KV mounts, policy templates, AppRole/runtime/issuer/provisioner/backup identities as candidates.
- [ ] **02.** Use native API/CLI to prove default policy is absent where required and list actual token capabilities; test every cross-namespace path and hostile selector.
- [ ] **03.** Exercise short-lived runtime/issuer lifecycle, self lookup, accessor inventory, token role restrictions and only required read/list permissions.
- [ ] **04.** Test namespace policy creation and privilege escalation permitted to the scoped provisioner; record exposure accurately instead of claiming it has no privilege-changing rights.
- [ ] **05.** Verify native audit sink behavior and denial events without emitting raw values or machine tokens.
- [ ] **06.** Publish policy/identity matrix and executable G-BAO authority tests required before tenant provisioning and machine-token functionality.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Use native API/CLI to prove default policy is absent where required and list actual token capabilities. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S06/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Test namespace policy creation and privilege escalation permitted to the scoped provisioner. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S06/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Publish policy/identity matrix and executable G-BAO authority tests required before tenant provisioning and machine-token functionality. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S06/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S06` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Org A runtime/provisioner/issuer cannot reach org B; no default/broad policy leakage.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-BAO identity subgate PASS with direct OpenBao denials and credential-lifecycle boundaries; written authority matrix.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S06` and commit `docs/evidence/sessions/S06/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S06/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S08, S10, S11, S16, S26 (only when all other predecessors also pass). **Next concrete action:** open S08 in this document, read its prerequisite and check `docs/evidence/sessions/S08/entry.md` eligibility, then execute its first ordered checkbox: **Create a miniature PostgreSQL intent/effect slot model with unique step identity and durable dispatch markers; use real pinned OpenBao endpoints.**

### S07 — Better Auth protected-storage and factor feasibility

**Plan:** 20 active hours · **Risk:** Critical · **Gate:** G-AUTH early · **Workstream:** A.

**Mini-project objective.** Choose a technically maintainable authentication integration that meets the non-negotiable contract.

**Included boundary.** Enumerate real handlers/adapter paths; protected session token, verifier-only backup codes, seed encryption, atomic TOTP step, MFA completion/freshness, password reset, refresh/list/revoke and 2-process races; dump inspection.

**Implementation/evidence targets.** `packages/auth/, packages/db/auth/, tests/integration/auth/, tests/security/auth/, docs/auth-route-contract.md`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S02, S04**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S02, S04.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S07/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — early integration feasibility; AC: none — contributing work; PO: PO-5 / PO-6 / PO-15 (early spike contributions; primary closure S12/S14/S13). Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §2 (auth/session); Document 06 §4, 17.3 (protected Better Auth integration). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Enumerate every exposed Better Auth handler, plugin route, adapter query/write/refresh/list/revoke path and their actual return schemas.
- [ ] **02.** Prototype protected session-bearer lookup and at-rest representation using maintained supported extension points; inspect real database content and dumps.
- [ ] **03.** Demonstrate one-way high-entropy recovery-code verifiers, authenticated TOTP seed encryption, single-use step constraint and atomic second factor elevation in two concurrent processes.
- [ ] **04.** Prove absolute and activity expiry, token rotation, fresh actual TOTP, password-only phase denial and reset-pending behavior under racing requests.
- [ ] **05.** Directly invoke hidden/disabled signup, trusted-device, reset-initiation, MFA-disable and account-updating endpoints to establish server-side denial.
- [ ] **06.** If any handler bypasses protection, stop auth-dependent work and record a reviewed adapter/component replacement instead of modifying the contract.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Prototype protected session-bearer lookup and at-rest representation using maintained supported extension points. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S07/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Prove absolute and activity expiry, token rotation, fresh actual TOTP, password-only phase denial and reset-pending behavior under racing requests. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S07/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** If any handler bypasses protection, stop auth-dependent work and record a reviewed adapter/component replacement instead of modifying the contract. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S07/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S07` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **A single plaintext bearer, recoverable backup code, adapter bypass or reused TOTP step blocks G-AUTH.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-AUTH early spike passes *all* critical negative tests on actual pinned integration or produces an approved component replacement before account feature work.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S07` and commit `docs/evidence/sessions/S07/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S07/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S12 (only when all other predecessors also pass). **Next concrete action:** open S12 in this document, read its prerequisite and check `docs/evidence/sessions/S12/entry.md` eligibility, then execute its first ordered checkbox: **Implement operator-private, idempotent owner bootstrap with immutable identity and withdrawn bootstrap authority afterward.**

### S08 — Delayed backend effect and exclusion feasibility

**Plan:** 18 active hours · **Risk:** Critical · **Gate:** G-EFFECT early · **Workstream:** A.

**Mini-project objective.** Prove that a request accepted by OpenBao cannot be incorrectly treated as never applied.

**Included boundary.** Minimal persisted intent/dispatch slot, injected process deaths/timeouts/delayed HTTP delivery, operator stop/drain and evidence-based re-admission on write/issuance; distinguish transport cancellation from backend fencing.

**Implementation/evidence targets.** `packages/operations/spikes/, tests/fault/effects/, docs/decisions/DEC-delayed-effects.md`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S04, S06**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S04, S06.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S08/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — early effect-feasibility work; AC: none — contributing work; PO: PO-16 (early spike contribution; integrated closure S44). Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §4 (operation correctness); Document 06 §6 (effect admission, uncertainty and exclusion). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Create a miniature PostgreSQL intent/effect slot model with unique step identity and durable dispatch markers; use real pinned OpenBao endpoints.
- [ ] **02.** Kill the executor before dispatch, during network delivery, after backend commit but before DB completion, and during reconciliation.
- [ ] **03.** Delay an accepted OpenBao request after DB connection loss, lease loss and client timeout; prove a replacement cannot act while the old effect remains possible.
- [ ] **04.** Implement operator-stop/drain/exclude evidence path or retain `outcome_unknown` and deny conflicting work; never use client cancellation as backend fencing.
- [ ] **05.** Exercise representative KV write and issuance shapes and explicitly record which action categories remain unproven for integrated S21/S27/S28 work.
- [ ] **06.** Publish G-EFFECT assumptions and hard stop conditions with reproducible transcripts and redacted traces.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Kill the executor before dispatch, during network delivery, after backend commit but before DB completion, and during reconciliation. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S08/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Implement operator-stop/drain/exclude evidence path or retain `outcome_unknown` and deny conflicting work. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S08/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Publish G-EFFECT assumptions and hard stop conditions with reproducible transcripts and redacted traces. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S08/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S08` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Old delayed backend effects cannot overlap replacement work; absent response is not proof of no effect.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-EFFECT spike records a provable exclusion/reconciliation boundary or freezes dependent effect-producing work.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S08` and commit `docs/evidence/sessions/S08/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S08/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S11, S18 (only when all other predecessors also pass). **Next concrete action:** open S11 in this document, read its prerequisite and check `docs/evidence/sessions/S11/entry.md` eligibility, then execute its first ordered checkbox: **Implement tenant-scoped application repositories, actor-safe request ID propagation, domain metadata, outbox IDs and sanitized error contracts.**

### S09 — Actual-time backup retention experiment launch

**Plan:** 14 active hours · **Risk:** Critical · **Gate:** G-BACKUP calendar fixture START only · **Workstream:** A.

**Mini-project objective.** Start real retention aging early instead of attempting to compress a provider-clock test later.

**Included boundary.** Start a small synthetic, isolated Restic-per-pair R2 fixture; object locks, immutable manifests, eligibility, partial/multipart failures, **DeleteObjects HTTP 200 with per-key errors**, lock-rule edit authority, expiry and **actual calendar-clock aging**. Capture baseline bytes and API requests for **COST-B1**, with the earliest eligible retention timeline. Preserve object IDs and provider evidence for **R2-L1/PO-9**; never shorten the required oldest-pair aging proof through timestamp manipulation.

**Implementation/evidence targets.** `infra/backup/retention-fixture/, tests/restore/retention/, docs/evidence/proofs/PO-09/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` evidence for **S03** and direct availability of the independent test bucket, encryption/key custody and actual-clock retention fixture; **S05 is not a prerequisite**.
- [ ] Evaluate the full Document 07 entry condition: **S03, R2 test bucket and independent encryption/key-custody access established; native KMS integration S05 is **not** a prerequisite for the storage-only fixture.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S09/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — independent storage feasibility; AC: none — contributing work; PO: PO-9 (early retention fixture only; accountable closure S41). Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §9 (backups/retention); Document 06 §13 (actual-clock retention). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** R2-L1 and COST-B1 — real-time lock-aging fixture launch and measured storage/API baseline; S41 primary closures. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Create independently encrypted synthetic Restic-per-pair fixtures against a dedicated R2 test bucket; keep repository and bucket credentials scoped.
- [ ] **02.** Apply real object retention/lock settings and record provider clock, policy, object version and initial footprint; do not backdate snapshots.
- [ ] **03.** Attempt deletion, mutation, interrupted multipart upload, repository locking and incompatible pruning during actual protection periods.
- [ ] **04.** Schedule dated evidence checks for the entire retention window and oldest-restorable pair, explicitly beyond engineering session completion.
- [ ] **05.** Measure daily object/metadata growth and capacity/cleanup liabilities under representative pairing.
- [ ] **06.** Record this session as **retention experiment STARTED**, not PO-9 PASS, with calendar owner and next check date.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] R2-L1: begin provider-clock 30-day object-lock test immediately using an isolated bucket/prefix; capture policy changes, retention timestamps, overwrite/delete denial and the later physical cleanup lag under the actual rules.
- [ ] Exercise batch DeleteObjects with mixed eligible/locked items and record each object result rather than trusting the batch HTTP status. Plan real aging checkpoints and oldest-eligible pair retrieval.
- [ ] COST-B1: record encrypted bytes per sample pair, object count, PUT/GET/LIST/DELETE operations, storage growth, retrieval charges, staging needs and current published account rates; mark values estimated until observed.
- [ ] Do not mark R2-L1 or COST-B1 complete from fixture creation. S41 owns matured observations and the full cost/retention pass.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Apply real object retention/lock settings and record provider clock, policy, object version and initial footprint. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S09/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Schedule dated evidence checks for the entire retention window and oldest-restorable pair, explicitly beyond engineering session completion. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S09/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Record this session as **retention experiment STARTED**, not PO-9 PASS, with calendar owner and next check date. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S09/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S09` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Lock tests on altered dates do not count; stale locks, deduplication and protected deletion must be examined on real clocks.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Provider fixture genuinely aging, exact lock configuration/object IDs/prices/scheduled checkpoints preserved, per-object failure probes captured. This is an **aging START** for PO-9/R2-L1 and a cost baseline, not a 30-day/release PASS.**
- [ ] Assign the independent real-clock follow-up dates; this session does **not** close PO-9 or G-BACKUP simply by successfully creating the fixture.

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S09` and commit `docs/evidence/sessions/S09/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S09/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S41 (only when all other predecessors also pass). **Next concrete action:** open S41 in this document, read its prerequisite and check `docs/evidence/sessions/S41/entry.md` eligibility, then execute its first ordered checkbox: **Implement durable paired-capture admission freeze, drain/resolution of in-flight operations and consistent Postgres/OpenBao artifact creation.** **Calendar handoff:** include next real-date object-lock aging and cleanup verification, outside the active engineering-hour estimate.

### S10 — OpenBao Agent versus MyKey CLI decision spike

**Plan:** 12 active hours · **Risk:** Medium · **Gate:** G-CLIENT comparison · **Workstream:** A.

**Mini-project objective.** Compare native process supervision with the required constrained product CLI.

**Included boundary.** Time-box the comparison of OpenBao Agent's **public-beta** process-supervisor mode against the thin MyKey CLI under fixed product API authorization, full-set resolution, token containment, TLS, child signals, denied historical reads, package support and upgrade/rollback risks. Own **AGENT-B1**; a beta supervisor may replace a release-critical CLI only after **explicit documented production exception and full contract equivalence**, not merely a successful launch fixture.

**Implementation/evidence targets.** `apps/cli/spikes/, infra/openbao/agent-spike/, tests/cli/supervision/, docs/decisions/DEC-client.md`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S02, S06**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S02, S06.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S10/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — prerequisite work; AC: none — contributing work; PO: none — contributing/spike work. **Exact source entry:** Document 04 §7 (CLI); Document 06 §10, 17.2 (OpenBao Agent comparison). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** AGENT-B1 — public-beta risk/exception evaluation and thin-CLI parity decision; S31 primary closure. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Install the supported pinned OpenBao Agent build and examine process-supervisor/env template behavior without assuming beta features are stable.
- [ ] **02.** Implement two synthetic comparison fixtures: native Agent-launched child and a minimal thin MyKey CLI calling the product API.
- [ ] **03.** Exercise complete-set consistency, token separation from child, TLS verification, stdout filtering, failures before launch and signal forwarding.
- [ ] **04.** Compare dependency size, packaging, user setup, policy boundary, direct OpenBao exposure and four-platform support.
- [ ] **05.** Publish the G-CLIENT chosen route and tested fallback, reserving full CLI acceptance for S30–S31.
- [ ] **06.** Explicitly reject any candidate that cannot uphold MyKey authorization or complete-resolved-set semantics.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] AGENT-B1: document the versioned public-beta status of OpenBao Agent process supervision and assess a production dependency exception explicitly; the thin first-party CLI remains the default.
- [ ] Reproduce the product API/current-only/coherent-set, token isolation, command/no-shell, signal, failure/no-launch and all four-platform requirements for each alternative. A similar native feature is not proof of parity.
- [ ] Record accepted design, supported fallback/rollback and decision owner; S31 closes selected shipping distribution and beta risk against actual images.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement two synthetic comparison fixtures: native Agent-launched child and a minimal thin MyKey CLI calling the product API. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S10/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Compare dependency size, packaging, user setup, policy boundary, direct OpenBao exposure and four-platform support. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S10/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Explicitly reject any candidate that cannot uphold MyKey authorization or complete-resolved-set semantics. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S10/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S10` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **A child must never launch on partial secret resolution; Agent capability alone does not prove MyKey authorization.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-CLIENT/AGENT-B1 documented release-maturity decision with thin CLI preferred absent exceptional proof; full four-platform evidence remains S31, not an assumed consequence of this spike.**

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S10` and commit `docs/evidence/sessions/S10/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S10/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S30 (only when all other predecessors also pass). **Next concrete action:** open S30 in this document, read its prerequisite and check `docs/evidence/sessions/S30/entry.md` eligibility, then execute its first ordered checkbox: **Implement shipping `mykey keys`, `mykey run`, `mykey export` against versioned product API with strict runtime response validation.**

### S11 — Application persistence and early paired-capture feasibility

**Plan:** 26 active hours · **Risk:** High · **Gate:** G-BACKUP paired-capture spike · **Workstream:** B.

**Mini-project objective.** Create a durable metadata/audit substrate and falsify dangerous early assumptions about PostgreSQL–OpenBao paired capture before large feature implementation.

**Included boundary.** Implement tenant-aware metadata repos, DB transaction helpers, safe audit event schema/append path, outbox envelope, sanitized errors, request IDs, and job skeleton; ensure the first later mutation has an audit gate. Add a small synthetic PostgreSQL-plus-OpenBao paired-capture/restore spike: identify the admission-freeze boundary, kill a dispatch during capture, reject an ineligible pair, then rehearse the **PostgreSQL globals/roles/config reconstruction plan from S04** on a disposable cluster and check forbidden permissions. This is **not** complete S41 backup implementation, 30-day aging or integrated DB-G1 clean-host closure.

**Implementation/evidence targets.** `packages/db/repos/, packages/operations/, packages/audit/, apps/api/, tests/integration/paired-capture/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S04, S06, S08**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S04, S06, S08.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S11/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — prerequisite work; AC: none — contributing work; PO: none — contributing/spike work. Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §§1, 4, 8–9; Document 06 §§3, 6, 12–13 (metadata, audit, pairing). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** DB-G1 — globals/role/permission restoration synthetic rehearsal before S42 full closure. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement tenant-scoped application repositories, actor-safe request ID propagation, domain metadata, outbox IDs and sanitized error contracts.
- [ ] **02.** Create the restricted append-audit path and initial audit gating before any real value mutation capability; prove runtime cannot mutate audit history.
- [ ] **03.** Implement bounded pg-boss delivery with IDs only; do not store values, bearer tokens or mutation requests in job payloads.
- [ ] **04.** Build synthetic cross-store capture experiment: freeze admissions, drain admitted effects, take PostgreSQL/OpenBao artifacts and bind pair manifest.
- [ ] **05.** Crash during capture and hold an unresolved dispatched operation; prove no incomplete pair is marked eligible or considered consistent.
- [ ] **06.** Generate repository/DB tests for tenant ancestry, missing audit, job restart and safe log/exception serialization.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] DB-G1: use a fresh disposable PostgreSQL cluster to replay the captured globals/role/config manifest; prove the backup identity, operator role and API/provisioner roles receive only intended permissions.
- [ ] Inject missing role, changed default grants and failed extension/config restoration; capture fail-closed negative outcomes and transfer all unresolved items to S42, without promoting this early rehearsal to clean-host PASS.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Create the restricted append-audit path and initial audit gating before any real value mutation capability. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S11/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Build synthetic cross-store capture experiment: freeze admissions, drain admitted effects, take PostgreSQL/OpenBao artifacts and bind pair manifest. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S11/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Generate repository/DB tests for tenant ancestry, missing audit, job restart and safe log/exception serialization. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S11/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S11` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **An unresolved effect means capture pair is ineligible, regardless of apparently matching timestamps.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Real PostgreSQL tests show cross-tenant denial, restricted audit mutations and no secret-bearing record; base system boots. Capture spike distinguishes a safe pair from an interrupted/unknown one, and the globals reconstruction fixture demonstrates roles/least privilege or blocks dependent recovery. PO-21 and DB-G1 still require final integrated closure; infeasible pair or globals reconstruction blocks S41/S42.**
- [ ] Record the exact safe capture cut and unresolved-effect counterexample for later S41; successful spike does not establish a recoverable protected 30-day pair.

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S11` and commit `docs/evidence/sessions/S11/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S11/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S12, S15, S16, S18, S38, S41 (only when all other predecessors also pass). **Next concrete action:** open S12 in this document, read its prerequisite and check `docs/evidence/sessions/S12/entry.md` eligibility, then execute its first ordered checkbox: **Implement operator-private, idempotent owner bootstrap with immutable identity and withdrawn bootstrap authority afterward.**

### S12 — Owner bootstrap, password phase and abuse protection

**Plan:** 17 active hours · **Risk:** High · **Gate:** Required session-local integrated acceptance · **Workstream:** B.

**Mini-project objective.** Provide the operator-created account and strictly bounded password authentication stage.

**Included boundary.** Bootstrap idempotency, account states, allowlisted auth routes, server-enforced signup prohibition, phase-specific errors, two-process password/factor throttling.

**Implementation/evidence targets.** `packages/auth/bootstrap/, apps/api/auth/, tests/integration/auth-bootstrap/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S07, S11**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S07, S11.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S12/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.01, FR-1.07; AC: AC-1.01, AC-1.05; PO: PO-5. **Exact source entry:** Document 04 §2 (account creation/password phase); Document 06 §4 (native routes/auth states). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement operator-private, idempotent owner bootstrap with immutable identity and withdrawn bootstrap authority afterward.
- [ ] **02.** Expose only approved pinned Better Auth password-phase handlers, with restricted enrollment transitions and no public account-creation paths.
- [ ] **03.** Implement password/source throttling backed by PostgreSQL across two API processes; use indistinguishable errors for missing account/bad password.
- [ ] **04.** Perform direct unauthenticated route inventory including plugin defaults and forged native endpoints; reject signup/reset-init/MFA bypass.
- [ ] **05.** Test restart, duplicate bootstrap and concurrency, account status transitions and sanitized audit attribution.
- [ ] **06.** Publish exact account-auth contract and first stage of end-to-end auth negative tests.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Expose only approved pinned Better Auth password-phase handlers, with restricted enrollment transitions and no public account-creation paths. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S12/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Perform direct unauthenticated route inventory including plugin defaults and forged native endpoints. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S12/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Publish exact account-auth contract and first stage of end-to-end auth negative tests. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S12/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S12` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Every public account-creation route and side channel is denied in both API processes.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Direct API enumeration and negative tests rule out public account creation and account-existence leaks.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S12` and commit `docs/evidence/sessions/S12/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S12/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S13 (only when all other predecessors also pass). **Next concrete action:** open S13 in this document, read its prerequisite and check `docs/evidence/sessions/S13/entry.md` eligibility, then execute its first ordered checkbox: **Implement pending enrollment and six-digit TOTP verification with accepted step uniqueness under transaction locking.**

### S13 — TOTP completion, enrollment and recovery codes

**Plan:** 19 active hours · **Risk:** Critical · **Gate:** Required session-local integrated acceptance · **Workstream:** B.

**Mini-project objective.** Deliver fully MFA-completed authentication with correct replay semantics and protected storage.

**Included boundary.** Enrollment, session rotation after factor elevation, six-digit TOTP window, one-step replay locks, one-way backup codes and atomic consumption/regeneration, protected seed and persistence checks.

**Implementation/evidence targets.** `packages/auth/mfa/, packages/db/auth/, tests/integration/totp/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S12**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S12.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S13/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.02, FR-1.03; AC: AC-1.02; PO: PO-15. **Exact source entry:** Document 04 §2 (MFA and codes); Document 06 §4 (factor transition). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement pending enrollment and six-digit TOTP verification with accepted step uniqueness under transaction locking.
- [ ] **02.** Rotate session bearer only after committed second-factor completion; preserve authentication start time and absolute expiry.
- [ ] **03.** Generate ten high-entropy one-use recovery codes; store verifiers, never reversible secrets, and enforce atomic consumption/regeneration.
- [ ] **04.** Ensure trusted-device shortcuts and public MFA disable remain server-side unavailable; recovery-code completion does not grant fresh TOTP.
- [ ] **05.** Exercise concurrent same TOTP step, rollback, replay after restart/clock rollback and duplicate recovery code across two processes.
- [ ] **06.** Inspect database dumps, logs and browser responses to confirm no forbidden stored credential or secret.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Rotate session bearer only after committed second-factor completion. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S13/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Ensure trusted-device shortcuts and public MFA disable remain server-side unavailable. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S13/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Inspect database dumps, logs and browser responses to confirm no forbidden stored credential or secret. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S13/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S13` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Exactly one concurrent factor attempt succeeds; recovery-code usage never creates fresh TOTP state.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Multi-process same-code races allow at most one accepted use; no password-only product session or forbidden stored bearer.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S13` and commit `docs/evidence/sessions/S13/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S13/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S14, S15 (only when all other predecessors also pass). **Next concrete action:** open S14 in this document, read its prerequisite and check `docs/evidence/sessions/S14/entry.md` eligibility, then execute its first ordered checkbox: **Implement current-session list/revoke, sign-out, server-side expiry and user-activity convention independent from background polling.**

### S14 — Sessions, fresh TOTP, account reset and recovery

**Plan:** 18 active hours · **Risk:** Critical · **Gate:** G-AUTH integrated · **Workstream:** B.

**Mini-project objective.** Complete account lifecycle with operational recovery and exact session validity rules.

**Included boundary.** Idle/absolute expiry, user-activity convention, signout/session revocation, password change, fresh-factor permission, operator-private reset and recovery-pending state even after link expiry.

**Implementation/evidence targets.** `packages/auth/sessions/, packages/auth/reset/, apps/ops/reset/, tests/integration/auth-lifecycle/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S13**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S13.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S14/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.04, FR-1.05, FR-1.06, FR-1.77; AC: AC-1.03, AC-1.04, AC-1.35; PO: PO-6. **Exact source entry:** Document 04 §2 (sessions/recovery); Document 06 §4 (session and reset). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement current-session list/revoke, sign-out, server-side expiry and user-activity convention independent from background polling.
- [ ] **02.** Implement password change requiring current password plus fresh TOTP and correct revocation of other sessions/epochs.
- [ ] **03.** Implement private operator-reset initiation, restricted recovery-pending account, one-use 15-minute link via fragment and HTTPS body redemption.
- [ ] **04.** Enforce factor-specific recovery: password-only reset still requires valid MFA; MFA reset forces complete re-enrollment.
- [ ] **05.** Exercise race between old password sign-in and reset, expired link, TOTP freshness expiry, idle/absolute clocks and server restart.
- [ ] **06.** Confirm no reset token in URLs seen by server, access logs, diagnostics or referrer, and demonstrate stale sessions denied.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement password change requiring current password plus fresh TOTP and correct revocation of other sessions/epochs. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S14/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Enforce factor-specific recovery: password-only reset still requires valid MFA. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S14/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Confirm no reset token in URLs seen by server, access logs, diagnostics or referrer, and demonstrate stale sessions denied. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S14/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S14` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Expired reset link never returns account to active and polling cannot extend user-idle lifetime.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Timed tests/clock controls and direct paths prove recovery without MFA bypass, old session reuse or forgotten old reset links.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S14` and commit `docs/evidence/sessions/S14/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S14/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S25, S26, S32, S33, S42 (only when all other predecessors also pass). **Next concrete action:** open S25 in this document, read its prerequisite and check `docs/evidence/sessions/S25/entry.md` eligibility, then execute its first ordered checkbox: **Implement explicit owner-authorized export requiring fresh current-session TOTP, warning and complete environment resolution.**

### S15 — Authorization, concealment and current-state gate

**Plan:** 17 active hours · **Risk:** High · **Gate:** Required session-local integrated acceptance · **Workstream:** B.

**Mini-project objective.** Make product authorization server-owned, current and tenant-safe across human and machine requests.

**Included boundary.** Membership/grant union rules, resource ancestry, 404 concealment, service gate, revocation admission recheck, state hierarchy and denial tests with two tenants.

**Implementation/evidence targets.** `packages/auth/authorization/, apps/api/middleware/, tests/security/tenancy/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S11, S13**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S11, S13.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S15/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.09, FR-1.10, FR-1.11; AC: AC-1.08; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§1, 3 (authorization); Document 06 §§4.4, 7.1 (current grants and states). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement server-owned organization membership and project/environment grant resolution with explicit tenant ancestry checks.
- [ ] **02.** Enforce resource-state precedence and fail-closed service gate for every product request; recheck at mutation admission.
- [ ] **03.** Implement hidden-resource 404 response shape for absent and inaccessible targets without resource-name leakage.
- [ ] **04.** Exercise direct API calls as owner, editor, reader, ungranted member and machine against both synthetic tenants.
- [ ] **05.** Inject committed grant revocation immediately before request and during in-flight work; document exactly what can finish.
- [ ] **06.** Test forged namespace/policy/path selectors, stale role claims, archived parents and missing backend state without an authority fallback.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Enforce resource-state precedence and fail-closed service gate for every product request. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S15/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Exercise direct API calls as owner, editor, reader, ungranted member and machine against both synthetic tenants. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S15/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Test forged namespace/policy/path selectors, stale role claims, archived parents and missing backend state without an authority fallback. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S15/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S15` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Unknown tenant/role/ancestor state and forged namespace selectors deny without existence leakage.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Full authorization matrix and in-flight semantics pass, including deliberately forged selectors and stale grants.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S15` and commit `docs/evidence/sessions/S15/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S15/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S16, S17, S18, S29, S33 (only when all other predecessors also pass). **Next concrete action:** open S16 in this document, read its prerequisite and check `docs/evidence/sessions/S16/entry.md` eligibility, then execute its first ordered checkbox: **Implement private operator provisioning with durable intent, idempotent organization ID and namespace/KV/policy/role configuration.**

### S16 — Operator-only organization provisioning and drift review

**Plan:** 18 active hours · **Risk:** Critical · **Gate:** Required session-local integrated acceptance · **Workstream:** B.

**Mini-project objective.** Provision each organization exactly once and refuse to serve inconsistent backend configuration.

**Included boundary.** Private operator command, durable namespace/KV/role/policy readback, failed/pending/review states, alert emission, forbidden public operator routes, resumable partial provisioning.

**Implementation/evidence targets.** `apps/provisioner/, packages/openbao/provision/, packages/db/repos/organizations/, tests/fault/provisioning/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S06, S11, S15**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S06, S11, S15.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S16/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.08, FR-1.12, FR-1.55; AC: AC-1.06, AC-1.09; PO: PO-4. **Exact source entry:** Document 04 §3 (organization provisioning); Document 06 §§5, 7.1 (operator/namespace). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement private operator provisioning with durable intent, idempotent organization ID and namespace/KV/policy/role configuration.
- [ ] **02.** Read back required OpenBao configuration before setting organization active; store no root/provisioner credential in API runtime.
- [ ] **03.** Model `provisioning`, `failed`, `needs_review`, `active` and narrow-backend-inconsistency quarantine states.
- [ ] **04.** Kill the operator after each namespace/policy/owner stage and verify safe retry without duplicate namespaces or privilege broadening.
- [ ] **05.** Alter/remove role, KV mount and policy on staging to verify 503, alert and no broader fallback.
- [ ] **06.** Confirm no public route exposes organization provisioning, privileged reconciler or raw OpenBao admin selectors.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Read back required OpenBao configuration before setting organization active. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S16/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Kill the operator after each namespace/policy/owner stage and verify safe retry without duplicate namespaces or privilege broadening. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S16/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Confirm no public route exposes organization provisioning, privileged reconciler or raw OpenBao admin selectors. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S16/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S16` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Partial namespace/policy work cannot be advertised active and cannot silently broaden rights.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Interrupted provisioning and missing-backend drift tests never create duplicate/broad authority or prematurely active organization.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S16` and commit `docs/evidence/sessions/S16/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S16/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S17, S40 (only when all other predecessors also pass). **Next concrete action:** open S17 in this document, read its prerequisite and check `docs/evidence/sessions/S17/entry.md` eligibility, then execute its first ordered checkbox: **Implement project create/rename with NFC normalization, unique names and atomic default `development` environment metadata.**

### S17 — Project/environment lifecycle and readiness

**Plan:** 17 active hours · **Risk:** High · **Gate:** Required session-local integrated acceptance · **Workstream:** B.

**Mini-project objective.** Deliver complete management of immutable resources and backend readiness prerequisites.

**Included boundary.** Create/rename (NFC/regex), default development environment, grant inheritance and FK integrity, pending/readiness/needs-review state and explicit non-deletion contract.

**Implementation/evidence targets.** `packages/db/repos/resources/, apps/api/routes/resources/, tests/integration/resources/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S15, S16**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S15, S16.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S17/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.14, FR-1.15, FR-1.16, FR-1.19; AC: AC-1.10; PO: none — contributing/spike work. **Exact source entry:** Document 04 §3 (project/environment); Document 06 §§3, 7.1 (resource lifecycle). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement project create/rename with NFC normalization, unique names and atomic default `development` environment metadata.
- [ ] **02.** Implement environment create/rename with strict naming, immutable identifiers, tenant FK ancestry and fixed backend paths.
- [ ] **03.** Drive environment pending→ready only after policy/role/KV readiness proof; retain `needs_review` when incomplete.
- [ ] **04.** Verify grants remain bound to identifiers under rename and a pending environment refuses machine issuance.
- [ ] **05.** Ensure no project/environment permanent-delete API or accidental metadata cascade bypass.
- [ ] **06.** Exercise colliding names, case/whitespace variants, concurrent create and foreign project identifiers.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement environment create/rename with strict naming, immutable identifiers, tenant FK ancestry and fixed backend paths. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S17/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Verify grants remain bound to identifiers under rename and a pending environment refuses machine issuance. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S17/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Exercise colliding names, case/whitespace variants, concurrent create and foreign project identifiers. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S17/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S17` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Environment rename cannot change backend binding; pending state cannot issue machine credentials.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **End-to-end project/environment create/rename tests preserve identifiers, authorization and backend bindings.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S17` and commit `docs/evidence/sessions/S17/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S17/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S19, S26, S28, S33 (only when all other predecessors also pass). **Next concrete action:** open S19 in this document, read its prerequisite and check `docs/evidence/sessions/S19/entry.md` eligibility, then execute its first ordered checkbox: **Implement validated KV v2 create/update with CAS zero/expected-current semantics and durable operation admission.**

### S18 — Durable operations and replay semantics

**Plan:** 21 active hours · **Risk:** Critical · **Gate:** Required session-local integrated acceptance · **Workstream:** B.

**Mini-project objective.** Implement the durable operation state machine for every possible OpenBao effect.

**Included boundary.** Intent before dispatch, actor/precondition binding, idempotency fingerprints, effect slots, step rows, queue outbox, stale executor protection and replay/expiry/status boundaries.

**Implementation/evidence targets.** `packages/operations/state-machine/, packages/db/schema/operations/, tests/fault/operations/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S08, S11, S15**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S08, S11, S15.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S18/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.82, FR-1.83; AC: none — contributing work; PO: none — contributing/spike work. **Exact source entry:** Document 04 §4 (durable operations); Document 06 §6 (admission/replay model). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Define and migrate durable operation, step, effect-slot, replay/tombstone, actor/precondition and sanitized audit/outbox link rows.
- [ ] **02.** Implement transactionally admitted state machine and unique execution ownership across processes without optimistic lease takeover.
- [ ] **03.** Bind idempotency keys to principal/action/resource and keyed intent fingerprint, excluding plaintext from durable state.
- [ ] **04.** Implement unknown status, replay states, retention and authorization recheck before any replay disclosure.
- [ ] **05.** Inject duplicate admission, changed-intent reuse, revoked principal, executor kill and database disconnection.
- [ ] **06.** Confirm an unknown external effect is never automatically redispatched by pg-boss or a retrier.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement transactionally admitted state machine and unique execution ownership across processes without optimistic lease takeover. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S18/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Implement unknown status, replay states, retention and authorization recheck before any replay disclosure. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S18/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Confirm an unknown external effect is never automatically redispatched by pg-boss or a retrier. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S18/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S18` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Concurrent replay cannot create two effects; changed fingerprint cannot reuse idempotency key.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Cross-process tests show single admitted executor, protected replay status and no auto-redispatch from an unknown outcome.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S18` and commit `docs/evidence/sessions/S18/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S18/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S19, S21, S26 (only when all other predecessors also pass). **Next concrete action:** open S19 in this document, read its prerequisite and check `docs/evidence/sessions/S19/entry.md` eligibility, then execute its first ordered checkbox: **Implement validated KV v2 create/update with CAS zero/expected-current semantics and durable operation admission.**

### S19 — Secret creation, update, indexing and version history

**Plan:** 25 active hours · **Risk:** Critical · **Gate:** G-RESOLVE preliminary · **Workstream:** B.

**Mini-project objective.** Ship the primary secret lifecycle with native KV CAS and correct metadata synchronization.

**Included boundary.** Name/value constraints, create-never-overwrites-deleted-history, update expected-version+tag, index/list/name search, 20-version history, server-side explicit reveal authorization/no-store response contract and safe historical attribution. Before integrating import/machine/CLI workflows, execute a small G-RESOLVE preliminary read-versus-write race (including version deletion, audit failure and incomplete pagination) against real KV and PostgreSQL; its success is a design feasibility decision, **not** final PO-19 closure.

**Implementation/evidence targets.** `packages/openbao/kv/, apps/api/routes/secrets/, packages/db/repos/secrets/, tests/integration/kv/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S17, S18**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S17, S18.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S19/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.20, FR-1.21, FR-1.24, FR-1.25, FR-1.26; AC: AC-1.12, AC-1.14; PO: none — contributing/spike work. Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §4 (secret writes/history); Document 06 §§6–8 (KV and preliminary coherent reads). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement validated KV v2 create/update with CAS zero/expected-current semantics and durable operation admission.
- [ ] **02.** Build name-only secret index/search, stable cursor order, random state tags and metadata/history read models.
- [ ] **03.** Enforce value UTF-8 byte size, NUL exclusion, immutable names, 20-version retention and no create-over-deleted-history.
- [ ] **04.** Implement explicit authorized reveal response with no-store and no audit/log/cache plaintext; verify historical actor provenance.
- [ ] **05.** Run preliminary coordinated environment read versus concurrent write/delete/audit-failure/pagination race directly against OpenBao/PostgreSQL.
- [ ] **06.** If G-RESOLVE coordination cannot yield coherent full sets or explicit failure, stop S24 consumer work and record a redesign decision.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Build name-only secret index/search, stable cursor order, random state tags and metadata/history read models. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S19/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Implement explicit authorized reveal response with no-store and no audit/log/cache plaintext. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S19/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** If G-RESOLVE coordination cannot yield coherent full sets or explicit failure, stop S24 consumer work and record a redesign decision. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S19/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S19` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Creation over deleted history is denied, stale CAS conflicts and broad history query cannot disclose values.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Real KV v2/PG tests pass stale-write, version-retention, prefix/UTF-8 and cross-tenant negative cases; preliminary G-RESOLVE either yields a defensible coordination protocol or explicitly BLOCKS S24 and dependent consumers.**
- [ ] Record only a preliminary G-RESOLVE design spike; S24 owns complete integration and PO-19 final proof.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S19` and commit `docs/evidence/sessions/S19/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S19/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S20, S21, S23, S24, S32, S34 (only when all other predecessors also pass). **Next concrete action:** open S20 in this document, read its prerequisite and check `docs/evidence/sessions/S20/entry.md` eligibility, then execute its first ordered checkbox: **Implement soft-delete only for the current live version with expected version/state tag and backend verification.**

### S20 — Secret deletion, undelete and version restoration

**Plan:** 17 active hours · **Risk:** High · **Gate:** Required session-local integrated acceptance · **Workstream:** B.

**Mini-project objective.** Complete the entire user-promised non-destructive secret lifecycle.

**Included boundary.** Soft-delete live latest only, verify undelete semantics, restore eligible historical value as new version, ABA-resistant tags and no permanent destruction route.

**Implementation/evidence targets.** `apps/api/routes/secrets/, packages/openbao/kv/, tests/integration/secret-lifecycle/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S19**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S19.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S20/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.27, FR-1.28, FR-1.29, FR-1.32; AC: AC-1.15; PO: PO-7. **Exact source entry:** Document 04 §4 (delete/undelete/restore); Document 06 §7.2 (KV lifecycle). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement soft-delete only for the current live version with expected version/state tag and backend verification.
- [ ] **02.** Implement undelete on expected deleted latest version without silently falling back to an older live value.
- [ ] **03.** Implement restore of eligible historical version as a new latest version, including when current latest is deleted.
- [ ] **04.** Guarantee state-tag changes across delete→undelete and reconciliation ABA cycles; forbid user destroy endpoints.
- [ ] **05.** Inject races between update, delete, undelete, restore and stale expected-state callers across API processes.
- [ ] **06.** Prove retained history and backend truth agree with UI-safe metadata despite interruption.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement undelete on expected deleted latest version without silently falling back to an older live value. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S20/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Guarantee state-tag changes across delete→undelete and reconciliation ABA cycles. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S20/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Prove retained history and backend truth agree with UI-safe metadata despite interruption. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S20/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S20` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Deleted current value does not silently fall back; ABA state tag reuse is rejected.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Cross-process state-tag ABA and restored historical versions tested against real OpenBao.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S20` and commit `docs/evidence/sessions/S20/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S20/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S21, S23, S34 (only when all other predecessors also pass). **Next concrete action:** open S21 in this document, read its prerequisite and check `docs/evidence/sessions/S21/entry.md` eligibility, then execute its first ordered checkbox: **Build operator-private reconciliation command that enumerates unresolved operations, dispatch markers, backend audit and current KV evidence.**

### S21 — Reconciliation, execution exclusion and fault suite

**Plan:** 23 active hours · **Risk:** Critical · **Gate:** G-EFFECT integrated KV · **Workstream:** B.

**Mini-project objective.** Turn uncertain backend outcomes into safe, attributable reconciliation without optimistic retries.

**Included boundary.** Operator-private status/evidence tools, kill/delay at each boundary, forensic KV/audit correlation, pending versus terminal classification, inaccessible/conflicting scopes, drain/stop controls.

**Implementation/evidence targets.** `apps/ops/reconcile/, packages/operations/reconciliation/, tests/fault/reconciliation/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S18, S19, S20**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S18, S19, S20.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S21/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.30, FR-1.31, FR-1.88; AC: AC-1.16, AC-1.38; PO: none — contributing/spike work. **Exact source entry:** Document 04 §4 (uncertainty/concurrency); Document 06 §6.4 (reconciliation). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Build operator-private reconciliation command that enumerates unresolved operations, dispatch markers, backend audit and current KV evidence.
- [ ] **02.** Implement backend-specific safe terminalization or review/quarantine when outcome cannot be conclusively established.
- [ ] **03.** Block same-scope successors until old execution is demonstrably excluded and affected operation reconciled.
- [ ] **04.** Inject process death before/after KV commit and artificially delayed requests beyond worker lifetime.
- [ ] **05.** Ensure metadata tag/version/actor outcome corrections and audit links are durable, with no invented actor for external operator changes.
- [ ] **06.** Produce reproducible G-EFFECT integrated KV failure suite and list issuance/archive variants still to close in S27/S28.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement backend-specific safe terminalization or review/quarantine when outcome cannot be conclusively established. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S21/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Inject process death before/after KV commit and artificially delayed requests beyond worker lifetime. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S21/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Produce reproducible G-EFFECT integrated KV failure suite and list issuance/archive variants still to close in S27/S28. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S21/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S21` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Timeout does not imply a failed backend operation; operator reconciler cannot fabricate a safe terminal outcome.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-EFFECT integrated smoke passes fault injections for KV; issuance/archive variants are extended in the later credential-revocation and archive sessions and retested at release.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S21` and commit `docs/evidence/sessions/S21/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S21/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S23, S24, S27, S28, S34, S38, S41 (only when all other predecessors also pass). **Next concrete action:** open S23 in this document, read its prerequisite and check `docs/evidence/sessions/S23/entry.md` eligibility, then execute its first ordered checkbox: **Implement per-environment import preview recording only actor/file HMAC/key classification/preconditions, with short expiry.**

### S22 — Strict dotenv codec and loader evidence

**Plan:** 13 active hours · **Risk:** Medium · **Gate:** Required session-local integrated acceptance · **Workstream:** C.

**Mini-project objective.** Deliver one precise, reversible dotenv dialect rather than claiming universal compatibility.

**Included boundary.** Bounded parser/serializer and property tests for multiline, Unicode, bytes, empty values, literal dollars, comments and pinned loader compatibility fixtures.

**Implementation/evidence targets.** `packages/contracts/dotenv/, tests/unit/dotenv/, tests/fixtures/dotenv-loaders/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S02**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S02.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S22/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.33, FR-1.34, FR-1.38; AC: none — contributing work; PO: none — contributing/spike work. **Exact source entry:** Document 04 §5 (dotenv); Document 06 §8 (dotenv codec). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Build strict bounded dotenv parser with declared grammar: comments, quoting, escapes, multiline, Unicode, empty and literal `$` values.
- [ ] **02.** Build serializer with exact round-trip contract and explicit unsupported syntax failure; never interpolate environment variables.
- [ ] **03.** Create compatibility fixtures for pinned supported dotenv loaders and versioned output expectations.
- [ ] **04.** Property-test arbitrary legal names/value bytes and fuzz malformed/oversized inputs to safe key-only diagnostics.
- [ ] **05.** Ensure serializer never logs secret values or presents escaped samples in test failure output.
- [ ] **06.** Publish format specification and parser limits for web and CLI use.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Build serializer with exact round-trip contract and explicit unsupported syntax failure. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S22/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Property-test arbitrary legal names/value bytes and fuzz malformed/oversized inputs to safe key-only diagnostics. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S22/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Publish format specification and parser limits for web and CLI use. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S22/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S22` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Unsupported syntax fails rather than silently changing literal dollars/escapes; test failures do not print secret bytes.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Round trip equals input values and incompatible loader cases produce safe key-only warnings.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S22` and commit `docs/evidence/sessions/S22/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S22/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S23, S25 (only when all other predecessors also pass). **Next concrete action:** open S23 in this document, read its prerequisite and check `docs/evidence/sessions/S23/entry.md` eligibility, then execute its first ordered checkbox: **Implement per-environment import preview recording only actor/file HMAC/key classification/preconditions, with short expiry.**

### S23 — Import preview, apply and interrupted continuation

**Plan:** 19 active hours · **Risk:** Critical · **Gate:** Required session-local integrated acceptance · **Workstream:** C.

**Mini-project objective.** Provide complete secure import with per-key outcomes, safe replay and exact-file continuation.

**Included boundary.** Actor/file HMAC preview, per-key metadata classification, value-free persistent records, deterministic step sequencing, interrupted input resubmission and partial terminal handling.

**Implementation/evidence targets.** `apps/api/routes/import/, packages/operations/import/, tests/fault/import/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S19, S20, S21, S22**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S19, S20, S21, S22.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S23/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.35, FR-1.36; AC: AC-1.39; PO: PO-17. **Exact source entry:** Document 04 §5 (imports); Document 06 §8 (import protocol). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement per-environment import preview recording only actor/file HMAC/key classification/preconditions, with short expiry.
- [ ] **02.** Apply entries through existing durable secret operations, ensuring one executor and per-key safe replay state.
- [ ] **03.** After lost process/input bytes, reconcile attempted steps and request exact-file resubmission for only safe unattempted entries.
- [ ] **04.** Terminate mixed-result import as partial, with a new preview required for further action; never replay successful steps.
- [ ] **05.** Inject changed files, changed actor/scope, concurrent edits, process kills and network timeouts.
- [ ] **06.** Check PG, queue, errors, frontend diagnostics and audit for zero persisted imported values.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Apply entries through existing durable secret operations, ensuring one executor and per-key safe replay state. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S23/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Terminate mixed-result import as partial, with a new preview required for further action. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S23/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Check PG, queue, errors, frontend diagnostics and audit for zero persisted imported values. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S23/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S23` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Retry after lost input does not reapply successful entries or persist imported values.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Synthetic conflict/kill/retry tests prove no duplicate successful mutation and no persisted import plaintext.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S23` and commit `docs/evidence/sessions/S23/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S23/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S24, S35 (only when all other predecessors also pass). **Next concrete action:** open S24 in this document, read its prerequisite and check `docs/evidence/sessions/S24/entry.md` eligibility, then execute its first ordered checkbox: **Implement bounded, sorted stable inventory and coordinated bulk retrieval with metadata-generation/state-tag stability checks.**

### S24 — Coherent whole-environment snapshot/resolution

**Plan:** 20 active hours · **Risk:** Critical · **Gate:** G-RESOLVE integrated · **Workstream:** C.

**Mini-project objective.** Make machine launch/export consume one internally coherent environment view or fail explicitly.

**Included boundary.** Coordinated read protocol and stability checks, bounded sorted pagination, audit-before-release, blocked reviewed keys, resource limits, empty environment and transport-truncation handling.

**Implementation/evidence targets.** `packages/operations/resolution/, apps/api/routes/resolve/, tests/fault/coherent-reads/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S19, S21, S23**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S19, S21, S23.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S24/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.84; AC: AC-1.41; PO: PO-19. **Exact source entry:** Document 04 §5 (complete reads); Document 06 §8 (coherent environment). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement bounded, sorted stable inventory and coordinated bulk retrieval with metadata-generation/state-tag stability checks.
- [ ] **02.** Exclude deleted latest versions, reviewed resources and inaccessible parents; detect incomplete/reordered pagination.
- [ ] **03.** Commit required attributable audit before returning complete resolved values; fail on audit failure.
- [ ] **04.** Race concurrent imports, updates, deletes and changes during multi-page reads; permit either coherent set or explicit error.
- [ ] **05.** Test empty environment, deleted key, backend timeout, payload truncation and resource ceiling.
- [ ] **06.** Prohibit launching/exporting from partial or mixed-generation data even if some values were successfully retrieved.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Exclude deleted latest versions, reviewed resources and inaccessible parents. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S24/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Race concurrent imports, updates, deletes and changes during multi-page reads. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S24/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Prohibit launching/exporting from partial or mixed-generation data even if some values were successfully retrieved. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S24/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S24` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Mixed-generation/partial/truncated environment never returns a successful complete set.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-RESOLVE proof: racing writers/imports lead to coherent set or failure; partial data never returned as a successful set.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S24` and commit `docs/evidence/sessions/S24/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S24/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S25, S29, S30, S44 (only when all other predecessors also pass). **Next concrete action:** open S25 in this document, read its prerequisite and check `docs/evidence/sessions/S25/entry.md` eligibility, then execute its first ordered checkbox: **Implement explicit owner-authorized export requiring fresh current-session TOTP, warning and complete environment resolution.**

### S25 — Human export and sensitive response path

**Plan:** 12 active hours · **Risk:** High · **Gate:** Required session-local integrated acceptance · **Workstream:** C.

**Mini-project objective.** Implement explicit, freshly authenticated plaintext export without server-side persistence.

**Included boundary.** Versioned API export streaming safeguards, sanitized content disposition, no-store, in-memory value lifetime, changed-set abort and format-roundtrip tests.

**Implementation/evidence targets.** `apps/api/routes/export/, packages/contracts/dotenv/, tests/integration/export/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S14, S22, S24**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S14, S22, S24.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S25/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.37; AC: AC-1.17; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§5, 8 (export); Document 06 §§8–9 (export and sensitive HTTP). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement explicit owner-authorized export requiring fresh current-session TOTP, warning and complete environment resolution.
- [ ] **02.** Use strict dotenv serializer with server response `no-store`, protected action audit and no URL/query values.
- [ ] **03.** Ensure export remains blocked on one reviewed key, incomplete response, stale grants or archive state as specified.
- [ ] **04.** Implement safe human download/filename convention and disclose plaintext disk/clipboard limitations truthfully.
- [ ] **05.** Inspect proxy buffering, browser cache, crash diagnostics and exported-value logs under failure.
- [ ] **06.** Exercise concurrent mutation, missing factor, canceled download and unauthorized export denials.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Use strict dotenv serializer with server response `no-store`, protected action audit and no URL/query values. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S25/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Implement safe human download/filename convention and disclose plaintext disk/clipboard limitations truthfully. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S25/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Exercise concurrent mutation, missing factor, canceled download and unauthorized export denials. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S25/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S25` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **No fresh factor, missing audit or reviewed key denies export; no partial download remains.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Response and storage canary sweep detects no secret in prohibited layers; exact export/import roundtrip passes.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S25` and commit `docs/evidence/sessions/S25/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S25/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S35 (only when all other predecessors also pass). **Next concrete action:** open S35 in this document, read its prerequisite and check `docs/evidence/sessions/S35/entry.md` eligibility, then execute its first ordered checkbox: **Implement strict dotenv preview with per-key create/update/conflict classifications and explicit apply confirmation.**

### S26 — Read-only machine issuance and token inventory

**Plan:** 21 active hours · **Risk:** Critical · **Gate:** G-BAO machine-issuer lifecycle · **Workstream:** C.

**Mini-project objective.** Issue one-environment, expiry-bounded machine credentials with real native least privilege.

**Included boundary.** Fixed orphan token role/no-default/read-only/nonrenewable, effective TTL, one-time delivery, accessor-only tracking, inventory/fresh TOTP and issuer/root authority isolation.

**Implementation/evidence targets.** `packages/openbao/credentials/, apps/api/routes/credentials/, tests/security/issuer/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S06, S14, S17, S18**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S06, S14, S17, S18.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S26/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.39, FR-1.40, FR-1.41; AC: none — contributing work; PO: none — contributing/spike work. Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §6 (machine credentials); Document 06 §§5, 7.3 (issue and token role). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement read-only per-environment OpenBao fixed token-role issuance with explicit positive TTL, no renewal, no default policy and expected orphan behavior.
- [ ] **02.** Create durable issuance intent, strict one-time token delivery boundary and metadata-only credential inventory with accessor, binding, expiry.
- [ ] **03.** Demonstrate issuer-token revocation and short issuer lifetime do not unexpectedly invalidate valid machine token, while token cannot access foreign environment.
- [ ] **04.** Prohibit machine token storage in PG, queue, logs and browser persisted state; inspect all accepted response paths.
- [ ] **05.** Exercise loss of issuance response and backend success before DB completion; unresolved issuance remains blocked/inspectable.
- [ ] **06.** Directly test effective OpenBao capabilities and thirty-day lifetime ceiling without accepting user-controlled arbitrary policy.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Create durable issuance intent, strict one-time token delivery boundary and metadata-only credential inventory with accessor, binding, expiry. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S26/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Prohibit machine token storage in PG, queue, logs and browser persisted state. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S26/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Directly test effective OpenBao capabilities and thirty-day lifetime ceiling without accepting user-controlled arbitrary policy. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S26/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S26` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Issuer expiry/revocation does not revoke intended orphan machine tokens; issued token cannot escalate or be re-shown.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **PO-2: short-lived issuer revocation leaves intended orphan token valid until expiry/accessor revocation; native escape/renewal/write denied.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S26` and commit `docs/evidence/sessions/S26/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S26/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S27, S29 (only when all other predecessors also pass). **Next concrete action:** open S27 in this document, read its prerequisite and check `docs/evidence/sessions/S27/entry.md` eligibility, then execute its first ordered checkbox: **Implement accessor-based backend revocation and verification with durable `revoking`/`revoked`/`needs_review` states.**

### S27 — Revocation and uncertain issuance lifecycle

**Plan:** 22 active hours · **Risk:** Critical · **Gate:** G-EFFECT issuance/revocation · **Workstream:** C.

**Mini-project objective.** Handle lost token delivery and revoke/archive races without secret reissue or escaped tokens.

**Included boundary.** Persistent denied state, accessor revocation and verification, issuance readback/inventory, delayed creation exclusion, no token replay, concurrent issuance denial and reconciliation.

**Implementation/evidence targets.** `packages/operations/revocation/, apps/api/routes/credentials/, tests/fault/credential-revocation/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S21, S26**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S21, S26.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S27/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.42, FR-1.43; AC: AC-1.40; PO: none — contributing/spike work. Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §6 (revoke/unknown); Document 06 §§6.4, 7.3 (credential reconciliation). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement accessor-based backend revocation and verification with durable `revoking`/`revoked`/`needs_review` states.
- [ ] **02.** Reconcile unknown issuance by backend inventory and audit, including tokens not returned to the API caller.
- [ ] **03.** Prevent credential re-delivery on retry; require explicit fresh replacement issuance after uncertainty resolution.
- [ ] **04.** Inject revoke timeout, lost OpenBao response, concurrent revocation and issuance and old issuer-runtime token renewal.
- [ ] **05.** Prove subsequent machine requests fail after committed verified revocation, with no unrecorded live token after a resolved race.
- [ ] **06.** Link security audit and actionable owner-visible safe credential metadata.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Reconcile unknown issuance by backend inventory and audit, including tokens not returned to the API caller. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S27/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Inject revoke timeout, lost OpenBao response, concurrent revocation and issuance and old issuer-runtime token renewal. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S27/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Link security audit and actionable owner-visible safe credential metadata. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S27/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S27` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Unknown issuance must not be silently resolved; revoked token is refused by real backend.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **PO-18/AC-1.40 kill/delay/race suite closes lost-delivery and absence-of-escaped-tokens paths.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S27` and commit `docs/evidence/sessions/S27/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S27/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S28, S29, S36, S41, S42 (only when all other predecessors also pass). **Next concrete action:** open S28 in this document, read its prerequisite and check `docs/evidence/sessions/S28/entry.md` eligibility, then execute its first ordered checkbox: **Implement project/environment `revoking` admission state before allowing any additional machine access or mutation effects.**

### S28 — Project/environment archive and reactivation

**Plan:** 17 active hours · **Risk:** Critical · **Gate:** G-EFFECT archive · **Workstream:** C.

**Mini-project objective.** Make archive a complete access-reducing operation, including credentials and concurrent issuance.

**Included boundary.** Revoking admission gate, finish/reconcile admitted mutations, token inventory/verified revocation, interrupted resume, child-project archive provenance and non-restored tokens.

**Implementation/evidence targets.** `packages/operations/archive/, apps/api/routes/resources/, tests/fault/archive/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S17, S21, S27**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S17, S21, S27.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S28/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.17, FR-1.18; AC: AC-1.11; PO: PO-18. Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §3 (archive/reactivate); Document 06 §7.1 (parent lifecycle). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement project/environment `revoking` admission state before allowing any additional machine access or mutation effects.
- [ ] **02.** Serialize archive with environment creation, issuance, existing operations and review states; inventory every affected token.
- [ ] **03.** Revoke and verify all OpenBao credentials before `archived`, including uncertain issuance; failed verification stays machine-closed.
- [ ] **04.** Implement parent project archive and origin-aware reactivation preserving previously independently archived children.
- [ ] **05.** Prove reactivation never resurrects revoked tokens and does not bypass missing backend readiness.
- [ ] **06.** Run crash/retry and concurrent create/issue/archive negative matrix.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Serialize archive with environment creation, issuance, existing operations and review states. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S28/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Implement parent project archive and origin-aware reactivation preserving previously independently archived children. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S28/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Run crash/retry and concurrent create/issue/archive negative matrix. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S28/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S28` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Issuance concurrent with archive cannot leave a live token or an incorrectly archived scope.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Concurrent creation/issue/archive and restart tests cannot escape revocation or re-enable old tokens.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S28` and commit `docs/evidence/sessions/S28/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S28/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S44 (only when all other predecessors also pass). **Next concrete action:** open S44 in this document, read its prerequisite and check `docs/evidence/sessions/S44/entry.md` eligibility, then execute its first ordered checkbox: **Freeze candidate release commit and dependency manifest, enumerate all direct and indirect trust boundaries.**

### S29 — Machine API, direct OpenBao checks and scope

**Plan:** 16 active hours · **Risk:** Critical · **Gate:** Required session-local integrated acceptance · **Workstream:** C.

**Mini-project objective.** Enable authenticated, read-only machine consumption with independent backend token authority.

**Included boundary.** Bearer-only routing, prohibit mixed auth, effective accessor verification, parent-state current read, secret-history restriction, read/list direct privilege matrix and truthful historical residual disclosure.

**Implementation/evidence targets.** `apps/api/routes/machine/, packages/openbao/credentials/, tests/security/machine-api/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S15, S24, S26, S27**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S15, S24, S26, S27.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S29/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.44, FR-1.45; AC: AC-1.19; PO: PO-2. **Exact source entry:** Document 04 §6 (machine use); Document 06 §§5, 7.3, 9 (machine auth). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement bearer-only machine API with direct OpenBao token validation, environmental binding and current parent state checks.
- [ ] **02.** Implement metadata-only key listing and coherent current-value resolution for bound environment with verified no-store transport.
- [ ] **03.** Enforce no human session fallback, historical value access or mutation privilege from a machine credential.
- [ ] **04.** Run direct OpenBao foreign-tenant requests and product API forged namespace/header/path tests with independently generated tokens.
- [ ] **05.** Verify issuer orphan-token lifetime, short-lived issuer revocation and backend accessor revocation through the actual machine API.
- [ ] **06.** Close PO-2 only after full issuance/use/revocation lifecycle, not from a token-create response.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement metadata-only key listing and coherent current-value resolution for bound environment with verified no-store transport. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S29/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Run direct OpenBao foreign-tenant requests and product API forged namespace/header/path tests with independently generated tokens. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S29/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Close PO-2 only after full issuance/use/revocation lifecycle, not from a token-create response. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S29/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S29` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Machine cannot mutate, read history or bypass parent state even by direct OpenBao request.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Machine reads limited to bound current API representation; direct native write/history/other-tenant tests and expired/revoked denies pass.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S29` and commit `docs/evidence/sessions/S29/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S29/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S30, S32, S38 (only when all other predecessors also pass). **Next concrete action:** open S30 in this document, read its prerequisite and check `docs/evidence/sessions/S30/entry.md` eligibility, then execute its first ordered checkbox: **Implement shipping `mykey keys`, `mykey run`, `mykey export` against versioned product API with strict runtime response validation.**

### S30 — Shipping CLI: secure keys/run/export and error model

**Plan:** 23 active hours · **Risk:** Critical · **Gate:** Required session-local integrated acceptance · **Workstream:** C.

**Mini-project objective.** Deliver a complete usable CLI rather than a demonstration shell wrapper.

**Included boundary.** Config/token FD/env contract, no secret cache, verified TLS, response schema integrity, no child on failure, spawn without shell, signals, env scrubbing, 0600 exclusive export, safe cleanup and stable codes.

**Implementation/evidence targets.** `apps/cli/src/, packages/contracts/api/, tests/cli/launch/, tests/cli/export/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S10, S24, S29**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S10, S24, S29.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S30/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.46, FR-1.47, FR-1.48, FR-1.49, FR-1.50, FR-1.79; AC: AC-1.20, AC-1.21; PO: none — contributing/spike work. **Exact source entry:** Document 04 §7 (CLI); Document 06 §§8–10 (complete delivery and launch). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement shipping `mykey keys`, `mykey run`, `mykey export` against versioned product API with strict runtime response validation.
- [ ] **02.** Require verified HTTPS and secure protected credential supply; never print token or pass it via command arguments.
- [ ] **03.** For `run`, retrieve and validate entire set before spawning child directly without shell; strip token-bearing input variables from child.
- [ ] **04.** Forward signals/exit codes correctly, reject truncated/unknown fields and never cache secret values on local disk.
- [ ] **05.** For `export`, use exclusive safe file creation and no-follow semantics, predictable error classification and secure cleanup.
- [ ] **06.** Run adversarial fixture children and transport faults proving no child starts and no export remains after incomplete resolution.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Require verified HTTPS and secure protected credential supply. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S30/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Forward signals/exit codes correctly, reject truncated/unknown fields and never cache secret values on local disk. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S30/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Run adversarial fixture children and transport faults proving no child starts and no export remains after incomplete resolution. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S30/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S30` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **No child spawn on HTTP truncation, invalid TLS or invalid scope; token not inherited by child.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Real supported fixtures show successful process environment injection and every specified negative launch/export behavior.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S30` and commit `docs/evidence/sessions/S30/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S30/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S31 (only when all other predecessors also pass). **Next concrete action:** open S31 in this document, read its prerequisite and check `docs/evidence/sessions/S31/entry.md` eligibility, then execute its first ordered checkbox: **Package candidate standalone CLI and tested Node fallback for Linux glibc x64/arm64 and macOS x64/arm64.**

### S31 — Four-platform delivery and protected consumer setup

**Plan:** 21 active hours · **Risk:** High · **Gate:** G-CLIENT four-platform · **Workstream:** C.

**Mini-project objective.** Make the CLI installable, predictable and operable across all committed platforms.

**Included boundary.** Linux glibc x64/arm64 and macOS x64/arm64 installation, checksums, distribution fallback, TLS/error/signal matrix, protected token rotation and **synthetic first-consumer deployment rehearsal**. Re-verify **AGENT-B1** maturity decision and reject beta-dependent substitutions without signed exception, full four-platform negative tests and rollback path. The canonical `secrets` CLI name remains contractually governed until an explicitly approved command-name change.

**Implementation/evidence targets.** `apps/cli/packaging/, infra/release/cli/, tests/cli/platform-matrix/, docs/runbooks/consumer.md`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S30**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S30.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S31/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.51, FR-1.85; AC: AC-1.37; PO: PO-8, PO-20. **Exact source entry:** Document 04 §7 (consumer setup); Document 06 §10 (distribution and token custody). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** AGENT-B1 — production CLI distribution/parity and signed beta-dependency disposition. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Package candidate standalone CLI and tested Node fallback for Linux glibc x64/arm64 and macOS x64/arm64.
- [ ] **02.** Run installation/uninstallation and integrity verification on each real supported target, not just cross-compilation.
- [ ] **03.** Document token supply/rotation/revocation via protected OS or isolated file handles, avoiding history/args/process list exposure.
- [ ] **04.** Test TLS denial, signal and child exit behavior, protected export permission on all four platforms.
- [ ] **05.** Perform synthetic rehearsal on the intended first consumer deployment host before release; defer real application secret onboarding until S45 approval.
- [ ] **06.** Record platform matrix, distribution artifacts and G-CLIENT final acceptance or documented fallback.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] AGENT-B1: retest the actual distributed CLI/Agent choice on all four committed targets; inspect beta-dependency maturity, maintenance/rollback, token handling, signals, TLS and fail-before-spawn behavior.
- [ ] Do not ship beta process-supervisor mode as a required production dependency without an explicit accepted exception and complete, independently checked parity. Otherwise use the qualified first-party CLI.
- [ ] Close the pre-release AGENT-B1 evidence with named reviewer and complete cross-platform distribution artifacts; stage-only external agent test is separate AC-1.53/1.54.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Run installation/uninstallation and integrity verification on each real supported target, not just cross-compilation. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S31/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Test TLS denial, signal and child exit behavior, protected export permission on all four platforms. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S31/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Record platform matrix, distribution artifacts and G-CLIENT final acceptance or documented fallback. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S31/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S31` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **A cross-compiled artifact does not prove platform behavior; history/argv/process listing must be clean.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-CLIENT four-platform installation passes with reproducible evidence, AGENT-B1 has an accepted outcome and AC-1.42 synthetic setup/restore coverage has an S01-approved interpretation; actual real consumer connects only after release gate and is proved in S47.**

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S31` and commit `docs/evidence/sessions/S31/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S31/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S44, S45, S46 (only when all other predecessors also pass). **Next concrete action:** open S44 in this document, read its prerequisite and check `docs/evidence/sessions/S44/entry.md` eligibility, then execute its first ordered checkbox: **Freeze candidate release commit and dependency manifest, enumerate all direct and indirect trust boundaries.**

### S32 — Shared API/OpenAPI and local protected Scalar

**Plan:** 14 active hours · **Risk:** Medium · **Gate:** G-CLIENT reference · **Workstream:** C.

**Mini-project objective.** Publish one accurate, versioned, locally served developer contract.

**Included boundary.** Consolidate the shared Zod request/response contracts and native-auth route inventory established incrementally from S02/S12 onward; validate the exact error envelope, generate OpenAPI 3.1, test compatibility/drift, and serve same-origin owner-only read-only Scalar with request execution/egress disabled. S32 **must not invent the API contract after clients and routes are implemented**.

**Implementation/evidence targets.** `packages/contracts/openapi/, apps/api/routes/, apps/web/reference/, tests/integration/openapi/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S14, S19, S29**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S14, S19, S29.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S32/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.52, FR-1.53, FR-1.54; AC: AC-1.22; PO: PO-10. **Exact source entry:** Document 04 §8 (API/reference); Document 06 §§9, 18.4 (OpenAPI/Scalar). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Produce precise Zod input and outbound schemas for all product routes and bind OpenAPI generation to the same contract.
- [ ] **02.** Bundle Scalar assets locally behind complete MFA/auth and serve a read-only reference with no request playground/executable mutation.
- [ ] **03.** Validate exact CORS/origin/CSRF rules for native auth and product routes; reject secret fields in URL or error surfaces.
- [ ] **04.** Test API pagination/idempotency/status/safe error shapes from independent CLI and browser consumers.
- [ ] **05.** Inspect runtime outbound DNS/HTTP for third-party Scalar assets, telemetry or credential-bearing requests.
- [ ] **06.** Create versioned examples with synthetic data and separately documented native Better Auth route exceptions.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Bundle Scalar assets locally behind complete MFA/auth and serve a read-only reference with no request playground/executable mutation. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S32/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Test API pagination/idempotency/status/safe error shapes from independent CLI and browser consumers. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S32/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Create versioned examples with synthetic data and separately documented native Better Auth route exceptions. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S32/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S32` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Scalar must not issue outgoing requests or allow mutation; native auth endpoints follow exact allowlist.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Schema drift and forbidden native/operator routes fail tests; Scalar works under restrictive CSP.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S32` and commit `docs/evidence/sessions/S32/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S32/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S33, S37, S44, S45 (only when all other predecessors also pass). **Next concrete action:** open S33 in this document, read its prerequisite and check `docs/evidence/sessions/S33/entry.md` eligibility, then execute its first ordered checkbox: **Build same-origin React shell, complete password→MFA enrollment/login/recovery navigation and accessible signout/session screens.**

### S33 — Owner frontend shell, MFA and resource navigation

**Plan:** 20 active hours · **Risk:** High · **Gate:** Required session-local integrated acceptance · **Workstream:** D.

**Mini-project objective.** Establish the real owner workspace with complete entry/onboarding and navigation states.

**Included boundary.** React shell, session state, MFA/challenge/recovery, visible organizations/projects/environments, loading/error/focus primitives and secure same-origin API integration.

**Implementation/evidence targets.** `apps/web/src/routes/auth/, apps/web/src/routes/projects/, apps/web/src/components/layout/, tests/browser/onboarding/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S14, S15, S17, S32**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S14, S15, S17, S32.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S33/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.89; AC: none — contributing work; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§2–3, 11 (owner workflows); Document 06 §§4, 9, 18.1 (auth and owner shell). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Build same-origin React shell, complete password→MFA enrollment/login/recovery navigation and accessible signout/session screens.
- [ ] **02.** Create owner project/environment information architecture with immutable IDs, state labels and backend readiness indicators.
- [ ] **03.** Ensure server-driven role/state handling rather than trusting cached frontend claims; useful empty and denied states.
- [ ] **04.** Keep authentication/reveal responses out of persistent client stores and cached query payloads.
- [ ] **05.** Exercise keyboard and narrow-screen first-run navigation and exactly displayed API errors.
- [ ] **06.** Collect synthetic walkthrough observations and adjust navigation without silently reducing functional steps.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Create owner project/environment information architecture with immutable IDs, state labels and backend readiness indicators. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S33/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Keep authentication/reveal responses out of persistent client stores and cached query payloads. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S33/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Collect synthetic walkthrough observations and adjust navigation without silently reducing functional steps. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S33/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S33` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Password-only session cannot access owner routes; no value caching or deceptive unsupported control.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Installed browser can complete authentication and resource navigation without bypass or frontend-only auth assumptions.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S33` and commit `docs/evidence/sessions/S33/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S33/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S34, S35, S36, S37 (only when all other predecessors also pass). **Next concrete action:** open S34 in this document, read its prerequisite and check `docs/evidence/sessions/S34/entry.md` eligibility, then execute its first ordered checkbox: **Build owner secret search/inventory with metadata-only query caching, explicit reveal and auto-hide component-local value disposal.**

### S34 — Secret inventory, reveal, lifecycle and history UI

**Plan:** 22 active hours · **Risk:** High · **Gate:** Required session-local integrated acceptance · **Workstream:** D.

**Mini-project objective.** Implement the full owner secret management experience, including dangerous actions.

**Included boundary.** Search/list, contextual masking/30-second reveal lifetime, copy warning, create/edit/delete/undelete/history/restore, stale-write conflicts, reviewed/unknown status and accessible confirmations.

**Implementation/evidence targets.** `apps/web/src/routes/secrets/, apps/web/src/components/secret-value/, tests/browser/secrets/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S19, S20, S21, S33**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S20, S21, S33; the server-side reveal endpoint and value handling from S19 must already be tested.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S34/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.22, FR-1.23; AC: none — contributing work; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§4, 11 (secret interface); Document 06 §§7.2, 9, 18 (secret UI). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Build owner secret search/inventory with metadata-only query caching, explicit reveal and auto-hide component-local value disposal.
- [ ] **02.** Implement create/update, expected-version/tag conflicts, history, historical reveal, soft-delete, undelete and restore controls.
- [ ] **03.** Make archived/review/pending states visible and prevent UI from suggesting forbidden mutations.
- [ ] **04.** Display actor-attributed history only where actual audit evidence supports it; label operator-external honestly.
- [ ] **05.** Exercise concurrent edits, countdown hide, navigation/signout and clipboard copy warnings with browser instrumentation.
- [ ] **06.** Test denied readers, forged scope IDs and unsafe toast/cache serialization.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement create/update, expected-version/tag conflicts, history, historical reveal, soft-delete, undelete and restore controls. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S34/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Display actor-attributed history only where actual audit evidence supports it. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S34/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Test denied readers, forged scope IDs and unsafe toast/cache serialization. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S34/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S34` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Value must clear after 30 seconds/hide/signout; stale edit must not overwrite newer secret.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Owner browser journey exercises every secret lifecycle action; sensitive-value persistence canaries remain negative.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S34` and commit `docs/evidence/sessions/S34/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S34/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S37, S39, S44, S45 (only when all other predecessors also pass). **Next concrete action:** open S37 in this document, read its prerequisite and check `docs/evidence/sessions/S37/entry.md` eligibility, then execute its first ordered checkbox: **Test full owner workflows through keyboard-only and small viewport before declaring visual polish sufficient.**

### S35 — Import/export and safe first-run UI

**Plan:** 16 active hours · **Risk:** Medium · **Gate:** Required session-local integrated acceptance · **Workstream:** D.

**Mini-project objective.** Make multi-secret onboarding and explicit export usable without obscuring partial operations.

**Included boundary.** File preview, classifications and conflicts, exact-file retry, progress/partial statuses, export MFA confirmation, error recovery and safe inline help.

**Implementation/evidence targets.** `apps/web/src/routes/import/, apps/web/src/routes/export/, apps/web/src/routes/guide/, tests/browser/import-export/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S23, S25, S33**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S23, S25, S33.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S35/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: none — prerequisite work; AC: none — contributing work; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§5, 11 (import/export UI); Document 06 §§8–9, 18 (import/export UI). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement strict dotenv preview with per-key create/update/conflict classifications and explicit apply confirmation.
- [ ] **02.** Present partial, awaiting exact-file resubmission, unknown and terminal outcomes without fabricating a global success.
- [ ] **03.** Implement fresh-TOTP-gated plaintext export with clear warning, deliberate filename and safe save semantics.
- [ ] **04.** Implement first-run guide linking project/environment, secret input, issuance and CLI consumption in the intended sequence.
- [ ] **05.** Perform complete synthetic round-trip and interrupted import/browser-reload regression.
- [ ] **06.** Ensure no raw values enter UI notifications, session storage, performance telemetry or error overlays.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Present partial, awaiting exact-file resubmission, unknown and terminal outcomes without fabricating a global success. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S35/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Implement first-run guide linking project/environment, secret input, issuance and CLI consumption in the intended sequence. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S35/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Ensure no raw values enter UI notifications, session storage, performance telemetry or error overlays. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S35/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S35` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **A partial import cannot show global success; no values in toasts, caches or browser diagnostics.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Browser acceptance covers full and interrupted imports and exact roundtrip export with truthful feedback.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S35` and commit `docs/evidence/sessions/S35/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S35/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S37, S44, S45 (only when all other predecessors also pass). **Next concrete action:** open S37 in this document, read its prerequisite and check `docs/evidence/sessions/S37/entry.md` eligibility, then execute its first ordered checkbox: **Test full owner workflows through keyboard-only and small viewport before declaring visual polish sufficient.**

### S36 — Credential inventory, issuance and revocation UI

**Plan:** 18 active hours · **Risk:** High · **Gate:** Required session-local integrated acceptance · **Workstream:** D.

**Mini-project objective.** Give the owner a secure, intuitive understanding of machine access and expiry.

**Included boundary.** Issue-once reveal, protected setup walkthrough, read-only scope and effective expiry, last-use-known vs unknown, expiry grouping, revoke/uncertain/review states and accessibility.

**Implementation/evidence targets.** `apps/web/src/routes/credentials/, apps/web/src/components/credentials/, tests/browser/credentials/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S27, S33**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S27, S33.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S36/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.91; AC: AC-1.47; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§6, 11 (credential UI); Document 06 §§7.3, 18 (credential status). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement metadata-only token list/status/expiry, scope, last-used and revocation progress in owner workspace.
- [ ] **02.** Implement fresh-TOTP credential issuance and one-time controlled token display without resumable token replay.
- [ ] **03.** Implement revoke/replace flow with backend-confirmed status, uncertain state and archive-aware denial.
- [ ] **04.** Explain 30-day maximum, unrenewability, post-restore replacement and safe credential supply.
- [ ] **05.** Run lost-delivery, duplicated-click, expiry/issuer-revocation and browser reload tests.
- [ ] **06.** Check copies, UI caches, notification and analytics outputs never expose the machine token.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement fresh-TOTP credential issuance and one-time controlled token display without resumable token replay. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S36/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Explain 30-day maximum, unrenewability, post-restore replacement and safe credential supply. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S36/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Check copies, UI caches, notification and analytics outputs never expose the machine token. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S36/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S36` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **One-time token cannot be retrieved after reload or replay; revocation success requires backend proof.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **All backend credential lifecycle fixtures render accurately; no re-reveal route or token persistence exists.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S36` and commit `docs/evidence/sessions/S36/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S36/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S37, S39, S44, S45 (only when all other predecessors also pass). **Next concrete action:** open S37 in this document, read its prerequisite and check `docs/evidence/sessions/S37/entry.md` eligibility, then execute its first ordered checkbox: **Test full owner workflows through keyboard-only and small viewport before declaring visual polish sufficient.**

### S37 — Accessibility, browser security and actionable errors

**Plan:** 16 active hours · **Risk:** High · **Gate:** G-OPS-DX browser/CSP · **Workstream:** D.

**Mini-project objective.** Finish the owner interface as an accessible, safe, comprehensible complete product.

**Included boundary.** Keyboard-only and narrow-screen workflow testing, CSP, CSRF/origin coverage including native auth, third-party egress deny, all error categories and correlation, secure state disposal.

**Implementation/evidence targets.** `apps/web/, apps/api/security/, infra/traefik/security/, tests/browser/accessibility/, tests/security/browser/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S32, S33, S34, S35, S36**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S33, S34, S35, S36, S32.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S37/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.76, FR-1.93, FR-1.96; AC: AC-1.29, AC-1.34, AC-1.51; PO: PO-12. **Exact source entry:** Document 04 §§2, 8, 11 (browser and accessibility); Document 06 §§9, 18 (CSP/CSRF, DX). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Test full owner workflows through keyboard-only and small viewport before declaring visual polish sufficient.
- [ ] **02.** Enforce actual CSP with no inline/third-party scripts, no framing, no referrer leaks and local assets.
- [ ] **03.** Test Origin/Fetch Metadata/CSRF policy on cookie-authenticated native/auth/export/reveal operations, not merely product PATCH routes.
- [ ] **04.** Implement actionable error mapping and request IDs for every failure category; never echo values.
- [ ] **05.** Exercise focus restoration, validation feedback, recovery codes, aria labeling and 30-second reveal expiry.
- [ ] **06.** Capture network/storage/devtools leak sweep under browser crash, navigation and login/logout.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Enforce actual CSP with no inline/third-party scripts, no framing, no referrer leaks and local assets. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S37/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Implement actionable error mapping and request IDs for every failure category. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S37/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Capture network/storage/devtools leak sweep under browser crash, navigation and login/logout. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S37/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S37` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **CSRF cross-origin mutation, CSP bypass and keyboard trapping are release blockers.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Usability and browser-security matrix passes; no critical flow trapped by focus/errors or allowed cross-site mutation.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S37` and commit `docs/evidence/sessions/S37/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S37/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S44, S45 (only when all other predecessors also pass). **Next concrete action:** open S44 in this document, read its prerequisite and check `docs/evidence/sessions/S44/entry.md` eligibility, then execute its first ordered checkbox: **Freeze candidate release commit and dependency manifest, enumerate all direct and indirect trust boundaries.**

### S38 — Full audit coverage, tenancy and retention

**Plan:** 17 active hours · **Risk:** Critical · **Gate:** Required session-local integrated acceptance · **Workstream:** D.

**Mini-project objective.** Independently reconcile and close complete attributable auditing already required during each preceding feature session; add owner visibility without logging sensitive payloads.

**Included boundary.** OpenBao audit sink failure handling, append-only DB privileges, event/operation correlation, organization-scoped paginated owner view, independent 365-day retention and operator purge.

**Implementation/evidence targets.** `packages/audit/, packages/db/audit/, apps/api/routes/activity/, tests/security/audit/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S11, S21, S29**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S11, S21, S29.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S38/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.56, FR-1.57, FR-1.58, FR-1.59, FR-1.80, FR-1.81; AC: AC-1.23; PO: none — contributing/spike work. **Exact source entry:** Document 04 §8 (audit); Document 06 §§3, 12 (audit and retention). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Enumerate all security-relevant actions, denials and backend audit events; map them to actor, target, operation and request IDs.
- [ ] **02.** Implement owner-scoped paginated audit reads, operator-only detailed inspection and bounded retention partition/cleanup.
- [ ] **03.** Prove append-only runtime DB rights, no raw payload logs and independent 365-day audit retention.
- [ ] **04.** Inject OpenBao audit-device failure and verify expected fail-closed mutation behavior.
- [ ] **05.** Exercise foreign tenant metadata/count inference and background job attribution with real two-tenant fixtures.
- [ ] **06.** Produce a comprehensive audit matrix that distinguishes verified attribution from operator-external unknown changes.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement owner-scoped paginated audit reads, operator-only detailed inspection and bounded retention partition/cleanup. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S38/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Inject OpenBao audit-device failure and verify expected fail-closed mutation behavior. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S38/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Produce a comprehensive audit matrix that distinguishes verified attribution from operator-external unknown changes. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S38/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S38` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Denied operations are attributable; audit-sink outage cannot silently allow protected mutation.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Audit matrix captures all sensitive operations/denials and zero secret bytes; writes fail closed where required.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S38` and commit `docs/evidence/sessions/S38/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S38/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S39, S40, S41, S44 (only when all other predecessors also pass). **Next concrete action:** open S39 in this document, read its prerequisite and check `docs/evidence/sessions/S39/entry.md` eligibility, then execute its first ordered checkbox: **Implement owner overview cards for projects/environments, credentials expiring, operations in review and recent actions.**

### S39 — Operations timeline, resource overview and safe analytics

**Plan:** 20 active hours · **Risk:** Medium · **Gate:** G-OPS-DX truthful owner intelligence · **Workstream:** D.

**Mini-project objective.** Provide informative, truthful product-local intelligence rather than decorative dashboard charts.

**Included boundary.** Tenant-scoped bounded activity/outcome summaries, chronological timeline, resource lifecycle counts, freshness/source/unknown labels, zero/denied/partial cases and safe aggregation.

**Implementation/evidence targets.** `apps/web/src/routes/overview/, apps/api/routes/analytics/, packages/db/repos/analytics/, tests/browser/analytics/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S34, S36, S38**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S34, S36, S38.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S39/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.90, FR-1.92, FR-1.94; AC: AC-1.46, AC-1.48, AC-1.55; PO: none — contributing/spike work. **Exact source entry:** Document 04 §11 (product analytics); Document 06 §§12, 18 (safe analytics). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement owner overview cards for projects/environments, credentials expiring, operations in review and recent actions.
- [ ] **02.** Build tenant-scoped bounded analytics endpoints that authorize/filter *before* counts and aggregation.
- [ ] **03.** Build activity timeline distinguishing accepted, pending, succeeded, partial, rejected and unknown outcomes.
- [ ] **04.** Display time window, observation source, freshness and unavailable/unknown state without invented accuracy.
- [ ] **05.** Test zero-state, stale data, archived scopes and second-tenant access/count inference.
- [ ] **06.** Demonstrate actual task value through a synthetic guided owner walkthrough, rejecting decorative or misleading charts.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Build tenant-scoped bounded analytics endpoints that authorize/filter *before* counts and aggregation. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S39/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Display time window, observation source, freshness and unavailable/unknown state without invented accuracy. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S39/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Demonstrate actual task value through a synthetic guided owner walkthrough, rejecting decorative or misleading charts. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S39/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S39` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Counts and trends cannot include unauthorized tenant records; unknown data must not look current.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Real server fixture evidence drives charts and summaries; forbidden-tenant and stale data are correctly concealed/labeled.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S39` and commit `docs/evidence/sessions/S39/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S39/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S44, S45 (only when all other predecessors also pass). **Next concrete action:** open S44 in this document, read its prerequisite and check `docs/evidence/sessions/S44/entry.md` eligibility, then execute its first ordered checkbox: **Freeze candidate release commit and dependency manifest, enumerate all direct and indirect trust boundaries.**

### S40 — Limits, readiness, private diagnostics and off-host alerts

**Plan:** 19 active hours · **Risk:** Critical · **Gate:** G-OPS-DX independent alerts · **Workstream:** D.

**Mini-project objective.** Make the service observable and fail-closed under overload/incident conditions.

**Included boundary.** Rate/body/read/connection caps, disk reserve and 507 behavior, public minimal health, VPN-bound private status including KMS vs seal, heartbeat/Worker probe, independent alert delivery/runbook references.

**Implementation/evidence targets.** `apps/api/health/, apps/ops/diagnostics/, infra/alerts/, workers/probe/, tests/fault/operations/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S03, S16, S38**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S03, S16, S38.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S40/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.60, FR-1.61, FR-1.62, FR-1.63, FR-1.95; AC: AC-1.18, AC-1.24, AC-1.25, AC-1.49; PO: PO-14, PO-23. **Exact source entry:** Document 04 §§9, 11 (limits/diagnostics); Document 06 §§11–12, 18 (health and privacy). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement product/service quotas: request/body/name/value/connection bounds, resource accounting and explicit 429/503/507 policies.
- [ ] **02.** Expose public minimal health while keeping KMS, seal state, backup, infrastructure and service internals on VPN/private operator route.
- [ ] **03.** Implement off-host heartbeat/probe and alert sink independent of lost host, with runbook links and safe redaction.
- [ ] **04.** Inject DNS/TLS/API/host outage, KMS unavailability, disk reserve exhaustion and proxy bypass attempts.
- [ ] **05.** Ensure alerts are generated where required even if application/DB/OpenBao is unavailable.
- [ ] **06.** Verify owner dashboard cannot access private infrastructure diagnostics or raw backup/audit authority.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Expose public minimal health while keeping KMS, seal state, backup, infrastructure and service internals on VPN/private operator route. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S40/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Inject DNS/TLS/API/host outage, KMS unavailability, disk reserve exhaustion and proxy bypass attempts. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S40/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Verify owner dashboard cannot access private infrastructure diagnostics or raw backup/audit authority. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S40/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S40` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Stopped host must still trigger a delivered alert; private operator diagnostics must not be publicly routed.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-OPS-DX negative-failure matrix and off-host alerts pass on a stopped host; private data unavailable to owners/machines.**

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S40` and commit `docs/evidence/sessions/S40/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S40/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S41, S43, S44, S45, S46 (only when all other predecessors also pass). **Next concrete action:** open S41 in this document, read its prerequisite and check `docs/evidence/sessions/S41/entry.md` eligibility, then execute its first ordered checkbox: **Implement durable paired-capture admission freeze, drain/resolution of in-flight operations and consistent Postgres/OpenBao artifact creation.**

### S41 — Paired capture, immutable retention and aging verification

**Plan:** 32 active hours · **Risk:** Critical · **Gate:** G-BACKUP retention/paired capture · **Workstream:** D.

**Mini-project objective.** Deliver actual recoverable consistent encrypted artifacts with candid retention and storage economics.

**Included boundary.** Durable service freeze/capture boundary, quiesce conflicting effects, PostgreSQL database **plus independently recoverable globals/privilege dependency manifests**, OpenBao snapshot, closed encrypted pair, R2 locked upload+verify+eligibility, **real 30-day aging and oldest-pair recovery**, per-object lock/delete errors and actual cleanup (R2-L1/PO-9), and bounded capacity/quota alarms. Measure full-pair daily encrypted bytes, peak staging, 30-day growth, operation counts/fees, retrieval/egress and recovery elapsed time, compare a credible alternative, and close **COST-B1** on observed provider data. Never treat an R2 bulk HTTP 200 as success without inspecting every object result.

**Implementation/evidence targets.** `apps/ops/backup/, infra/backup/, tests/restore/paired/, docs/evidence/proofs/PO-09/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S09, S11, S21, S27, S38, S40**, including S11 paired-capture feasibility `SPIKE_PASS` and actual observed R2 aging maturity; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S09, S11 paired-capture feasibility PASS, S21, S27, S38, S40; actual retention fixtures must have had sufficient real elapsed time.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S41/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.66, FR-1.78; AC: AC-1.27, AC-1.36; PO: PO-9, PO-13, PO-21. **Exact source entry:** Document 04 §9 (backup pairs); Document 06 §13 (capture/retention). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** R2-L1 and COST-B1 — primary measured provider-aging, per-object cleanup and cost closure. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement durable paired-capture admission freeze, drain/resolution of in-flight operations and consistent Postgres/OpenBao artifact creation.
- [ ] **02.** Upload closed encrypted pair to immutable R2 with signed hashes, schema/commit references, custody metadata and eligible-only selection.
- [ ] **03.** Validate retention/locks, incomplete uploads, oldest-restorable pair, pruning/cleanup and quota math on real provider-aging evidence.
- [ ] **04.** Use separate least-privileged snapshot/backup role; test denied elevated OpenBao/PG operations.
- [ ] **05.** Run unclean capture, audit failure, concurrent writes and a blocked unresolved operation; never promote pair to eligible.
- [ ] **06.** Produce off-host manifest and staged restore-byte validation before declaring G-BACKUP storage closed.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] R2-L1: prove actual elapsed retention expiration/oldest-pair recovery and per-object lock, overwrite, lifecycle, multipart, batch-delete error and cleanup cases on real provider storage. Record object-level status, actual physical deletion and allowed lag; do not accept transport HTTP 200 as complete deletion.
- [ ] Reject a shared mutable Restic repository with incompatible locks; test the selected per-pair independent repository/alternate backup format end-to-end, including pruning/maintenance and encryption/decryption.
- [ ] COST-B1: measure full encrypted daily pair size, 30-day peak storage, object/API charges, staging headroom, restore retrieval and elapsed time, plus a credible alternative. Capture sample counts, account rates, bounds and alarms.
- [ ] Verify database-local dumps and off-host PostgreSQL globals/role/config manifests refer to one coherent restore protocol; S42 proves reconstruction on a lost-host clean machine.
- [ ] Block release and keep R2-L1/COST-B1 OPEN if real-time aged expiration/physical cleanup, cost/capacity or oldest-pair restore evidence is not mature.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Upload closed encrypted pair to immutable R2 with signed hashes, schema/commit references, custody metadata and eligible-only selection. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S41/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Use separate least-privileged snapshot/backup role. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S41/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Produce off-host manifest and staged restore-byte validation before declaring G-BACKUP storage closed. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S41/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S41` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Incomplete pair, unaged lock, failed prune or missing oldest recoverable pair blocks release.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-BACKUP paired capture passes interruption and restore-byte comparisons; real provider-aged retention, oldest-pair restore, per-object cleanup errors and physical removal are evidenced for **PO-9/R2-L1**, and a price/capacity result closes **COST-B1** subject to final release regression. Release is blocked if required calendar-aging evidence is immature or incompatible with pruning/recovery.**

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S41` and commit `docs/evidence/sessions/S41/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S41/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S42, S43, S44 (only when all other predecessors also pass). **Next concrete action:** open S42 in this document, read its prerequisite and check `docs/evidence/sessions/S42/entry.md` eligibility, then execute its first ordered checkbox: **Implement an external fail-closed restore quarantine gate independent of restored DB state, absent means CLOSED.**

### S42 — Clean-host quarantine restore and authority revalidation

**Plan:** 34 active hours · **Risk:** Critical · **Gate:** G-BACKUP quarantine restore · **Workstream:** D.

**Mini-project objective.** Prove that losing the original host does not prevent recovery and old access does not survive it.

**Included boundary.** External fail-closed gate, independent off-host seal-key **versions** and certificate access (KMS-L1), restore pair checks, **full PostgreSQL clean-host globals/roles/extensions/grants/TLS/pg_hba reconstruction with least-privilege negative tests (DB-G1)**, stale auth/session/MFA/reset invalidation, unrecorded token/accessor and runtime authority revocation, fresh owner enrollment, operator verification, reopen/rollback drills. Simulate *temporary* KMS outage separately from permanent **disposable** seal-key loss; recovery shares must not be asserted to decrypt lost external wrapping keys. No real/shared KMS key destruction.

**Implementation/evidence targets.** `apps/ops/restore/, infra/recovery/, tests/restore/clean-host/, docs/runbooks/restore.md`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S14, S27, S41**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S14, S27, S41.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S42/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.67, FR-1.68, FR-1.69, FR-1.86, FR-1.87; AC: AC-1.28, AC-1.43, AC-1.44; PO: PO-22. Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §9 (restore/reopen); Document 06 §14 (quarantine and revalidation). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** KMS-L1 and DB-G1 — primary clean-host seal-key and PostgreSQL globals recovery closure. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Implement an external fail-closed restore quarantine gate independent of restored DB state, absent means CLOSED.
- [ ] **02.** Bring up a clean host from off-host release manifests, retained encrypted pairs, KMS/cert/keys and operator credentials only.
- [ ] **03.** Validate pair signature/hashes and recovered OpenBao/PostgreSQL consistency; reconcile unknown recorded and unrecorded effects.
- [ ] **04.** Invalidate all restored human sessions/challenges/reset/MFA material and known/unknown machine/runtime issuances; rotate authentication keys.
- [ ] **05.** Privately re-establish current owner identity and authorization, verify all old credentials deny before and after reopening.
- [ ] **06.** Exercise cert reissue, host loss, emergency rollback, negative foreign-tenant access and timed recovery with signed reviewer evidence.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] DB-G1: reconstruct a *new* PostgreSQL cluster from off-host globals, roles, grants, extensions, ownership, TLS and pg_hba configuration plus the paired data dump; execute positive and denied privilege tests; a database-only restore is not PASS.
- [ ] KMS-L1: unseal with the still-accessible, referenced external provider key version and independently reissued KMIP certificate while the previous host/service are unavailable; verify key-version custody does not rely on secrets inside MyKey.
- [ ] Separate temporary provider outage from a disposable permanent seal-key loss. Prove fail-closed status and the inadequacy of recovery shares as an alternate decryptor without destroying shared/production keys.
- [ ] Enumerate and invalidate restored/invisible machine tokens and sessions, reconstruct current owner authority, keep external quarantine closed until all checks pass, and preserve rejected opens as evidence.
- [ ] Link S42 primary clean-host DB-G1 and KMS-L1 records to PO-22, AC-1.28/1.43/1.44, and S44/S45 integrated review.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Bring up a clean host from off-host release manifests, retained encrypted pairs, KMS/cert/keys and operator credentials only. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S42/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Invalidate all restored human sessions/challenges/reset/MFA material and known/unknown machine/runtime issuances. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S42/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Exercise cert reissue, host loss, emergency rollback, negative foreign-tenant access and timed recovery with signed reviewer evidence. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S42/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S42` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Restore without external gate CLOSED or old-credential invalidation must never reopen.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Real synthetic staging clean-host restore succeeds with original host unavailable, externally retained key version, reconstructed PostgreSQL roles/permissions, and all-old-credential negative tests before/after reopening; separately demonstrate permanent missing-key fail-closed behavior with disposable material. **KMS-L1 and DB-G1** evidence is linked and independently reviewed; an unavailable referenced key leaves restore/unseal **BLOCKED**.**

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S42` and commit `docs/evidence/sessions/S42/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S42/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S43, S44, S45 (only when all other predecessors also pass). **Next concrete action:** open S43 in this document, read its prerequisite and check `docs/evidence/sessions/S43/entry.md` eligibility, then execute its first ordered checkbox: **Pin final image/workflow hashes and run dependency, container/OS, license and secret scanning with documented mitigation decisions.**

### S43 — Supply chain, deployment/rollback and operator runbooks

**Plan:** 20 active hours · **Risk:** High · **Gate:** G-PINS final deployment · **Workstream:** D.

**Mini-project objective.** Make the integrated service supportable, upgradable and honest to its actual guarantees.

**Included boundary.** Image/dependency/secret scanning, provenance, DB/BAO migrations, deploy/rollback strategies, tested operational runbooks for every alert, threat disclosures, operator and first-use manuals. Include off-host KMS key-version custody, PostgreSQL global rebuild, R2 lock-rule drift/per-object cleanup failure and measured backup costs/capacity; ensure current runbook steps do not assume unavailable MyKey/OpenBao infrastructure during clean-host recovery.

**Implementation/evidence targets.** `infra/release/, .github/workflows/, docs/runbooks/, docs/security/, tests/integration/deploy/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S02, S03, S40, S41, S42**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S02, S03, S40, S41, S42.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S43/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.73, FR-1.74, FR-1.75; AC: AC-1.32, AC-1.33; PO: none — contributing/spike work. **Exact source entry:** Document 04 §10 (deployment/lifecycle); Document 06 §§2, 14–16 (release/rollback). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** KMS-L1, DB-G1, R2-L1 and COST-B1 — operator runbook and custody/cost handoff contribution. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Pin final image/workflow hashes and run dependency, container/OS, license and secret scanning with documented mitigation decisions.
- [ ] **02.** Implement reviewed Drizzle and OpenBao configuration migration deployment order with clean rollback or explicit restore path.
- [ ] **03.** Rehearse upgrade/rollback and emergency security update on staging with exact digest diff and compatible backup.
- [ ] **04.** Write tested runbooks for each off-host alert and operational scenario: token, KMS, disk, audit, capture, restore, expired cert.
- [ ] **05.** Document truthful capabilities and limits: operator/plaintext trust, exposure surfaces, no HA, no zero knowledge, outage stops CLI launches.
- [ ] **06.** Prepare first-consumer secure credential setup, uninstall, rotation and post-restore replacement procedures.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] Document and rehearse no-old-host/no-MyKey recovery from off-host KMS seal key *versions*, KMIP client cert renewal, PostgreSQL cluster globals/config and privileged authentication material.
- [ ] Document R2 lock policy drift, DeleteObjects per-item errors, retention-aging and bounded cleanup lag; include measured COST-B1 volumes, charges, capacity alarms and restore economics.
- [ ] Check that runbooks reference stable 29-proof IDs and final pin/manifest identities; no untested recovery step is presented as operational fact.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Implement reviewed Drizzle and OpenBao configuration migration deployment order with clean rollback or explicit restore path. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S43/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Write tested runbooks for each off-host alert and operational scenario: token, KMS, disk, audit, capture, restore, expired cert. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S43/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Prepare first-consumer secure credential setup, uninstall, rotation and post-restore replacement procedures. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S43/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S43` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Unreviewed image digest, broken rollback and missing alert runbook block release.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Fresh staging deploy/upgrade/rollback succeeds or documented restore path passes; reviewed runbooks and scans bind release artifacts.**

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S43` and commit `docs/evidence/sessions/S43/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S43/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S44, S45 (only when all other predecessors also pass). **Next concrete action:** open S44 in this document, read its prerequisite and check `docs/evidence/sessions/S44/entry.md` eligibility, then execute its first ordered checkbox: **Freeze candidate release commit and dependency manifest, enumerate all direct and indirect trust boundaries.**

### S44 — Independent security, fault and prohibited-surface suite

**Plan:** 24 active hours · **Risk:** Critical · **Gate:** Independent integrated security proof · **Workstream:** E.

**Mini-project objective.** Prove the integrated system preserves invariants that unit/subsystem tests cannot prove alone.

**Included boundary.** Two-tenant direct API/OpenBao matrix, concurrent revocation and effect-kill tests (KV, issuance and archive), canary scans browser/DB/logs/telemetry, every supported CLI platform, full UI/Scalar journeys, load thresholds, TLS/recovery negative checks, and independent non-author review. Include all **29** technical proof records, including a beta CLI substitution decision, KMS loss, PostgreSQL global roles, R2 aging/errors and backup cost, with explicit FAIL/BLOCKED states. Any release-affecting change after review invalidates relevant checks and requires re-review.

**Implementation/evidence targets.** `tests/security/integrated/, tests/fault/integrated/, docs/evidence/releases/candidate-review/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S24, S28, S31, S32, S34, S35, S36, S37, S38, S39, S40, S41, S42, S43**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S28, S24, S31, S32, S34, S35, S36, S37, S38, S39, S40, S41, S42, S43. All included product surfaces and recovery/operations must be integrated before independent final-system review.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S44/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.13; AC: AC-1.07, AC-1.13, AC-1.50; PO: PO-16. Any early proof here is a **spike or subsystem result** unless and until the final integrated release verification explicitly closes it. **Exact source entry:** Document 04 §§1–12 (integrated contract), §12 acceptance; Document 06 §§1, 15–18 (integrated proof). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** KMS-L1, DB-G1, R2-L1, AGENT-B1 and COST-B1 — independent exact-build integrated review. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Freeze the immutable product candidate (`product_source_sha`, schema, dependency manifest, image/config digests) independently of evidence commits; enumerate direct and indirect trust boundaries.
- [ ] **02.** Independently replay two-tenant direct OpenBao/API denials, concurrent auth/MFA, lost token issuance/revocation and archive race.
- [ ] **03.** Replay delayed KV/issue/archive effects, coherent resolution under concurrent writes and no child launch on partial response.
- [ ] **04.** Run canary leak search against DB/backups/logs/traces/browser state/audit/CLI command line/proxy and restricted Scalar paths.
- [ ] **05.** Exercise all four CLI platform paths, CSP/CSRF, owner DX, overflow limits, private diagnostics and clean-host recovery negative cases.
- [ ] **06.** Obtain independent reviewer signoff on evidence and failure cases; mark changed release pins as invalidating affected results.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] Independently inspect all **29** technical proofs (24 inherited plus KMS-L1, DB-G1, R2-L1, AGENT-B1 and COST-B1) on exact candidate code/configuration, checking failed, stale and insufficient observations.
- [ ] Reproduce disposable KMS-key-loss denial, fresh PostgreSQL globals role reconstruction/denials, provider-aged R2 lock/cleanup per-item outcomes, measured backup costs, and agent beta/CLI parity decision; preserve artifact hashes and non-author reviewer.
- [ ] If any security-relevant change occurs after this review, mark precisely affected proof evidence `STALE` and rerun it before S45; an unchecked proof cannot be counted among the 29.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Independently replay two-tenant direct OpenBao/API denials, concurrent auth/MFA, lost token issuance/revocation and archive race. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S44/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Run canary leak search against DB/backups/logs/traces/browser state/audit/CLI command line/proxy and restricted Scalar paths. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S44/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Obtain independent reviewer signoff on evidence and failure cases. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S44/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S44` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Reviewer cannot be author; critical failing negative case cannot be labeled mitigated without executed evidence.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **No unresolved critical release violations; security reviewer has reproducible negative evidence and signed dispositions.**
- [ ] Rebind all security/functional results to the **exact** final candidate commit and image digests; any security-relevant post-review change makes affected results stale.

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S44` and commit `docs/evidence/sessions/S44/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S44/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Potential successor entry checks:** S45 (only when all other predecessors also pass). **Next concrete action:** open S45 in this document, read its prerequisite and check `docs/evidence/sessions/S45/entry.md` eligibility, then execute its first ordered checkbox: **Reconcile all R-class 56 acceptance scenarios and release-applicable PO results against exact release commit/digests/schema.**

### S45 — Controlled-use release, synthetic onboarding and evidence closure

**Plan:** 25 active hours · **Risk:** Critical · **Gate:** R controlled-use release · **Workstream:** E.

**Mini-project objective.** Release an independently usable MyKey Private service with fully substantiated behavior.

**Included boundary.** Run the **56 release ACs** plus **24 inherited POs and five added proofs (29 total)** against exact release pins with explicit release applicability, verify independent S44 review is current, synthetic-only install/CLI consumer journey (including the intended first-consumer deployment form), private restore/off-host alert and complete real R2 lock-aging/oldest-pair evidence. AC-1.42 requires the S01 signed interpretation/amendment before release; **AC-1.52 is synthetic-only**, while **real-consumer onboarding belongs to S47/AC-1.58 after approval**. Close reviewer/budget/claims and sign before *any* real application secret.

**Implementation/evidence targets.** `docs/evidence/releases/R/, tests/acceptance/, infra/release/manifests/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S31, S32, S34, S35, S36, S37, S39, S40, S42, S43, S44**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S31, S32, S34, S35, S36, S39, S37, S40, S42, S43, S44.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S45/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.97, FR-1.101, FR-1.102; AC: AC-1.42, AC-1.45, AC-1.52, AC-1.56, AC-1.57, AC-1.60; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§10, 12 (R release cases); Document 06 §§15, 20 (release evidence). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** all five supplemental proofs plus PO-1–PO-24 — release-bound decision and evidence manifest. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Reconcile all R-class 56 acceptance scenarios and release-applicable PO results against exact release commit/digests/schema.
- [ ] **02.** Confirm S44 non-author security review still applies and all incomplete/failed effects, high/critical vulnerabilities and runbook alerts are resolved.
- [ ] **03.** Perform full synthetic owner setup→secret lifecycle→credential issuance→CLI launch→revocation→clean-host restore flow.
- [ ] **04.** Perform synthetic-only rehearsal on intended first-consumer deployment target; do not introduce real secrets before signed release gate.
- [ ] **05.** Verify actual retention aging, backup freshness, alerts, certificate reissue and off-host recovery credentials; sign R evidence manifest against the frozen `product_source_sha` and digests, preserving separate evidence revision/hash.
- [ ] **06.** Sign the controlled-use R release decision and issue a dated, restricted authorization for later S47 non-critical first-consumer onboarding; do not load real application secrets in S45 or premark F evidence PASS.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] Bind all 56 release ACs, all 24 inherited POs and KMS-L1/DB-G1/R2-L1/AGENT-B1/COST-B1 to the exact product source, images, migrations and configuration, reviewer and evidence hashes; each must be `RELEASE_PASS` or an approved tested replacement.
- [ ] Check that AC-1.52 is entirely synthetic, inherited AC-1.42 has a signed S01 disposition, AC-1.36/1.44 include real provider aging/oldest-pair restore, and AC-1.53/1.54/1.58/1.59 remain `NOT_YET_DUE`.
- [ ] Reject pre-release real-secret consumer onboarding. Deliver signed R authorization that enables S46 and S47 *independently*, with first real consumer actually onboarded in S47 only.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Confirm S44 non-author security review still applies and all incomplete/failed effects, high/critical vulnerabilities and runbook alerts are resolved. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S45/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Perform synthetic-only rehearsal on intended first-consumer deployment target. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S45/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Record the signed controlled-use release and the prospective S47 first-consumer authorization, without asserting that onboarding or daily use already occurred. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S45/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S45` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **A missing or post-release AC cannot be incorrectly marked release PASS; no real secret before R signoff.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **Release manifest signed, critical dependencies PASS, product usable without Stage 2; only then connect first non-critical real application.**
- [ ] Rebind all security/functional results to the **exact** final candidate commit and image digests; any security-relevant post-review change makes affected results stale.

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S45` and commit `docs/evidence/sessions/S45/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.
- [ ] Obtain a non-author security/proof reviewer disposition when this session owns a security proof or critical boundary; record reviewer identity and reviewed negative case.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S45/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Independent post-release successors:** S46 and S47 are both eligible independently after S45; do not delay S47 field onboarding or its 28-day observation for S46. **Next concrete action:** open S46 in this document, read its prerequisite and check `docs/evidence/sessions/S46/entry.md` eligibility, then execute its first ordered checkbox: **Create staging-only trusted runner with fixed allowlisted scope, command and arguments; give synthetic token exclusively to runner.** **Real-consumer gate:** actual real-secret onboarding is executed and measured in S47 after signed R approval; S45 only authorizes it.

### S46 — Bounded staging-only agent-initiated acceptance

**Plan:** 15 active hours · **Risk:** High · **Gate:** G-AGENT-FIELD agent exercise · **Workstream:** E.

**Mini-project objective.** Test one actual agent-to-trusted-executor path without shipping a general agent orchestration platform.

**Included boundary.** Allowlisted action/scope/command/args, protected executor-held synthetic token, shipping CLI fixture, prompt/output canaries, forbidden scope/command, revoked credential, outage and no secret exposure in observable harness.

**Implementation/evidence targets.** `tests/agent-fixture/, apps/agent-fixture-trusted-runner/, docs/evidence/acceptance/AC-1.53/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` records and SHA-bound handoffs for **S31, S40, S45**; additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S31, S40, S45.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S46/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.98, FR-1.99; AC: AC-1.53, AC-1.54; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§11–12 (agent cases); Document 06 §19 (bounded agent experiment). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** Create staging-only trusted runner with fixed allowlisted scope, command and arguments; give synthetic token exclusively to runner.
- [ ] **02.** Connect actual bounded autonomous agent instruction to invoke runner through shipping `mykey run`, not arbitrary shell access.
- [ ] **03.** Ensure agent-visible outputs, transcripts, telemetry and tool results never receive fixture secret values or bearer tokens.
- [ ] **04.** Inject forbidden scope, command, path, network outage, revoked credential and prompt-injection attempts.
- [ ] **05.** Publish documented boundaries: compromised privileged runner/child code can access its environment and is not defended by this test.
- [ ] **06.** Record AC-1.53/54 outcomes only after R approval with full attribution and synthetic evidence.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02:** Connect actual bounded autonomous agent instruction to invoke runner through shipping `mykey run`, not arbitrary shell access. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S46/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04:** Inject forbidden scope, command, path, network outage, revoked credential and prompt-injection attempts. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S46/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06:** Record AC-1.53/54 outcomes only after R approval with full attribution and synthetic evidence. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S46/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S46` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Agent cannot choose arbitrary shell command or obtain a machine token/model-visible secret output.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **G-AGENT-FIELD fixture produces attributable allowed result and comprehensive denial/leakage evidence; correctly documents unprotected arbitrary-code boundary.**
- [ ] Require signed R manifest from S45 and mark post-release scenario results `NOT_YET_DUE` until actually executed; do not modify the R release retrospectively.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S46` and commit `docs/evidence/sessions/S46/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S46/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Independent stage-exit handoff:** Send AC-1.53/1.54 and S46 evidence to the S47 final-dossier owner; **S47 may already be running from signed S45 R approval and must not have waited for S46**. **Next concrete action:** inspect the currently running S47 observation diary (or its S45-only entry eligibility) and attach these agent findings to the `AC-1.59` final-decision package without resetting the field-use clock.

### S47 — Four-week field observation, regression and stage-exit dossier

**Plan:** 22 active hours · **Risk:** Medium · **Gate:** F stage completion · **Workstream:** E.

**Mini-project objective.** Connect the first real non-critical consumer after R approval, independently start genuine daily-use evidence, and produce the F decision only after both field-use and separate S46 agent results pass.

**Included boundary.** Once S45 is signed, **independently execute and record the first real non-critical consumer** using protected token supply, actual application launch, revocation/replacement and no forbidden persistence; capture authorization and test evidence without values. Begin the **minimum 28-day genuine daily-use window only after that verified onboarding**, in parallel with separate S46 synthetic agent evidence. Maintain dated diary, staged restore, weekly reliability/UX/cost/latency observations, defects, remediation and affected proof reruns. Final dossier waits for **both S46 and S47** evidence and signed decision.

**Implementation/evidence targets.** `docs/evidence/field-use/, docs/evidence/releases/F/, tests/restore/field-drill/`. These are intended paths; reconcile actual paths to the S02 path map.

**Entry — prerequisites (do not mark complete until checked):**

- [ ] Verify prerequisite `PASS` record and SHA-bound handoff for **S45** (signed R); additionally require every gate/condition named in the paragraph below.
- [ ] Evaluate the full Document 07 entry condition: **S45 (signed R); S46 runs in parallel and is mandatory for the final F decision, not for S47 entry.**
- [ ] Read the full normative requirement and technical contract for the identifiers below; inspect actual branch SHA, pins, schema and unresolved operation/review states.
- [ ] Record `docs/evidence/sessions/S47/entry.md`: source SHA, reviewer, proof maturity, permitted synthetic fixture, time estimate, security boundary and next command.

**Source and proof ownership.** **Primary accountable IDs:** FR: FR-1.100; AC: AC-1.58, AC-1.59; PO: none — contributing/spike work. **Exact source entry:** Document 04 §§11–12 (four-week evaluation); Document 06 §§15, 19–20 (stage closure). Read the full requirements, not only this index. All release-applicable evidence remains subject to integrated final-commit replay and stale-evidence rules.

**Supplemental v0.3 trace:** AC-1.58 real-consumer evidence and AC-1.59 closure after independent S46 agent evidence. Proof maturity is not automatically PASS merely because this session exits.

**Execution checklist — complete in order and record actual evidence:**

- [ ] **01.** After signed R approval, execute **and verify** first real non-critical consumer onboarding, protected token supply, actual application launch, revoke/replacement and non-leakage; then timestamp the beginning of at least 28 days of honest real-use observations. Do not wait for S46 to begin this.
- [ ] **02.** Record weekly backup age, last restore, latency P50/P95, CPU/memory/disk, CLI errors, owner UX friction, alerts and costs.
- [ ] **03.** Perform scheduled staging clean-host restore with synthetic secrets under the production recovery procedure.
- [ ] **04.** Contain discovered defects immediately and repeat affected regression/independent proof; extend observation if daily use requirement was broken.
- [ ] **05.** Evaluate architecture and DX hypotheses, effort, operations and measured gaps versus Northstar; before the final dossier check that **S46** has independently passed AC-1.53 and AC-1.54 with usable evidence.
- [ ] **06.** Produce signed evidence-led ADVANCE/HARDEN–RE-SCOPE/PIVOT/STOP decision without declaring next-stage plans automatically approved.

**Additional v0.3 mandatory evidence tasks (complete before CP-03 and session PASS):**

- [ ] First obtain separate signed post-release authorization, then genuinely deploy the initial non-critical **real** application using safe token bootstrap, actual launch, rotation/revocation and leakage check. Preserve sanitized evidence and timestamp the first eligible observation day.
- [ ] Record each of at least 28 calendar days as actual use, blocked attempt, outage or absent activity; only substantiate four weeks of genuine use when the observed record supports it, extending the window if necessary.
- [ ] Begin S47 after S45 even if S46 is not complete. At the **final stage-exit** checkpoint require S46 PASS and AC-1.53/1.54 evidence as well as S47 AC-1.58/1.59 evidence; field work does not wait for agent research to finish.

**Breadcrumbs — mandatory checkpoint artifacts:**

- [ ] **CP-01 — after steps 01–02, not before the first complete observation week:** Record actual daily-onboarding start and the first weekly backup age, restore recency, latency P50/P95, CPU/memory/disk, CLI errors, UX friction, alerts and costs. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S47/cp-01.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-02 — after steps 03–04, at an evidenced intermediate field-use date:** Contain discovered defects immediately and repeat affected regression/independent proof; record completed and missing daily-use days and remaining calendar minimum. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S47/cp-02.md`. Never label a partial or uncertain state VERIFIED.
- [ ] **CP-03 — after steps 05–06, only after at least 28 qualifying field-use days AND S46 independently PASS:** Produce signed evidence-led ADVANCE/HARDEN–RE-SCOPE/PIVOT/STOP decision without declaring next-stage plans automatically approved. Record specific verified files/decisions, expected and observed results, executed tests, source SHA, unresolved effects and `resume_at` in `docs/evidence/sessions/S47/cp-03.md`. Never label a partial or uncertain state VERIFIED.

**Session-local verification and falsification:**

- [ ] Run `pnpm run check` and `pnpm run test:session -- S47` from the pinned workspace, collecting exact commands, test counts and signed/hashed evidence; provider/operator drills are appended as external evidence rather than simulated.
- [ ] Explicitly falsify this security/failure premise: **Missing genuine use day, skipped restore drill or open critical defect blocks F signoff.** Preserve failing-case outputs and any backend uncertainty for review.
- [ ] Meet the Document 07 testable exit: **First real consumer onboarding and ≥28 days of credited actual-use observations pass AC-1.58; independent S46 AC-1.53/1.54 evidence is complete; AC-1.59 stage decision signed, with remaining defects and uncertainty represented truthfully. S46 does not delay *starting* daily use but is mandatory for stage exit.**
- [ ] Require signed R manifest from S45, preserve AC-1.53/1.54 as `NOT_YET_DUE` until S46 evidence exists, and mark AC-1.58/1.59 no earlier than observed reality; do not modify the R release retrospectively.

**v0.3 checkpoint dependency:** `CP-03 VERIFIED`, the applicable verification procedure and session `PASS` are forbidden while any mandatory supplemental item above lacks actual evidence, reviewer disposition or the appropriate expressly OPEN/later-stage proof ownership.

**Exit — binary acceptance decision:**

- [ ] The session-owned deliverable is demonstrated end to end **within its declared boundary**, without placeholders that masquerade as finished behavior; early feasibility sessions do not claim downstream product integration or final release proof.
- [ ] `CP-01`, `CP-02`, `CP-03`, the stated denied/fault cases, sanitized artifacts and exact test outputs are all recorded with SHA/pin/schema provenance.
- [ ] No open effect or credential discrepancy is represented as a definite safe outcome; all gate-specific failures have a signed disposition.
- [ ] Execute `pnpm run evidence:verify -- S47` and commit `docs/evidence/sessions/S47/exit.md` with `PASS` or an explicit `FAIL`/`BLOCKED`/`REPLAN_REQUIRED` status.

**Handoff — no hidden work:**

Write `docs/evidence/sessions/S47/handoff.md` with the actual commit, affected files, dependency manifest checksum, schema, image digests, approved decisions, positive/negative/fault evidence hashes, outstanding operations, failed tests, reviewer, actual hours and remaining estimate. **Next concrete action:** perform the signed stage-close evidence archival and enter the subsequent product decision process; do not assume Stage 2 authorization.

## Part IV — Integrated acceptance, proof registry and execution audit

### A. Normative accountability and release timing

The indexes below repeat **Document 07 v0.3 primary accountability**, not substitute for the full requirement text. Primary owners do not automatically own all integration and non-author review work. S44/S45 must replay relevant **release** proofs against the exact shipping build. Any mismatch between these indexes and the signed Documents 04–07 is a stop condition and requires regeneration rather than a quiet runbook-only edit.

### B. Independent review and regression invalidation

Every acceptance/proof manifest identifies: run/session owner; release-versus-field gate; test ID; required exact deployment, identity and backend fixture; expected and observed allowed/denied behavior; source and image digests; evidence hashes; reviewer; and final conclusion. A vendor capability page can support a design decision but cannot certify integration. A passing isolated spike can unblock development while its final integrated proof remains OPEN. Security-sensitive changes invalidate related evidence until rerun and independently reviewed.

**Unacceptable release substitutions:** a green unit test in place of a real OVH unseal; a successful upload in place of clean-host restore; expiry claim in place of real protected object lock aging; client timeout in place of backend-effect exclusion; UI RBAC in place of direct OpenBao tenant denials; partial key reads in place of complete coherent environment; a token-create response in place of revocation proof; a preview/screenshot in place of a usable DX workflow; and a synthetic agent run in place of arbitrary-agent isolation claims.

### C. Session exit ledger and release checklist

- [ ] S01 governance and scope/budget authorization is actually signed, or only approved isolated feasibility experiments have proceeded.
- [ ] All required R sessions S01–S45 are PASS with preserved exit/handoff records; all pre-release service functionality is integrated and verified.
- [ ] Each of the 56 R ACs has true `RELEASE_PASS` against the specific release commit; no F AC is pre-marked passed.
- [ ] All applicable PO-1–PO-24 have integrated evidence and nonauthor review, including provider aging and recovery; failed tests remain in the historical register.
- [ ] All critical/high vulnerabilities and defects meet the exact governing severity response and deployment containment obligations.
- [ ] No credential or value appears in prohibited logs, diagnostics, analytics, backups (outside approved encrypted secret-store artifacts), examples or session evidence.
- [ ] Real OVH unseal, complete tenancy matrix, delayed effects, token issuance/revocation, coherent reads, four supported CLI platforms, independent off-host alerts and quarantined clean-host restore have all been demonstrated.
- [ ] Owner workflows, protected Scalar reference, accessibility, meaningful telemetry-free analytics, secret copy/reveal controls and error feedback actually work against the final system.
- [ ] R manifest is signed before any first real-secret onboarding; a noncritical consumer is connected only afterward.
- [ ] S46–S47 complete the actual bounded agent experiment and at least 28 days of real daily use, plus regression and stage-exit decision, to reach **F**.

### D. The final artifact and change-control contract

Completion produces a real **deployable MyKey Private service** with checked-in source, pinned artifacts, operator runbooks, release evidence, and daily-use observations. The next stage is selected by observed value and architecture evidence; it is not assumed or required for this product to work. A new technical finding may force an approved redesign, re-estimation or changed sessions, but cannot make a failed security guarantee quietly optional.

**Document 08 adoption checklist:** compare generated session/requirement/proof indexes against Document 07; sample-execute session entry/exit protocol on S01, S07, S19, S26, S42 and S45; require reviewer coverage for critical gates; resolve budget/authority and AC-1.42 before treating the full roadmap as execution-authorized. This publication is a detailed candidate plan, not evidence that its prerequisites are satisfied.

### E. Requirement primary-owner index (102)

| Requirement | Owning mini-project |
| --- | --- |
| FR-1.01 | S12 — Owner bootstrap, password phase and abuse protection |
| FR-1.02 | S13 — TOTP completion, enrollment and recovery codes |
| FR-1.03 | S13 — TOTP completion, enrollment and recovery codes |
| FR-1.04 | S14 — Sessions, fresh TOTP, account reset and recovery |
| FR-1.05 | S14 — Sessions, fresh TOTP, account reset and recovery |
| FR-1.06 | S14 — Sessions, fresh TOTP, account reset and recovery |
| FR-1.07 | S12 — Owner bootstrap, password phase and abuse protection |
| FR-1.08 | S16 — Operator-only organization provisioning and drift review |
| FR-1.09 | S15 — Authorization, concealment and current-state gate |
| FR-1.10 | S15 — Authorization, concealment and current-state gate |
| FR-1.11 | S15 — Authorization, concealment and current-state gate |
| FR-1.12 | S16 — Operator-only organization provisioning and drift review |
| FR-1.13 | S44 — Independent security, fault and prohibited-surface suite |
| FR-1.14 | S17 — Project/environment lifecycle and readiness |
| FR-1.15 | S17 — Project/environment lifecycle and readiness |
| FR-1.16 | S17 — Project/environment lifecycle and readiness |
| FR-1.17 | S28 — Project/environment archive and reactivation |
| FR-1.18 | S28 — Project/environment archive and reactivation |
| FR-1.19 | S17 — Project/environment lifecycle and readiness |
| FR-1.20 | S19 — Secret creation, update, indexing and version history |
| FR-1.21 | S19 — Secret creation, update, indexing and version history |
| FR-1.22 | S34 — Secret inventory, reveal, lifecycle and history UI |
| FR-1.23 | S34 — Secret inventory, reveal, lifecycle and history UI |
| FR-1.24 | S19 — Secret creation, update, indexing and version history |
| FR-1.25 | S19 — Secret creation, update, indexing and version history |
| FR-1.26 | S19 — Secret creation, update, indexing and version history |
| FR-1.27 | S20 — Secret deletion, undelete and version restoration |
| FR-1.28 | S20 — Secret deletion, undelete and version restoration |
| FR-1.29 | S20 — Secret deletion, undelete and version restoration |
| FR-1.30 | S21 — Reconciliation, execution exclusion and fault suite |
| FR-1.31 | S21 — Reconciliation, execution exclusion and fault suite |
| FR-1.32 | S20 — Secret deletion, undelete and version restoration |
| FR-1.33 | S22 — Strict dotenv codec and loader evidence |
| FR-1.34 | S22 — Strict dotenv codec and loader evidence |
| FR-1.35 | S23 — Import preview, apply and interrupted continuation |
| FR-1.36 | S23 — Import preview, apply and interrupted continuation |
| FR-1.37 | S25 — Human export and sensitive response path |
| FR-1.38 | S22 — Strict dotenv codec and loader evidence |
| FR-1.39 | S26 — Read-only machine issuance and token inventory |
| FR-1.40 | S26 — Read-only machine issuance and token inventory |
| FR-1.41 | S26 — Read-only machine issuance and token inventory |
| FR-1.42 | S27 — Revocation and uncertain issuance lifecycle |
| FR-1.43 | S27 — Revocation and uncertain issuance lifecycle |
| FR-1.44 | S29 — Machine API, direct OpenBao checks and scope |
| FR-1.45 | S29 — Machine API, direct OpenBao checks and scope |
| FR-1.46 | S30 — Shipping CLI: secure keys/run/export and error model |
| FR-1.47 | S30 — Shipping CLI: secure keys/run/export and error model |
| FR-1.48 | S30 — Shipping CLI: secure keys/run/export and error model |
| FR-1.49 | S30 — Shipping CLI: secure keys/run/export and error model |
| FR-1.50 | S30 — Shipping CLI: secure keys/run/export and error model |
| FR-1.51 | S31 — Four-platform delivery and protected consumer setup |
| FR-1.52 | S32 — Shared API/OpenAPI and local protected Scalar |
| FR-1.53 | S32 — Shared API/OpenAPI and local protected Scalar |
| FR-1.54 | S32 — Shared API/OpenAPI and local protected Scalar |
| FR-1.55 | S16 — Operator-only organization provisioning and drift review |
| FR-1.56 | S38 — Full audit coverage, tenancy and retention |
| FR-1.57 | S38 — Full audit coverage, tenancy and retention |
| FR-1.58 | S38 — Full audit coverage, tenancy and retention |
| FR-1.59 | S38 — Full audit coverage, tenancy and retention |
| FR-1.60 | S40 — Limits, readiness, private diagnostics and off-host alerts |
| FR-1.61 | S40 — Limits, readiness, private diagnostics and off-host alerts |
| FR-1.62 | S40 — Limits, readiness, private diagnostics and off-host alerts |
| FR-1.63 | S40 — Limits, readiness, private diagnostics and off-host alerts |
| FR-1.64 | S05 — OVH–OpenBao real auto-unseal feasibility |
| FR-1.65 | S05 — OVH–OpenBao real auto-unseal feasibility |
| FR-1.66 | S41 — Paired capture, immutable retention and aging verification |
| FR-1.67 | S42 — Clean-host quarantine restore and authority revalidation |
| FR-1.68 | S42 — Clean-host quarantine restore and authority revalidation |
| FR-1.69 | S42 — Clean-host quarantine restore and authority revalidation |
| FR-1.70 | S03 — Hardened two-host network and service skeleton |
| FR-1.71 | S03 — Hardened two-host network and service skeleton |
| FR-1.72 | S03 — Hardened two-host network and service skeleton |
| FR-1.73 | S43 — Supply chain, deployment/rollback and operator runbooks |
| FR-1.74 | S43 — Supply chain, deployment/rollback and operator runbooks |
| FR-1.75 | S43 — Supply chain, deployment/rollback and operator runbooks |
| FR-1.76 | S37 — Accessibility, browser security and actionable errors |
| FR-1.77 | S14 — Sessions, fresh TOTP, account reset and recovery |
| FR-1.78 | S41 — Paired capture, immutable retention and aging verification |
| FR-1.79 | S30 — Shipping CLI: secure keys/run/export and error model |
| FR-1.80 | S38 — Full audit coverage, tenancy and retention |
| FR-1.81 | S38 — Full audit coverage, tenancy and retention |
| FR-1.82 | S18 — Durable operations and replay semantics |
| FR-1.83 | S18 — Durable operations and replay semantics |
| FR-1.84 | S24 — Coherent whole-environment snapshot/resolution |
| FR-1.85 | S31 — Four-platform delivery and protected consumer setup |
| FR-1.86 | S42 — Clean-host quarantine restore and authority revalidation |
| FR-1.87 | S42 — Clean-host quarantine restore and authority revalidation |
| FR-1.88 | S21 — Reconciliation, execution exclusion and fault suite |
| FR-1.89 | S33 — Owner frontend shell, MFA and resource navigation |
| FR-1.90 | S39 — Operations timeline, resource overview and safe analytics |
| FR-1.91 | S36 — Credential inventory, issuance and revocation UI |
| FR-1.92 | S39 — Operations timeline, resource overview and safe analytics |
| FR-1.93 | S37 — Accessibility, browser security and actionable errors |
| FR-1.94 | S39 — Operations timeline, resource overview and safe analytics |
| FR-1.95 | S40 — Limits, readiness, private diagnostics and off-host alerts |
| FR-1.96 | S37 — Accessibility, browser security and actionable errors |
| FR-1.97 | S45 — Controlled-use release, synthetic onboarding and evidence closure |
| FR-1.98 | S46 — Bounded staging-only agent-initiated acceptance |
| FR-1.99 | S46 — Bounded staging-only agent-initiated acceptance |
| FR-1.100 | S47 — Four-week field observation, regression and stage-exit dossier |
| FR-1.101 | S45 — Controlled-use release, synthetic onboarding and evidence closure |
| FR-1.102 | S45 — Controlled-use release, synthetic onboarding and evidence closure |

### F. Acceptance accountability index (60)

| Acceptance scenario | Accountable session | Gate |
| --- | --- | --- |
| AC-1.01 | S12 | R — controlled-use release |
| AC-1.02 | S13 | R — controlled-use release |
| AC-1.03 | S14 | R — controlled-use release |
| AC-1.04 | S14 | R — controlled-use release |
| AC-1.05 | S12 | R — controlled-use release |
| AC-1.06 | S16 | R — controlled-use release |
| AC-1.07 | S44 | R — controlled-use release |
| AC-1.08 | S15 | R — controlled-use release |
| AC-1.09 | S16 | R — controlled-use release |
| AC-1.10 | S17 | R — controlled-use release |
| AC-1.11 | S28 | R — controlled-use release |
| AC-1.12 | S19 | R — controlled-use release |
| AC-1.13 | S44 | R — controlled-use release |
| AC-1.14 | S19 | R — controlled-use release |
| AC-1.15 | S20 | R — controlled-use release |
| AC-1.16 | S21 | R — controlled-use release |
| AC-1.17 | S25 | R — controlled-use release |
| AC-1.18 | S40 | R — controlled-use release |
| AC-1.19 | S29 | R — controlled-use release |
| AC-1.20 | S30 | R — controlled-use release |
| AC-1.21 | S30 | R — controlled-use release |
| AC-1.22 | S32 | R — controlled-use release |
| AC-1.23 | S38 | R — controlled-use release |
| AC-1.24 | S40 | R — controlled-use release |
| AC-1.25 | S40 | R — controlled-use release |
| AC-1.26 | S05 | R — controlled-use release |
| AC-1.27 | S41 | R — controlled-use release |
| AC-1.28 | S42 | R — controlled-use release |
| AC-1.29 | S37 | R — controlled-use release |
| AC-1.30 | S03 | R — controlled-use release |
| AC-1.31 | S03 | R — controlled-use release |
| AC-1.32 | S43 | R — controlled-use release |
| AC-1.33 | S43 | R — controlled-use release |
| AC-1.34 | S37 | R — controlled-use release |
| AC-1.35 | S14 | R — controlled-use release |
| AC-1.36 | S41 | R — controlled-use release |
| AC-1.37 | S31 | R — controlled-use release |
| AC-1.38 | S21 | R — controlled-use release |
| AC-1.39 | S23 | R — controlled-use release |
| AC-1.40 | S27 | R — controlled-use release |
| AC-1.41 | S24 | R — controlled-use release |
| AC-1.42 | S45 | R — controlled-use release |
| AC-1.43 | S42 | R — controlled-use release |
| AC-1.44 | S42 | R — controlled-use release |
| AC-1.45 | S45 | R — controlled-use release |
| AC-1.46 | S39 | R — controlled-use release |
| AC-1.47 | S36 | R — controlled-use release |
| AC-1.48 | S39 | R — controlled-use release |
| AC-1.49 | S40 | R — controlled-use release |
| AC-1.50 | S44 | R — controlled-use release |
| AC-1.51 | S37 | R — controlled-use release |
| AC-1.52 | S45 | R — controlled-use release |
| AC-1.53 | S46 | F — post-release |
| AC-1.54 | S46 | F — post-release |
| AC-1.55 | S39 | R — controlled-use release |
| AC-1.56 | S45 | R — controlled-use release |
| AC-1.57 | S45 | R — controlled-use release |
| AC-1.58 | S47 | F — post-release |
| AC-1.59 | S47 | F — post-release |
| AC-1.60 | S45 | R — controlled-use release |

### G. Proof closure index (29: 24 inherited + five supplemental; all OPEN at authoring)

| Proof | Primary closure owner | Evidence maturity at authoring |
| --- | --- | --- |
| PO-1 | S05 | `OPEN` (no executable proof claimed) |
| PO-2 | S29 | `OPEN` (no executable proof claimed) |
| PO-3 | S06 | `OPEN` (no executable proof claimed) |
| PO-4 | S16 | `OPEN` (no executable proof claimed) |
| PO-5 | S12 | `OPEN` (no executable proof claimed) |
| PO-6 | S14 | `OPEN` (no executable proof claimed) |
| PO-7 | S20 | `OPEN` (no executable proof claimed) |
| PO-8 | S31 | `OPEN` (no executable proof claimed) |
| PO-9 | S41 | `OPEN` (no executable proof claimed) |
| PO-10 | S32 | `OPEN` (no executable proof claimed) |
| PO-11 | S03 | `OPEN` (no executable proof claimed) |
| PO-12 | S37 | `OPEN` (no executable proof claimed) |
| PO-13 | S41 | `OPEN` (no executable proof claimed) |
| PO-14 | S40 | `OPEN` (no executable proof claimed) |
| PO-15 | S13 | `OPEN` (no executable proof claimed) |
| PO-16 | S44 | `OPEN` (no executable proof claimed) |
| PO-17 | S23 | `OPEN` (no executable proof claimed) |
| PO-18 | S28 | `OPEN` (no executable proof claimed) |
| PO-19 | S24 | `OPEN` (no executable proof claimed) |
| PO-20 | S31 | `OPEN` (no executable proof claimed) |
| PO-21 | S41 | `OPEN` (no executable proof claimed) |
| PO-22 | S42 | `OPEN` (no executable proof claimed) |
| PO-23 | S40 | `OPEN` (no executable proof claimed) |
| PO-24 | S02 | `OPEN` (no executable proof claimed) |
| KMS-L1 | S42 (S05 disposable early spike; S44/S45 release review) | `OPEN` — off-host referenced seal-key version, disposable key-loss denial, clean-host unseal |
| DB-G1 | S42 (S04 inventory; S11 synthetic globals restore; S44/S45 release review) | `OPEN` — PostgreSQL cluster-global reconstruction and privilege-denial matrix |
| R2-L1 | S41 (S09 provider-clock start; S44/S45 release review) | `OPEN` — real lock aging, per-object error/cleanup and oldest-pair recovery |
| AGENT-B1 | S31 (S10 beta decision; S44/S45 release review) | `OPEN` — beta dependency decision and four-target CLI parity |
| COST-B1 | S41 (S09 cost baseline; S43 ops handoff; S44/S45 release review) | `OPEN` — provider-measured backup footprint, retrieval, operations and capacity |


**Supplemental proof release contract:** KMS-L1, DB-G1, R2-L1, AGENT-B1 and COST-B1 are five **additional stable IDs**, not renamings of PO-1–PO-24. The owning session must create a separate nonsecret `docs/evidence/proofs/<ID>/` record for each, with test fixture, adverse case, actual provider/host/runtime identity, source/pin/config digests, observed artifacts, open limitations, non-author reviewer and release applicability. A missing, `BLOCKED`, `FAIL`, `NOT_YET_DUE` or `STALE` release-applicable proof blocks S45 signoff. Their full detailed closure criteria are in Documents 05–07 v0.3; this short index is not a substitute.

### H. Provenance, scope and version control

This revised execution document is synchronized from `doc_07_mykey_stage_1_pre_roadmap_v0.3_preimplementation_audited.md` and checked against Documents 03–06 v0.3 (with Document 01 v0.2 / Document 02 v0.3 as higher-level authorities). Session titles, objectives, workstream estimates, primary FR/AC/PO accountability and no-go gates are inherited from Document 07. Two historical v0.1 dependency-generation defects (S01 self-edge and S09 accidental S05 edge) were corrected in the prior v0.2 review; the resulting graph is checked against Document 07. Ordered checklists, proposed paths, checkpoint naming and command interfaces are *new planning instructions*; they are not claims that code or tests already exist. Any contradiction must be recorded in change control and corrected before executing the affected session.

**Status at v0.3:** Revised execution-runbook candidate; the 47 sessions and full 102/60/29 requirement, acceptance and proof registers are structurally reconciled on paper. Unresolved governing authority, signed AC-1.42 interpretation/amendment, 1,039-hour planning-envelope approval and all executable feasibility proofs still prohibit unrestricted implementation authorization.


## Appendix I — v0.2 historical audit corrections (retained)

The separate Document 08 independent audit report documents detailed findings. This appendix is the in-roadmap change ledger; it does not supersede upstream authority.

| Change | Executable effect |
| --- | --- |
| S01 self-dependency removed | The bootstrap session has no prior session, and it must not be marked PASS unless governing, budget, reviewer and AC-1.42 conditions are actually signed and resolved. |
| S09 accidental S05 dependency removed | Real-clock R2 storage retention fixture begins once S03 plus separately verified R2 and key custody are available, without waiting for native KMS. |
| Per-session normative references added | Each runbook names its exact FR/AC/PO primary accountability and Document 04/06 section locations; empty primary ownership is expressly marked as a contributing/feasibility session. |
| Session-specific test manifest required | The evidence checker must reject absent named tests rather than treating generic checklists or skipped provider cases as passing. |
| Release artifact identity separated from evidence revision | S44/S45 attest immutable product build identity without invalidating the product merely by committing signed evidence. Any actual build/config change still invalidates affected proofs. |
| Field onboarding timing clarified | S45 signs R and authorizes later onboarding; S47 conducts and measures the first real noncritical consumer and 28-day observation. |
| S47 checkpoints made calendar-sensitive | A checkpoint cannot represent a week's or four weeks' observations before elapsed evidence exists. |
| Labor/reviewer estimates made an entry condition | Compare expected hours with Doc 07 and record reviewer effort, external costs and calendar dependencies explicitly; no invented confidence intervals. |

The governing P-01/P-02/P-03 and AC-1.42 source issues remain open, and the 903-hour expected / 1,039-hour planning envelope is not yet authorized.


## Appendix J — v0.3 final pre-implementation audit and synchronization record (7 November 2026)

The v0.2 runbooks are preserved as complete session mini-projects; v0.3 synchronizes them with the governing **Documents 02–07 v0.3** (Document 01 remains v0.2). This audit is a *planning and static traceability assessment*, not proof that any software, provider account, security integration or recovery operation passed.

| Change | Execution impact and control |
| --- | --- |
| Workload recosted | S01, S02, S04, S05, S09, S10, S11, S31, S41, S42, S43, S44, S45 and S47 adjusted; 47 total sessions, 903 person-hours, 136-hour reserve, 1,039-hour unapproved envelope. All session-local estimates are provisional. |
| Proofs expanded | Maintains PO-1–PO-24 and adds KMS-L1, DB-G1, R2-L1, AGENT-B1, COST-B1; each is explicitly assigned early, primary and integrated evidence ownership; all start OPEN. |
| Recovery made genuinely off-host | S04/S11/S42 reconstruct PostgreSQL globals; S05/S42 prove seal-key/version custody and permanent disposable loss; no recovery claim depends on a vanished old host or MyKey service. |
| Object locks and economics made testable | S09 begins provider-clock fixtures; S41 demonstrates lock aging/oldest pair, per-object cleanup failure and measured backup storage/operation/recovery economics. |
| Beta dependency decision added | S10 explicitly evaluates OpenBao Agent process supervisor public-beta status; S31 closes distribution/exception/parity. The staging agent request experiment in S46 remains distinct. |
| 28-day observation dependency corrected | S47 **starts after S45**, not after S46; S46 runs in parallel. Stage F cannot close until both paths and all four post-release ACs pass. |
| Controlled-use contract clarified | AC-1.52 stays synthetic-only; AC-1.58 owns real-consumer onboarding and daily observation. AC-1.42 **still requires a signed authoritative interpretation or amendment at S01**; runbooks do not alter inherited text. |
| Complete release safeguards preserved | AC-1.36/AC-1.44 actual-provider-clock and oldest-pair recovery remain release-due unless formally amended. All 56 release ACs and 29 proof records require exact-build evidence and independent security review before real application secrets. |
| Missing governing approvals not fabricated | P-01/P-02/P-03 originals, Documents 03–06 governing approval, AC-1.42, budget/scope decision, provider credentials, and every executable proof remain OPEN until completed. |

**Current disposition:** This v0.3 file is recommended as the synchronized session-runbook **candidate** for S01 governance and authorized synthetic-only feasibility planning. It does **not** authorize the current 1,039-hour engineering envelope or any real-secret use. If S01 fails authority or budget reconciliation, dependent implementation must stop and a formally re-scoped, complete-product roadmap must replace this one. Real-world test outcomes always override planning assertions.
