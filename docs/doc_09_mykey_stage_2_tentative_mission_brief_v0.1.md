# Document 09 — MyKey Stage 2 Tentative Mission Brief

**Working product:** MyKey  
**Proposed Stage 2 product:** **MyKey Teams — Trustworthy Shared Secrets Operations**  
**Version:** **0.1 — aspirational, evidence-contingent mission candidate**  
**Prepared:** 7 November 2026  
**Strategic horizon:** After Stage 1's authorized release, four-week field validation, and signed transition decision; **no calendar commitment**  
**Governing direction:** Document 01 v0.2 *Project Northstar* and Document 02 v0.3 *Project Stage Breakdown*; the eventual approved Stage 1 outcome and its evidence supersede today's untested assumptions  
**Source baseline:** Documents 03–08 v0.3, as audited on 7 November 2026, including Stage 1's 102 candidate FRs, 60 candidate ACs, 29 technical proof records, and provisional 47-session, 903-hour engineering plan plus 136-hour reserve  
**Decision status:** **NOT APPROVED FOR STAGE 2 DESIGN OR IMPLEMENTATION.** This document is an ambitious hypothesis and a discussion artifact, not a revision to Stage 1, a functional specification, an approved architecture, a funded budget, or a claim that Stage 1 has been implemented or tested.

> **Stage 2 mission in one sentence:** Transform a proven, single-operator MyKey Private service into a **small-team, invite-only, operator-managed service** in which access can be granted, understood, used, transferred, revoked, recovered, and exited **without distributing unnecessary plaintext credentials or losing track of who can still act**.

> **Strategic ambition:** Do not build merely “multi-user MyKey.” Build the **trustworthy handoff of authority** between people, teams, applications, and their existing machine consumers. If that distinction cannot produce measurable advantage over direct OpenBao and incumbent developer-secret workflows, this stage has not earned its additional complexity.

---

## 1. Executive decision: the next organic product shape

### 1.1 The proposed choice

**Default direction: MyKey Teams.** Document 02 identifies an invite-only, controlled hosted multi-organization service as the proposed Stage 2. This mission sharpens that choice around **assured collaboration and access transitions**, rather than treating tenant creation or seat counts as the outcome. The transition is organic because Stage 1 already intends to supply:

- a real secret/value and versioning authority in OpenBao, with independently enforced machine access;
- PostgreSQL-governed organizations, projects, environments, authorization, operations and audit;
- a complete owner workspace, CLI, API and current-only complete-environment delivery path;
- explicit credential issuance, expiry, revocation, uncertainty and recovery states;
- operator-controlled provisioning, backup/restore, release gates and useful status evidence;
- the first synthetic agent-to-trusted-executor experiment and measured production-like field use.

**Stage 2 asks the next valuable question:** Can these individually usable, security-sensitive workflows become **safer and less laborious when multiple real humans and organizations must coordinate them**, without making the operator's blast radius, recovery obligations, support burden or per-tenant cost unacceptable?

The central differentiator is **assured authority transitions**: a teammate joins; receives only intended rights; can see why; can perform a legitimate change; can hand over responsibility; can be removed; and the service can demonstrate which human and machine authority remains effective afterward. A different team cannot observe or perturb any of that process.

### 1.2 Why this has unusually high payback

| Investment | Immediate value to Stage 2 users | Reusable value for later stages |
| --- | --- | --- |
| Reliable invitation, membership and scoped-grant lifecycle | Stops password/account sharing and ad hoc secret forwarding | A concrete sponsor and authorization model for future workloads and agents |
| Explicit machine-credential sponsor and lifecycle ownership | Makes offboarding and project handoff safe and explainable | Proven attribution and revocation semantics before identity federation |
| Tenant isolation proven across all layers | Allows real external organizations to trust the managed service within its stated boundary | Safe partitioning and policy boundaries for future delegated actions |
| Tenant-safe provisioning, recovery and exit | Makes the service supportable and reduces lock-in anxiety | Operational foundation for larger hosted deployments |
| A genuinely helpful team workspace | Reduces support, permission mistakes and incident confusion | Human supervision experience for future agentic operations |
| Evidence-based managed-service economics | Distinguishes a useful SaaS from an expensive hobby service | Defensible decisions on hosting, scale, pricing and platform alternatives |

**The payback test is comparative, not aesthetic:** measure whether MyKey makes common collaboration and rotation tasks faster, less risky, more understandable and less operator-intensive than direct OpenBao, environment-variable/secret features offered by deployment platforms, or a small well-written set of scripts.

### 1.3 What does *not* follow automatically

Stage 1 is **not yet an executed result**. Its revised plan estimates **903 active engineering hours and a 1,039-hour uncertainty envelope**, substantially above the nominal 400-hour target; neither amount is an approved budget. Its hard integration proofs, actual provider behavior and 28-day observation remain to be performed. We must not assume successful implementation, easy reuse of the single-host topology, maintainable Better Auth customization, acceptable operator toil, or sufficient customer demand.

The six-stage sequence in Document 02 is an **option map, not destiny**. If the controlled Stage 1 evidence shows disproportionate value in private agent-facing consumption but weak justification for external teams, the owner should **replace this candidate** with a new, fully specified Stage 2 mission instead of adding team features merely to conform to an old diagram.

## 2. Product proposition and intended users

### 2.1 Product promise

**MyKey Teams gives a small invited engineering team a governed, visible and recoverable place to operate application secrets together—without replacing explicit access control with trust in coworkers, or replacing operational evidence with optimistic UI states.**

In practical terms, a team can onboard a person, delegate a narrow role, see which projects and credentials they are responsible for, complete ordinary secret-management work, rotate and remove access, and recover safely from an infrastructure or operational incident. MyKey retains the Stage 1 machine-facing CLI/API experience. An operator can provision and support several independently scoped organizations on a hosted service and can explain the supported and unsupported recovery and privacy guarantees.

This is an **invite-only, limited-customer managed service**, not a self-service public SaaS launch. It may be offered to carefully chosen friends, teams or design partners under explicit pilot terms. Payment and broad commercial availability are not prerequisites; actual security and privacy responsibilities are.

### 2.2 Primary consumers and the jobs to be done

| Actor | Job to be done | Required successful outcome |
| --- | --- | --- |
| Team owner | Establish team workspace and transfer responsibility safely | Clear authority map, bounded invitations, recoverable owner continuity, no shadow owners |
| Team administrator | Maintain users, projects, credentials and incidents | Can act within delegated bounds without gaining infrastructure/operator authority |
| Developer / project editor | Change secrets for assigned work and launch applications | Fast, specific legitimate access; no visibility into unrelated environments |
| Reader / limited collaborator | Inspect authorized metadata or revealed values where explicitly allowed | No accidental edit, issuance, invitation or privilege escalation |
| Existing CLI/application consumer | Continue a known service runtime securely | Stable scoped consumption, documented rotation, no silent authentication regression |
| Managed service operator | Provision, monitor, investigate, support, upgrade and recover invited tenants | Credible isolation, manageable workload, verified backup and incident procedure |
| Future workload / agent sponsor | Know which human/team authorized a machine credential | Stable, auditable sponsorship record for a later stage; **not** Stage 2 autonomous delegation |

