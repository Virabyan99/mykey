# Document 03 — MyKey Stage 1 Mission Brief

**Working product name:** `mykey` (placeholder)  
**Stage/product shape:** Stage 1 — **MyKey Private**  
**Version:** 0.3 — final pre-implementation audit; revises v0.2 for downstream drafting  
**Date:** 7 November 2026  
**Target implementation start:** week beginning 9 November 2026 (feasibility and permitted preparation first; not a release date)  
**Stage planning envelope:** approximately 400 engineering hours; provisional and subject to bottom-up reconciliation  
**Strategic parents:** Document 01, *MyKey Project Northstar* v0.2 audited; Document 02, *Project Stage Breakdown* v0.3 pre-implementation audited  
**Existing Stage 1 source basis:** uploaded `1-01` Mission Brief v2.1, `1-02` Functional Specification v2.1, `1-03` Technical Audit v2.0, `1-04` Technical Specification v2.1  
**Next document:** Document 04 — Stage 1 Functional Specification  
**Status:** **Audit-revised and suitable to govern drafting of Documents 04–08, subject to explicit project approval. Not implementation-authorized.** It defines a coherent candidate Stage 1 product but neither closes technical proofs, approves package versions, certifies a 400-hour estimate, nor silently supersedes existing requirements or the unavailable P-01/P-02/P-03 records. Approved downstream specifications, governing-record reconciliation, and prerequisite proof results are required before dependent feature implementation.

> **Stage 1 mission:** Deliver a small but complete and independently useful OpenBao-centered secrets service for one real operator and their applications. The operator can manage application secrets through an excellent developer interface, grant and revoke bounded machine access, launch a real supported application without a routine plaintext dotenv file, understand failures, and recover the service from off-host material. Use this working product to test consequential security, architecture, developer-experience, operating-cost, and agent-readiness hypotheses before designing the eventual SaaS.

> **Non-negotiable definition of done:** Stage 1 is not a proof-of-concept, partially wired UI, future SaaS skeleton, collection of isolated feasibility spikes, or a beta whose missing security mechanisms will arrive in Stage 2. Every **included** capability works end to end, including setup, authorized use, denial, interruption, revocation or lifecycle transitions, diagnostics, verification, and recovery. A failed hypothesis can be a successful experiment; an unimplemented promised workflow cannot be called a complete stage.

---

## 1. Purpose and product promise

### 1.1 The smallest product worth operating

The problem is practical: a developer needs to maintain different application secrets for different environments, avoid scattering plaintext configuration files, let software access only the secrets it needs, see what changed, and regain control after a credential leak or infrastructure failure. Current alternatives can solve parts of this problem; MyKey must demonstrate meaningful incremental value beyond managing raw OpenBao commands or conventional local dotenv files.

At Stage 1 exit, one operator can reasonably choose to keep using MyKey Private **even if every later stage is cancelled**. They can run it, maintain it, diagnose it, back it up, recover it, and use it for a declared set of real, non-critical applications. Its limitations are documented, not hidden behind a future-stage roadmap.

The service is intended to be **production-usable within its deliberately narrow scope**, not enterprise-ready or commercially generally available. It must be safe enough to entrust with supported real, non-critical application secrets *after* the security and recovery gate passes. It need not support arbitrary customers, infrastructure topologies, agents, or third-party workloads. **Complete** means every declared workflow and its required safety/operational boundary works without Stage 2; it does **not** mean every conceivable secret type, team workflow, or commercial obligation is included.

### 1.2 Three outcomes, none of which substitutes for another

1. **Delivered utility:** a complete, self-operated application secrets service whose promised workflows work under realistic failure and recovery conditions.
2. **Exceptional developer experience:** coherent UI, API, CLI, documentation, meaningful status and product-local visualizations that improve understanding rather than decorate it.
3. **Decision-quality evidence:** reproducible measurements of the selected architecture, controls, usability and operating burden, including negative findings, so later SaaS decisions are based on observation rather than attachment to today's design.

A beautiful interface cannot compensate for inaccurate authorization or failed recovery. Conversely, reliable security plumbing with an unusable CLI, incomplete owner workflows, or misleading diagnostics does not satisfy the product promise.

### 1.3 Two distinct gates

- **Controlled-use release gate:** before onboarding real secrets, demonstrate the approved complete product and all applicable security, denial, fault, audit, and clean-host recovery scenarios with synthetic data. Only after approval may a real, non-critical application be connected.
- **Stage-completion gate:** after release, operate the completed service for **at least four weeks** under the source baseline, collect prescribed evidence, address critical defects, conduct a staging restore drill, and record a decision to advance, harden/re-scope, pivot, or stop. Field use is evidence gathering on a working product, **not a period in which unfinished promised features are completed**.

The source requirement is **daily use for at least four weeks**, beginning only after controlled-use authorization and the first real non-critical consumer. Record a minimum 28-day observation window and daily-use evidence; a paused or unusable service cannot be credited as four weeks of successful operation without qualification and remediation. Four weeks is elapsed observation time, not automatically 160 engineering hours. All engineering work actually performed during observation and correction counts toward Stage 1 effort.

## 2. Users, supported environment and trust boundary

### 2.1 Supported real users

- **One owner/developer:** the only ordinary real human account in daily Stage 1 use. This person manages projects, environments, secrets, machine credentials and activity through the web UI and supported operator procedures.
- **A separate infrastructure operator role:** on the validation deployment, it may be exercised by the same person but is technically **distinct** from the owner's web authority. Bootstrap, high-privilege provisioning, recovery, and host maintenance are not public web/API abilities.
- **Scoped machine consumers:** a protected CLI/executor process that presents the environment-bound machine credential, and a designated real non-critical application that receives resolved application values at launch. **The launched child need not—and should not by default—inherit the MyKey retrieval credential.**
- **Synthetic security fixtures:** at least two organizations and representative owner/admin, editor, reader, ungranted-member and machine principals for authorization and namespace-isolation testing. These fixtures **do not** amount to real multi-user product support.
- **A bounded external agent/test fixture:** an agent may request a preauthorized test execution through a trusted executor; the agent is not a privileged secrets administrator and the experiment does not introduce a general agent runtime into MyKey.

### 2.2 Supported environment

The selected Stage 1 deployment baseline is **self-managed production on an OVHcloud host and a separate staging host using the same release configuration and component versions**, while maintaining separate credentials, KMS/storage identities and synthetic staging data. OpenBao is the secrets engine; PostgreSQL stores authorization/coordination data. **OVHcloud KMS and Cloudflare R2 are baseline providers**, not optional conveniences; OpenBao’s **built-in KMIP seal with an externally provisioned OVHcloud KMS key and mTLS client certificate** is the current auto-unseal candidate. OpenBao 2.7.x and OVHcloud document that integration, but source documentation is **not an executed proof** of this deployment, its restart behavior, key custody, or recovery. The proposed Restic/R2 backup mechanism likewise remains **conditional on paired restore, retention and repository-maintenance proofs**. The distinct OpenBao OVHcloud REST KMS seal plugin is not an automatically approved substitute. Any provider or mechanism substitution requires explicit governing change control. The existing audited Stage 1 technical documents select TypeScript/Hono, Better Auth/Drizzle, React, Docker Compose/Traefik and related components conditionally on executable integration proofs. These selections are candidates and constraints for Documents 05–06, not proof that the assembled product works.