A person can belong to more than one organization, but the product must make the *active context* unmistakable. A user's membership in one organization may never imply access to another. The infrastructure operator is not automatically a member of every tenant and the tenant owner is never an infrastructure administrator.

### 2.3 The initial service cohort

The **provisional demonstration cohort** is at least **two independent real invited organizations**, each with multiple distinct human accounts and at least one useful application/project workflow. These numbers are a design-test proposal, not an assertion of market viability or a permanent product maximum. The selected release contract may constrain organization count, members, secret volumes, regions, and support hours if those limits are real, disclosed, and enforced end to end.

A single owner switching between two test namespaces is insufficient evidence of Stage 2 collaboration or external tenant isolation.

## 3. The essential evolutionary leap: from owner custody to accountable team authority

### 3.1 Four transitions that must work as a single coherent system

1. **Invitation to scoped membership.** A verified eligible inviter proposes a role and scope; the invited human proves control of the invitation channel and completes the supported protected account/MFA ceremony; acceptance is bound to the exact tenant, role, expiry and invitation state. A link alone never becomes a product session or an infrastructure credential.
2. **Membership to permitted work.** Each sensitive request re-evaluates current membership, resource ancestry, resource state, effective grant and step-up requirements. The UI explains the scope and denied action without leaking unseen resource names or privileged operator information.
3. **Responsibility transfer.** When a person changes team or hands over a project, the service exposes related access and machine-credential sponsorship. Changes to human and machine authority occur through an explicit, verified plan with honest pending, blocked and uncertain states—not a decorative “transfer ownership” button.
4. **Removal to proven denial and durable continuity.** A revoked or offboarded person's new human requests fail promptly according to the documented in-flight boundary. The service independently evaluates affected machine credentials and either revokes/reissues or explicitly preserves them under an eligible surviving sponsor, according to a recorded team policy. No blanket claim is made that removing a user magically revokes every token that user once issued.

**This lifecycle, not a new role dropdown, is the unit of product completeness.** Every transition must have successful, denied, concurrent, interrupted, recovery and audit cases.

### 3.2 Minimal effective authorization model

The default proposal is a **small finite set of understandable roles** (organization owner, organization administrator, project/environment editor, project/environment reader) plus explicit resource grants where justified by Stage 1's existing domain model. Avoid a general-purpose policy language, ad hoc role builder, organization-wide wildcard privileges, or a complex inheritance graph until real collaboration demonstrates the need.

Some actions deserve *distinct authority*: inviting a user, changing another user's grant, issuing a machine credential, viewing a plaintext secret, exporting an environment, performing a high-impact offboarding, transferring the last owner, and accessing operator diagnostics must **not** all collapse into “admin.” The eventual functional contract should define a small explicit action matrix and freshness conditions. Visibility and ability to modify must be separately represented.

**Provisional owner-continuity invariant:** no normal web operation may leave an active organization without a valid, recoverable owner or transfer ownership into an unaccepted invitation. Emergency operator recovery must use the separate, audited, off-host authority path and remain constrained by the service's incident/trust model.

### 3.3 Machines have operational owners, not human sessions

Stage 1 machine tokens are backend bearer capabilities with limited lifetimes and native scope. A Stage 2 team needs to know **why a machine credential exists, which project/workload it serves, who requested it, and who is accountable for replacing it**, without claiming that the issuing human is the runtime principal.

A machine credential should have an explicit *sponsorship/ownership classification* (for example, individually sponsored or team/project-owned) and associated immutable issuing evidence. Before a person's removal, the UI should show the blast radius and safe options:

- credentials that must be revoked and replaced;
- credentials that may remain under an authorized surviving sponsor by an explicit, audited transfer with any necessary reissue;
- credentials in an uncertain issuance/revocation state that block a false completion claim;
- consumers that need coordinated protected replacement, with no token ever re-revealed from storage.

The exact sponsorship rules are **not decided here**. They require a failure-mode design and direct OpenBao tests; in particular, token revocation, loss of delivery and archive races retain Stage 1's conservative effect semantics. The team product must preserve current-only machine delivery, CLI protections and token non-persistence.

### 3.4 Human access is not an invitation to expose values broadly

A well-designed shared workspace should make it easy to discover that a secret exists and to obtain authorized use **without normalizing copy/paste of its plaintext**. The UI should favor safe metadata, scoped operations, child-process delivery and informative denies. Reveal/export remain explicit privileged exceptions. Copying a value or launching a process necessarily crosses a disclosure boundary; the service cannot revoke bytes already delivered to a person or executable.

## 4. Six defining Stage 2 journeys

Each scenario is an **aspirational acceptance narrative**, not a numbered FR or AC. The eventual Stage 2 functional specification must expand it into positive, negative, concurrency, crash, misuse, accessibility and recovery cases.

### Journey A — A second engineer joins without shared credentials

A managed operator provisions an invited organization's supported workspace. The owner invites a developer to a named project with an editor scope. The developer accepts through a validated, short-lived, one-use process, completes protected account enrollment/MFA, and sees only authorized resources. They run a real permitted developer task through MyKey's supported CLI. The developer cannot reveal unrelated secrets, change grants, issue credentials or call an operator endpoint without the appropriate additional authority. Expired, canceled, transferred or replayed invites are denied. The activity record explains *who invited whom, for what scope, when it became effective, and what was denied* without exposing sensitive values.

### Journey B — Collaboration without access drift

A project owner grants a colleague temporary or continuing limited project access. The colleague rotates a development secret using the existing expected-version/operation contract; a concurrent stale change fails explicitly. The team sees a useful timeline of the change and affected credentials. A later grant reduction immediately governs new requests. A hidden sibling project remains invisible through search, errors, cursors, analytics and API docs, not just through navigation menus.

### Journey C — Offboard an engineer and account for machine consumers

An engineer leaves. The authorized owner starts a guided offboarding action that enumerates **known** effective human privileges and associated credential sponsorship. The service disables new human authority, revokes sessions/challenges, and executes or schedules the approved token actions. A running consumer's protected rotation steps are documented. A timed-out OpenBao revoke remains `uncertain` or blocked until verified; the UI never declares “fully offboarded” while relevant authority remains unaccounted for. The old user cannot regain access through an earlier invitation, password-reset link, browser session, alternate organization context, restored backup or machine-token issuance race.

### Journey D — One hostile tenant cannot inspect or affect another

Two unrelated teams operate concurrently. A hostile user in organization A attempts organization-header manipulation, forged IDs, unexpected auth/plugin routes, direct backend paths, secret-name guessing, cursor reuse, audit search, response/exception probing, cached-browser views, quota exhaustion and unauthorized token operations against organization B. Every tested attack is denied within the declared threat model. Backend privilege, service accounts, restored state, backup locations and support diagnostics are tested—not inferred from OpenBao namespace naming alone. A privileged managed operator remains a **trusted** actor under a separate disclosed and audited role, not magically unable to inspect the service.