The existing CLI source contract targets Linux glibc x64/arm64 and macOS x64/arm64, permits a tested Node-based packaging fallback, and excludes native Windows. Any change to that supported-platform contract must be an **explicit approved scope decision** with updated acceptance coverage, not an undocumented missing build.

### 2.3 Honest trust model

The owner, relevant application processes, service application runtime, infrastructure host, and infrastructure operator are trusted within their declared roles. Authorized owners/admins can access plaintext values; this is **not zero-knowledge**. The platform offers logical organization isolation and policy controls, not immunity to host compromise, malicious administrators, or arbitrary code running in a credential-bearing process. A process environment, copied clipboard contents, explicit plaintext export, and secrets already delivered to a process cannot be recalled by MyKey. Revocation prevents subsequent authorized retrieval, not retrospective erasure.

**Agent-execution limitation:** if untrusted agent-controlled code can execute inside the same process/security context that contains an application secret, that code may read or exfiltrate the secret. No Stage 1 interface may claim otherwise. The validated agent path relies on a separately trusted executor and deliberately bounded fixture; future stronger execution isolation is a separate engineering undertaking. The fixture accepts only an allowlisted, predetermined test action and non-secret parameters, not an agent-supplied arbitrary command or code executed alongside fetched credentials.

## 3. Complete Stage 1 journeys

These journeys define the product's **outcome**, not the exact API or screen layout. Document 04 must specify observable behavior, error contracts, negative paths and acceptance tests for each.

### Journey A — First use and ordinary secret management

1. The operator uses a documented, private bootstrap procedure to establish the owner and organization; public sign-up and public privileged provisioning are unavailable.
2. The owner signs in with password and completes mandatory MFA. Enrollment, recovery, sessions and fresh factor verification behave according to the approved protected-authentication contract.
3. The owner creates a project and a usable environment, or sees a truthful pending/review state while backend provisioning is incomplete.
4. The owner enters or imports secrets through a documented accepted format and sees preview, per-key outcomes and safe error information without secret leakage.
5. The owner lists names, deliberately reveals or copies individual values, edits values with stale-write detection, reviews retained history, and performs the approved lifecycle operations. No conflicting write silently wins.
6. The interface gives useful context: the project/environment, its readiness, secret counts and changes, relevant access/operation status, and what an actionable failure means.

**Negative case:** invalid input, missing permission, backend uncertainty or another writer must produce a truthful failure or unresolved state. The UI cannot hide the problem with optimistic success or silently substitute stale values.

### Journey B — Machine access and real application launch

1. An authorized owner performs any required fresh TOTP verification and issues a **read-only credential bound to one active environment**, with explicit expiry and one-time protected token delivery.
2. The operator follows a tested setup procedure that places the token in a protected host/process configuration path rather than repositories, images, command arguments, history or application dotenv files.
3. The CLI validates the HTTPS peer, authenticates the machine, requests the complete current secret set, validates delivery, and launches the supported application with values in its process environment **without invoking a shell**.
4. If any required secret, audit, transport or backend precondition fails, the CLI **does not launch the child process** and presents an actionable, non-secret diagnostic.
5. The owner can inspect the credential's scope, status and effective expiry, then revoke it and demonstrate that **subsequent retrieval requests are denied**. Replacement after rotation or restore is documented and tested.

This is a meaningful solution for real development/deployment workflows; it does not promise zero persistent credentials. **MyKey's bootstrap machine credential remains a protected credential** even if application dotenv files are avoided.

### Journey C — Incident, interruption and recovery

1. A write, token issuance, archive or other backend-affecting action may be interrupted at any boundary. The service retains an attributable, non-secret record and reports **uncertain** outcomes truthfully.
2. An operator can diagnose and reconcile unresolved effects without blind mutation replay or letting an old delayed backend request escape into later work.
3. The operator can identify an expiring or revoked credential and relevant service/backup condition through the supported UI/diagnostics and alerts.
4. After host loss, the operator reconstructs a complete eligible **OpenBao/PostgreSQL** pair on a clean host using documented off-host dependencies. The restored service starts **closed/quarantined** under a control not supplied solely by restored data.
5. Restored machine and human access is invalidated; service authority and current owner authorization are re-established through a private operator procedure; historical credentials do not silently become usable.
6. The operator verifies identity, namespace isolation, secret completeness, audit and health, then explicitly reopens. The original credentials fail before and after reopening; new supported credentials can be issued deliberately.

A backup existing on R2 is not evidence that it can be restored. The actual paired-capture, retention, KMS/key-custody, object-lock maintenance, and clean-host recovery behavior must be proven.

### Journey D — Bounded agent-initiated use

1. A coding/deployment agent operating **outside MyKey** requests a predetermined synthetic test action through a separately controlled trusted executor. The request cannot select arbitrary executables, command arguments, environment scope, OpenBao paths or secret names outside the preapproved fixture.
2. The executor applies a **preapproved scope** and has access to a machine credential through protected configuration not placed into the model prompt or tool transcript. The agent does not receive an administrative MyKey token.
3. The executor invokes the supported CLI to run a deterministic, allowlisted synthetic integration-test application. The agent receives status, safe operation identifiers and redacted diagnostics—not secret values or the MyKey credential. It has no ability to run arbitrary code in the credential-bearing execution context.
4. The evaluator deliberately tests an unauthorized-scope request, token revocation, failed resolution and transcript/log inspection. Each is refused or handled exactly as documented.
5. The experiment records the setup burden, user intervention, diagnostic clarity, leakage checks and the limitations of the trusted-executor assumption.

This is **a validation fixture using existing Stage 1 machine capabilities**, not a shipped agent orchestration service, general-purpose sandbox, workload-identity federation, autonomous machine-token issuer, MCP server or delegation protocol. The **harness may be simplified**, but an actual end-to-end, agent-initiated, authorized request and separately verified denial/leakage cases remain required for the Stage 1 evidence gate under Document 02. Removing the experiment itself requires a formal amendment to Documents 02–03 and the evidence register; it cannot be treated as an informal budget saving. An unsuccessful test is a valid negative finding; an unexecuted test is not a positive result.

## 4. Product capabilities and scope boundary

The table describes the **candidate Stage 1 complete product**, anchored in the existing audited `1-01`/`1-02` baseline. It does not delete any of their requirements. Document 04 must reconcile every retained, revised or removed obligation by identifier before the new contract is approved.