### Journey E — The service is lost, but neither organization silently regains obsolete authority

The operator conducts a clean-host whole-service restore from eligible protected backup material with the original deployment fenced, required KMS seal-key versions still available, PostgreSQL roles/configuration reconstructed and the restored service **closed**. Historical human sessions, MFA/recovery artifacts, machine authority and pending effects are reconciled or invalidated before reopening. Both teams subsequently prove current access and backend denial of old credentials. A failure in one organization's logical recovery or tenant export cannot roll back the other organization's state. A Raft snapshot is **not** described as a per-organization point-in-time restore.

### Journey F — A team can inspect, export and leave without relying on undocumented operator magic

A team owner requests a supported tenant-level exit package. The service explains its scope (for example, authorized current values, version/reference metadata, nonsecret access maps and permitted audit exports), what it excludes (raw lost tokens, inaccessible history, infrastructure-level authority) and how delivery is protected. The package is verified and safely handed to the authorized tenant representative. Outstanding credentials, invitations and grants are revoked/disabled according to the exit plan. Residual encrypted backup retention, administrative deletion/lock limits and legal retention obligations are explained truthfully. A second team continues functioning. This is a **tested tenant exit**, not a promise of instantaneous physical deletion or arbitrary full tenant rollback.

---
## 5. Signature product capabilities: what deserves disproportionate attention

### 5.1 An effective-access map, not another permissions page

A high-payback feature is a **credible answer to “Who can use this, and why?”** Within the *supported* Stage 2 domain, the owner workspace should explain the current authorization path for a given human or credential: tenant membership → project/environment grant → resource state → relevant action constraint → known machine-credential scope/status. The explanation should make pending changes, expired credentials, uncertainty and unavailable backend verification visible.

**The proposed signature experience is a permission-change preview**: before removing a member or reducing a grant, show which verified human rights and *known sponsored machine credentials* are affected, what will be revoked or transferred, and what remains outside the service's ability to retract (for example, plaintext previously exported). After execution, show only verified results. This may substantially reduce cognitive load and unsafe manual coordination. It is not a promise to infer every secret copy or every access path outside MyKey.

An access map that displays attractive relationships but silently trusts stale SQL data over live OpenBao token validity is a **product failure**. Versioned sources, evidence freshness and explicit `unknown` states matter more than visualization sophistication.

### 5.2 A guided offboarding and transfer workflow

**Ambition:** turn an error-prone series of user, grant, session, machine-token, deployment and recovery steps into one bounded, inspectable workflow. The workflow may have several internal operations; it must not pretend they are a single distributed atomic transaction. It should:

- deny newly admitted access promptly at the authoritative boundary;
- show the affected rights, sponsored credentials, known consumer dependencies and required human decisions;
- execute only the authorized, feasible revocations and transfers through existing durable mechanisms;
- preserve idempotent, queryable progress, explicit unresolved operations and nonsecret audit evidence;
- fail closed rather than mark offboarding complete while actionable known authority remains;
- give the team a concrete, minimal next-action package for any unsupported or manual consumer replacement.

**Stage 2 should become exceptional at this one workflow.** A complete, verified offboarding story is more defensible and more useful than a much larger list of partially supported access-control features.

### 5.3 Managed tenant lifecycle with supportable economics

Organization creation, supported quotas, operator approvals, trial suspension, tenant migration between approved deployment units (if selected), backup evidence, incident containment and deliberate tenant exit should be a **repeatable operator capability**, not a collection of database edits or hand-run OpenBao commands. Any privileged operation must preserve separation between ordinary tenant administration and infrastructure administration.

Operator tooling should reveal the minimum useful tenant-scoped state: provisioning progress, verified backend/configuration status, backup eligibility, alert conditions, support case reference, nonsecret operations and recovery dependencies. Raw secret-bearing OpenBao audits are not a tenant-facing analytics data source. This is product-local operational visibility, **not** a broad general observability platform.

### 5.4 An intentional human UX and developer API

MyKey should aim for an exceptional, keyboard-accessible, responsive, context-aware team workspace with:

- clear organization/project context and a conspicuous tenant switcher;
- invitations, pending memberships, owner continuity and scoped grant review;
- safe resource and secret workflows retained from Stage 1;
- machine credential inventory, effective expiry, named sponsorship and verified revocation states;
- the access-map/offboarding preview and a truthful before/after result;
- activity timelines that distinguish observed events from derived summaries and unavailable evidence;
- first-run and incident guidance that is actionable rather than alarmist.

Preserve a stable CLI/API path for existing machine users, with compatibility tests and notices for any deliberate migration. New read-only explanations and operational statuses should be accessible through narrow authenticated, typed, versioned interfaces usable by scripts and external agents **without yielding plaintext by default**. Scalar remains the candidate developer-reference surface; the existing strict product/agent boundary remains in force.

## 6. Trust, privacy and security: conditions for earning external tenancy

**Stage 2 materially changes the threat model.** The service begins to hold secrets on behalf of different real organizations and multiple users who do not necessarily trust one another. This is not a cosmetic extension of Stage 1's synthetic second-tenant tests.

### 6.1 Required security invariants

| Boundary | Invariant the released product must demonstrate |
| --- | --- |
| Human identity | Every supported public auth route preserves protected session storage, completed MFA, recovery, current account state, appropriate fresh factor and non-bypassable invite-only enrollment |
| Tenant authorization | All sensitive decisions derive tenant and resource identity from authenticated server-owned state; cross-tenant selectors, stale memberships and hidden resources never gain authority |
| Backend authority | OpenBao namespace/policy, token-role and operator permissions are directly verified; no public actor obtains root, cross-tenant or arbitrary issuance privileges |
| Machine access | No stored/replayable machine bearer; scoped current-only product API and backend verification remain the authority; ownership metadata does not expand token privileges |
| Revocation/offboarding | New requests are denied according to a precise linearization boundary; remote effects are not assumed canceled by a client timeout; uncertainty is durable and blocks false completion |
| Tenant data separation | Cross-tenant leaks are denied in values, names, IDs, counts, errors, caches, logs, export, audit, diagnostics, backup interfaces and restored state |
| Audit and explainability | Security events are accurately attributed to observed principals/scope and are privacy-minimized; inferred posture is labeled as inferred and bounded by available evidence |
| Recovery | The external quarantine gate, complete off-host key custody, PostgreSQL cluster-role reconstruction, OpenBao token cleanup and fresh human account recovery remain mandatory |
| Confidentiality | Ordinary browser storage, telemetry, email, invitations, support tickets, job payloads and screenshots do not collect values, credentials, factor material or reset secrets |
| Operational claims | No zero-knowledge, universal secretless execution, true tenant cryptographic independence, immutable-to-operator storage or HA/SLA claim without exact supporting controls and tests |

### 6.2 The most consequential architecture fork: tenant deployment topology

A Stage 1 **namespace-per-organization** approach is a strong *candidate* foundation, but it is not a complete hosted service security case. The principal alternatives for Stage 2 are:

| Candidate | Potential advantage | Important cost / open proof |
| --- | --- | --- |
| **Shared hardened OpenBao + PostgreSQL** with separate namespaces, tenant-aware SQL and tightly scoped runtime identities | Least incremental infrastructure and lowest small-cohort operator overhead | Shared privileged operator/root/KMS and failure domains; cross-tenant data, backup, auth and support compromise tests are demanding |
| **Per-tenant OpenBao units**, with central product UI/control-plane boundaries | Narrows some cross-tenant backend blast radii and makes recovery domains clearer | More processes, cert/key handling, upgrades, snapshots and per-tenant cost; shared control plane and database can still cross boundaries |
| **Dedicated deployment per tenant** behind a controlled managed operator workflow | Strongest simple starting isolation narrative for high-trust early tenants, and potentially simpler tenant-specific restore | Higher minimum resource cost and provisioning/support burden; true multi-tenant managed operations still need working identity and isolation |

**No topology is selected by this mission.** Use Stage 1's real host resource use, KMS behavior, R2 restore cost, backup validity, credential escalation analysis and operator toil to choose and *falsify* a candidate. A dedicated backend is not proof of independent customer-only cryptographic key custody; a shared backend is not automatically insecure if its actual supported threat model and host/operator boundary are candidly defined and verified.

A smaller, fully supported cohort on a safer topology is preferable to a larger number of tenants on an unproved shared design. Conversely, introducing a dedicated deployment per tenant without quantifying operator and cost impacts may erase the entire SaaS value proposition.

### 6.3 Tenant recovery and tenant exit are different products

**Whole-service disaster recovery** must restore a coherent PostgreSQL/OpenBao pair under an off-host quarantine and credential-replacement procedure. Stage 1 already demands this, and Stage 2 must re-prove it against the selected multi-tenant topology and real membership authority.

**Tenant-specific remediation** is a separate problem. Native OpenBao Raft snapshots are not assumed to restore *one organization* into a live shared cluster. The Stage 2 baseline should promise only genuinely supported, tested tenant-level capabilities, such as individual historical-value restoration, safe current-value/metadata export and, if feasible, an explicitly designed logical import/reconstruction workflow. Any **tenant point-in-time restore** is a separate proposed capability that must prove non-target tenant continuity, consistent SQL/backend state, recovery of intended values, and non-resurrection of revoked sessions or machine tokens before it is advertised.

A tenant exit is likewise not a substitute for erasure. OpenBao version retention, protected backup pairs, R2 bucket locks, 365-day audit retention, legal obligations and operator-held keys may leave retained encrypted historical material. Stage 2 must disclose retention and actual deletion authority correctly; the operator cannot promise immediate erasure while required backups remain locked. Offboarding must disable active authority and complete a proven lifecycle regardless of these longer storage obligations.

### 6.4 Invitation and recovery channel trust

A new invited user must not be permitted to bypass MFA through invitation acceptance, join the wrong organization because of a changed active-org cookie, or use an invitation as a reset token. The channel used to notify them (email or an operator-mediated secure route) is an implementation choice, **not** an authentication authority by itself.

If the existing Better Auth organization plugin can be safely integrated with the Stage 1 protected session/factor architecture and **every exposed native endpoint**, use it instead of recreating standard membership plumbing. But its ability to create organizations, change roles, accept invites or manage users may widen the route surface. The current Stage 1 allowlist deliberately excludes these operations; **turning on the plugin is a new security decision and mandatory direct-route proof**, not a simple option toggle. Any operator-controlled invite delivery system must avoid placing high-value reset or credential material in broadly retained notification logs.

### 6.5 Responsibility and legal prerequisites

Before onboarding external tenants with real secrets, publish a truthful responsibility model: who owns customer account recovery, who may access service plaintext, who holds/rotates KMS and backup authority, which incidents the operator investigates, what support is available, what is retained and for how long, how tenants exit, and what the tested recovery limits are. Establish appropriate privacy notices, data-processing/contractual terms, access to support, vulnerability disclosure, breach/incident procedures and applicable jurisdictional review. This document does not certify compliance or legal adequacy.

## 7. Stage 2 functional package: committed *candidate* versus conditional ambition

This partition prevents aspirational ideas from silently becoming mandatory implementation scope before the technical and budget evidence exists.

### 7.1 Candidate mandatory capability bundle — a complete *MyKey Teams* release

1. **Controlled hosted onboarding:** operator-provisioned organizations; invite-only account creation or enrollment; verified human MFA/recovery; invitation cancel/expiry/replay denial; clear organization switch and membership lifecycle.
2. **Effective team authorization:** simple finite role/grant matrix; current and cross-tenant checks; grant editing with explicit authority; no hidden privilege escalation; truthful explanation of access.
3. **Accountable machine authority:** existing token and CLI workflows preserved; documented sponsor/consumer linkage; effective expiry/revocation and offboarding handling with backend verification.
4. **Assured join/change/leave journeys:** fully implemented ownership and last-owner protection, handoff/offboarding preview, durable status and safe completion/failure states.
5. **Tenant-safe managed operations:** provision/suspend/offboard/reopen within tested scopes; quotas/resource limits; migration/upgrade controls; operator support and private diagnostics; tenant-safe audit/alerts.
6. **Honest recovery and exit:** whole-deployment clean-host restore and credential revalidation; supported tenant-specific recovery/export/exit semantics with real negative and cross-tenant tests; retention/cleanup disclosures.
7. **Excellent team experience:** accessible browser journeys, clear membership/credential/access mapping, safe local API/CLI reference, and useful nonsecret evidence-based analytics.
8. **Release and field evidence:** threat review, adversarial cross-tenant and auth tests, integrated backup/restore, workload economics, first team pilot and explicit stage-exit decision.

**A capability belongs in the candidate release only if its full safe lifecycle can be delivered.** The final Stage 2 functional specification will choose exact scopes and outcomes; this list is a mission-level envelope, not a hidden FR register.

### 7.2 High-payback stretch objectives, promoted only when justified

| Stretch objective | Why it could be powerful | Minimum evidence for promotion |
| --- | --- | --- |
| **One-screen authority-change impact preview** for memberships and known credentials | Makes access decisions intelligible and reduces manual handoffs | Current grants/roles/token status can be reconciled without false completeness; meaningful task improvement in observed trials |
| **Verified machine-credential sponsorship transfer** with guided consumer replacement | Completes the shared-responsibility story and prepares workload identity | No widening of backend token rights, no token re-reveal, no privilege gap or orphaned consumer; measurable need |
| **Tenant-scoped logical export and reconstruction** across supported deployment units | Lowers lock-in and accelerates tenant recovery/migration | Proven source/destination consistency, version/attribution rules and isolation from non-target tenants |
| **Support-grade diagnostic evidence package** with redacted, correlated operations | Reduces operator time during real incidents | Demonstrated reduction in time to identify safe next action without disclosing any sensitive fields |
| **Operator-guided, verified tenant placement or dedicated deployment** | Stronger isolation options for teams with distinct risk profiles | Measured cost/operability and repeatable provisioning, upgrade and recovery; not merely a diagram |