| Capability | Stage 1 product commitment | Completion boundary |
| --- | --- | --- |
| Owner authentication | Private bootstrap; password and mandatory MFA; protected sessions; operator-mediated password/MFA recovery; fresh verification for sensitive effects | No bypass through native auth routes, expired/replayed challenges or restored state |
| Authorization/isolation | One real organization; immutable scope identifiers; direct server-side membership/grant checks; synthetic cross-tenant matrix | No real invitations, membership/grant administration or public organization lifecycle |
| Projects/environments | Create/rename, readiness, archive and reactivate as required by the inherited baseline **unless each affected obligation is formally amended** | No pretend-active environment; archiving must first stop new machine access, reconcile pending issuance, revoke affected credentials and verify backend denial; reactivation never restores revoked authority |
| Secret lifecycle | Safe name/value handling, create/read/update, version history, explicit reveal, concurrency protection, and retained delete/undelete/restore semantics | No silent overwrite, ambiguous effect-as-failure, unsupported permanent destruction or unaudited plaintext persistence |
| Import/export | One explicit dotenv contract, preview and safe partial outcomes/retry rules; deliberate plaintext export with warnings | No claim to handle all `.env` dialects or preserve secrecy after export |
| Machine credentials | One-environment read-only credentials; one-time issuance display, inventory, actual expiry, tested revocation/replacement | No implicit regeneration of a lost issuance response; no broader access inherited from a human session |
| CLI | Supported `keys`, `run`, and `export` behavior, complete-set validation, safe process launch/file creation, clear errors, tested distribution | No persistent cache of application values; outage means unavailable new starts, not cached fallback |
| API and reference | Versioned API for all supported workflows; precisely bounded separate auth/machine routes; local, protected Scalar reference | No raw OpenBao admin interface and no unverified “type-safe” claim without runtime validation |
| Owner experience | Complete responsive task flows, contextual status, safe copy/reveal, understandable errors, accessibility essentials | No backend-only feature with an unfinished or misleading owner workflow |
| Product-local intelligence | Accurate inventory/readiness, credential status/expiry, bounded operation/activity timeline, and operator-appropriate service/backup freshness and alerts; optional trend charts only when supported by safe measured data | No invented health, precision or audit completeness; no secret-bearing analytics, metadata exposure across authorization boundaries, or cross-agent observability platform |
| Operational safety | Off-host alerting, audit integrity, deployment/update procedures, encrypted consistent backups, clean-host quarantine recovery | No “backup verified” without restore evidence; no unseen operator dependency |
| Agent-ready validation | Narrow reproducible external executor test on preauthorized machine capabilities | No general workload identity, delegation, policy-autonomy runtime or agent context secrecy guarantee |

### 4.1 Explicitly absent from this product

Public signup; billing or payment; real multi-user invitations, grants administration and offboarding UI; hosted multi-customer operations; contractual availability SLA; generalized organizational suspension/offboarding; HA or zero-downtime failover; broad SDK portfolio; dynamic/database/cloud secrets; auto-rotation of third-party credentials; multi-provider workload identity; generalized agent delegation or arbitrary tool access; general agent runner/agent orchestration; comprehensive cross-project operations/observability center; full self-service KMS administration; promise of universal Windows or dotenv compatibility.

The presence of an attractive screen, aspirational API schema or conceptual Northstar capability must **never** imply one of these is already available. Future-stage functionality may only become an active Stage 1 feature through an approved scope change with full lifecycle, testing and effort reconciliation.

### 4.2 Scope-reduction candidates are **not approved cuts**

If the full inherited baseline is demonstrably infeasible near the target budget, evaluate **whole, user-understandable capability slices** rather than removing checks from security-critical behavior. Candidate decisions include narrowing optional convenience functions, supported distribution breadth with a tested replacement contract, or removing an entire lifecycle workflow **only if the remaining product has an honest complete user journey and the governing security baseline explicitly permits the change**. The preexisting archive/reactivation, history, and import/export workflows remain **included** until a signed identifier-by-identifier scope amendment removes them; prose such as “where retained” is not approval to omit them. In particular, archive cannot become a button that sets a database flag while leaving live machine tokens: either provide the complete verified archive behavior or formally exclude the archive feature and every corresponding route/claim.

Do **not** simplify by permitting plaintext bearer storage, eliminating necessary MFA, removing authorization checks, permitting partial machine resolution, relaxing crash/replay truthfulness, silently reducing audit requirements, omitting clean-host recovery, or introducing an unsafe cache. Those are not legitimate schedule levers. The current `1-02` source explicitly makes all 88 FRs and all 44 ACs mandatory; a shorter approved contract requires named, reviewed revisions and corresponding changes in the audit/proof register.

## 5. Security, correctness and truthfulness — release-critical invariants

The following principles are acceptance constraints for whatever features the final approved Stage 1 scope includes. The existing eight `M-01`–`M-08` requirements remain a source-of-truth baseline until reconciled; this section explains their intended product consequences rather than assigning new identifiers.

1. **Defined authority and no false zero-knowledge claim.** Declare which humans, hosts, processes and operators can see plaintext, and which cannot. Do not advertise isolation that is only application routing when the backend identity still has broader authority.
2. **Separated persistence authority.** OpenBao owns application values/versions; PostgreSQL owns product metadata, authorization and coordination. Explicitly permitted protected authentication records are not treated as application values. No plaintext passwords, recovery codes or machine tokens are stored in application tables.
3. **Least privilege enforced at the backend.** Public processes have no global administrative OpenBao authority. Different runtime, issuer, provisioner, operator and backup functions are scoped and tested against real backend permissions, including a second synthetic organization.
4. **MFA and recoverability without bypass.** Password-only or enrollment-incomplete state grants no product access. Native authentication routes, replayed factors, reset links, session renewal and restored credentials cannot bypass the explicit policy. A blocked recovery stays blocked until appropriately completed.
5. **Fail-closed authorization and state precedence.** New requests after committed revocation or restrictive state transitions are refused. Missing, uncertain or inconsistent scope states deny access. Previously delivered values cannot be rescinded; in-flight effects receive defined treatment.
6. **No prohibited secret persistence.** Secrets, issued tokens, reset links, TOTP/recovery codes and credential-bearing responses do not enter request logs, analytics, traces, jobs, databases where forbidden, browser persistent storage, crash diagnostics, documentation examples or agent transcripts. Any permitted transient delivery or intentional export is identified separately; memory-state clearing is not claimed to erase RAM.
7. **Truthful mutations across systems.** A PostgreSQL commit cannot make an OpenBao change atomic. Durable intent precedes backend effects; optimistic version checks, operation identity, state tags, locking/exclusion and backend evidence protect against stale writes, duplicate actions and false no-effect conclusions. If a delayed effect cannot be excluded, work stays blocked for reconciliation.
8. **Complete, coherent machine delivery.** Partial or truncated values cannot trigger launch or export; denied or reviewed keys fail the full operation. The child process never inherits the MyKey retrieval credential by accident.
9. **Credential issuance is not reversible text delivery.** Issue once with a bounded scope and TTL. An interrupted/lost successful response cannot make the token retrievable again or silently issue a replacement. Backend-verified revocation governs access; token replacement has a documented operator procedure.
10. **Auditable, non-sensitive accountability.** Security-relevant actions, access and effects carry attributable request/operation references. Relevant audit must persist before admitting/releasing sensitive effects where required. Runtime roles cannot rewrite protected audit records; a trusted infrastructure administrator remains in the threat model.
11. **Recovery does not restore old authority.** The restore gate is closed independently of recovered database state. Old sessions, machine credentials, authentication material and unexpected grants are invalidated/reviewed before reopening. Test loss of the original host and previous KMS/bootstrap availability assumptions.
12. **Operational defenses and honest degradation.** TLS verification, network segmentation, restricted host/container privileges, rate limits, supply-chain inspection, off-host detection and actionable incident/upgrade procedures are part of readiness. Without a cache or HA, service unavailability blocks new CLI starts that depend on fetching values; the service must say so.
13. **No “tested” status from documentation alone.** Every release-critical assertion requires reproducible observed evidence on the pinned integrated product, including denied paths, fault injection, and recovery. Source documentation and isolated feasibility spikes do not close end-to-end release gates.

The source baseline's fifteen P-02 production guarantees and security/governance records **P-01/P-02/P-03 have not been supplied** in this conversation. Their specific wording and authority cannot be certified here. They must be obtained and reconciled before implementation approval; any contradiction is a blocker, not an invitation for a developer to guess which rule to obey.

## 6. Developer experience and the informative interface

### 6.1 UX is a release obligation, not decoration

The operator must be able to finish each approved day-to-day task through the product's intended interface. This includes first-run onboarding, project/environment context, secret work, credential issuance/revocation, confirmation of irreversible or access-reducing actions, and recovery guidance. Advanced host recovery itself remains operator-only tooling: the UI should explain the quarantined/blocked condition without exposing administrative recovery controls on public routes.

The interface should emphasize **location, meaning, and next action**: where am I, what is available, which credential is bound where, what just changed, what is uncertain, what failed, and what can be done safely? It should use consistent terminology across UI/API/CLI. Avoid optimistic success indicators that contradict durable operation state.

### 6.2 Minimum informative surfaces

| Surface | User question answered | Allowed data |
| --- | --- | --- |
| Workspace overview | What projects/environments exist and what needs attention? | Scoped names, counts, lifecycle/readiness states |
| Environment detail | Which keys are present and what is their lifecycle state? | Key names, versions, state tags/status, change timestamps; values only after explicit isolated reveal |
| Credential inventory | Which machine identities can read this environment and until when? | Bound scope, effective expiry, revocation/status, non-sensitive attribution |
| Activity/operation timeline | Did the action finish, fail, or become uncertain? | Operation IDs, actor/source, safe action/outcome, times, documented resolution state |
| Service/backup health | Is the service presently healthy, and how recent is the newest verified recovery pair? | Verified age/health/alert information with provenance and freshness timestamps |
| CLI diagnostics | Why did a launch fail, and what must the developer change? | Typed error categories, correlation ID, non-secret remediations |
| Reference/documentation | How do I integrate a legitimate machine consumer correctly? | Versioned, local API reference and tested setup/rotation examples with placeholders |

The **minimum release surface** is actual owner-visible project/environment readiness, key metadata, credential scope and expiry, permitted operation/activity outcomes, and actionable failures, plus **operator-only** verified backup age, alert and dependency condition accessible through the authenticated operator channel. Public health remains deliberately minimal. Charts are appropriate only where a trend changes an action or understanding: for example, operation outcome rates, CLI failure categories, request latency, or verified backup age. A chart is **not** mandatory solely to appear modern; truthful accessible tables/timelines may be superior. If a trustworthy measurement is unavailable, say **unknown / not measured**, not zero or green. **Names, actor identifiers, project topology, scope bindings and audit metadata may themselves be sensitive**: enforce visibility, field minimization and retention, rather than treating all non-value metadata as public. Any analytics instrumentation must be allowlisted and reviewed for cardinality, authorization, privacy, retention and secret-leakage risks; product-local analytics is not a substitute for the future separate cross-service agent observability/operations platform.

### 6.3 Usability quality bar

- One coherent onboarding path from installed CLI and created environment to a successful synthetic application launch, with tested documentation that does not depend on undocumented author knowledge.
- Clear, recoverable form errors without reflecting secret values; no secrets in toasts or global state. Explicit reveal is short-lived and localized; clipboard risk is disclosed.
- Keyboard-operable core workflows; usable labels, focus handling, accessible error/status semantics, readable dense metadata views and responsive layouts. Document and correct blocking accessibility defects before release; do not claim accessibility certification not performed.
- Consistent actionable errors across UI/API/CLI, including authorization, missing state, stale version, uncertain result, backend outage, expired credential and incomplete resolution.
- Safe control of confirmation, retry and replay semantics; UI affordances do not imply a forbidden “force success” capability.
- Screens and charts are backed by actual authorized data, with source/freshness understood. No secret-bearing frontend caches, local storage, analytics tools, or third-party script/telemetry requirements.

**Acceptance measurement:** before controlled-use release, execute the full first-run owner journey from an unfamiliar, documented starting state, including credential setup, CLI launch, normal secret update, visible uncertainty/denial, and recovery guidance. Capture objective task completion and defects, including keyboard/focus and small-screen checks, without declaring an untested accessibility standard. During field use, observe real owner tasks, record completion/abandonment, corrections, confusing steps and time-on-task; compare with an explicitly described baseline (for example, direct OpenBao CLI/manual dotenv handling) for the same bounded task. With one user and a small sample, these results establish practical usability evidence, **not statistically generalizable market demand**.

## 7. Agent-native foundations without premature agent-platform scope

Stage 1 must be **machine-native in execution contracts** even though the product is primarily operated by one developer. A real agent-consumer experiment should show that safe automation is plausible without turning the core secrets service into an orchestrator.

Required foundations:

- Programmatic API/CLI behavior with machine-readable and stable error categories, explicit scopes and bounded output.
- Clear distinction between human session, product-issued machine credential, service runtime identity and external agent/task identity in the documented trust model. Stage 1 does **not** invent an identity attestation for an arbitrary model.
- Durable operation IDs, safe replay/status inspection, traceable audit and rational handling of delayed effects.
- A machine credential never grants a tool arbitrary OpenBao backend paths, secret-history access, mutation authority or another environment's scope.
- A protected setup and trusted-launch workflow that avoids putting values and token material into model context, tool transcripts and common diagnostics, with tested leakage checks.
- No assertion that MyKey controls a child process after values have been handed to it, or that a trusted runner can safely execute arbitrary malicious agent-generated code without isolation.

**Evaluation question:** Does this narrow, dependable API/CLI provide a usable foundation for agents to request legitimate application work without copied broad human credentials? Measure setup/manual approvals, successful/denied requests, error comprehension, transcript findings and operator burden. It is legitimate for Stage 1 to conclude that stronger workload identity or execution isolation is necessary before agent-native commercial claims can be made.

**Out of scope:** self-service agent identity enrollment, SPIFFE/JWT federation, policy delegation chains, autonomous issuance/rotation, dynamic secret brokers, agent-to-agent workflows, arbitrary agent code execution, an MCP tool that reveals secrets, and an integrated HITL console. These may be future experiments, not half-features in Stage 1.

## 8. Operations, recovery and explicit service limitations

### 8.1 Full lifecycle of the delivered service

The approved Stage 1 release includes tested install/bootstrap, configuration, certificate/TLS setup, secret/credential use, monitoring, backup creation and verification, incident response, versioned deployment and upgrade, rollback or documented restore replacement, account recovery, credential rotation/replacement, clean-host recovery and controlled reopening. If a security-relevant alert exists, there is a tested response runbook for it. The deployment and its runbooks remain maintainable if the original implementer stops development.