Do **not** interpret these as automatically additive requirements. One or two may deserve to become the Stage 2 signature after proof and budget review; the others remain future options. In particular, a visual graph, risk score or automatic “fix” should never be treated as authoritative unless its data provenance and enforced effect boundary are established.

### 7.3 Explicitly outside this stage by default

- Open public signup, unrestricted organization self-creation, payment collection, automated subscription lifecycle, billing, public marketplace and broad commercial service-level commitments.
- Enterprise SAML/OIDC SSO, SCIM, universal directories, arbitrary custom role/policy DSL or a full IAM replacement.
- Production agent delegation, prompt-governed authorization, autonomous secret changes, general MCP plaintext reveal tools, workload attestation federation or a hosted agent sandbox.
- Automatic rotation of arbitrary external provider credentials, generalized dynamic secrets across engines, or unlimited tenant-selective point-in-time recovery.
- High availability, multi-region active/active, global traffic management or geographical residency promises without proof; a one-host Stage 1 topology is not silently promoted to such a promise.
- General-purpose cross-application observability, security information/event management, or an independent workflow orchestration platform.
- Customer-held zero-knowledge keys, secrecy from the trusted service operator, guaranteed non-disclosure to code running in a credential-bearing process, or retroactive revocation of copied secret bytes.

**These omissions create room to become excellent at collaborative secrets operations rather than mediocre at the entire secrets/identity ecosystem.** The later stages described in Document 02 remain candidate directions, not automatic backlog commitments.

## 8. A technical direction without premature architectural lock-in

### 8.1 Preserve what Stage 1 proves

Continue using **OpenBao** as the primary value/version and token-validity authority, and **PostgreSQL** for product metadata, durable operations, bounded coordination, membership/grants and nonsecret audit if Stage 1 validates that arrangement. Preserve measured-safe Hono/Zod API contracts, the CLI, React workspace, local Scalar reference, Traefik/Compose/host controls, explicit operator utilities and externally held recovery gates when they demonstrably fit the hosted threat model.

**No technology is guaranteed a permanent place merely because it already appears in Stage 1.** The Stage 2 technical audit should compare native and product-provided invitation/organization features, isolation approaches and recovery strategies using implementation, verification, operations, maintenance and blast-radius cost. Do not add Redis, a second database, an agent framework, a new queue, a general event platform or an external identity provider without a concrete complete workflow that pays for them.

### 8.2 Design for future agents without prematurely shipping them

Stage 2 should quietly strengthen primitives that future autonomous users need:

- stable organization/resource/sponsor identity and explicit permission provenance;
- narrow time-bounded machine authority with reliable revocation and no backend bypass;
- queryable durable operation outcomes, `uncertain` states and read-only diagnostics;
- approval/delegation *metadata readiness*, not unreviewed autonomous authority;
- reliable data-minimized event export for external operations agents;
- human owner/administrator supervision screens focused on actionable exceptions.

This is an **agent-native substrate**, not an agent runtime or Stage 3 workload-identity integration. A later workload-identity adapter should be able to bind to a real tenant, a legitimate human/team sponsor, a policy, an executor and an attributable operation. Stage 2's engineering should avoid design decisions that make that eventual binding impossible, but must not implement speculative federation prematurely.

### 8.3 A pilot deployment may deliberately be unglamorous

A limited, carefully operated tenant cohort with a single tested region, a small supported role model and explicit maintenance windows is acceptable. **A small truthful service can be a stronger next evolutionary increment than a nominally scalable service with untested failure boundaries.** If the product promises availability or restore performance, those promises must be bounded by executed drills and actual hosting evidence, not assumed from provider marketing.

---
## 9. Stage 1 → Stage 2: evidence-driven entry decision

**There is no valid shortcut past Stage 1.** Stage 2's substantive design can begin only once Stage 1's declared complete product exists and the evidence needed to assess its assumptions is available. Early research and drafting are possible; this mission does not authorize production tenant onboarding, replacement of pending Stage 1 requirements, or diversion of security/recovery work into a future stage.

### 9.1 Required source evidence at the transition

| Evidence family | What Stage 1 must actually provide | Consequence for Stage 2 |
| --- | --- | --- |
| **Complete product release** | Release evidence for all 56 controlled-use ACs under the approved contract, applicable technical proofs and signed security review | An incomplete Stage 1 feature is not rebranded as a Stage 2 enhancement |
| **Field and agent validation** | Four post-release ACs, at least 28 days of genuine use after controlled real-consumer onboarding, bounded agent fixture evidence | Reveals whether teams or workload identity will produce the greater next payoff |
| **Architecture and security** | Actual Better Auth adapter/route behavior, OpenBao namespace/token/KMS effective privileges, fault tests for delayed backend effects and full read coherence | Determines whether shared tenant/auth boundaries can safely be extended |
| **Recovery and retention** | Executed clean-host restore, historical credential invalidation, PostgreSQL cluster-global reconstruction, KMS key/cert custody and real R2 lock aging/cleanup | Determines tenant isolation/recovery options and whether managed operation is commercially defensible |
| **Developer value** | Real CLI/API tasks, setup/rotation/revoke UX observations and comparison with an explicit baseline | Determines the collaboration workflows worth optimizing |
| **Operational and provider economics** | Hosting, backup, KMS, storage, alerts, latency, capacity, deployment/recovery time and hands-on operator labor | Determines cost per tenant and the viable deployment topology |
| **Governance and scope** | Reconciled P-01/P-02/P-03 authorities, AC-1.42 decision, actual Stage 1 completion manifest and postmortem | Prevents Stage 2 from inheriting unknown or contradictory source obligations |

**Document 07/08 are plans, not evidence of completion.** At document creation time, all major Stage 1 integrations and the 29 proof records remain unexecuted in the materials supplied. No value should be copied into a Stage 2 metric table as if it had already been observed.

### 9.2 The transition workshop: four defensible outcomes

1. **ADVANCE TO MYKEY TEAMS.** Stage 1 is safe and independently useful; human collaboration, managed-team demand and operator economics plausibly justify external tenancy; the new threat model can be supported. Approve a revised Stage 2 mission and commence the Stage 2 functional/technical audits.
2. **ADVANCE ON A DIFFERENT PRODUCT WEDGE.** Stage 1 is complete, but a private agent/workload product shows much higher comparative value or tenant-hosting cost is prohibitive. Draft a different complete Stage 2 mission, explicitly reconcile Document 02's stage sequence, and do not quietly mix arbitrary Stage 3 features into MyKey Teams.
3. **HARDEN / RE-SCOPE BEFORE EXPANSION.** Stage 1 operates, but auth, recovery, tenancy, support cost or developer friction needs corrective work before external users. Fund that as stabilization and rerun changed proofs; do not label fixing a Stage 1 defect as Stage 2 differentiated functionality.
4. **PIVOT / STOP.** The real tasks are simpler, safer or cheaper through direct OpenBao or deployment-native tools; the intended differentiation does not appear to pay for its maintenance burden. Preserve the useful functioning Stage 1 service if desired and record the evidence. No stage count is owed to the original roadmap.