The inherited Stage 1 baseline makes the following **specific commitments**; they are required unless explicitly amended under the governing-record procedure, and are **not claims of tested capability**:

| Current baseline obligation | Required value / interpretation |
| --- | --- |
| Staging separation | Separate staging host; same tested release configuration/versions, distinct provider credentials and synthetic data |
| Paired backups | At least daily; alert when newest *verified, eligible* pair's capture age exceeds **26 hours** |
| Recovery history | Retain recoverable pairs for **30 days from capture**, with independently proved storage maintenance/cleanup and requisite KMS key versions |
| Audit history | Retain application and OpenBao audit **365 days** under the independently protected audit policy |
| Machine credentials | Maximum **30-day** lifetime, nonrenewable; alert at **7 days** before expiry where the source's alert threshold applies |
| KMIP certificate | Alert at **30 days** before expiry |
| Critical advisories (CVSS ≥9.0 or known exploited) | Contain within **24 hours** and patch within **72 hours** |
| High advisories (CVSS 7.0–8.9) | Patch or document verified mitigation within **7 days** |
| Medium/low advisories | Address within **30 days** |
| Advisory timing | Count from public disclosure of an affected deployed component; delayed discovery does not reset the clock; containment is not patch completion |
| Availability | No SLA or HA, and no offline CLI application-value cache; outage can block new starts/restarts/deployments |

These values are inherited from `1-01` and `1-02`; they do not establish that their required providers, retention mechanisms or operational processes have been tested. Immovable retention/lock-aging evidence may require more calendar time than initial coding.

A recovery plan is incomplete if it depends on the lost host to fetch KMS access, restoration keys, bootstrap credentials, TLS reissue authority or operator login material. Recovery pairs must be internally consistent, and key versions needed by retained artifacts must remain available. **OpenBao auto-unseal recovery-key shares are authorization material, not substitutes for the external seal key; loss or deletion of the required KMS key can render an intact snapshot unrecoverable.** The disaster-recovery procedure must distinguish a temporary KMS outage, expired/revoked KMIP client certificate, lost host, and *irretrievable seal-key loss*, and state exactly which failures are recoverable. Preserved active and historical wrapping keys (which cannot simply be reissued after deletion), independently restorable or reissuable KMIP client certificates and private keys, and recoverable operator IAM authority are critical dependencies. Physical cleanup and object-lock/repository interactions—including unsuccessful deletes, pruning and expiry—must be tested rather than inferred from configuration settings. Do not assume that an R2 bucket-lock retention rule is immutable against a privileged administrator who can change or remove the rule; test and document the actual authority and retention boundary. Distinguish a running-unsealed OpenBao instance from separate upstream KMS reachability when presenting health.

### 8.2 Limitations we must state to users

- One real owner; not supported for arbitrary customer onboarding or independent teams.
- No availability SLA or HA. An outage can prevent application **starts, restarts and deployments** requiring fresh secrets. Already-running processes may continue with previously injected values according to their own behavior.
- No routine local application-secret cache in the CLI. Offline start is not promised.
- Not zero-knowledge, not a hardened execution sandbox, and not a guarantee against trusted host/operator compromise.
- Soft deletion/version retention is not immediate physical erasure; restored backups may contain historical authentication material until expiration, subject to quarantine/revalidation.
- Explicit export/clipboard/process injection moves sensitive material into a caller-controlled surface with risks outside MyKey's guarantee.
- No production-general agent delegation, workload federation, HA, complex migration, universal environment-file interpretation, or commercial tenant support.

## 9. Hypotheses, experiments and evidence obligations

Stage 1 exists to **replace assumptions with evidence**. Record each experiment's baseline, environment, exact build, synthetic versus real fixture, success criterion, observed result, exception, limitation and consequence for next-stage decisions. Experiment owners must designate whether evidence is an engineering pass/fail result, a single-user usability observation, an operator-cost estimate, or an untested market hypothesis; these categories are not interchangeable. Do not invent benchmark numbers or use a single success as proof of general behavior.

| ID | Hypothesis to test | Minimum observation or experiment | Possible consequential decision |
| --- | --- | --- | --- |
| H-01 | OpenBao + PostgreSQL can maintain safe product metadata/secret coordination | Interrupt secret writes, token issuance, archive, backup admission; inspect replay and reconciliation | Retain design, narrow mutations, or replace coordination mechanism |
| H-02 | Chosen protected auth/MFA integration is maintainably implementable | Exercise real adapter/session paths, step reuse, reset, freshness and protected storage | Retain integration, select proven alternative, or stop dependent work |
| H-03 | Scoped OpenBao authority and OVH KMS can operate reliably on the chosen host | Real KMS/unseal/restart/outage tests; second-tenant escape probes; key/cert procedures | Approve provider flow, change integration, or revise operational choice |
| H-04 | Paired off-host recovery and retention are operationally credible | Clean-host restore from actual eligible pair, revoked historical access, maintenance and aging controls | Adopt mechanism or replace backup/retention design |
| H-05 | Developer launch workflow reduces credential/file friction without creating new leakage | Same bounded task using documented baseline vs MyKey CLI; inspect logs/files/process args; record setup and failures | Improve DX/credential supply, change CLI model, or reconsider value |
| H-06 | Human-facing interface and operational visualizations improve comprehension | Observe new project, recovery guidance, credential inventory, uncertain operation and activity tasks | Retain/rework key views and remove decorative surfaces |
| H-07 | Existing machine API/CLI can support a constrained agent-initiated workflow | External trusted-executor fixture; success/denial/revocation and transcript canary checks | Prioritize workload identity/runner isolation, or postpone agent-facing expansion |
| H-08 | Single-operator service is affordable and sustainably operable | Track hosting/KMS/R2 spend, backup/restore toil, incident/restart handling, operator time | Revisit managed SaaS economics or favor a private agent-native path |
| H-09 | Security/operational burden is proportionate to the value over direct OpenBao | Compare setup, daily maintenance, incident recovery and human error with explicit baseline | Reduce product layering, change target buyer, or stop |

**Minimum field record:** release build/pins; first successful genuine non-critical consumer; weekly backup age and integrity status; restore drill time and outcome; P50/P95 API/CLI latency for declared operations; disk/CPU/memory headroom; credential expiry/rotation failures; CLI error distribution; user task notes; agent-fixture outcomes; security incidents or near misses; approximate provider costs and hands-on maintenance time. Maintain a defect/decision log. Record metric provenance and censor observations when sample sizes are too small or traces are incomplete.

**Interpretation:** "Can build it" is not the same as "worth building as a SaaS." The controlled one-owner validation cannot establish willingness to pay, external tenancy suitability, broad reliability, developer-market demand, or full agent-execution security. Those remain later-stage questions.

## 10. Feasibility gates, blocked work and decision rights

### 10.1 First-path proofs (before dependent product features)

The existing Stage 1 technical audit has **24 proof obligations, all OPEN as of the supplied audit**. The revised documents must preserve their identifiers and coverage or explicitly replace individual proofs after an approved requirements decision. Stage 1 proof work is implementation work and consumes budget.