The decision should identify which observations were engineering outcomes, single-user usability findings, pilot demand signals or still-unproven market assumptions. A 28-day single-owner field study is not a demonstration that customers will pay for a hosted team service.

## 10. Stage 2 hypotheses and scientific/economic validation

**Measurement rule:** pre-register the test protocol, comparison baseline, expected workload, exact product release, participant role, sample limitations, privacy rules and decision consequence **before** interpreting pilot outcomes. Compare *whole workflows*, including integration/setup, recovery, operator interventions and failures—not only the speed of an isolated API request.

| Hypothesis | Proposed observation or experiment | Evidence that would support it | Evidence that would change course |
| --- | --- | --- | --- |
| **T2-H01 — Collaboration value** | Team onboarding, first authorized edit, routine scoped access and handoff compared with direct OpenBao/deployment-native/manual baseline | Fewer manual credential exchanges and lower combined task effort with equal or better safety | Teams still use out-of-band sharing because MyKey's workflow is slower or too complex |
| **T2-H02 — Effective authority is understandable** | Ask owners to predict who can see/change one environment and which credentials remain after a proposed change; compare against verified backend state | Correct understanding with a small number of UI interactions and no misleading certainty | Permission explanations hide provenance or give false confidence |
| **T2-H03 — Offboarding is materially safer** | Exercise an authorized removal including concurrent access, outstanding invites, machine sponsors and uncertain revocation | All declared new-access denies verified; remaining machine authority explicitly inventoried and handled | Unknown/unrevoked authority is declared closed, or token management is too costly to operate |
| **T2-H04 — Cross-tenant isolation is credible** | Adversarial multi-tenant API, SQL, direct OpenBao, UI, telemetry, export, backup/restore and operator-role matrix | No unauthorized cross-tenant reads, writes or privilege escalation in the declared test space | Any successful escape or unbounded operator/API blast radius incompatible with the pilot risk |
| **T2-H05 — Recovery is operationally sustainable** | Host-loss clean restore and supported tenant repair/exit with a non-target tenant kept intact | Actual backed-up state/roles and current access restored safely, with truthful recovery granularity | Shared storage cannot meet stated tenant needs without prohibitive cost or data-risk |
| **T2-H06 — Hosted economics are acceptable** | Record fully loaded per-tenant infrastructure, KMS, storage, review, on-call/support and incident labor during genuine use | A plausible steady-state cost structure for the selected controlled cohort | Operator work or dedicated-tenant costs erase product advantage |
| **T2-H07 — DX reduces mistakes and toil** | Time-to-first-use, successful first rotation, UI task comprehension, CLI setup, support questions and incident interpretation | Measured fewer avoidable errors/handoffs and actionable diagnoses | More complexity than alternatives; frequent manual operator remediation |
| **T2-H08 — Existing stack remains maintainable** | Upgrade/test Better Auth routes, OpenBao namespace/policies, SQL roles, CLI compatibility, key rotation and restores with multi-user state | Versioned reproducible tests and bounded upgrade/recovery effort | A dependency or plugin creates repeated unsafe adapter workarounds or unbounded change cost |
| **T2-H09 — Agent-native foundations retain option value** | Inspect whether sponsor, scope, operation and effective authority records can support one future bounded workload binding without credential-bearing agent tools | A narrow, feasible future integration contract and minimal irreversible legacy | New team architecture blocks future workload isolation or requires privileged API bypass |

### 10.1 Proposed Stage 2 field evidence

A suitable candidate post-release study would include **at least two independent invited organizations with two or more distinct active human members each**, at least one real noncritical consumer workflow per organization, and **a proposed four-week period of observed team operation** after authorization to handle real pilot credentials. These are **proposed study-design minimums**, subject to customer recruitment, risk review and later signed acceptance criteria—not factual adoption numbers or a commitment already made.

Capture, with minimization and explicit consent where necessary:

- number and completion/failure of invitations, MFA enrollment, and first successful scoped use;
- time and human actions from invitation to useful team task;
- number of out-of-band credential handoffs that remain necessary;
- role/grant errors, cross-tenant denial tests and attempted bypass classes;
- token issuance, sponsor transfer/revocation, uncertain states, replacement and verified effective denial;
- support interventions, operator minutes, incidents, user confusion and unresolved access questions;
- backup eligibility, clean-host restore time, storage growth, KMS requests and provider costs;
- task-completion and comprehension observations against the explicitly chosen baseline;
- negative results, failures, manual workarounds and changes required to the release assumptions.

Do not log plaintext, tokens, MFA seeds/codes, invitations containing bearer secrets, arbitrary prompts or raw HTTP bodies to obtain these metrics. Clearly mark samples too small for statistical inference. Do not infer absence of compromise from an absence of observed incidents.

### 10.2 Measurable decision criteria — without invented success rates

Some results are **non-negotiable binary release conditions**: denied cross-tenant access, actual protected auth, no bearer persistence, correct revocation semantics, accurate audit, recoverability and supportable operations. One demonstrated critical cross-tenant privilege escape is a release blocker regardless of usability improvements.

Other results are **product-economics decisions**, not security waivers. Before starting the pilot, set *numerical* improvement and cost thresholds based on the recorded Stage 1 and direct-tool baselines: onboarding effort, support minutes per active tenant, offboarding time/interventions, successful task completion, operator on-call burden, and cost per active tenant. Their thresholds are intentionally **TBD until a baseline exists**; publishing arbitrary percentages now would turn aspiration into false precision. Favor outcomes that improve several dimensions together: reduced risk, effort, ambiguity and cost, without unacceptable loss of usability or supported security.

## 11. Release and completion gates for the next complete product

Stage 2 retains the project's two distinct acceptance moments, with **new** Stage 2 identifiers to be assigned only by its later functional specification. Stage 1's FR/AC/PO identifiers must not be reused as though they define Stage 2 requirements.

### 11.1 Proposed T-R — Controlled invited-team release gate

**Before any real external tenant secrets are accepted**, the exact staged build and deployment must demonstrate:

1. Completed Stage 1 compatibility/regression suite for all inherited supported workflows, or individually approved safe migrations with tests and disclosure.
2. A frozen and reviewed tenant topology, threat model, customer/operator responsibility matrix and corresponding direct backend/API/DB test results.
3. Complete invitation, enrollment, membership, scoped-grant, role-change, owner-continuity and removal flows, including native-auth route enumeration and adversarial tests.
4. Genuine machine-token sponsor/offboarding handling in the declared supported cases, including old-session denial and unknown backend effects.
5. A tenant-safe operator lifecycle, measurable quotas, support/incident controls and safe error/status behavior.
6. Complete recoverable PostgreSQL/OpenBao state, KMS/certificate dependency custody, off-host backup/retention verification, clean-host quarantine/credential rotation and *tested* tenant-level remediation/export within the advertised limits.
7. Browser, CLI, API, local Scalar, accessibility, CSP/CSRF, leak canaries, logs/audit/analytics isolation and responsive core workflows.
8. Explicit service limitations, privacy/data-processing terms, retention/deletion policy, incident response, support channel, operator runbooks and external-user enrollment approval.
9. Independent security review with preserved positive, negative, concurrency, interruption, restore and cross-tenant evidence bound to exact release sources, packages, database schema, backend policy/configuration and build/image digests.
10. Signed authorization for a **bounded** real-tenant pilot only after the synthetic/hostile-tenant release evidence passes. No blocked or `unknown` required outcome is represented as completed.

This gate permits a real limited-service cohort only for the risks and tenant limits actually approved. It is **not** a claim of general commercial availability, enterprise certification, universal high availability or a public SLA.

### 11.2 Proposed T-F — Stage 2 completion and evolution gate

A complete, operable MyKey Teams service exists at T-R. **T-F additionally requires actual invited-team use**, the agreed field observation period, a completed tenant onboarding/offboarding cycle, recorded intervention/cost/recovery evidence, verified regression after material fixes, and a signed independent conclusion about user value and next direction. If the observations are disappointing, Stage 2 can still be a successfully completed engineering product but an unsuccessful market hypothesis. If a declared core workflow is broken or the recovery/isolation contract is false, the stage is **not** complete regardless of commercial enthusiasm.

**No-work-in-progress test:** if all future stages are canceled, invited teams can continue to onboard members, manage and consume secrets, coordinate ownership, remove access, obtain support, recover within the stated boundaries and leave the service. They do not need future agent federation, automatic rotation, a broader IAM policy engine or billing to finish their core workflows.

## 12. Scope and engineering discipline: ambitious outcome, hard accounting

### 12.1 The budget is a decision variable, not an excuse

Document 02 supplies a **nominal ~400 engineering-hour Stage 2 target** with an illustrative 50-hour internal reserve. It is a useful forcing function, but it is **not** a validated bottom-up estimate. The Stage 1 candidate itself now costs roughly 903 active engineering hours in its pre-implementation roadmap, so this mission must not present a similarly broad hosted service as a proven 400-hour project.

Before Stage 2 implementation approval, prepare a workload decomposition derived from executed Stage 1 productivity and real proofs. Include isolation/provisioning, complete auth and membership paths, frontend/CLI/API changes, data and backup migration, multi-tenant restore, legal/operational duties, supply chain, adversarial negative cases, independent review, field-study effort and failure reserves. Distinguish active labor, provider cost and elapsed calendar time. Do **not** arbitrarily slice work into forty ten-hour sessions or hide needed proofs in “later hardening.”

**If the whole candidate is too large:** first narrow customer segment, deployment model, number of supported role/grant patterns, integration types, or other **entire** capability families; then re-estimate. Alternatively approve a justified budget increase. Do not keep tenant-specific recovery in marketing while removing the restore test; do not ship membership management without revocation; do not trade away MFA, access isolation, audit, quarantine or credential safety to hit 400 hours.

### 12.2 Risk-first ordering, without choosing session count

The eventual implementation sequence should follow **evidence dependencies**, broadly:

1. **Reconcile actual Stage 1 outcomes and target-user evidence.** Approve the precise hosted trust model, product promise, budget and customer pilot responsibilities.
2. **Falsify topology, privileged identities and protected multiuser authentication early.** Prove a real second human and second tenant under exact pinned components before building broad team UI.
3. **Prove complete invite → grant → use → revoke transitions** with machine-sponsored side effects on a thin vertical; verify concurrency and unknown effects.
4. **Prove backup/recovery/tenant exit and operator economics** under the chosen topology early enough to change it before adoption; commence any real-clock retention fixture immediately when needed.
5. **Finish the team product** across APIs, CLI compatibility, UI, explainers, audit, documentation, support and incident paths, with each coherent session independently verified.
6. **Run independent whole-system release testing**, admit external teams only after T-R, then collect field observations and decide T-F.

Actual session count and hours must follow these workloads, not precede them.

### 12.3 Scope valves with real consequences

| If the evidence says... | Prefer this coherent response | Do not do this |
| --- | --- | --- |
| Shared infrastructure has unacceptable tenant compromise radius | Reduce cohort or choose dedicated tenant deployment with tested operator cost | Describe a namespace as physical isolation or ignore operator/root rights |
| Full logical tenant point-in-time rollback is too risky | Commit to verified per-secret version recovery, protected tenant export and whole-deployment DR with plain disclosures | Promise selective Raft rollback without tests |
| Role design grows faster than user needs | Freeze a small explicit role/action matrix and remove entire advanced-role features | Leave unrestricted plugin endpoints or inconsistent privilege checks |
| Credential sponsorship transfer is unsafe | Implement explicit revoke-and-reissue under a surviving owner and an honest manual consumer handoff | Mark machine access transferred solely by editing SQL metadata |
| Human team pilot value is weak and agent fixture value is strong | Draft a new Stage 2 private workload mission and update the stage plan | Smuggle general agent delegation into an uncosted Teams stage |
| Operator time or hosting cost exceeds value | Simplify the product/deployment or stop hosted expansion | Assume more tenants will automatically solve negative unit economics |

## 13. Decision register to close after Stage 1 evidence

| Decision | Default candidate (not approved) | Must be answered by |
| --- | --- | --- |
| **D2-01 — Next product wedge** | MyKey Teams, with assured authority transitions | Stage 1 comparative DX, agent fixture, operator costs and actual demand signals |
| **D2-02 — Managed tenant topology** | Choose between shared namespaces and more isolated units by measured risk/cost | Adversarial OpenBao/DB/auth tests, backups, KMS, privileges and capacity measurements |
| **D2-03 — Invitation/auth integration** | Reuse verified Better Auth primitives where genuinely compatible | Full route inventory, protected factor/session paths, invite-only negative tests and upgrade cost |
| **D2-04 — Role/grant model** | Minimal fixed roles and explicit project/environment grants | Actual team workflow mapping, least-privilege proof and usability testing |
| **D2-05 — Machine sponsor semantics** | Explicit team/individual accountability; verified revoke/reissue | Token inventory and offboarding races, operator and consumer effort |
| **D2-06 — Tenant recovery promise** | Whole-service DR + tested tenant version recovery/export; logical restore only if proved | Actual Raft/SQL topology and cross-tenant restore experiment |
| **D2-07 — Tenant exit/retention** | Secure current-value/metadata export plus disclosed locked-backup retention | Pilot user expectations, exact storage lifecycle permissions and legal review |
| **D2-08 — Release service tier** | One region, controlled invitation cohort and stated maintenance/support limits | Measured availability/restore, operational labor, provider contracts and safe capacity |
| **D2-09 — Signature UX** | Effective-access explanation and guided offboarding | User comprehension, truthfulness, implementation cost and adoption impact |
| **D2-10 — Engineering authorization** | Use the ~400-hour target as a pressure test, not a cap | Bottom-up estimates, Stage 1 actuals, mandatory security/review scope and approved budget |
| **D2-11 — Pilot obligations** | Two independent organizations, more than one human each, observed team tasks | Security/legal readiness, participant consent, declared support and test design |
| **D2-12 — Stage 3 runway** | Preserve sponsor/scope/operation contracts without new autonomous powers | Actual demand for workload identity and trusted delivery, not speculative feature enthusiasm |