| Gate | Critical uncertainty | Earliest acceptable evidence | Failure response |
| --- | --- | --- | --- |
| **F-01 — Dependency baseline** | Do exact library/runtime versions cooperate, with maintainable adapter and migration boundaries? | Pinned manifest, reviewed migrations, executable starter and integration checks | Replace candidate, repin and rerun; do not start dependent integration on unverified defaults |
| **F-02 — Auth boundary** | Can protected bearer storage, factor completion/replay and operator recovery satisfy the contract? | Real Better Auth/Drizzle (or approved alternative) storage/route/session tests | Block auth-driven product release; decide maintained alternative rather than storing plaintext bearer |
| **F-03 — Backend/KMS privilege** | Can real OVH KMIP auto-unseal, external key/certificate custody and narrow OpenBao identities behave as assumed? | Real restart, outage, certificate/key renewal and lost-host tests; real policy and second-organization probes | Replace integration/design with a tested equivalent or stop/defer affected whole capability; never assume recovery shares can decrypt without the KMS key |
| **F-04 — Delayed backend effects** | Can old executors be excluded before reconciliation admits replacement work? | Delayed-request/process-death fault tests against actual backend, not only mocks | Keep affected scope blocked; change protocol before user writes/issuance |
| **F-05 — Complete resolution and clients** | Can coherent environment reads and client verification prevent partial launch/export? | Concurrent mutation/truncated delivery/CLI platform integration tests | Adjust complete-read protocol and transport; never launch on partial set |
| **F-06 — Backup/restore/retention** | Can eligible pairs be captured, retained, maintained and safely reopened without the original host and with independent KMS authority? | Real pair capture, bucket-lock and repository prune/expiry tests, key/cert custody, oldest-eligible capture and clean-host quarantine restore | Replace backup mechanism or block live-secret release |
| **F-07 — User experience and leakage** | Do UI, CLI, local reference and telemetry satisfy strict containment while remaining usable? | Browser/CSP/network, secret-canary and guided task tests | Correct UX/instrumentation, do not waive containment for analytics |

**Dependency and calendar policy:** run the backup retention/lifecycle fixture and any aging-dependent tests at the earliest executable opportunity; never imply that a short-lived spike simulates actual deployed 30-day controls. **Document 04 and the reconciled P-series guarantees must assign each long-aging proof to its actual controlled-use release gate or stage-completion gate. No source-required pre-release test may be moved after release by implication**, and no post-release observation may be labeled PASS before elapsed verification. Track the elapsed-time critical path in Documents 07–08 independently from engineering effort.

**Proof policy:** isolated spikes establish feasibility prerequisites; the complete integrated product must still rerun and pass the affected acceptance evidence before release. A failed proof is not merely a task to carry into Stage 2. It either drives a documented verified replacement, a formally amended coherent product contract, or a release block. Real-time retention/lock aging may remain a calendar gate even after other code is ready.

### 10.2 Non-negotiable decision process

Before an approved mission changes: (1) state precisely the failed assumption or effort gap; (2) identify affected user journey, threat boundary and existing FR/AC/PO identifiers; (3) propose a complete replacement or entire coherent scope slice to remove; (4) prove that remaining supported behavior and security claims are intact; (5) obtain the required governing decision and revise Documents 03–08 and test/evidence ownership; (6) only then implement the changed contract.

Do not erase failed results, use an optimistic default on backend inconsistency, or call a skipped test PASS. Where a necessary proof is pending, release remains blocked even if a UI demonstration appears to work.

## 11. Time and scope discipline

### 11.1 The 400-hour target is a constraint to evaluate, not a deadline promise

Document 02 gives the following **illustrative**, not measured, allocation:

| Package | Allowance (engineering hours) |
| --- | ---: |
| Dependency and feasibility/architecture closure | 40 |
| Identity/account and resource authority | 55 |
| Secret state, durable cross-store operations | 75 |
| Machine credentials and CLI | 40 |
| Web/API, DX, documentation, local analytics | 45 |
| Deployment, backup/restore, security operations | 60 |
| Integrated acceptance, independent review, field-use instrumentation | 35 |
| Unassigned risk, proof reruns, correction capacity | 50 |
| **Total illustrative envelope** | **400** |

**HIGH delivery risk.** The existing source documents contain **88 functional requirements, 44 acceptance scenarios and 24 unexecuted proof obligations**. There is **no verified bottom-up estimate** establishing that implementing them, plus the newly proposed high-value DX and bounded agent fixture, fits 400 hours. In particular, protected authentication, crash-safe effects, KMS interoperability and actual retained-pair restore are high-variance engineering tasks. A 50-hour reserve does not resolve the uncertainty and cannot stand in for testing or integration.

The target is **engineering effort**, not calendar days, and does not include passive waiting for the field-use period or provider-retention aging. External review costs, hosting and provider spend are tracked separately; when independent review is a release condition, it still must occur. **At the end of the initial auth/KMS/coordination feasibility tranche, reforecast the full stage from observed effort and remaining work, including field-use remediation and calendar-blocked retention tests.** If expected completion materially exceeds the envelope, approve a closed scope revision or justified overrun before expanding dependent features; do not carry an impossible estimate unchanged into Document 08.

### 11.2 Hard priority order when effort becomes constrained

1. **Do not compromise safety or truthfulness.** Preserve authentication, authorization, backend scope, secret containment, mutation integrity, revocation, audits, restore and credible operation for the *chosen* product.
2. **Protect one complete end-to-end application use case.** The owner must be able to bootstrap, manage secrets, issue a bounded machine credential, launch a real supported app, revoke and recover.
3. **Protect the developer interface that makes those workflows actually usable.** Concentrate on explanatory UI, CLI reliability, trusted status and documentation rather than breadth of charts or styling experiments.
4. **Contain optional breadth before core quality.** Remove entire unapproved feature families, integrations, unsupported platforms or convenience workflows **only after** approved contract reconciliation; preserve honest messaging and tests for what remains.
5. **Approve an overrun rather than falsify completion.** If no safe coherent reduction exists, revise the budget and schedule explicitly. A second stage cannot be used as a disguised repair phase for security, recovery or included workflows left unfinished in Stage 1.

### 11.3 Stop-loss and escalation triggers

Escalate for product/design adjudication when any of these occurs: a critical feasibility proof fails twice without a credible maintained replacement; an authentication/privilege/secret leak violates the trust model; delayed backend effects cannot be fenced or reconciled; recovery depends on lost-host material or object-lock maintenance proves incompatible; the expected-to-complete estimate materially exceeds 400 hours; or a significant UX/agent addition jeopardizes a release-critical slice.

Escalation outcomes are: verified architectural substitution; narrow, approved *closed* product scope; a justified increase in engineering effort; or stopping the stage. None authorizes release with failing included capabilities. Estimates should be refreshed after the first feasibility experiments rather than waiting for the final pre-roadmap.

## 12. Release gate and Stage 1 completion gate

### 12.1 Release gate — before connecting any real application secret

Every applicable item is mandatory under the final approved Stage 1 contract; evidence must identify release commit, package/image pins, schema versions, environment and independent reviewer where required.

- [ ] The approved functional requirements/acceptance register is complete and its inherited 88 FR/44 AC mapping is resolved; all currently applicable proof obligations pass or have formally approved tested replacements. **No silent omission** is permitted.
- [ ] Operator bootstrap, mandatory MFA/recovery, current authorization, every public/native auth route, and second-organization denial tests pass against real services.
- [ ] The end-to-end synthetic owner → project → environment → secret → machine credential → CLI application launch → revocation workflow passes on every declared supported client platform.
- [ ] Negative paths cover stale writes, archive/issuance races where included, missing/inconsistent scope, expired credential, incomplete resolution, replay and interrupted backend effects.
- [ ] No secret values, machine tokens, authentication codes/links or prohibited credential material appear in logs, diagnostics, traces, browser persistent state, job payloads, analytics or agent transcripts under seeded canary exercises.
- [ ] Source-listed P-02 guarantees are each traced to executed tests/drills; P-01/P-02/P-03 reconciled and governing authority signed off. No unreviewed critical security claim is treated as a pass.
- [ ] Scoped OpenBao identities, real KMS unseal/host restart and KMS outage, TLS/certificate handling, off-host probe/alert delivery, software-supply-chain inspection and operator incident procedures pass in staging.
- [ ] At least one consistent off-host OpenBao/PostgreSQL recovery pair is created and used in a timed **clean-host restore**; service remains quarantined until old human/machine authority is invalidated, current owner is revalidated and reopened deliberately. Restore independently proves necessary external seal-key/certificate custody. Retention/object-lock maintenance and oldest-eligible restore obligations are fulfilled under actual provider behavior **at their source-mandated gate**; if a pre-release aging proof is required and still awaiting elapsed time, real-secret onboarding remains blocked.
- [ ] Every retained UI/API/CLI capability works end to end; owner-facing project/environment/secret/credential/operation surfaces and **separate privileged operator health and backup diagnostics** are accurate, access-controlled and comprehensible, never implying measured health when unknown; documented onboarding, safe machine-credential setup/rotation and API reference match the installed product. At least one guided unfamiliar-start-to-application-launch and failure/recovery-guidance task passes.
- [ ] Independent reviewer(s) other than the feature/proof author examine required failure cases and evidence; high/critical issues are fixed or subject to a tested, accepted mitigation consistent with the governing security contract.
- [ ] Product documentation and runbooks honestly disclose residual risks, supported environments, operational cost/availability limitations and exact recovery prerequisites.
- [ ] Non-destructive production readiness checks pass; destructive tests remain on isolated staging/synthetic material. The operator signs the evidence manifest and **authorizes controlled field use**.

A release blocker may not be relabeled “Stage 2 scope” after implementation without a documented, approved amendment to the Stage 1 capability and security contract.

### 12.2 Stage completion — evidence after release

- [ ] **Daily real field use for at least four weeks** following controlled release with one non-critical application; record the observation window, disruptions and weekly health/backup/latency/resource/failure/defect observations. A defect-driven suspension is recorded and evaluated rather than credited as normal functioning use.
- [ ] A scheduled staging restore drill using production procedures and synthetic data passes; changed release pins or configurations cause the relevant security proofs to be rerun.
- [ ] At least one **executed** end-to-end external agent-initiated synthetic request through the trusted allowlisted executor is recorded, including denial/revocation, transcript/canary inspection, manual intervention and execution-trust limitations. The harness may be minimal, but an unperformed experiment cannot satisfy this gate without formal amendment to Documents 02–03.
- [ ] The developer UX evaluation includes task-level friction, actionable diagnostics and a bounded baseline comparison; analytics claims are supported by measurements.
- [ ] Material defects are corrected and verified, or controlled use is halted/contained consistent with the security contract. No unresolved critical defect remains at the stage decision.
- [ ] Retention/calendar-dependent obligations are satisfied; any additional elapsed proof horizon is recorded honestly rather than waived because coding finished.
- [ ] An exit report distinguishes **implemented/proven**, **measured but uncertain**, **disproved**, **untested**, and **deferred**, with implications for commercial hosting, workload identity, isolation and next-stage architecture.
- [ ] A signed **ADVANCE / HARDEN–RE-SCOPE / PIVOT / STOP** decision includes the plan for operating or deliberately retiring MyKey Private if no subsequent stage is built.

**Stage 1 is complete only after this gate, not after coding stops.** If the strategic evidence is negative, the software may still be a properly completed private secrets service. If release-critical behavior is missing or unsafe, no amount of favorable DX feedback makes the stage complete.

## 13. Document authority, reconciliation and implementation handoff

### 13.1 Documents 03–08 have distinct responsibilities

| Document | Role after this mission is approved |
| --- | --- |
| **03 — Mission Brief** | Declared product, users, boundaries, hypotheses, non-negotiables, release/field-use gates; **not** schemas or package pins |
| **04 — Functional Specification** | Every observable workflow, state and error; exact permissions, UI/API/CLI behavior, complete denial cases and acceptance scenarios; requirement-by-requirement reconciliation with current `1-02` |
| **05 — Technical Audit** | Independently validate candidate technologies and source claims; alternatives, risks, unresolved proofs, compatibility and blockers; reflect changed product requirements |
| **06 — Technical Specification** | Implementable identities, schema, exact operations/fencing, protocols, API/routes, deployment/backup and proof hooks; distinguish conditional choice from demonstrated behavior |
| **07 — Pre-Roadmap** | Exhaustive work inventory, session-sized dependency graph, effort ranges, critical path, proof timing, evidence mapping, workload/session sequencing; no full implementation runbooks |
| **08 — Implementation Roadmap** | Executable runbooks per coherent mini-project session: entry prerequisites, complete tasks, mid-session checkpoints, commands/tests, exit evidence, exceptions and handoff |

The existing `1-01`–`1-04` are historical source names and must not be renumbered in place as though their contents already satisfy the new document roles. Old v2.1/v2.0 audits remain useful source material, but their references must be remapped to Documents 03–08 after reconciliation.

### 13.2 Mandatory reconciliation before proof-dependent implementation work

1. **Authority:** obtain/inspect P-01, P-02 and P-03 and document their current status. The precise release guarantees in P-02 cannot be certified from secondary summaries alone. Reconcile confidentiality language about *application values versus protected authentication representations*, Drizzle choice, actual OpenBao/host/KMS restart terminology, and every changed requirement. Do not assert these records are already updated.
2. **Scope:** create an explicit table for all **88 existing FRs, 44 ACs and 24 POs**: retain, amend, replace or propose to remove, with rationale, residual guarantee and new evidence owner. No row disappears by implication. Added DX/agent requirements receive their own identifiers and acceptance tests.
3. **Feasibility:** verify pins and high-risk auth/KMS/privilege/operations/retention mechanisms early using synthetic data. If the chosen design cannot satisfy the requirement, revise the design or make a governing decision before dependent work.
4. **Estimate:** Document 07 delivers lower/expected/upper engineering effort ranges for the *entire* approved product (including front end, restore, security and field remediation) and reconciles with the 400-hour target. The number of sessions follows coherent work, not an arbitrary forty-session quota.
5. **Execution:** Document 08 makes every approved proof, acceptance scenario, DX test and recovery obligation executable with actual exit criteria, and gives exact handoff evidence. The **week beginning 9 November 2026** is the revised intended engineering start window; it does not imply any prerequisite is already approved or that a release date has been set. Unblocked synthetic feasibility work may begin, but dependent production feature work must follow the approved gates.