Each decision record should identify its source evidence, falsifying test, rejected alternative, residual security risk, impact on the mission and what would trigger reconsideration. **No table cell above is implementation approval.**

## 14. What Stage 2 should make possible next — without needing it to finish

A successful Teams release creates much more than more users. It creates a trusted answer to **who is responsible for credential authority and how it changes over time**. That is an especially useful foundation for the later stages in Document 02:

- **Toward MyKey Workloads:** one verified workload identity, under an actual team sponsor and an explicit tenant/scope, can replace a copied long-lived token for a real executor. Stage 2 supplies truthful scope, sponsorship and operation evidence, **not** an identity-federation claim.
- **Toward MyKey Autonomy:** future agent proposals can be compared against known human/team authority and risk-sensitive policies, with exceptional human review rather than constant approval prompts. Stage 2 itself does not accept model output as authorization.
- **Toward MyKey Lifecycle:** rotation and revocation can eventually act on a proven map of team-owned consumers and accountability. The current stage must not claim to rotate arbitrary external credentials.
- **Toward broader MyKey SaaS:** managed tenant provisioning, support cost, isolation and exit evidence will inform whether public onboarding, billing and commercial support are economically sensible. The future SaaS is not just a credit-card form on the Stage 2 service.

**The strategic win is compounding correctness:** every completed stage should make the next high-value workflow easier and safer, rather than accumulating undocumented shortcuts that later agents must somehow work around.

## 15. Governance, provenance and document lifecycle

### 15.1 Normative status and reconciliation

- **Document 01 v0.2** supplies the enduring agent-native secrets, policy, delivery, DX, recovery and truthfulness direction.
- **Document 02 v0.3, especially §5 Stage 2**, supplies the default MyKey Teams stage hypothesis and the rule that each stage is a fully operable product. This Document 09 sharpens its value thesis; it does **not** independently approve a different stage allocation.
- **Documents 03–06 v0.3** define the candidate Stage 1 mission, 102 FR/60 AC contract, native-capability audit and technical design. Their unresolved proof and governance gates remain unchanged.
- **Documents 07–08 v0.3** provide the provisional 47-session, 903-hour Stage 1 workload/runbooks and the two acceptance moments. They are not evidence of live release.
- **P-01/P-02/P-03** originals were not among the documents supplied for the audited series and must be reconciled under Stage 1 S01. This document does not reconstruct their missing text.
- The **Stage 1 production evidence and transition decision**, once available, must be reviewed before this mission is promoted from aspiration to a governing Stage 2 brief.

**If Stage 1 uncovers an architectural incompatibility, cost problem or changed market wedge, edit this document openly.** Do not keep the original wording for consistency at the cost of a failed product. Document explicit changed assumptions and discard unearned promises.

### 15.2 Next Stage 2 documents if this mission is selected

The next documents should be drafted **after the Stage 1 transition** and can follow the now-proven progression without assuming their content in advance:

1. **Stage 2 Functional Specification:** narrow roles, invite/account lifecycle, exact tenant and machine-sponsor semantics, recovery/exit contract, quotas, UI and API, release/field acceptance with new Stage 2 IDs.
2. **Stage 2 Technical Capability and Integration Audit:** native-first, current pinned Better Auth/OpenBao/PostgreSQL/R2/Traefik/CLI fit-gap, threat model, deployment-topology alternatives, FR-by-FR proof ownership and total cost.
3. **Stage 2 Technical Specification:** selected enforcement boundaries, transactions/unknown effects, token/revocation behavior, infrastructure, recovery and release-safe migrations.
4. **Stage 2 Pre-Roadmap:** bottom-up coherent work packages, critical proofs, engineering low/expected/high estimates, calendar/provider cost, prerequisite graph and explicit budget decision.
5. **Stage 2 Session Runbooks:** precise entry prerequisites, full TODOs, test/fault evidence, checkpoints, verified exits and dependency-accurate handoffs.

This is an illustrative future documentation flow, **not** an amendment to the existing canonical Documents 01–09 or a commitment to produce/approve more documents today.

### 15.3 External technical references and their limits

The following public references were consulted on **7 November 2026** as *feasibility context*, not as proof that the eventual Stage 2 implementation works or that an external provider satisfies this mission:

- [OpenBao 2.7 namespaces](https://openbao.org/docs/concepts/namespaces/): supports scoped namespaces, identities and policies; actual cross-tenant containment and root/operator authority remain deployment-dependent.
- [OpenBao integrated storage](https://openbao.org/docs/concepts/integrated-storage/) and [storage/backup guidance](https://openbao.org/docs/concepts/storage/): relevant to topology and cluster-level backup/restore; not proof of selective tenant rollback.
- [Better Auth organization plugin](https://better-auth.com/docs/plugins/organization): documented organization, membership, invitation and role functionality; **not** proof that it is compatible with Stage 1's protected sessions, restricted native route set and verifier-only recovery semantics.
- [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) and [object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/): candidate retention/cleanup features; actual provider-clock aging, privileged rule changes and per-object delete failures must be tested.

No provider price, supported target runtime, legal compliance status, customer demand or quantitative performance claim is certified by this mission. Future architecture work must rerun current release-tag/provider checks and observe real deployments.

---

## 16. Mission acceptance test — the one-paragraph story

**MyKey Teams succeeds if** two genuinely independent small teams can enter a controlled managed service, invite and authenticate real people, perform legitimate scoped development work through an excellent UI/API/CLI, understand who has authority and why, offboard a person while proving what machine access remains, survive a tested infrastructure-loss recovery without resurrecting stale power or exposing another organization, and export/leave through a disclosed, verified procedure—with less friction and no greater unacknowledged security burden than their realistic alternatives. The operator can support those teams at measured, sustainable cost. The whole product is complete and independently useful even if the later workload-identity, autonomy and commercial SaaS stages never occur.

**The ambition is not more roles, screens or integrations. It is to make shared credential authority substantially easier to operate, harder to misunderstand, and possible to verify.** That is the proposed organic bridge from MyKey Private to a genuinely agent-native, trustworthy service.