**If reconciliation cannot be completed before implementation begins:** limited, isolated, synthetic-data feasibility experiments may proceed when they do not prejudge conflicting requirements; product feature work dependent on unresolved authority or failed safety proofs must not. This is a sequencing constraint, not permission to ship unapproved behavior.

### 13.3 Exit of this document

Approve this mission only when the reviewer can answer all of the following affirmatively:

- Is the deliverable a whole, independently operable service, not a partial pre-SaaS subsystem?
- Does it solve the declared human and machine problem without needing later stages?
- Are real users, systems, platforms and trust assumptions bounded honestly?
- Are security, backend effects, secret delivery and recovery release-critical and testable?
- Is excellent DX substantive but limited to real available data and workflows?
- Is the agent-native test meaningful without promising arbitrary agent-runtime isolation or future agent features?
- Are exclusions, failure states, outages, risk and costs explicit?
- Are the 400-hour constraints and inherited 88/44/24 evidence obligation treated honestly?
- Are decisions that require P-01/P-02/P-03 review and Document 04 reconciliation visible rather than silently assumed resolved?
- Do both the controlled-use release gate and post-release validation gate require objective evidence?

If any answer is no, revise Document 03 before treating it as an implementation authority. A project vision is not a release certification.

---

## Appendix A — Provenance and conflicts to reconcile

| Basis | What this mission derives from it | Explicit limitation |
| --- | --- | --- |
| Document 01, Northstar v0.2 audited | Long-term OpenBao-centered, agent-native value proposition; trusted execution distinction; DX priority; stage completeness philosophy | Future product opportunities are **not** Stage 1 promises |
| Document 02, Stage Breakdown v0.2 audited | MyKey Private product shape, complete-stage contract, provisional 400-hour allocation, bounded agent fixture, exit evidence | Work-package allowances are **not** measured estimates |
| Uploaded `1-01` Stage 1 Mission Brief v2.1 | Core owner/CLI/secret/recovery end-to-end workflow; eight security properties; real-use/production gate and operating commitments | Older document order and omissions regarding new DX/agent-validation ambitions need reconciliation |
| Uploaded `1-02` Stage 1 Functional Specification v2.1 | 88 FRs, 44 ACs, detailed auth, lifecycle, import, issuance, audit, recovery and failure requirements | No existing FR/AC is removed by this prose; Document 04 must map each |
| Uploaded `1-03` Stage 1 Technical Audit v2.0 | 24 OPEN proof obligations; auth, delayed effects and retention as high-risk areas | Documentation audit; no executable proof passes are claimed |
| Uploaded `1-04` Stage 1 Technical Specification v2.1 | Candidate technical mechanisms, six gates and implementable protocols for later audit/spec revision | Conditional design, not verified interoperability or final version pins |
| Governing P-01/P-02/P-03 records | Referred to as governing inputs by existing Stage 1 materials | **Not provided**; cannot certify correspondence or supersession |

### Appendix A.1 — Proposed additions to the inherited Stage 1 mission

- Treat substantive, secure **developer experience and accurate product-local visualizations** as a release obligation rather than an optional finishing polish.
- Define a single **bounded external agent-initiated validation fixture** using preauthorized machine consumption, with an explicit execution trust limitation; do not add a general agent runtime.
- Distinguish **safe release for real, non-critical use** from **stage completion after observed field evidence**.
- Place the current Stage 1 work under the **eight-document 01–08 hierarchy**, including separate 05 Technical Audit, 06 Technical Specification, 07 Pre-Roadmap and 08 session runbooks.
- Add an explicit **400-hour feasibility and change-control mechanism** without assuming all source requirements automatically fit.

These are proposals awaiting Stage 1 governing-contract approval, not retroactive statements about what `1-01`/`1-02` already required. This v0.2 audit additionally clarifies **mandatory owner/operator diagnostic surfaces, metadata confidentiality, real field-use cadence, the non-waivable agent experiment absent formal reapproval, and exact inherited operations commitments**; it adds no unapproved provider or advanced autonomous capability.

## Appendix B — Evidence classification to use throughout the stage

Every consequential claim in the project evidence register uses one of these statuses:

| Status | Meaning |
| --- | --- |
| **PLANNED** | Contracted but not implemented or exercised |
| **SPIKE-PASS** | Isolated feasibility mechanism passed; integrated-product proof remains pending |
| **INTEGRATED-PASS** | Required end-to-end integrated scenario passed on declared pins |
| **FIELD-OBSERVED** | Measured during controlled use; limitations/sample recorded |
| **FAILED** | Executed requirement did not pass; includes reproducible evidence and remediation decision |
| **BLOCKED** | Unresolved prerequisite, authority or effect prevents legitimate testing/operation |
| **DEFERRED** | Explicitly excluded from this approved stage contract; not a promise or shippable feature |

A SPIKE-PASS must not be displayed as INTEGRATED-PASS. FIELD-OBSERVED usability value does not supersede a FAILED security property. A DEFERRED feature must not remain enabled as a half-implemented public endpoint.

---

## Appendix C — 7 November 2026 targeted external verification and audit delta

This final pass verifies the **documented integration surface**, not the running MyKey deployment. Official references checked:

- [OpenBao 2.7.x KMIP seal](https://openbao.org/docs/configuration/seal/kmip/) — documents a built-in `kmip` seal, required externally provisioned active KMS key, client-certificate authentication, and OVHcloud KMS interoperability. This is the candidate referenced in §2.2 and F-03.
- [OVHcloud KMIP integration guide](https://docs.ovhcloud.com/en/guides/manage-and-operate/kms/kms-kmip) — lists OpenBao among validated KMIP integrations and requires certificate-based protocol access.
- [OpenBao seal/unseal concept](https://openbao.org/docs/concepts/seal/) — explicitly warns that auto-unseal recovery keys cannot replace an unavailable or deleted external seal key.
- [OpenBao OVHcloud seal](https://openbao.org/docs/configuration/seal/ovhcloud/) — documents a **different**, plugin-based REST KMS seal; it is not interchangeable with the selected KMIP design without deliberate approval and tests.
- [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) and [object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) — document retention and lifecycle behavior, including authorized rule removal and lock priority over deletion, which require real tests with the selected backup-repository operations.

**v0.3 audit actions:** updated the stale 2 November start date, clarified the KMS key-versus-recovery-share boundary, named KMIP client-certificate custody, explicitly required lock/repository maintenance compatibility, and removed ambiguity about assigning elapsed-time proofs to release versus completion. **Not changed:** the inherited 88-FR/44-AC/24-PO counts, security obligations, 30-day retention/365-day audit promises, four-week real-use requirement, operator/agent scope, budget warning or unapproved P-series authority. None of the cited documentation constitutes an observed Stage 1 proof pass.

---

**Document state:** v0.3 final pre-implementation audited candidate; recommended for approval as the Stage 1 mission baseline **for downstream specification only**, contingent on the named governing-record and scope reconciliation. **Not implementation authorization, release approval, effort certification, or assertion that any of the 24 technical proofs have passed.**
