# Document 06 — MyKey Stage 1 Technical Specification

**Working product name:** MyKey (`mykey`, provisional)  
**Stage/product:** Stage 1 — **MyKey Private**, a complete, operator-managed, independently useful service  
**Version:** **0.3 — final pre-implementation audit revision, 7 November 2026**  
**Implementation program target:** week beginning **9 November 2026** (prerequisite proof/governance work first; **not** a release date or an unconditional coding authorization)  
**Upstream proposed authorities:** Document 01 v0.2 Northstar (unchanged); Document 02 **v0.3** Stage Breakdown; Document 03 **v0.3** Stage 1 Mission; **Document 04 v0.3 Functional Specification (102 FR; 60 AC)**; **Document 05 v0.3 Technical Audit (24 inherited POs and five additional proof records)**  
**Detailed historical input:** `1-04_stage_1_technical_specification_v2.1_audited(1).md`, selectively carried forward as an implementation *candidate*, never as proof.  
**Downstream:** Document 07 — Pre-Roadmap (work packages, dependency order, estimates); Document 08 — Implementation Roadmap (executable per-session runbooks).  
**Approval:** **AUDITED CANDIDATE / NOT IMPLEMENTATION-APPROVED.** The originals of P-01/P-02/P-03 remain unavailable for reconciliation; no integration, production, cloud, security, or restore proof is claimed PASS; the ~400-hour Stage 1 estimate is unsubstantiated. Revisions to requirements need explicit governing approval rather than a code-level workaround.

> **Governing design rule.** Specify a complete, secure and maintainable MyKey Private service with native-first technical mechanisms and verifiable contracts. Every included path—from bootstrap through secret delivery, revocation, operator recovery and meaningful owner DX—must work end to end. A release cannot depend on a future stage to finish an advertised feature. **Document 04 defines required behavior; Document 05 explains the capability choices and unresolved alternatives; this document specifies the proposed implementation**, and the evidence gates decide whether it may actually ship.

## Final pre-implementation design-audit disposition — v0.3

**Result:** revised and conditionally suitable as a complete design candidate for Document 07; **not** an authorization to implement proof-dependent features or introduce real secrets before its gates close. The 102 FR IDs and 60 AC IDs are reconciled against Document 04 **v0.3** at the identifier/gate level; the 24 inherited POs and the five new Document 05 v0.3 proof records remain **OPEN**. This is design traceability, not executed interoperability, full semantic proof, or a 400-hour estimate. See `mykey_doc_06_final_preimplementation_audit_report_2026-11-07.md` for findings and changes.

**Material tightened boundaries:** (a) protected Better Auth storage and every enabled native handler are blocking, (b) OpenBao token-role-created orphan credentials must outlive the short-lived issuer by design *and by direct proof*, (c) concurrency and audit history cannot infer a no-effect result from a missing backend response, (d) an owner analytics endpoint must filter *before* counting, (e) a clean-host restore remains closed until stale human and machine authority have been invalidated, **PostgreSQL cluster globals and privileges reconstructed, and externally held auto-unseal keys verified**, (f) R2 retention and per-object delete outcomes must be tested, and (g) limits, CLI runtime dependencies and storage/cost assumptions remain candidates subject to integrated tests. Native capabilities are preferred only where their **effective** permissions and actual versions meet Document 04 v0.3.

**Evidence hierarchy:** `DOCUMENTED` (versioned vendor description) → `SPIKE-PASS` (narrow reproducible integration proof) → `INTEGRATED-PASS` (actual pinned deployment/negative and failure tests) → `RELEASE-APPROVED` (reviewed manifest). An OPEN prerequisite does not become a design fact by repeated citation. Alternatives, proof failures and compromises need signed changes in the decision register; no feature is allowed to ship as a placeholder.

## 1. Architectural decision contract and unresolved prerequisites

### 1.1 What is selected versus what is conditional

| Area | Candidate decision for Stage 1 | Authority and proof boundary |
| --- | --- | --- |
| Application | TypeScript, supported Node LTS, Hono, Zod, versioned product API; React SPA, existing UI and TanStack libraries | Support/pins via G-PINS / PO-24; Hono types do **not** replace runtime validation |
| Secret engine | OpenBao Raft + KV v2, namespace per synthetic/real organization, scoped policies and identities | G-BAO, G-EFFECT; OpenBao is the **only** persistent application-secret value/version authority |
| Auth | Better Auth + Drizzle **conditionally**, constrained native handler allowlist, protected credentials, SQL-enforced MFA/recovery session state | **G-AUTH BLOCKER**: full adapter/handler/storage proof needed. No stock plugin compromise accepted |
| Data | PostgreSQL 18, Drizzle/`pg`, reviewed SQL migrations, SQL constraints/locks/roles, pg-boss only as delivery scheduler | G-PINS, G-EFFECT, G-OPS-DX; queue is **not** the authority over effects |
| Unseal | Built-in OpenBao KMIP with OVHcloud KMS first; OVHcloud external plugin is a conditional fallback | G-BAO / PO-1 actual provider proof and supply-chain review; no automatic fallback |
| Machine access | One-environment read-only nonrenewable bounded OpenBao service tokens; bearer-only MyKey product routes | G-BAO, G-EFFECT / PO-2, PO-18; no token bytes in PostgreSQL |
| CLI | Thin MyKey CLI over coherent product API, four tested Linux/macOS targets, verified HTTPS and no local value cache | **G-CLIENT BLOCKER**; must compare OpenBao Agent's beta process-supervisor mode before locking final choice |
| Web DX | Complete owner information architecture, safe timelines and aggregates; limited security-sensitive component state; locally bundled protected read-only Scalar | G-OPS-DX, G-CLIENT; no dashboards generated from hidden/untrusted measurements |
| Edge/host | Traefik **OSS**, Docker Compose, WireGuard/host network controls, verified TLS and least-privileged containers | G-PINS, PO-14, PO-23; OSS `rateLimit` optional; no new Redis for one edge host |
| Recovery | SQL/raft *paired* freeze-and-capture plus reproducible PostgreSQL globals/permissions, encrypted off-host R2 material, external KMS key-version custody, isolated quarantine restore and access rotation | **G-BACKUP/G-BAO BLOCKERS**; independently recoverable pair storage candidate, real R2 lock-aging/per-object deletion and seal-key recovery proof required |
| Agent validation | Separate staging-only fixed-command trusted executor using **shipping** CLI, synthetic credential and explicit output allowlist | Post-release AC-1.53–54; **not** a shipped arbitrary agent runtime or workload identity system |

The table represents the **implementation candidate**, not established compatibility. Exact dependency versions, image digests, plugin hashes and adapter schemas **must not be invented**: G-PINS produces the authoritative committed manifest after version and advisory review. **As of 7 November 2026**, Node.js **26 is Active LTS** and Node.js 24 remains LTS; both require project-specific compatibility evidence. PostgreSQL **18 is the stable baseline**, while PostgreSQL 19 is at release-candidate stage with general availability planned for 19 November, not a permissible silent upgrade. OpenBao **2.7.2**, Traefik Proxy OSS **3.7.17**, and Better Auth **1.7.18** are current review candidates as of this audit, **not automatically approved pins**; verify advisories, artifacts and exact versions at G-PINS. Better Auth 1.7.18 includes a concurrent session-revocation fix whose residual hook/secondary-storage cases require direct regression. Node.js 26 official Linux distribution may require `libatomic`; verify actual supported hosts before selecting the Node CLI fallback.

### 1.2 Native-first architecture, including deliberately unchosen features

1. Prefer OpenBao's native namespaces, KV CAS/versioning, policy/token roles, self-lookup, audit and Raft snapshots for **backend-enforced** behavior. Do not implement an independent secret-value or token store in PostgreSQL.
2. Prefer PostgreSQL's actual transaction/constraint/role/advisory-lock semantics for metadata, authorization, durable intent, audit append and coordination. Do **not** mistake an advisory lock for fencing against a delayed external OpenBao effect.
3. Use Hono/Zod/OpenAPI/Scalar as one product-contract toolchain but independently runtime-validate both incoming inputs **and** sensitive outbound/CLI responses. Hono middleware cannot certify authorization or CSRF by itself.
4. Use Traefik OSS for TLS, ingress and edge request limits and Compose/host hardening for service boundaries. Keep account/source/factor rate counters in PostgreSQL; do not introduce Redis merely because OSS Traefik optionally supports it.
5. Do not use PostgreSQL RLS, OpenBao Agent/Proxy, an external seal plugin, a second issuer service, a new workflow orchestrator or additional analytics infrastructure merely because each is possible. **Co-resident runtime and issuer credentials remain a deliberate residual risk**: compromise of the public API process may expose bounded issuer power inside an organization despite different OpenBao policies. G-BAO must measure the actual effective damage and document why preserving one API process is justified; a separate private issuer is promoted if the fixed-role boundary is not strong enough. Native KMS, auth and runtime access controls cannot be described as a process-level isolation boundary when the same process holds both credentials. §17 records measurable promotion criteria.
6. Use maintained, tested cryptography and secure libraries for protected auth records; native-first does **not** justify inventing a new cryptographic primitive or abusing unsupported adapter extension points.

### 1.3 System shape and trust partitions

```text
Public TLS client (browser or MyKey CLI)
    |
Traefik OSS: HTTPS, bounds, edge admission
    |
Hono API + Better Auth integration -- local React SPA / read-only Scalar
    |              |                     \
    |              +-- PostgreSQL: account/grants/metadata/operations/audit
    |              +-- scoped per-org OpenBao runtime/issuer credentials
    |
Private OpenBao namespace + KV v2 + native ACL/token/audit, Raft
    |                   |
    |                   +-- OVHcloud KMS unseal via verified KMIP (candidate)
    +-- off-host encrypted paired recovery material in Cloudflare R2

Independent: provisioner, private operator maintenance/restore, off-host probe.
Separate staging-only agent -> fixed trusted executor -> shipping CLI -> fixture child.
```

**Plaintext trust:** operator and host, MyKey API when handling values, authorized owner reveal/export and deliberately launched child processes can encounter plaintext. MyKey is **not** zero-knowledge. A user or agent that controls arbitrary code inside the child runtime can exfiltrate its secrets; the bounded agent fixture is not a proof against arbitrary malicious agents. No system-wide observability console, hosted signup, general agent tool server, external workflow orchestrator or dynamic secret engine is part of Stage 1.

### 1.4 Feasibility decision gates and no-go responses

| Gate | Early executable evidence required *before* dependent feature implementation | Failure disposition |
| --- | --- | --- |
| **G-PINS** | Review Node 26/24 LTS and runtime `libatomic` compatibility; PostgreSQL 18 stable vs 19 RC; patched OpenBao 2.7.x, Traefik 3.7.x, Better Auth 1.7.x, exact supported package/toolchain/image/action manifest, adapter schema, advisories, clean migrations/builds | Stop dependent work; choose supported pins or record justified component swap; never pin an RC merely because its documentation is available |
| **G-AUTH** | Native handler enumeration and total prohibition of signup/MFA bypass; protected bearer storage **all paths**, verifier-only one-use backup codes, TOTP replay/freshness, expiry/reset under concurrency and data dumps | Block auth/UI work; change supported integration or revisit component with an approved decision, never weaken requirements |
| **G-BAO** | Actual OVH KMIP initialization/unseal, host restart/outage, certificate/key-version custody including all still referenced seal keys, disposable key-unavailability/loss negative case, scoped issuance/provisioning and hostile second-tenant requests; **KMS-L1** | Block backend-dependent work and any restore claim; compare external OVH seal plugin only after a recorded decision; permanent referenced seal-key loss can render snapshots **unrecoverable**, not recoverable via OpenBao recovery shares |
| **G-EFFECT** | Intent/dispatch/death/delayed response across KV, issuance, archive, and review; old execution demonstrably excluded before takeover | Block mutations/replacement execution; unresolved effects remain quarantined rather than being assumed failed |
| **G-RESOLVE** | Concurrent mutation versus consistent full-environment read, audit, truncated delivery and no-launch semantics | Block `run`/export; no eventual-consistency caveat permitted for a successful complete response |
| **G-BACKUP** | Paired capture, **PostgreSQL global roles/privileges/extension reconstruction**, real R2 lock aging, per-object delete error parsing (including partial failures in HTTP 200), oldest-recoverable pair, independent seal-key access, clean-host quarantine/full rotation, measured archive growth/cost; **DB-G1, R2-L1, COST-B1** | No real secrets; replace backup mechanism with tested equivalent if candidate fails, never mark partially restored DB authority as ready |
| **G-CLIENT** | **Public-beta** OpenBao Agent comparison and explicit maturity disposition (**AGENT-B1**); verified four-platform CLI including Node 26 Linux `libatomic` fallback, HTTPS/TLS, child/spawn/signal/file behavior, local Scalar and strict CSP | Prefer tested thin CLI; a beta-based release-critical replacement requires signed exception and equal-or-better full-contract proof; no one-platform demo is complete |
| **G-OPS-DX** | Security/audit failure drills, protected private diagnostics, actual owner screens/metrics/a11y, external probe and notices | Do not release an API-only product as complete |
| **G-AGENT-FIELD** | After authorized controlled-use release, bounded stage-only runner, canary/leak/denial exercise and 28-day daily-use report | Stage remains incomplete; do not reclassify these as release-blocking prerequisites or pretend they passed early |

**Two checkpoints:** a feasibility spike justifies implementing dependent features, while an integrated proof on the final release commit closes a **release** gate. All inherited **PO-1 through PO-24** and Document 05 v0.3 proof records **KMS-L1, DB-G1, R2-L1, AGENT-B1 and COST-B1** start **OPEN**; none is replaced by a design review. New DX/agent/field checks require separately linked evidence. P-01/P-02/P-03 source reconciliation and independent security reviewer assignment precede implementation authority. **All inherited AC-1.01–1.44, including actual-aging AC-1.36 and AC-1.44, remain release-due unless a named governing amendment changes that fact.** Document 07 estimates the whole scope and calendar dependencies; ~400 hours is not a certified ceiling.

### 1.5 Non-negotiable invariants (implemented throughout §§2–20)

- One authority per fact: OpenBao holds application values/versions and token validity; PostgreSQL owns product metadata/authorization and audit/operation state. Auth records use only explicitly protected representations.
- New requests following committed revocation, expiry or restrictive state may not rely on stale cached authority; already-disclosed bytes cannot be recalled. Newly accepted mutations recheck authorization under admission locks.
- No application value, issued token, reset/recovery code or unwrapped credential may land in prohibited PostgreSQL data, jobs, logs, browser storage, telemetry, crash capture, queue messages or examples. Explicit authorized export and child environment are disclosed exceptions outside later recall.
- Before every possible external mutation, write durable nonsecret intent. Never report a timeout as definitely not applied; never redispatch based on lease expiry. An uncertainty blocks conflicting scopes until trustworthy operator reconciliation.
- No coherent complete-environment **success** if a single relevant secret or consistency/audit check fails. The CLI never launches a child from a partial or truncated response and never caches a fallback secret set.
- Restored data never makes restored identities valid. Quarantine is external to the restored database, default closed, and reopening requires independent proof of credential invalidation, rotated auth material and current owner verification.
- Security-sensitive state, user-visible status and analytics cannot claim certainty greater than their actual source evidence. The independent web owner and infrastructure operator remain distinct authorities.

---

## 2. Runtime boundaries and repository

| Unit | Responsibilities | Credentials / exclusions |
| --- | --- | --- |
| `edge` | Traefik: public TLS, routing, bounded requests | Public certificate only; no Docker socket, database or OpenBao credential |
| `api` | Hono, static SPA, product routes, auth, synchronous secret actions and machine reads | Application/auth DB role; organization runtime and issuer credentials; authentication/replay keys. No global OpenBao administration |
| `provisioner` | Durable environment policy/role provisioning | Separate DB role and organization provisioner credential; no plaintext job payload or machine-token delivery |
| `postgres` | Application, auth, coordination, audit and pg-boss schemas | Own TLS/storage credentials; no OpenBao root authority |
| `openbao` | Raft, KV v2, token authority, KMIP unseal, backend audit | Own TLS/KMIP credentials and volumes |
| `ops` | Separate backup/check commands and explicitly invoked recovery commands | Backup identity for scheduled work; elevated operator authority injected only into interactive maintenance runs |
| External probe | Cloudflare Worker tests public health and reports off-host | Probe heartbeat secret only; no service authentication |

One production host and a separate staging host use the same versioned Compose configuration. Document the exact host firewall/Compose/Traefik boundary with real packets: `expose` alone is not a host-firewall rule, Compose secrets are not an external KMS, Docker-network isolation does not inherently deny egress, and edge TLS does not prove internal TLS. The selected network egress restrictions and API/provisioner/PG/OpenBao credential-file ownership must be exercised using actual container UIDs, not inferred from Compose syntax. Staging has separate KMS, storage, identities and synthetic data. No cache server, HA subsystem, email service or observability console is added.

Internal API–PostgreSQL, API–OpenBao, provisioner, backup and proxy–API connections use verified TLS. Networks separate edge, application, database and OpenBao access. Egress is denied by default; permit exact required services through tested host rules or a controlled egress proxy. Allowing arbitrary hosts on port 443 is not an endpoint allowlist. Account for DNS, ACME, KMS, R2 and alert delivery explicitly. Revalidate provider endpoint changes without disabling certificate verification.

Public listeners: TCP 443 and the declared WireGuard UDP port. SSH binds to the VPN interface and uses keys only. No public port 80; use a tested ACME TLS-ALPN challenge with an unproxied DNS record. Private verification is VPN-bound with operator client authentication and never routed by public Traefik.

Containers run non-root with read-only root filesystems, dropped capabilities, `no-new-privileges`, explicit memory/process limits and bounded tmpfs. Volume/secret permissions must be verified for the actual image UID; Compose secrets are protected host files, not an encrypted secret manager. No mounted Docker socket. Core dumps, heap snapshots and diagnostic body capture are disabled. Node permissions supplement OS controls and are not a malicious-code sandbox [S5].

| Repository path | Ownership |
| --- | --- |
| `apps/api`, `apps/provisioner`, `apps/web`, `apps/cli`, `apps/ops` | Deployable entry points; operator code excluded from public route composition |
| `packages/contracts` | Zod product schemas, error codes, OpenAPI generation, strict dotenv codec |
| `packages/db` | Drizzle schemas, reviewed SQL migrations, role definitions and transaction helpers |
| `packages/auth` | Proven Better Auth adapter/plugin integration; native route allowlist and response mappings |
| `packages/openbao` | Narrow TLS client; fixed typed operations, no caller-provided backend paths |
| `packages/operations` | Admission, durable state transitions, reconciliation evidence and replay rules |
| `infra` | Pins, Compose, host/network/TLS configuration, timers and deployment manifests |
| `workers/probe` | Off-host probe |
| `tests/{unit,integration,browser,cli,fault,restore}` | Tests against the layers named by each AC/PO |
| `docs/{decisions,runbooks,evidence}` | Superseding decisions, executed procedures and nonsecret evidence |

## 3. Data model and database authority

Use UUID identifiers generated by a pinned implementation; no requirement depends on UUID sort order. Use `READ COMMITTED` for authorization/admission transactions, acquire the prescribed locks, then re-read state; do not authorize from a long-lived repeatable-read snapshot. UTC `timestamptz` records use database time for security expiry/admission. Backend-reported expiry remains authoritative for machine tokens. Secret names use bytewise ASCII ordering; display names follow Document 04 normalization rules.

Every organization-owned record carries `organization_id`. Composite foreign keys enforce matching organization/project/environment ancestry; globally unique IDs alone do not replace tenant checks. Queries use explicit scope predicates. Database constraints enforce enum states, positive limits, unique normalized names and one active execution slot per scope.

| Table / schema | Required columns or invariants |
| --- | --- |
| `organization` | ID, immutable namespace, state, configuration digest, provisioning operation |
| `membership` | `(organization_id,user_id)` unique; owner/admin/member; current state |
| `access_grant` | User, organization, project or environment, reader/editor; valid exclusive target; no public CRUD |
| `project` | ID, organization, normalized display name, lifecycle state, archive operation |
| `environment` | ID, project/organization, name, state, KV readiness, policy/role digest, metadata generation, live-value byte total, unique advisory-lock number, archive origin |
| `secret_index` | `(environment_id,name)` unique; observed current version, opaque random state tag, live/deleted/review state, current live-value byte length, last change, last operation; no value or unkeyed value digest |
| `secret_version_event` | Environment/name/version, operation, actor, action/time; records attribution, not a second version authority |
| `machine_credential` | ID, scope, name, issuance operation, accessor unique within namespace, requested/effective expiry, lifecycle, issuer, last use; no token column |
| `operation` | ID, principal, scope/action, idempotency key, fingerprint/key ID, expected metadata, state, executor boot ID, dispatch marker, heartbeat, result/error, replay expiry and audit link |
| `operation_step` | Parent operation, ordinal/target, before state, dispatch attempt ID, outcome/backend references; imports and multi-step provisioning/archive |
| `effect_slot` | Unique scope key, owning operation/step, execution generation, acquisition time; no automatic lease expiry or takeover |
| `outbox` | Unique `(operation_id,job_kind)`; pending/delivered marker; transactionally committed with the domain change; only IDs in payload |
| `import_entry` | Unique `(parent_operation_id,ordinal)` and name; original classification/preconditions, child operation ID and outcome; retained with the parent without values |
| `import_preview` | Owner/scope, file HMAC/key ID, expiry, per-key observed tags/classifications; no file/value bytes |
| `service_control` | Singleton capture mode/epoch, owner and state; durable freeze independent of process lifetime |
| `backup_pair` | Pair ID, capture boundary/time, artifact hashes/schema/commit/key references, validation status and expiry; mirrored to off-host manifest |
| `audit.event` | Append-only timestamp, actor/source category, organization where applicable, action/target/outcome, request/operation IDs; allowlisted fields only |
| `auth.*` | Reviewed Better Auth schema plus account state/epoch, enrollment, factor usage, protected sessions, reset/recovery verifiers; §4 |
| `jobs.*`, `rate_limit` | pg-boss internal schema and atomic bounded counters; job payloads contain IDs only |

`operation` uniqueness is `(principal_kind,principal_id,action,target,idempotency_key)`. Terminal records live at least thirty days after completion; unfinished records are never age-purged. Preserve minimal key tombstones after detailed replay expiry so reuse returns `409 replay_expired` instead of silently executing again. Tombstones contain no payload fingerprint or result. Audit linkage lasts through audit retention; old version attribution must remain for every version still retained by OpenBao.

### Roles and migrations

| Role | Rights |
| --- | --- |
| `migration_owner` | DDL and grants; deployment only; never mounted into runtime |
| `api_runtime` | Required app/auth DML, bounded job submission, audit append and authorized reads; no DDL or audit mutation |
| `provisioner_runtime` | Its jobs, operation/provisioning metadata and audit append; no auth tables or application values |
| `backup_reader` | Required database dump reads and metadata inspection; no auth mutation, audit purge or DDL |
| `maintenance` | Explicit reconciliation/retention/recovery procedures; unavailable to normal public runtime |

Keep table ownership outside runtime roles. Revoke `PUBLIC` privileges that would reopen access. **Database roles and grants are cluster-global recovery dependencies** and must be reconstructed through the tested version-matched globals/declarative procedure, not assumed to be embedded in a per-database `pg_dump`. Audit writes go through a fixed-schema insert function or insert-only grant with no update/delete/truncate privilege; security-definer functions, if used, have a fixed `search_path`, restricted execution and reviewed owner. Test inherited roles, partition privileges and job roles directly. An administrator remains trusted; append-only is a runtime boundary, not tamper-proof storage against the operator.

Drizzle Kit generates reviewed SQL; custom migrations define grants/functions/constraints and unsupported DDL. Better Auth schema generation feeds that same reviewed stream. pg-boss migrations run under a dedicated deployment step, not an unrestricted worker startup. Migrations have a checksum and applied history; deploy one migrator at a time. No production schema push.

## 4. Authentication and current authorization (candidate pending G-AUTH)

### 4.1 Protected storage integration — G-AUTH

Better Auth supplies password verification and session machinery through the Drizzle adapter. The application security integration owns account recovery state, factor-completed authorization and freshness. Stock session storage/freshness is not sufficient [S3].

Candidate session representation, subject to G-AUTH: a keyed lookup verifier and authenticated ciphertext, so the adapter can satisfy any internal need to return the original session token without storing plaintext. Use separate operator-managed keys for lookup HMAC and authenticated encryption; store key IDs. Conditionally use a maintained JOSE library with JWE `alg=dir`, `enc=A256GCM`, library-generated fresh nonces, and authenticated protected-header/context binding to purpose/user/session and key ID. Never implement encryption primitives. If the proven adapter can operate with verifiers only, omit ciphertext.

The adapter boundary transforms every token write, equality lookup, refresh, delete, list and transaction path. Raw tokens may exist only in process memory and authorized cookie delivery. Unsupported query operators on protected fields fail closed. Hooks alone are not accepted evidence of complete interception. Tests inspect real tables, query diagnostics, dumps and adapter return paths. Key rotation reads old supported key IDs until expiry or revokes affected sessions; keys never enter database/job configuration.

TOTP seeds use authenticated encryption with separate purpose binding; password storage uses Better Auth's maintained password verifier. Recovery/reset tokens are cryptographically random and stored as keyed verifiers; recovery codes are ten independent high-entropy codes, grouped for entry, never six-digit substitutes. Daily cleanup removes expired credential representations; revocation/use removes them immediately. No machine token is stored even as ciphertext.

### 4.2 Factor and session transitions

Account states: `enrollment_pending`, `active`, `recovery_pending`, `disabled`. Session phases: `password_verified`, `enrollment`, `mfa_complete`. Public product access requires `active` plus `mfa_complete`, valid auth epoch and all time limits. Password verification captures the credential/account epoch; before creating or elevating a session, lock and recheck that epoch and account state in the same transaction as session creation. A concurrent reset/password change cannot mint a usable session from an obsolete password verification. Password changes increment a credential epoch, revoke other sessions and explicitly migrate only the verified current session to the new epoch.

For successful TOTP, a transaction locks the enrollment/account and pending session, checks account state/epoch and expiry, verifies the code through the pinned maintained implementation, then records the matched step under a unique `(enrollment_id,step)` constraint and transitions the session. Accept only the configured ±one-step window. Choose the matching step deterministically without filtering consumed steps first; if that step is consumed, reject rather than trying another matching step. Rotate the session bearer at factor elevation to prevent session fixation; atomically invalidate the previous bearer and preserve the original authentication/absolute-expiry time. Only a committed elevation may deliver its new cookie. Retain accepted step numbers for the lifetime of that enrollment; do not purge them merely because the current clock window advanced. Replay protection survives process restart and clock rollback. Retire them when the enrollment is irreversibly invalidated. Session factor state cannot be set through client-writable custom fields.

Recovery verification consumes a single verifier with an atomic conditional update in the same transaction as session elevation. Failure or a rollback cannot leave an elevated session with an unconsumed code. Regeneration invalidates the old set before delivering the new set once. TOTP replay rules apply to enrollment and step-up as well. A completed fresh verification can authorize several permitted actions within its window without resubmitting the consumed code.

A successful TOTP records `totp_verified_at`, enrollment ID and session ID. A recovery-code login leaves freshness empty. Password change and code regeneration require the appropriate password/factor checks and current enrollment; factor state cannot be inherited by a different session.

Session expiry is `min(authenticated_at + 12h, last_user_activity_at + 30m)`. The client sends an activity signal only following trusted UI input while visible, coalesced to at most once per minute; background polling sends none. The server checks session validity before advancing activity using server time. This is an inactivity convention, not proof of a physical human: a hostile authenticated client can send activity. Absolute expiry still holds. Native refresh routes cannot extend the absolute deadline or bypass factor state.

### 4.3 Native route allowlist and reset

Do not mount an unrestricted Better Auth catch-all. G-AUTH generates `docs/auth-route-contract.md` from the pinned integration and records exact method/path, native schema/errors/cookies, allowed account/session phases and CSRF checks. Only sign-in, sign-out, permitted session management, protected password change, enrollment/verification, step-up and recovery-code use/regeneration are eligible. Public signup, reset initiation, MFA disable, trusted-device bypass, organization/admin/social/email plugins and client updates to protected fields are disabled server-side. Unsupported paths return a generic not-found response.

Product reset completion is `POST /v1/auth/reset/complete`; it accepts the single-use token in the body. Operator tooling prints an HTTPS link carrying the token in the fragment. The local SPA reads and immediately clears the fragment, retains it only in component memory while collecting required input, then submits through the protected reset flow; no token in a server URL, analytics or referrer. It never initiates reset. G-AUTH must define the complete native route inventory before auth UI implementation; this document does not invent package-specific endpoint names.

Reset initiation runs outside public processes, locks the account, sets `recovery_pending`, increments its auth epoch, invalidates sessions/challenges and previous reset verifiers, and creates a fifteen-minute token. Expiry leaves the account pending. Password-only recovery still requires the current MFA factor. `reset/complete` atomically consumes the reset verifier and either completes that factor-verified password reset, or enters a restricted `reset_enrollment` challenge after invalidating the old MFA seed/codes. That challenge has the lesser of ten minutes and the original reset deadline, permits only new enrollment verification/sign-out, and never permits product access. Enrollment completion atomically activates the new password/enrollment and invalidates every interim challenge. Expiry or interruption leaves the account recovery-pending for operator reissue; it never restores old login. Final completion requires fresh login. Audit initiation, attempts and completion without tokens.

During restore, the private verification process uses the same tested security modules but no public listener. Off-host operator authority replaces password, enrollment and codes regardless of restored values, revalidates owner membership and removes unexpected grants. Public gate opening never treats an old password/MFA record as current authority.

### 4.4 Authorization pipeline

For each request: gate → bounded headers/body and source rate checks → authentication and mixed-auth rejection → current membership and server-resolved ancestry → visibility → action authority. For replay/status, next inspect the existing operation under current scope/action authorization without requiring new-effect readiness or fresh TOTP. For new work, next check parent/resource state → applicable freshness → admission. Restrictive organization state and quarantine still override ordinary access. Archived/review child scopes may expose their authorized nonsecret operation status. Authorize again at mutation admission. Use current database reads, no cookie authorization cache and no cross-request authorization cache.

Absent and hidden resources share `404 not_found` with identical message shape. Authorized but insufficient action receives 403. Restrictive states follow Document 04; do not disclose them before visibility. Operator status has a separate authority. Previously authorized in-flight work may finish, but newly admitted effects recheck state. No route accepts a namespace, backend path or policy supplied by a caller.

## 5. OpenBao layout and privileges (pending G-BAO)

Organization namespace: `org-<organization_id>`; mount: `kv`; secret address: `p/<project_id>/e/<environment_id>/<NAME>`. Backend paths are generated solely from validated immutable IDs and validated secret names. Mount settings: KV v2, required CAS, twenty versions, no automatic time deletion. Per-key overrides must not relax these settings.

Store each version as an internal envelope `{value: string, operation_id: uuid, format: 1}`. This metadata is inside OpenBao, never an extra application value store. Product responses extract only `value`; the operation marker supports attribution after interrupted writes. A directly usable native machine token may observe this envelope and arbitrary retained versions; the backend is private and the product API exposes only current values. Verify envelope compatibility in PO-2/PO-7.

| Identity | Permitted backend actions | Explicit exclusions |
| --- | --- | --- |
| Organization runtime | Read/write `kv/data/p/*`; read/list metadata; update delete/undelete endpoints | No metadata deletion, destroy, mount settings, policy administration or token creation |
| Organization issuer | Create through exact environment role family; lookup/revoke accessors; read corresponding role/policy | No general create/create-orphan, policy write, accessor enumeration, `sudo` or other namespace |
| Organization provisioner | Create/read/update the defined environment policy and token-role families | No global namespace/auth/mount administration; no data reads; no standing broad operator token |
| Machine token | Read exact environment data prefix; list exact environment name prefix; lookup-self | No write/delete/renew/create, ancestor listing, other environment or namespace; no default policy |
| Backup | Read Raft snapshot endpoint only, subject to PO-13 | No product token or data administration |
| Operator | Explicit bootstrap, namespace setup, accessor inventory, restore/reconciliation | Not held by API/provisioner; supplied to isolated maintenance only |

Policies are rendered from checked IDs into committed templates and read back for canonical comparison. Exact ACL path/list semantics and required capabilities are proved against the pinned API [S1]. KV v2 does **not** support OpenBao policy `allowed_parameters`, `denied_parameters`, or `required_parameters` as a substitute for application validation: only narrowly scoped allowed paths/capabilities, product authorization, fixed backend selectors, CAS and tested preconditions enforce this product contract. Explicit native-denial tests must exercise data version reads, `delete`, `undelete`, `destroy`, `metadata/delete`, ancestor listing and cross-environment paths with the *actual machine token*. The provisioner necessarily has narrowly scoped `sys/policies/acl` rights within its permitted namespace; the exact `sys/` exposure must be listed, evaluated and denied outside its allowed boundary. Do not describe it as incapable of modifying any privileges.

Machine roles fix **only the intended environment policy**, disallow the default policy, create **orphan nonrenewable service tokens**, enforce an explicit maximum TTL and refuse user-provided policy/parentage/renewal overrides. This orphan property is **essential**: the issuer login may expire or be revoked in approximately sixty seconds, whereas a machine token may live up to thirty days. Demonstrate on the pinned OpenBao release that creation through `auth/token/create/<fixed-role>` really yields a parentless service token while the issuer has **no generic token-creation, create-orphan or sudo ability**; inspect `lookup`, effective policy, TTL, `renewable`, `orphan` and accessor. Revoke/expire the issuer and verify the issued machine token *continues to work*, then revoke the machine accessor and prove denial. If fixed-role orphan creation requires authority broader than the intended issuer role, **G-BAO fails** and the architecture must be revised before issuance is implemented. Tokens produced through a parent token without verified orphan semantics are forbidden. Direct renew, create, and other native token endpoints must be tested with the machine bearer and denied, not merely hidden by MyKey's API. Issuer login tokens are short-lived and revoked after use; this must not revoke successfully issued orphan machine tokens. Inline runtime AppRole is a candidate subject to PO-3; its Secret ID still requires protection and restore rotation. IP bindings may add defense in depth but are not proof that stolen credentials cannot be used by a compromised allowed process.

Organization bootstrap records its operation before creating namespace, mount, auth roles and policies. Each deterministic step compares existing state before taking action. A matching existing resource permits continuation, a mismatch enters review; no overwrite of unexpected authority. Set active only after full read-back and owner binding. Initial root token is revoked after bootstrap; recovery material and operator authority remain off-host.

## 6. Coordination and durable execution (candidate pending G-EFFECT)

### 6.1 Selected concurrency model

Serialize backend mutations **per environment**, including issuance and provisioning changes affecting readiness. This is intentionally coarser than per-key locking and satisfies key serialization with simpler complete reads. Different environments may proceed independently. Organization bootstrap uses an organization slot. Project archive is a coordinator over its children, not a database transaction held across all backend calls.

Use a dedicated `pg` connection for a session-level advisory lock identified by the environment's unique bigint lock number. Never return a connection with a held lock to the pool. PostgreSQL session locks survive transaction boundaries but disappear with the session [S2]; therefore the durable `effect_slot`, not the lock, prevents takeover after connection loss.

Acquire the environment session advisory lock before any row locks when it is needed; a lifecycle coordinator must release its row-lock transaction before waiting for an environment lock. Inside short transactions use lock order: capture control → account/session authority when applicable → organization → project → environment → operation/credential/key. Use shared parent locks for admission and exclusive locks for lifecycle changes; multiple IDs are ordered consistently. No transaction-level retry may repeat an external call. DB-only deadlock/serialization retries are bounded and occur before dispatch or during idempotent finalization.

### 6.2 Mutation protocol

1. Validate bounded input in memory; authenticate/authorize and look up the replay identity. If it exists, verify its protected fingerprint and return its nonsecret outcome/status before testing current preconditions, effect slots or fresh TOTP. This path cannot dispatch.
2. For a genuinely new operation, acquire the environment advisory lock within the configured wait. In an admission transaction recheck replay uniqueness first to handle a concurrent insert; then lock/check capture mode, ancestry, current authority, new-effect readiness/freshness, expected version/tag, unresolved slots and capacity. Commit operation, audit intent and durable slot together. The plaintext input remains only in the request executor's memory. A different operation cannot take over an occupied slot.
3. Claim `accepted → executing` through a conditional update with the expected owner/generation, and commit a unique dispatch attempt marker **before** sending the backend request. Recheck that capture permits this already-admitted step and that the host gate/incarnation is valid. Only the executor that successfully commits this transition may send. Even a crash immediately after this commit is treated as potentially dispatched. A duplicate dispatch marker or an uncertain commit acknowledgement is not permission to send.
4. Perform exactly one intended backend effect with no automatic network retry. Read back the required state. For writes use KV CAS; delete/undelete additionally rely on application exclusion because they operate on existing versions [S1].
5. In a final transaction verify operation ownership, update index/tag/generation and outcome, append audit completion, and clear the slot. Finalization may be retried only by the still-valid owner on its original healthy execution connection, as the same metadata commit, never as a new backend mutation. A lost connection or unknown commit result requires read-only outcome inspection and operator reconciliation, not reconnect-and-finalize. Release the advisory lock and clear transient values.
6. Any failure after possible dispatch keeps the durable slot, sets or subsequently recovers to `uncertain`, marks the affected key or environment for review, and returns `503 outcome_unknown` where possible. A lost response after committed success is recovered through replay/status, which must re-check current caller identity/authorization and never redisclose a token or secret-bearing result. Retries without the original request value can query a **nonsecret** status, not recreate a secret-bearing effect; a stale replay cannot cross an account-auth epoch or resource visibility boundary. If final-commit acknowledgement is lost, inspect the durable outcome read-only: never overwrite a committed terminal result or recreate its cleared slot merely because the caller saw a transport failure. Only a still-unresolved record enters reconciliation.

For value-carrying single-key actions, do not accept work into a background queue that cannot retain the value. **The protected request executor must remain alive for the plaintext-bearing effect; a queued ID alone can only resume value-free work or resolve an already-dispatched effect.** If it dies after admission and before a demonstrably excluded dispatch, mark/no-effect reject only after excluding the previous executor. Never pretend an accepted queue job can reconstruct a value absent from any approved persistence surface. If the executor dies before the dispatch marker, operator recovery can prove no dispatch after excluding that executor and reject the operation; the user can then start a new operation. Imports have the explicit `awaiting_input` path. Value-free provisioning/archive jobs carry only operation IDs.

Only dispatch-marked steps enter delayed-effect reconciliation. Every multi-step operation commits a separate step intent/dispatch/outcome; auxiliary issuer login/logout effects are included with their bounded authority and cleanup, not hidden outside the operation. DB-only admission/denial changes commit atomically with their own audit/result. A parent with some effects cannot become `rejected`; known incomplete provisioning/archive remains resumable with explicit step errors, while unknown child effects make the parent uncertain.

An old executor may not reconnect to reclaim ownership. Database ownership checks prevent stale finalization, but do not by themselves fence an already sent backend request. Heartbeat expiry triggers alert/review, not automatic effect execution by another worker.

### 6.3 Replay and state tags

Use UUID idempotency keys generated once per intentional mutation. Fingerprint canonical validated intent, including principal/action/target, preconditions and value/file bytes, with HMAC-SHA-256 under a separate protected key. Store key ID, never a plain hash of low-entropy values. Exact import bytes are bound separately from parsed intent. Rotate fingerprint keys only after every referencing open operation/preview and retained replay record has been handled; never publish fingerprints.

Authorize before lookup. Same identity and fingerprint returns current nonsecret status; different intent returns `409 idempotency_conflict`. An unfinished retry cannot create an executor. Terminal successful issuance always returns `409 credential_not_replayable` with credential ID/state; confirmed rejection returns its recorded failure. Expired replay keys return `409 replay_expired`; clients never manufacture a replacement after uncertainty.

State tags are fresh random identifiers committed after every verified mutation and reconciliation. They are not hashes of version/live state. Increment the environment metadata generation in the same transaction. Every update/delete/undelete/restore requires the original expected version and tag. Create requires no OpenBao history, even if no live value exists. Enforce the environment name and live-byte limits under the same exclusion using the indexed live byte lengths, updated with each verified effect. Reconciliation rebuilds these counters from backend state before admission resumes. Index absence is checked against backend metadata under exclusion. Inconsistency enters review rather than being treated as creation permission.

### 6.4 Reconciliation and delayed-effect boundary — G-EFFECT

First attempt evidence-based resolution while retaining exclusion. A known successful backend response with attributable read-back can complete metadata. The embedded `operation_id` is a useful provenance marker for KV **writes only**; KV soft-delete/undelete, token issuance/revocation and policy/role provisioning do not automatically persist that same value in their resulting data. They require **effect-specific** audit evidence, pre/post backend state, a unique dispatch attempt, and proven old-executor exclusion. OpenBao audit coverage, request-header recording and retention continuity must be verified on the pinned release; a missing audit record or header is never treated as a no-effect certificate. A timeout followed by absence is not proof of rejection. Every backend request carries server-generated operation and dispatch-attempt UUID headers, overwritten rather than accepted from public input. Configure those two *strictly server-generated, nonsecret* headers through the versioned OpenBao audit-request-header configuration, and use no-HMAC only if the pinned release, threat review and recorded audit examples validate their safety. Do not assume every arbitrary header is logged, or that a proxy preserves it. Do not disable HMAC for values, credentials or general payload fields. Correlate request/response audit by backend request ID and the dispatch header [S9]. A missing response still does not prove no effect.

If outstanding execution cannot be excluded, use the conservative Stage 1 maintenance boundary:

1. Close the host service gate and stop all API, provisioner and scheduled backend-effect executors; disable automatic restarts for those units. Block their OpenBao network paths. Verify process/container termination and enumerate every possible writer, including interactive tooling.
2. Stop OpenBao and verify the old process is gone; restart it with only the operator maintenance path reachable. A process restart is selected to terminate in-process KV/token requests, not merely drop client connections. PO-16 must demonstrate this on the pinned Raft/backend configuration; if it does not, remain closed and revise the protocol.
3. Invalidate old executor authority, rotate relevant service credentials and boot IDs, and reconcile durable dispatches against recovered backend state and audit. Revocation alone is not assumed to cancel requests already running.
4. For a write, match operation marker, expected predecessor and backend version. For delete/undelete, require verified target state plus attributable audit/exclusive-history evidence. For issuance, enumerate accessors under **tested operator-level authority** and match safe issuance metadata; **prove that enumeration covers the entire relevant namespace/token population, including orphan credentials created before a lost response**. Revoke every unrecorded/ambiguous token and test denial before permitting replacement. If listing is incomplete, insufficiently privileged, or cannot exclude a late creation, **do not infer absence**; hold the issuing environment, archive and any recovery reopen blocked until a separately proved whole-scope invalidation/rotation procedure makes old issuance authority unusable. Revoking only the short-lived issuer is not sufficient to revoke an already created orphan token. For provisioning, compare each intended object and its audit history.
5. Mark no-effect rejection only after the old execution is excluded and state/evidence proves no effect. If evidence is incomplete, keep uncertainty. Update affected state tags/generations even when reconciled visible state resembles its earlier state. Append reconciliation evidence without values.
6. Restart fresh executors, run negative-access and consistency checks, then reopen through a report bound to this host/backend incarnation. Never clear a slot solely to restore availability.

This trades occasional service-wide maintenance for a smaller correctness surface. It is not a general distributed fencing algorithm. Current Stage 1 effects use local KV/token operations; adding asynchronous external secret engines would require a new termination proof.

## 7. Resource, secret and credential protocols

### 7.1 Resource lifecycle

Project creation commits project plus `development` environment, nonsecret operation and outbox/job reference atomically. Environment state begins pending; humans may use its KV scope only after organization/KV readiness is verified. Machine use waits for exact environment policy/role verification. Successful initial development-environment verification activates the new project as well as that environment; a failed initial verification keeps it non-serving. Later environment creation does not alter an already active project. The transactional outbox commits with the domain change; its dispatcher submits the operation ID and marks delivery, tolerating duplicate submission after interruption. Conditional operation ownership, not queue deduplication alone, prevents duplicate dispatch. Provisioning retries may run a confirmed not-yet-dispatched step or verify an already completed step; they never retry an uncertain backend call blindly.

Archive transaction locks the project/environment and sets `revoking`, with an operation ID and child archive-origin records, before new admission can pass. Environment creation and issuance admission lock the same parent rows. Already admitted effects may finish, but issuance finalization rechecks archive state and never delivers a newly activated credential after archive precedence; it proceeds to revocation instead. Normal archive drains admitted work and revokes every credential in the durable catalog, including newly completed issuance, then verifies each accessor before terminal archived state. It checks that no unmatched issuance step remains. It does not require privileged accessor enumeration in the public issuer. Unknown issuance escalates to **operator-only verified-complete** backend inventory and old-request exclusion; an empty or access-restricted accessor list is **not** proof of no issued token. If it cannot comprehensively identify and revoke potential orphan tokens (or prove a stronger scope-invalidating alternative), the archive remains non-serving and incomplete until that evidence exists. Unknown issuance prevents completion. Known human reads remain available unless review/audit/dependency state blocks them.

Reactivation verifies configuration and restores only children marked as archived by that project operation; independently archived children remain archived. Revoked/expired tokens never reactivate. No project/environment delete route exists.

### 7.2 Secret actions

Create sends CAS zero after proving no metadata history. Update sends expected current version CAS and rejects deleted latest state. Soft-delete targets only the expected current version. Undelete restores that same deleted latest version, never a newer version. Restore reads the selected available historical value in memory and writes a new version with expected-current CAS and a new operation marker. None of these endpoints accepts destroy or metadata-delete selectors.

Backend configuration sets twenty versions. History renders backend state joined with durable attribution; missing/out-of-band attribution is labelled unknown/operator-external. Operator writes require maintenance quarantine and index/tag reconciliation. Name search queries only the metadata index; verify index/backend consistency during provisioning, reads that detect disagreement, scheduled checks and recovery.

### 7.3 Credential issue, use and revoke

Credential display names follow the project display-name length/normalization rules; duplicate labels are allowed because immutable credential IDs identify revocation targets. Issue validates current role/policy digest and owner/admin plus fresh TOTP; creates durable credential `issuing` and issuance operation before dispatch. Put product credential ID and issuance operation ID in backend token metadata to support accessor inventory. The original executor holds the returned token only in memory, verifies effective attributes, then commits accessor/binding/expiry/active state and audit before its one-time response. If archive took precedence, deny delivery and revoke. Failure after dispatch follows uncertainty; loss after success requires explicit revoke/new issue, never retrieval.

Machine request: reject cookie plus bearer; resolve supplied product project/environment identifiers; use the presented token for self-lookup in the server-derived namespace; match accessor to an active credential and its exact scope; check current parents, expiry and gate. Every data/list request to OpenBao uses that same token. No runtime-identity fallback and no history selector. Last use is informational only.

Revoke first commits denied `revoking` state and intent, then revokes by accessor and verifies absence. A sealed backend, denied request or network error is not absence. Reconciliation may safely repeat only a proven idempotent revocation step after accounting for prior execution; never repeat creation. `revoked` is reported only after backend confirmation. Expired credentials deny even if housekeeping has not updated their label.

## 8. Complete reads, imports and export

### Complete environment read

Acquire the environment advisory lock on a dedicated connection, recheck current authority and states, and reject an unresolved effect slot. Latch any connection/lock-ownership loss for the entire read: discard the aggregate and never reconnect to claim uninterrupted exclusion. Before releasing values, perform final state/slot checks and the audit commit on that same still-healthy lock-holding connection. This closes the case where another writer starts after a read loses its lock. Read the full bounded live name set, resolve all values and validate every envelope/value under that same exclusion. Compare metadata against backend state; discrepancy enters review. Native operator changes are prohibited while public access is open. No application mutation can proceed until this read releases the lock.

Build the entire bounded response in memory, append the successful read authorization/outcome audit, then release the lock and send. Already-authorized data may be delivered after a later revocation; this is the specified in-flight boundary. Do not stream values as they are fetched. Empty environments succeed. Every failed key, capacity violation or audit failure discards the aggregate. Single-key known reads use the same advisory lock and final connection checks. They may bypass a durable slot only when it unambiguously targets a different key and neither the environment nor a parent is under review; the current key metadata is checked before and after the backend read. Whole-environment reads and new environment mutations remain blocked; the uncertain key itself never reveals a value.

Machine resolve returns `{apiMajor, environmentId, generation, count, entries, complete:true}` validated as a whole, with unique names and exact count. Serialize once with explicit byte length, disable compression/transformation for sensitive routes, and require full transport completion and schema validation. Human export similarly buffers canonical bytes, supplies `Content-Length` and a `Content-Digest`, and the browser verifies the complete body before creating the download. Digest is transport validation, never a persisted value fingerprint. Unexpected/truncated/non-JSON machine responses produce no launch.

### Import

The parser implements Document 04 format v1 exactly; use fatal UTF-8 decoding and property tests. Literal dollar characters are data. Canonical export sorts names, quotes every value, escapes only the documented characters and ends with LF. Test pinned Next.js and python-dotenv loaders and return compatibility warnings by validated key name, never changed value.

Preview stores actor/scope, exact-file HMAC and per-key metadata/tag observations. At apply acceptance, atomically copy all required preview metadata, classifications, original per-key preconditions and file/key binding into durable parent/entry records. Claim the preview for that operation so another key cannot apply it again. Preview expiry/cleanup cannot erase state needed by an accepted import. Compute unchanged classification while holding the environment lock and reading values only in memory; retain only classification. Invalid or duplicate entries block apply. Deleted/review keys are conflicts. Preview expiration prevents a new apply, not continuation of an already accepted operation.

Apply resubmits the exact file and binds one parent operation. Each entry uses the common mutation protocol and its original preconditions; release exclusion between entries, so import is not atomic and complete readers may observe a completed subset. Recheck unchanged entries. Entry outcomes are created/updated/unchanged/conflict/rejected/uncertain/not-attempted. Stop dispatching on uncertainty; parent becomes uncertain. Parent execution has one conditional executor owner even between child steps; concurrent resumes cannot drive different entries. If an executor loses file bytes, reconcile started children and exclude the old parent executor, then enter awaiting_input only when no child can still act. Awaiting_input holds no slot. Exact-file resubmission explicitly resumes unattempted children under current authorization; newer edits conflict.

All successful/unchanged entries produce succeeded. Known mixed outcomes produce terminal partial. A fully no-effect rejected import is rejected. Explicit abandonment after some completed entries produces partial. Terminal partial is never resumed: preview remaining work anew.

## 9. HTTP and browser contract

Use `/v1` product routes with strict Zod input and runtime output validation. **Route-contract freeze:** the tables in §§9 and 18 are normative API-design candidates, but no feature implementation may begin until `packages/contracts` specifies *exact* methods, route identity, request/response Zod schemas, error variants, authorization and JSON examples, reflected in a generated, approved OpenAPI document. The separate `/v1/operations/:operation` and `/v1/operations/:id/status` descriptions denote **one canonical operation-status interface**, not two independently authorized handlers. Select the canonical route during G-PINS/G-AUTH contract freeze, amend this specification and its acceptance-test expectations, and eliminate or explicitly deny any alias. The same applies to organization overview/metrics and private operator diagnostics. No vague “route family” remains implementer discretion at the start of the relevant work. Reject unknown selector fields. Native auth routes use the G-AUTH allowlist and tested native error mapping. All API/auth responses are `no-store`; sensitive bodies are excluded from compression, caching, proxy buffering to disk and payload logs. Request IDs are generated server-side; accept an upstream ID only from the trusted proxy after strict validation.

Cookie-authenticated POST/PATCH actions, including read-like reveal/export, activity, sign-in and reset completion, require the exact configured Origin. Reject missing/null/foreign Origin and conflicting Fetch Metadata; when Fetch Metadata is unavailable, Origin validation remains mandatory rather than permitting a bypass. GET routes have no state-changing behavior. Test this policy against every allowed native auth route. Machine bearer routes do not use browser cookie authentication. Host-only cookies are Secure/HttpOnly/SameSite=Strict, preferably with the supported `__Host-` naming convention. Restrict trusted proxy configuration to the actual edge hop; ignore arbitrary forwarded source headers.

### Product routes

`E` below means `/v1/organizations/:org/projects/:project/environments/:env`; all IDs are server-validated. Human callers must pass the authorization matrix; operator routes are absent.

| Method / route | Contract |
| --- | --- |
| `GET /health` | Public `{status:"up"}` or `{status:"down"}`; 200/503 only, no component details |
| `GET /v1/version` | Public API major/build identifier; gate still applies |
| `GET /v1/organizations` | Visible organizations only; bounded metadata |
| `GET/POST /v1/organizations/:org/projects` | List/create; creation body `{name}`; creates development environment |
| `PATCH /v1/organizations/:org/projects/:project` | Rename `{name}` |
| `POST .../projects/:project/archive` and `/reactivate` | Explicit confirmation and lifecycle operation |
| `GET/POST .../projects/:project/environments` | List/create `{name}` |
| `PATCH E`; `POST E/archive`, `POST E/reactivate` | Rename or lifecycle operation |
| `GET E/secrets` | Names/metadata only; `prefix`, bounded `limit`, opaque cursor |
| `GET E/secrets/:name/history` | Retained version metadata, no values |
| `POST E/secrets/:name/reveal` | Read-like body `{version?}`; explicit current/historical reveal |
| `POST E/secrets` | Create `{name,value}`; idempotency required |
| `PATCH E/secrets/:name` | `{value,expectedVersion,expectedStateTag}` |
| `POST E/secrets/:name/delete` or `/undelete` | `{expectedVersion,expectedStateTag,confirmed:true}` |
| `POST E/secrets/:name/restore` | `{sourceVersion,expectedVersion,expectedStateTag,confirmed:true}` |
| `POST E/import/preview` | Bounded raw dotenv bytes; returns nonsecret preview/classifications/warnings |
| `POST E/import/:preview/apply` | Same raw bytes and idempotency header; asynchronous/status-capable result |
| `POST E/import-operations/:operation/resume` | Same raw bytes; explicit continuation of existing operation, never a new operation |
| `POST E/export` | Read-like `{confirmed:true}`; fresh TOTP; canonical attachment after complete validation |
| `GET/POST E/credentials` | Inventory / issue `{name,ttlSeconds}`; owner/admin; issue requires fresh TOTP |
| `POST E/credentials/:credential/revoke` | `{confirmed:true}`; denied state before backend revocation |
| `GET /v1/operations/:operation` | Scope-authorized nonsecret status; no fingerprint or request payload |
| `GET E/operations` | Bounded metadata list of recent/unfinished operations for the current principal, with owner/admin visibility in scope; recover status after a lost response without retaining request values |
| `GET /v1/organizations/:org/audit` | Owner/admin; bounded filters and keyset cursor; no global events |
| `POST /v1/session/activity` | Authenticated activity convention; no product mutation key |
| `POST /v1/auth/reset/complete` | Restricted reset flow described in §4, not normal product authorization |
| `GET /v1/reference`, `/v1/openapi.json` | Fully authenticated owner/admin; local read-only reference |
| `GET /v1/machine/projects/:project/environments/:envName/keys` | Bearer only; resolves current name to immutable environment and verifies binding |
| `POST /v1/machine/projects/:project/environments/:envName/resolve` | Bearer-only read; coherent complete set; empty body, no history/version selectors |

All product effect-starting mutations use `Idempotency-Key`, except auth challenges/activity and the explicit existing-operation resume endpoint. The exact allowlisted **Better Auth native routes** are enumerated separately and tested by actual HTTP method, alias, redirect, parameter and plugin endpoint; a GET that changes protected state is not acceptable merely because product routes disallow state-changing GETs. Native signup, MFA disable, reset initiation and device-trust paths must be denied server-side even when invoked directly, with route-level Origin/CSRF enforcement and no other handler path exposed. Resume authorizes the existing replay binding. Read-like POSTs do not create effect replay records. Lifecycle confirmations are required in clients and validated by the API; confirmation is not authority. Display-name edits are DB-only operations whose change, outcome and audit commit together.

Before sending a mutation, web/CLI callers generate and retain the nonsecret idempotency key. The web may keep that key and the eventual operation ID in short-lived UI metadata; it never persists value-bearing form/request bodies. After reload/lost delivery, use the authorized operation list/status rather than guessing a replacement key.

Metadata lists use keyset ordering: secret names by ASCII name, resources by immutable ID, audit by `(timestamp,id)`. Cursor binds scope, filter, last key and metadata generation with a server MAC. Generation change returns `409 listing_changed`; no client may compose a coherent export by collecting list pages. Limits default to fifty/max one hundred. Keep separate generations where unrelated audit appends would otherwise invalidate resource pages. Audit keysets anchor a maximum timestamp/ID from the first page to exclude later inserts.

### Response and error rules

Success schema is route-specific and generated into OpenAPI 3.1. Operation-bearing responses include `{operationId,state,statusUrl,replayExpiresAt,result?}`; unfinished expiry is null. Status GET is 200 even for uncertain, with the actual state. Submission is 202 for accepted/executing/awaiting_input, 503 for unknown outcome, and 200 for succeeded/partial import. Credential success is 201 with the token exactly once; replay uses the specified 409. Single synchronous create is 201; other completed mutations are 200.

Product errors are `{error:{code,message,requestId,operationId?,details?}}`, with allowlisted safe details. Use the Document 04 HTTP table without reinterpretation: malformed 400, auth 401, action/CSRF/freshness 403, hidden/absent 404, stale/replay/review mutation conflicts 409, semantic/missing preconditions 422, rate 429, dependency/busy/uncertainty 503, capacity 507. Never echo invalid values or raw backend errors. Proxy errors may not match this schema; clients handle them as transport failure.

### Browser workflow requirements

Implement owner workflows for projects/environments, secret list/edit/history/reveal, import preview and per-entry progress, export, credential inventory/issue/revoke, audit, account/security/session management and recovery. Every state in Document 04 has explicit UI behavior. Pending/revoking/review/uncertain states are not represented by an indefinite success spinner. Display operation ID and refreshable status, conflict reload/cancel, and operator-required instructions; no force overwrite.

Use TanStack Query only for metadata, with no persistence plugin. Secret-bearing fetches bypass query and mutation caches and keep results only in short-lived component state. Clear on hide/navigation/sign-out/timeout; revoke download object URLs after use. Keep edit/import form bytes only in component memory and clear them on navigation/sign-out/completion; no autosave or persistence for secret-bearing drafts. Require explicit copy/export actions and warnings. Keep one-time token/recovery-code displays out of route state and browser history. No autofill/logging library may retain them inadvertently.

CSP: local scripts only, no inline/third-party scripts, no framing, no object embedding, exact local connection sources and `Referrer-Policy: no-referrer`. Styles/non-script asset directives must match the proven build without weakening script restrictions. Scalar assets are local, telemetry/request execution disabled and network-tested. The native auth client must respect the same CSP and safe error mapping.

## 10. CLI distribution and consumer setup

Commands and exits remain exactly those in Document 04. Configuration contains API URL only. Credential input is `SECRETS_MACHINE_TOKEN`, or explicit stdin for keys/export; reject simultaneous sources. Never offer a token argument. `run` preserves stdin for the child.

Before sending credentials, validate HTTPS URL, reject userinfo/fragments/unsupported redirects, require trusted certificates and check API major at `/v1/version`. Refuse known TLS-disable and code-injection runtime settings, including unsafe `NODE_OPTIONS`/preload/loader settings. A pre-executed hostile launcher cannot be made safe by JavaScript checks; the distribution documents that boundary. Follow no credential-bearing redirects.

`keys` validates the complete name response and prints names only. `run` validates complete resolution, builds the merged environment, removes every `SECRETS_*` variable, checks collisions unless `--override`, closes credential handles and spawns with `shell:false`. Never interpolate a command string. No fallback/cache, including when the parent environment contains similarly named values.

Check both total argument/environment bytes and platform per-string constraints. A response may be valid for export yet too large for process launch; fail safely before spawning where detectable. Handle OS `E2BIG` without logging arguments/values. Test interactive and noninteractive signal/process-group behavior: SIGINT/SIGTERM/SIGHUP/SIGQUIT reach the child without double forwarding, cancellation before spawn creates no child, exit status is preserved or `128 + signal`. Do not claim terminal signal correctness from unit mocks.

`export` resolves and validates before touching the output path. Require a trusted directory with no symlink ancestors; exclusively open a new file with no-follow where supported and mode 0600. Verify handle identity/type/permissions, write completely, flush, close, then report success. On failure unlink only if pathname and open-file identity still match; if a replacement/race is detected, report cleanup required without deleting another file. Directory trust is explicit; the portable Node implementation does not claim to defend against an attacker controlling its parent directory. PO-8/PO-20 prove the chosen APIs on all four targets.

Evaluate OpenBao Agent **public-beta** process-supervisor mode as a genuine native **comparison only**, with its maturity/security/upgrade risks recorded before choosing a production path (see §17.2; AGENT-B1). Retain the **thin first-party CLI** as the preferred production candidate unless the beta alternative achieves full-contract equivalence and a separately approved release-critical beta exception. A standalone binary packaging tool (including Vite+ if its actual supported release permits) is also only a candidate: test real four-platform executable artifacts, otherwise distribute a pinned Node package with an explicitly tested installer/runtime procedure. If Node 26 is selected, verify or provide the actual Linux `libatomic` prerequisite on clean x64/arm64 glibc hosts; fail with clear installation guidance rather than crashing obscurely. Native Windows fails explicitly. Never infer macOS/Linux cross-architecture support from compilation alone.

Provide `docs/runbooks/consumer-local.md` and `consumer-deploy.md`: install/verify, verify endpoint, issue token, supply through protected host/process configuration, resolve synthetic values, launch a real Next.js/FastAPI fixture, rotate, verify the new token, revoke the old token and verify denial. Production consumer bootstrap uses a protected owner-readable credential file/secret mount read by the launch wrapper, not shell history/argv, repository or image. The wrapper exports only to the CLI process and closes/removes its input handle before launching the child. Define backup/custody of that bootstrap credential and replace it after service restore.

## 11. Limits and overload

These are **initial proposed enforced values**, not validated capacity, performance or deployable-safety claims. They live in `packages/contracts/limits.ts` plus typed deployment configuration after G-OPS-DX and G-CLIENT capacity proof, with tested exact boundaries. Quantify peak per-process and total memory use for simultaneously buffered 48 MiB responses, OpenBao envelopes, typed validation, UI export serialization, JSON copies, TLS/proxy buffering, pg pools and two large requests per process; enforce safe backpressure from *measured* memory and connection budgets. A 1,000-name / 8 MiB value set is not evidence that all routes fit their configured response/heap limits. Test body-size rejection **before** large allocation, compression/disk-spill behavior in the real Traefik/Hono stack, and outbound response failures after audit. Increasing or reducing limits requires capacity evidence, synchronized requirements/tests where observable behavior changes, and documented operator guidance.

| Control | Value / behavior |
| --- | --- |
| Session / factor | Thirty-minute user inactivity; twelve-hour absolute; ten-minute fresh TOTP; ten-minute incomplete challenge |
| TOTP / recovery / reset | Six digits, thirty-second step, ±one step; ten recovery codes; fifteen-minute reset link |
| Secret | Name ≤128 ASCII characters; value ≤65,536 UTF-8 bytes; twenty versions |
| JSON body | 512 KiB wire bytes; apply before parsing; nesting depth ≤16 |
| Dotenv file / entries | 1 MiB wire bytes; ≤1,000 entries; preview fifteen minutes |
| Environment capacity | ≤1,000 distinct retained secret names; ≤8 MiB aggregate current value bytes; no automatic deletion to free name capacity |
| Complete response | ≤48 MiB encoded body plus 1 MiB metadata allowance; compute actual serialized size before headers |
| Listing | Default fifty, maximum one hundred; search/filter strings ≤128 characters |
| General requests | Per source 300/minute; per human session 120/minute; per machine credential sixty/minute |
| Header / auth input | Total headers 16 KiB; bearer ≤4 KiB; auth body ≤16 KiB; password ≤1,024 UTF-8 bytes; reset/recovery challenge attempts included in auth source and subject budgets |
| Sensitive reads | Reveal thirty/minute/session; import preview/apply and export five/minute/session |
| Auth attempts | Five/minute/source/phase; five failed attempts/account/phase in fifteen minutes trigger fifteen-minute delay; recovery shares factor limits |
| Concurrent work | ≤64 HTTP requests/process; ≤2 large read/import requests/process; ≤2 API processes initially; provisioner ≤2 active jobs |
| DB capacity | API pool twenty/process; provisioner six; scheduled ops four; PostgreSQL max connections one hundred with reserved operator capacity |
| Waits / deadlines | Pool/advisory acquisition two seconds; individual backend call five seconds; ordinary request thirty seconds; bounded import/resolve/export 120 seconds |
| Operation liveness | Heartbeat every fifteen seconds; executing with no progress for two minutes alerts; no automatic takeover |
| Issuer session / machine lifetime | Issuer sixty seconds where compatible with proven calls; machine default/max 2,592,000 seconds; warn seven days before expiry |
| Disk/inodes | Block expanding writes below fifteen percent free bytes or ten percent free inodes, or below 2 GiB free on a critical data volume |
| Audit reserve | Separate quota/volume budget ≥2 GiB; stop admission before reserve exhaustion; emergency actions still require successful durable writes |
| Backup / expiry | Daily 07:00 Asia/Yerevan (03:00 UTC); age alert >26h; eligibility thirty days from capture; archive upload must complete within two hours of capture |
| Capture / retention cleanup | Freeze >ten minutes alerts; cleanup at least daily; physical pair deletion target ≤48h after eligibility expiry under healthy provider/worker conditions |
| Audit retention | 365 days; separate storage/cleanup policy; no pair-retention coupling |
| Monitoring | External probe and heartbeat every minute with three-minute missing grace; disk/gate/unresolved check every minute; certificate/key expiry daily |
| Reveal display | Clear no later than thirty seconds, sooner on hide/navigation/sign-out |

Implement rate counters atomically in PostgreSQL with fixed-window identifiers and bounded retention; account identifiers are keyed digests, not raw attempted emails. Count unknown accounts equivalently and perform dummy password work where appropriate. Edge limits are an additional layer. Counter failure returns unavailable; no bypass. Successful factor attempts still consume source attempt budget. Credentials, session tokens and codes never become counter keys.

Use bounded queues: when admission capacity or lock wait is exhausted return `503 busy`; reject oversized input/output with 507 or the documented semantic validation error before effects. Deadlines after dispatch produce uncertainty, not safe retry permission. Large operations are admitted before memory allocation; proxy buffering cannot spill sensitive bodies to disk.

Disk flags are advisory inputs to admission, backed by actual write-error handling. Sign-out, credential denial and archive denial use reserved capacity; if durability fails, report failure/unavailability and keep access closed where possible. Reads require functioning audit. A full filesystem must not produce a success response from an in-memory-only state change.

## 12. Audit, health and alerts

Application events use an allowlist: time, action, actor or unauthenticated category, safe scope IDs, outcome, request ID, operation ID and bounded error code. Record all actions enumerated by FR-1.56, including denied access, authentication failures, infrastructure and retention actions. Organization views filter at query time; global maintenance events are operator-only. Log no arbitrary request, response, exception or backend object. Use pino redaction as a second defense only.

Before an effect, commit audit intent with the operation. Before releasing values, commit read authorization/outcome. After an effect, failed completion audit leaves the operation unresolved. Audit outage denies sensitive access and triggers off-host alert; diagnostic denial logs are best effort, never described as durable audit. Configure OpenBao audit with sensitive values protected, no raw logging, operator-only file access and rotation/reopen checks. Canary tests inspect API, proxy, job, database diagnostic and backend audit sinks.

Archive application events and OpenBao audit segments independently of restore pairs. Every segment has a checksum, interval and sequence/cursor manifest; detect gaps, duplicates and failed rotation. Keep local records until off-host upload/decryption/integrity verification succeeds. Do not delete an unarchived segment merely to reclaim disk. Restricted purge is audited before removing expired records. Preserve records for 365 days from event time; segment cleanup is permitted only after its latest event expires. A full-volume event invokes capacity controls, not silent dropping.

Public `/health` is down for gate closure, sealed backend, unavailable PostgreSQL or required audit failure. It does not disclose which. KMS trouble is separately reported to operators because an already unsealed OpenBao may continue serving. Internal checks cover KMS reachability, TLS/KMIP expiry ≤thirty days, latest eligible capture age, freeze duration, disk/inodes, audit health, executing/uncertain work and credential expiry. The off-host probe validates DNS, TLS and response. Healthchecks receives both explicit failures and periodic heartbeats; test host/checker disappearance, not only application error responses.

Each condition maps to one runbook with diagnostic commands, access prerequisites, containment, recovery, verification and escalation. Weekly field-use reports contain P50/P95 latency, resource headroom, backup/restore measurements, CLI failure categories and defects; no sensitive labels or payloads.

## 13. Backup and retention (pending G-BACKUP)

### 13.1 Capture boundary

`service_control.capture_mode` is durable and checked inside every transaction that changes authentication authority, grants, resource lifecycle, secret/token/provisioning admission or operation execution. **Deployment changes to database cluster roles, extensions, `pg_hba.conf`, secret-provider key identities or other recovery-critical configuration cannot race a purportedly eligible pair capture**: they are frozen under an explicit operator maintenance boundary or the candidate pair is rejected and recaptured. Reconstructed globals and the dump must describe the same approved authority configuration epoch. Ordinary read audit and machine-credential informational last-use may continue. Session activity/refresh, factor consumption, challenge creation and session expiry/revocation writes are authority changes, not informational updates; they obey the barrier. Already-valid sessions can read without automatic auth refresh during capture. Native auth writes must join this boundary through the proven auth integration; an auth path outside it fails G-AUTH/PO-21.

Capture coordinator acquires a database coordination lock, commits `draining` with pair ID/epoch, and denies new effect admission. Previously admitted work completes under its recorded admission epoch; no new import child starts. Drain active effects, reconcile uncertain work, and pause idle accepted/awaiting-input work. No unresolved effect may enter an eligible pair. Admission and dispatch/finalization hold the capture-control row lock in their short transactions. The coordinator uses its exclusive row lock for each mode transition, checks every dispatch-marked step including service-token cleanup, and commits `capturing` only after verifying the barrier. Paused accepted jobs/awaiting-input imports are safe only if no backend effect can still run. Scheduled/operator writers and infrastructure changes use the same maintenance boundary or are stopped.

While capturing, deny authority-changing auth/resource operations. Emergency access reduction first invalidates/aborts the candidate capture through the same control row, then commits the reduction; that candidate can never be marked eligible. Do not block emergency containment behind a long dump. Reads and their audit can continue when dependencies are healthy; they do not change restored access authority.

Record capture time at the start of the stable boundary. Obtain a PostgreSQL custom-format consistent dump and OpenBao Raft snapshot while authority/effect state is stable. Capture **PostgreSQL cluster-global role/role-membership/tablespace/configuration-privilege definitions** through a separately reviewed and protected globals export (for example the version-matched `pg_dumpall --globals-only`) or a fully declarative independently tested reconstruction. `pg_dump` of the application database alone **does not include cluster globals**. Reproduce extensions, schema ownership, default privileges, custom functions/security-definer ownership, PostgreSQL configuration and TLS/pg_hba access rules from versioned deployment configuration. The globals export can contain credential verifier hashes and privileged role metadata: store it **inside the encrypted restricted recovery set**, never plaintext logs or publicly readable manifests. Recreate/rotate database login secrets from fresh operator-managed credentials rather than embedding reusable plaintext passwords in manifests. Restorability requires actual least-privilege function checks under `api_runtime`, `provisioner_runtime`, `backup_reader`, `maintenance` and the migration owner on a new cluster. Use a backup backend session established before the stable boundary, with enough bounded lifetime for the capture. Token expiry/background housekeeping may occur naturally; no new application authority or content effect is admitted, and every restored credential is revalidated rather than trusted by snapshot time. The PG dump may include different informational audit/last-use timestamps; that is not an authorization inconsistency. Include schema revision, PostgreSQL **global-role reconstruction artifact/version and role/grant checksums**, release commit/digests, backend version, namespace manifest, operation boundary, gate/capture epoch, off-host recovery dependencies and **every referenced external KMIP seal-key identifier/version**. A pair is not certified *service-recoverable* merely because its database and Raft bytes decrypt: role/privilege reconstruction, available seal keys, audit and private operator entry must also pass the clean-host drill. Never capture authentication keys or a plaintext machine token into application tables.

Any error or crash before completion leaves the candidate ineligible. Freeze does not expire automatically. On coordinator restart, inspect durable capture ownership and process state; resume safely or explicitly abort, audit and clear freeze. Upload failure after a successful capture does not require holding the service frozen: release freeze after both local artifacts and the manifest are complete, then encrypt/upload/verify. The authoritative capture time never changes on retry.

### 13.2 Candidate storage design — independent pairs (G-BACKUP OPEN)

Use a **new local Restic repository per captured pair**. Restic generates its repository encryption key; initialize it under a high-entropy backup password from protected operator-managed storage, with an independently verified off-host copy. The scheduled capture process necessarily receives this password through a protected file/descriptor, never argv/logs. Do not invent or substitute repository encryption primitives. Put both artifacts and the internal manifest into that repository, complete it, run integrity/read verification, close all writers, then archive the entire encrypted repository directory into one immutable bundle. Do not place plaintext source artifacts outside a protected bounded tmpfs or encrypted staging volume. Remove source staging after verified encryption; no swap/core dump exposure.

Upload the bundle under a unique pair-specific object name in the R2 `pairs/` prefix. A thirty-day bucket lock applies to that prefix. Never overwrite, append to, deduplicate across, or prune an uploaded repository. R2 is storing a closed repository archive, not serving as a live Restic repository with mutable lock/index files. This deliberately spends storage to remove shared-pack and repository-lock deletion conflicts [S6–S7]. **The resulting 30-day full-pair storage amplification is an explicit operational-cost risk**: G-BACKUP must measure compressed and encrypted bundle size, thirty-day high-water storage, upload/download egress, local encrypted staging volume space, recovery duration, and whether the OVH/R2 plan can execute it within budget. A passing lock test alone does not validate retention capacity. PO-9 now tests this selected combination rather than the original shared-repository pruning proposal.

Download the uploaded bundle, verify **its full object hash and the authenticated off-host eligibility manifest** (a self-reported manifest checksum is not an independent trust anchor), safely unpack into isolated staging, run a full-data Restic check (`check --read-data`) and restore the **database dump, PostgreSQL globals/reconstruction definitions, Raft snapshot and internal manifest** into isolated staging for checksum comparison; a metadata-only repository check is insufficient. Authenticate manifest provenance using a protected operator-controlled signature/MAC or equivalent approved independent mechanism and test rejection of changed or swapped pair IDs; do not imply R2 lock alone protects against its own administrators. Then write an immutable eligibility manifest under the same locked `pairs/` prefix and its own unique pair-specific key. Eligibility requires the verified bundle and matching manifest; an object existing alone is never enough. Mirror status locally but do not depend on the old host/database to discover recoverable pairs.

Finish bundle upload, download verification and eligibility-manifest publication within two hours of capture or discard the candidate as ineligible and capture a new pair. This deadline covers every retained pair object, so late manifest creation cannot silently extend the normal deletion lag. Retain eligible pairs until `capture_time + 30 days`; upload/verification never extends eligibility. Because the object lock starts at object creation, physical deletion may lag eligibility expiry. Daily maintenance deletes only expired, unlocked pair bundles and their manifests, targeting a maximum forty-eight-hour lag in normal operation. Provider outage or failed maintenance raises an overdue-cleanup incident; this target is not a guarantee against an unavailable provider. For **S3 DeleteObjects/multi-delete**, inspect **each returned object status and error code** even when HTTP status is **200**, and perform subsequent HEAD/LIST verification before claiming physical cleanup; locked objects may be reported as per-key `ObjectLockedByBucketPolicy` errors inside a nominally successful HTTP response. Distinguish expiry of *restore eligibility* from confirmed physical deletion; never remove the last eligible manifest or label a locked pair gone merely from request-level HTTP success. If PO-9 finds actual lock semantics require a longer normal lag, revise the bound before implementation approval.

No Restic prune runs against sealed uploaded bundles. Local repository workspaces are deleted as complete units after verification or failed-candidate cleanup. Multipart failures have their own bounded cleanup and alert; incomplete uploads are not eligible. Protect the deletion credential separately from the ordinary capture process where provider permissions permit; document the actual permissions if object write credentials also permit deletion. Account administrators with adequate permissions may be able to change retention controls; do not claim irreversible WORM protection against them. Keep bucket-configuration permission separate from ordinary backup-upload credentials, exercise deletion/overwrite failures as a low-privilege principal, and verify that changing a bucket-lock rule or using another privileged principal does not silently undermine the documented threat model. Object-lock age is based on actual upload/object age, while restore eligibility is based on **capture time**; evidence must record both clocks and the maximum normal physical-deletion lag.

### 13.3 Key custody and actual-time proofs

Keep backup decryption material, operator recovery authority, **actual independently verifiable access to each external KMIP seal key and every still referenced key version**, replay-fingerprint keys needed by retained/open operations, KMIP certificate reissue authority, private CA/reissue material, **PostgreSQL cluster-global reconstruction authority/artifacts and replacement database credentials**, deployment artifacts and bootstrap runbooks off-host. A valid OpenBao Raft snapshot and OpenBao recovery-key shares **cannot decrypt a root key wrapped by a permanently lost auto-unseal KMS key**. If the referenced seal key was irreversibly deleted, keep the service closed and report affected backup state **UNRECOVERABLE**, not `wrong recovery shares` or `operator reset`; only an independently proved, supported prior migration changes that result. Reference KMS/auth key IDs in manifests; refuse destructive key changes while any physically retained/restorable pair depends on them. Auth keys may be replaced through the private reset procedure rather than recovering old sessions, but this alternative must be exercised.

Audit archives use a separate prefix/policy with 365-day retention and independent encrypted segment manifests. Do not put 365-day retention on the thirty-day pair prefix. Expired restore-pair eligibility never authorizes deleting audit data early.

Start actual-time retention fixtures during the **first proof-only work period**. Short-retention isolated tests can validate mechanics, but **AC-1.36 and AC-1.44 are inherited controlled-use release obligations** for deployed thirty-day retention, actual provider aging/cleanup and oldest eligible pair restoration unless a formally approved identifier-specific amendment changes their due dates. Backdating a Restic snapshot cannot demonstrate R2 expiry. A calendar-dependent proof may delay release beyond coding completion.

## 14. Quarantine, recovery and upgrades

### 14.1 Gate

The candidate externally governed gate is a root-owned host control outside restored PostgreSQL/Raft data; the exact binding and atomic-replacement mechanics remain subject to G-BACKUP. Bind-mount its containing directory read-only into public processes, not the individual file; open the gate by pathname afresh for each check. This design must pass a real in-container atomic-replacement test [S10]. Default/missing/unreadable is closed. State binds `host_instance_id`, `backend_incarnation`, `restore_pair_id` or fresh-install ID, `gate_epoch`, allowed release and successful verification report hash. Write a bounded, strictly validated gate record to a sibling file, fsync it, rename atomically, and fsync the containing directory; reject symlinks/unexpected ownership. Keep independent expected host/backend incarnation values in the supervisor configuration, outside both restored data and the gate record, so the gate cannot validate its own stale identity. Only the host supervisor/operator may change them. Public entry points check it per request and effect admission; no indefinitely cached open value.

The supervisor closes the gate before planned backend replacement/restore and starts fresh installs closed. Unexpected executor/backend failures block affected work and trigger reconciliation; a persisted old open file cannot authorize a new restore because its incarnation/report no longer match. The public maintenance shell contains no protected data; auth/product/reference deny, health is down. Private operator verification is separately authenticated and permitted to perform required recovery while public access remains closed.

### 14.2 Clean-host restore sequence

1. Provision the clean host, closed gate, network/TLS controls and exact compatible release images. Fence the old deployment using provider/host authority before reopening the replacement: stop it or disable its public/backend network paths and prevent automatic restart. If it may still serve, the replacement stays closed; a lost SSH connection alone is not fencing evidence. Verify off-host operator authority and storage/KMS access without consulting the old service.
2. Select an eligible pair from immutable manifests. Verify capture age, hashes, schema/version compatibility and required key IDs; download/decrypt in isolated staging. Record start time and backup age.
3. Stop normal executors and timers. **Before database restore, reconstruct PostgreSQL cluster globals/roles/tablespaces and version-matched extensions through the approved secured operator procedure; rotate fresh database login secrets and reapply source-reviewed pg_hba/TLS/ownership/privilege boundaries.** Restore PostgreSQL application data and Raft into private instances, checking that every referenced KMIP seal key is available before assuming OpenBao can unseal. Restore opens neither public routes nor the job queue. Establish a fresh host/backend incarnation. A restore that succeeds with the database superuser but fails under normal runtime roles is **not** successful.
4. Load PostgreSQL/backends with public processes and dispatchers stopped. Invalidate restored human sessions/challenges/reset/code authority immediately. Inspect capture flags, durable operations and pending jobs without dispatch; freeze/reconcile them only through operator tooling after the next step fences historical service authority. Never dispatch an uncertain operation because a queue delivery is due.
5. Enumerate namespaces and all token accessors under **directly tested sufficiently privileged operator authority**, including root-namespace service tokens, orphan machine tokens and unrecorded issuance; verify the list is complete for the intended scope, not merely that a list request returned HTTP 200. If unrecorded tokens cannot be enumerated or invalidated under proven authority, the gate **stays closed**; short-lived issuer revocation alone cannot invalidate issued orphan credentials. Revoke historical machine/runtime/issuer/provisioner/backup authority as applicable; recreate minimal service identities and rotate AppRole Secret IDs/auth key material. Preserve the active recovery channel until its replacement works, then revoke old operator authority. Verify effective policies/mounts/roles. Reconcile/cancel stale operations and queued work under fresh private authority, applying §6.4 where relevant; no public executor starts before this is complete.
6. Invalidate restored sessions/challenges/reset links/codes and old factor seeds. Through private recovery, set a new password, enroll new TOTP, generate new recovery codes and revalidate sole owner membership. This is a **new current-identity ceremony**, not trusting restored database passwords/factors. The operator procedure must prove the current owner's authority using an independently retained off-host recovery factor/procedure, and must not simply accept the restored owner's pre-loss password/MFA or grant state. Test a compromised restored owner record, a stale recovery token, and a synthetic unauthorized owner/grant insertion. Remove obsolete/synthetic/unexpected grants. Do not issue new machine credentials while quarantined.
7. Prove old credentials fail, public routes stay closed, cross-tenant policy isolation holds, **all normal PostgreSQL runtime roles have exactly their required rights and forbidden rights are denied**, audit works, private owner authentication succeeds, KV state matches and there is no unexplained unfinished effect. Reissue KMIP certificate from off-host authority when needed; verify restart/unseal and superseded access removal.
8. Produce a verification report bound to this host, pair, backend incarnation, release, schema and configuration. Gate-opening tool checks the report and current state, appends audit, then opens deliberately. Failed/stale/mismatched reports leave it closed.
9. Issue new machine credentials after reopening; execute consumer replacement/revocation checks. Capture a new eligible pair. Record elapsed restore/revalidation time and results without claiming an SLA.

Retained old TOTP seeds must not be accepted; tests compare enrollment authority rather than claiming a six-digit number can never recur coincidentally. Production recovery may use real retained encrypted artifacts in a controlled incident, but ordinary CI/staging drills use synthetic data and separate credentials.

### 14.3 Deployment and rollback

Build once from pinned sources and promote the same artifact digest. Validate scans/provenance, run migrations under the deployment role, and execute staged smoke/negative tests before public promotion. Expand/contract migrations preserve the declared previous release where feasible. Otherwise document a tested paired restore rollback with its data-loss boundary and service quarantine. Never downgrade PostgreSQL/OpenBao data files or schema simply by changing an image tag.

Rehearse deployment, failed migration, stopped rollout, supported rollback, KMS/certificate recovery, reconciliation and advisory containment. Disable unreviewed install scripts; pin CI actions by commit. OSV/image scanning must actually cover chosen OS and application artifact formats; add a compatible scanner where coverage is missing. Gitleaks and sentinel tests supplement, not replace, review. Critical/high advisory obligations and field-use duration remain those in 1-01.


## 15. Requirement-to-implementation verification contract

The selected implementation is **not done** because its function exists or a unit test passes. The full release-evidence graph includes the additional stable proofs **KMS-L1, DB-G1, R2-L1, AGENT-B1 and COST-B1** from Document 05 v0.3. No subset may be labeled release-ready while its security/recovery-critical proof is merely planned. Controlled-use release requires all **56** release-applicable acceptance cases on the integrated, pinned deployment, all relevant security proofs, demonstrated credential replacement and recovery, a complete owner interface and an independent security reviewer. The other **four** cases (AC-1.53, -1.54, -1.58, -1.59) are post-release agent/field observations. AC-1.52 is deliberately split: its pre-release portion is synthetic; the first real consumer's actual onboarding occurs after authorization. No real application secrets enter the service before the release manifest is signed.

### 15.1 Test matrix and evidence modes

| Layer | Required evidence | Failure that must be exercised |
| --- | --- | --- |
| Unit/property | Zod contracts, strict dotenv codec, cursor tags, state machine, key derivation names, deterministic error mapping | Invalid values, copy/restore/delete stale preconditions, malformed encodings and parser bombs |
| Database integration | PostgreSQL constraints, transaction boundaries, auth/recovery verifiers, multi-process counters, audit grants and pg-boss role boundaries | Race, `SERIALIZATION_FAILURE`, crash before/after commit, least-privilege SQL direct calls |
| OpenBao integration | Actual 2.7 pinned release, namespace/policy effective permissions, CAS/soft delete/undelete/history, TTL/accessor revoke, real audit | Raw machine token wrong path/version/namespace, issuer escape, delayed network response |
| End-to-end API | Complete Hono routes, no unauthorized native auth routes, current grants, ownership concealment, CSRF and no-store | Forged foreign resources, mixed cookie/bearer, missing Origin, proxy errors, concurrent archive/issue |
| Browser/DX | Every offered owner workflow, metadata-only caches, reveal clearing, activity and expiry provenance, keyboard/narrow view, local Scalar | Lost response, pending or uncertain state, stale measurement, secret in browser stores/logs |
| CLI | Four supported OS/arch combinations with actual consumer fixture, TLS, process/signal propagation, protected token supply, safe exclusive export | Expired token, redirect, truncated JSON, partial set, E2BIG, symlink/racing destination |
| Recovery/security | Independent off-host alert, real KMIP host restart/outage, paired R2 backup and restored quarantine, login/token invalidation | R2 lock and cleanup under real aging, lost host, old owner MFA state, unexpected token issuance |
| Agent/field | Separate synthetic staging runner, test-agent claims, least-permitted executor scope, diary of 28+ days of real use | Agent scope/argument injection, prompt/log leakage, absent or interrupted daily use |

Evidence per result: requirement and AC/PO IDs, commit SHA, dependency manifest hash, migration checksum, container digests, deployed configuration digest, command/fixture, expected and observed result, benign redacted artifacts, failure injection, owner, independent reviewer, outcome, blocking issues and change impact. A vendor documentation link earns `DOCUMENTED`, not `SPIKE-PASS` or `INTEGRATED-PASS`. Each failed proof remains in the record after remediation.

### 15.2 Proof assignments inherited from Document 05

| Technical gate | Inherited proof identifiers | Mandatory interpretation |
| --- | --- | --- |
| G-PINS | PO-24 | Version/advisory/integrated schema/build compatibility; no floating image/action releases |
| G-AUTH | PO-5, PO-6, PO-15 | All auth endpoints and persisted state; no plaintext bearer or recoverable backup code |
| G-BAO | PO-1–4, PO-13; **KMS-L1** | Native/provider tests, retained KMIP seal-key loss/availability and custody, tenant escape and snapshot privilege under real OpenBao |
| G-EFFECT | PO-7, PO-16–18 | Crash-safe effects, replay, issuance inventory, archived credentials and no false no-effect |
| G-RESOLVE | PO-19 | Coherent set or failure; no torn/missing environment read accepted |
| G-CLIENT | PO-8, PO-10–12, PO-20; **AGENT-B1** | CLI, OpenBao Agent beta-maturity assessment, protected setup, CSP, Scalar and actual platform behavior |
| G-BACKUP | PO-9, PO-13, PO-21–22; **DB-G1, R2-L1, COST-B1** | Paired capture, PostgreSQL cluster globals and least privilege, actual R2 lock-aging/per-object deletion, measured full-pair cost, clean-host invalidation |
| G-OPS-DX | PO-14, PO-23 and new DX-specific scenarios | External alert, audit, limits, private/owner status and honest visualizations |
| G-AGENT-FIELD | AC-1.53, -1.54, -1.58, -1.59 | Stage completion after release, never substitute for incomplete release proofs |

### 15.2a Audited proof refinements (not new passing claims)

| Focus | Mandatory evidence before an affected release claim |
| --- | --- |
| Native orphan issuance | Short-lived issuer uses only fixed token role; issued 30-day token has actual orphan/no-default/read-only/nonrenewable attributes; issuer expiry/revocation does not kill token; accessory revocation does; generic creation and native renewal attempts deny |
| Authentication adapter | Inventory **every** native handler and adapter operation including joins, session refresh, cookie cache, cleanup, delete/list, login challenge and MFA recovery; inspect on-disk records/backups and the two-process race; prove permission to intercept all paths on pinned APIs |
| KV mutation attribution | Separate write marker vs delete/undelete/token/provisioning audit evidence; kill/delay after dispatch and after final commit; **enumerate and revoke unrecorded orphan issuance under verified full operator privilege** or retain denied state; absent response/audit or an empty incomplete accessor list never certifies no effect |
| API schema freeze | One canonical operation-status route; concrete typed payloads/errors/auth policies and generated OpenAPI for every §18 endpoint; tests deny all undocumented aliases and unapproved native routes |
| Capacity and backup growth | Measured peak heap/process/DB connections, bounded concurrent full reads/imports, 30-day full-pair R2/storage/staging, actual-time lock-aging/cleanup **including per-object delete errors**, priced API/storage/egress and oldest-pair recovery, with environment-specific budget evidence |
| Tenant-safe observability | Direct member, ungranted member, owner, operator, and machine requests against raw and aggregate endpoints; no count-based foreign disclosure or accessor exposure |
| Restore authority | Closed external gate, lost-host capability, independently available referenced seal key, **PostgreSQL cluster roles/grants restored and least-privilege negative tests**, all namespace/root token accessor inventory, negative historical password/MFA/access and newly verified owner identity; no automatically dispatched queue work after restore |
| Trusted fixture boundaries | Controlled command/args, no agent-visible secret or raw stdout, no injection through fixture output, denials and canary scans across all declared surfaces |

### 15.2b Additional stable proof records from Document 05 v0.3 (all OPEN)

| Proof | Assigned gate | Required reproducible acceptance (synthetic/disposable only) | Fail consequence |
| --- | --- | --- | --- |
| **KMS-L1** | G-BAO / G-BACKUP | Identify every referenced seal key/version and independent off-host access path; demonstrate startup after planned certificate rotation and **closed, explicitly unrecoverable behavior** on loss of a disposable referenced external key. Never destroy a shared or production key. | No claim of recovery from permanently lost seal keys; unresolved key custody blocks relevant release/restore. |
| **DB-G1** | G-BACKUP | Restore database-scoped data **and** PostgreSQL cluster globals, extensions, TLS/pg_hba, ownership/functions and fresh runtime identities onto a clean cluster; show normal role operations pass and forbidden privileges fail. | Restored pair is not service-recoverable; gate stays closed. |
| **R2-L1** | G-BACKUP | Test bucket-lock behavior across actual elapsed lock aging, pair/manifest overwrite and deletion denials, expiry, multi-object HTTP 200 **per-key errors**, eventual verified removal, and oldest eligible restore. | Retention/cleanup claims remain unproved; release-due AC-1.36/1.44 stay open unless formally amended. |
| **AGENT-B1** | G-CLIENT | Record exact public-beta process-supervisor maturity, security/isolation/API differences, upgrade/rollback and operational support risks; compare to the thin first-party CLI with full contract tests. | Reject beta substitution for a critical shipping CLI unless a separate approved exception and equivalence proof exist. |
| **COST-B1** | G-BACKUP | Measure daily encrypted full-pair bytes, peak staging capacity, 30-day retained storage, API operations/cost, retrieval cost, time to eligibility and oldest-pair restore duration against a defensible alternative. | No claim of feasible near-400-hour/low-cost operations without a priced, capacity-tested plan. |

These new identifiers **supplement rather than replace** the inherited 24 PO records. The proof registry must contain owner, due gate, test environment, adverse case, exact release configuration, outcome and independent reviewer; statuses remain **OPEN** in this document. Separate DX and field acceptance evidence retains the Document 04 two-gate split.

### 15.3 Error response semantics and forbidden substitutions

Machine-visible error codes use Document 04's accepted list: `not_found` conceals absent versus hidden resources; `fresh_verification_required` demands *actual recent TOTP*; `outcome_unknown` preserves operation ID; `backend_inconsistent` blocks the narrowest safe scope; `busy` is bounded capacity denial; `listing_changed` prevents accidental assembled snapshots. Unknown outcome is **not** a retryable failed mutation; `revoking` is **not** revoked; an absent read is **not** proof an external request can no longer apply; an owner dashboard estimate is **not** an observed OpenBao fact.

### 15.4 Release versus stage-completion evidence

- **Controlled-use release:** all declared product functionality works; **56 release ACs** (including **fully synthetic AC-1.52** and inherited **AC-1.36/AC-1.44 actual-aging/retention proof** unless formally amended), all release-applicable inherited POs **and additional critical proofs KMS-L1/DB-G1/R2-L1/AGENT-B1/COST-B1** close on exact pins; the independent reviewer signs failure evidence; synthetic-to-real boundary is respected; off-host recovery drill including PostgreSQL privileges and external KMS key custody is complete; product is operable even if Stage 2 is cancelled.
- **Controlled-use operations:** **after approval**, execute and verify first **real non-critical consumer** onboarding under **AC-1.58**, including safe credential supply, launch, revocation/replacement and leakage inspection; only then begin the supported minimum 28-day daily-use observation. **AC-1.52 is exclusively the pre-release synthetic onboarding exercise** and cannot be signed off using an unexecuted real-consumer future step. Failed operational controls trigger containment rather than retroactively changing release requirements.
- **Stage completion:** close AC-1.53/-1.54 with the bounded agent experiment; close AC-1.58 (including **real consumer onboarding** and truthful subsequent 28-day observations) and AC-1.59 with a signed `ADVANCE`, `HARDEN–RE-SCOPE`, `PIVOT`, or `STOP` decision; a `STOP` is **not** permission to pretend an unbuilt product was complete.

## 16. Current-source and version-bound evidence register

This section identifies sources for *candidate component capabilities*. Exact APIs and version-specific behavior must be pinned and proved. A primary-source URL does not certify MyKey's integrated result. The inherited protocol text retains `[S1]`–`[S10]` references resolved in Appendix D; current primary-source review and pin-specific proof obligations supersede those historical checks. Record per-release line-level citations in `docs/evidence/source-manifest.md` after G-PINS.

| ID | Source | Relevance and confidence boundary |
| --- | --- | --- |
| SRC-01 | https://openbao.org/community/release-notes/2-7-0/ | OpenBao 2.7 release lineage, changes and security context; patch and actual release need fresh validation |
| SRC-02 | https://openbao.org/docs/configuration/seal/kmip/ | Native KMIP seal design and external key requirements; verify pinned page and actual OVH KMS account |
| SRC-03 | https://openbao.org/docs/agent-and-proxy/agent/process-supervisor/ | Agent environment injection/process supervisor **public beta**, not an automatically approved distribution |
| SRC-04 | https://openbao.org/docs/next/configuration/seal/ovhcloud/ | External OVHcloud seal plugin example on **development** documentation; released/plugin pin must be verified before adoption |
| SRC-05 | https://www.ovhcloud.com/en/public-cloud/kms/ | Provider product context; actual tenant/certificate/protocol proof required |
| SRC-06 | https://www.better-auth.com/docs/concepts/session-management | Better Auth session/cookie semantics; exact pinned adapter paths must be inspected |
| SRC-07 | https://www.better-auth.com/docs/plugins/2fa | Backup code/trusted device/MFA routes; default behavior is **not** accepted as contract-compliant |
| SRC-08 | https://www.better-auth.com/docs/adapters/drizzle | Supported Drizzle adapter interface; integration overrides remain conditional |
| SRC-09 | https://orm.drizzle.team/docs/overview | Drizzle schemas/migrations and explicit SQL boundaries; supported versions must be checked |
| SRC-10 | https://www.postgresql.org/docs/18/explicit-locking.html | PostgreSQL advisory/transaction/row locks; do not extrapolate cross-store fence |
| SRC-11 | https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ratelimit/ | Traefik Proxy OSS native rate limits, including optional Redis configuration; no new Redis in candidate |
| SRC-12 | https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/distributed-ratelimit/ | Distinct Traefik Hub-branded feature; do not conflate with OSS `rateLimit` options |
| SRC-13 | https://docs.docker.com/compose/how-tos/use-secrets/ | Compose secrets are protected file mounts; no host-operator secrecy guarantee |
| SRC-14 | https://scalar.com/products/api-references | Scalar API references, subject to local asset and request execution test |
| SRC-15 | https://restic.readthedocs.io/en/stable/060_forget.html | Forget/prune distinction and repository-mutation risks |
| SRC-16 | https://developers.cloudflare.com/r2/buckets/bucket-locks/ | R2 bucket lock enforcement; time-based retention must be tested in actual provider environment |
| SRC-17 | https://nodejs.org/en/about/previous-releases and https://nodejs.org/en/blog/release/v26.13.0 | Node 26 became LTS **28 October 2026**; official Linux builds since Node 25 may require `libatomic`. Exact target hosts require proof |
| SRC-18 | https://openbao.org/community/release-notes/2-7-0/ | OpenBao **2.7.2** includes 26 October 2026 security fixes; review on exact pinned patch |
| SRC-19 | https://github.com/traefik/traefik/releases | Traefik Proxy OSS **3.7.17** includes security fixes; version pin/advisory tests still required |
| SRC-20 | https://better-auth.com/changelog | Better Auth **1.7.18** (5 November 2026) includes concurrent revoke-all session fix; evaluate `secondaryStorage`/DB/hook semantics under chosen integration |
| SRC-21 | https://www.postgresql.org/docs/18/app-pg-dumpall.html | `pg_dump` does **not** include cluster-global roles/tablespaces/configuration grants; use protected tested globals reconstruction |
| SRC-22 | https://www.postgresql.org/about/news/postgresql-19-rc-1-released-3409/ | PostgreSQL 19 was release-candidate as of 7 November; GA was planned for 19 November, not yet a validated stable dependency |
| SRC-23 | https://developers.cloudflare.com/r2/buckets/bucket-locks/ | R2 administrator-removable lock rules and `DeleteObjects` HTTP 200 with per-object lock errors require explicit verification |
| SRC-24 | https://openbao.org/docs/concepts/seal/ | External auto-unseal key loss cannot be repaired by OpenBao recovery shares; verify referenced seal key availability and failure state |

### 16.1 Primary-source confirmations and 7 November 2026 updates

- [OpenBao token roles, token hierarchies and orphan tokens](https://openbao.org/docs/concepts/tokens/): a child issuer token's expiry/revocation normally affects children; **token-role orphan semantics are essential** and still require direct fixed-role proof. [Token create](https://openbao.org/docs/commands/token/create/) documents the role parameter, effective TTL and metadata implications.
- [OpenBao KV v2 ACL design](https://openbao.org/docs/secrets/kv/kv-v2/): paths for data, metadata, delete, undelete and destroy differ; parameter restrictions are expressly unsupported for KV v2 policies. Verify exact permissions using the production token, not a simulated role.
- [OpenBao request-header audit configuration](https://openbao.org/docs/api/system/config-auditing/): custom audited headers require explicit privileged configuration; no general claim that arbitrary application headers automatically appear in audit logs.
- [Better Auth database](https://better-auth.com/docs/concepts/database), [session management](https://better-auth.com/docs/concepts/session-management) and [two-factor plugin](https://better-auth.com/docs/plugins/2fa): existing adapters/hooks/plugins provide primitives, not proof of the required verifier-only backup codes, total bearer protection, factor transitions or route suppressions.
- [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/): protection against object overwrites/deletions while applicable; configuration is itself changeable by authorized principals and real object-age tests remain necessary.
- [OpenBao Agent process supervisor](https://openbao.org/docs/agent-and-proxy/agent/process-supervisor/): still marked public beta, and not a demonstrated replacement for a coherent audited MyKey product API/CLI.
- [PostgreSQL 18 pg_dumpall](https://www.postgresql.org/docs/18/app-pg-dumpall.html): database dump alone omits roles and cluster globals; clean-host reconstitution must include privileges and configuration independently.
- [OpenBao seal/unseal](https://openbao.org/docs/concepts/seal/): auto-unseal recovery shares are not a replacement decryptor if the external seal key is permanently lost.
- [Cloudflare R2 bucket lock semantics](https://developers.cloudflare.com/r2/buckets/bucket-locks/): locking is configurable by authorized administrators, and bulk deletion may report per-object failures within HTTP 200.
- [Node.js 26 LTS release](https://nodejs.org/en/blog/release/v26.13.0), [Better Auth release notes](https://better-auth.com/changelog), [OpenBao 2.7 release line](https://openbao.org/community/release-notes/2-7-0/) and [Traefik releases](https://github.com/traefik/traefik/releases): updated security/version candidate context; none is an automatically chosen pin.

These citations support *capability facts only*. No version-specific executable success is inferred.

## 17. High-value architectural alternatives and promotion rules

### 17.1 Native KMIP seal versus external OVHcloud plugin

**Default investigation order:** (a) built-in OpenBao KMIP with externally provisioned key and mTLS credentials; (b) documented released/pinned external OVHcloud seal plugin only if (a) fails or (b) has a verified lifecycle/security advantage; (c) a different tested provider/custody path only under approved P-03 change. Compare number of privileged credentials, expiry/renewal, key versioning, plugin binary provenance, runtime compatibility, certificate custody, loss-of-KMS behavior, restart and clean-host restore. Do not depend on a `/next` API unless the corresponding feature is available and verified on the chosen release. A healthy running unsealed server during a KMS outage is possible; report seal condition and KMS reachability **separately**.

### 17.2 Thin MyKey CLI versus OpenBao Agent process supervisor

OpenBao Agent process supervisor is **a substantial native alternative**; documentation describes `env_template` and `exec` injecting environment variables into child execution, but flags the feature **public beta**, with configurable restart-on-change behavior. Its example is oriented around per-template OpenBao fetch, not MyKey's current-only, all-or-nothing environment API. The CLI remains the candidate default because it can enforce bounded API resolution, service metadata authorization, product audit, no child launch on failure, strict response validation, protected token boundary and exact supported OS semantics.

**Proof comparison (AGENT-B1):** build the same Linux fixture with Agent and MyKey CLI, explicitly treating the Agent supervisor as **public beta** and documenting upgrade/rollback/security support exposure. Test secret name discovery, binary/envelope interpretation, historical-version bypass through raw token, complete-set atomicity under concurrent mutation, backend access networking, startup without partial env, auditing and identity attribution, child signal exit code, token exposure, rotation behavior and cross-platform packaging. Do not claim Agent feature parity unless the complete tests pass. If adopted, revise FR/AC/PO and packaging contracts; not merely swap an executable behind identical claims.

### 17.3 Better Auth adapter alternatives

Preferred conditional design: Better Auth password/session machinery with a complete supported adapter boundary that transforms all bearer writes/lookup/refresh/list/delete paths, enforces verifier-only recovery and strict factor phases, and does not expose public native bypass routes. **Do not rely on database hooks alone.** If the extension cannot safely preserve the contract, choose between a more restricted *supported* native setup and a narrowly defined separate product-session/factor boundary; document the security review and implementation cost. If neither complies, **STOP** before auth-dependent feature work and submit an explicit design decision; no plaintext token storage, recoverable backup codes or trusted-device bypass as fallback.

### 17.4 Issuer identity, DB RLS and other complexity valves

The organization issuer co-resident with the API has a nonzero compromise blast radius even if OpenBao role creation is narrowly constrained. First test policy and role bounds against a hostile API identity. Promote a separate private issuer process only when this materially reduces proven risk without fragile calls, untracked issuance or delayed-effect races. Database RLS is defense in depth only after proving tenant context propagation across Drizzle, Better Auth, pooled workers, migrations and recovery; composite foreign keys, scoped queries and roles remain mandatory regardless. No additional analytics, queueing, cache or workflow subsystem without documented requirement gain and cost comparison.

## 18. Developer experience, analytics and operator-only visibility

### 18.1 Required complete owner surfaces (FR-1.89–1.97)

The shipped React app must support sign-in/factor/session/security management, project/environment overview and readiness/archive/reactivation, bounded secret metadata/search/edit/history/reveal, import preview/apply with per-key outcomes, deliberate human export, machine credential one-time issue/inventory/revoke/replacement, action/operation/audit timeline, and locally bundled protected Scalar/CLI guides. No owner page can offer a button that silently calls operator-only route or implies a disabled feature will arrive in a later stage.

- **Owner project overview:** `project_id`, `environment_id`, name and lifecycle state, indexed secret-name counts and last verified change time. Index-derived counts label their provenance and freshness and do **not** imply whole-environment coherent resolution.
- **Credential page:** immutable scope, `issuing`/`active`/`revoking`/`revoked`/`expired`/`needs_review`, backend effective expiry if known, last use only when observed, seven-day warning, explicit replacement-not-renewal guidance. No token re-display.
- **Activity/operation timeline:** request and durable operation ID, attribution as actually known, state (`accepted`, `executing`, `uncertain`, `awaiting_input`, `partial`, terminal), mutation-safe progress and operator escalation instructions. Owner never receives general backend policy administration or private operator reconciliation controls.
- **Useful analytics:** authenticated organization-filtered, allowlisted event counts and outcomes, safe time distribution, credential status grouping and error/operation trend. Every visualization provides underlying textual/tabular equivalence, source name, observation time, gap/no-data/zero distinctions and access checks **before aggregation**.
- **Private operator status:** KMS reachable and OpenBao unsealed are different fields; show last eligible pair's **capture** age (not upload time), last drill, audit health, capacity, alert delivery age, unresolved operations. Served only through VPN/private operator identity, never through web-owner role or public `/health`.

### 18.2 Application and browser data-handling rules

Use TanStack Query only for scoped metadata and allowlisted metrics; query keys include authenticated tenant scope, and sensitive plaintext calls bypass caches entirely. **Authorization precedes aggregation:** owner-visible organizational totals count only resources the particular current caller is authorized to discover; members with environment grants cannot infer other projects or tenants through counts, event dimensions, credential states, pagination or timing labels. Do not expose token accessors to owner dashboards by default when immutable product credential IDs suffice; if a debug workflow truly needs them, require a separately approved scope and evidence. Invalidate query caches on user/session/organization changes and permission revocation; a metadata cache may display stale UI only with a visible freshness convention and must never authorize an operation. Explicit reveal/copy forms retain the secret for at most thirty seconds in isolated component memory, clear on hide/navigation/sign-out, and do not persist it in logs, chart datasets, URL parameters, object stores, browser databases, session/local storage, service worker cache or request examples. One-time credential and recovery-code display is equally isolated. Browser zeroization is **not** guaranteed by JS state clearing; clipboard/process/export are declared external surfaces.

All status cards derive from real, authorized bounded endpoints; the client never optimistically marks a security effect succeeded. Navigation and error states have keyboard focus handling, labels, accessible name/description, deterministic confirmation text, status not conveyed by color alone and a useful narrow viewport. Test actual keyboard workflows and known-denial states (AC-1.45–52, -1.55–57, -1.60). Do not claim WCAG certification unless separately audited.

### 18.3 Additional API contract (route family; exact route shape reviewed at G-PINS)

| Route family (all versioned unless private) | Required safe response and authority |
| --- | --- |
| `/v1/organizations/:org/overview` | Current authorized owner/member scoped resource counts, lifecycle and source time; no values |
| `/v1/organizations/:org/credentials/summary` | Authorized owner/admin credentials by state/expiry; only IDs, accessors when authorized and safe, never token bytes |
| `/v1/organizations/:org/activity` | Scoped append-only event and operation metadata, bounded cursor, operation linkage, no raw backend payload |
| `/v1/organizations/:org/metrics` | Allowlisted aggregates tagged with source window/sampling/freshness; no cross-tenant dimensions |
| `/v1/operations/:id/status` | Current authorized nonsecret operation state; `uncertain` never described as definite failure |
| Private operator interface | **Not** under public router or web credential authority; its own VPN/authenticated maintenance gate and allowlisted status only |

These are **route family design proposals**, not new unreviewed user privileges. The exact methods, path structure and response Zod schemas will be committed in `packages/contracts` and generated OpenAPI, with explicit tests against native auth routes and authorization matrix. A more consolidated endpoint layout is acceptable only when the same functional contract is preserved and Document 06 is amended before implementation.

### 18.4 Scalar and documentation

Bundle and pin Scalar locally, authenticate documentation as an owner-only/read-only reference, and disable request execution (`Try it`), token persistence, external scripts, telemetry and hosted fonts. Its existence does not excuse standalone CLI setup, error/reference and operator runbooks. Captured browser network events must demonstrate no unsolicited third-party requests or credential-bearing interactive references (PO-10). Structured OpenAPI examples contain synthetic placeholder values, never actual tokens or real secret values.

## 19. Bounded agent-initiated validation (stage completion)

**This is a test harness, not a public feature:** a trusted executor in independent staging/synthetic environment receives a predetermined allowlisted request from an external test agent, fixes the tenant/environment/fixture command and arguments itself, retrieves an already-issued test machine token from protected executor setup, and calls **the shipping CLI** to launch a controlled fixture child. Only allowlisted exit status, safe operation/result category and correlation ID may be returned. Neither arbitrary command/arguments/path/env/secret selection nor raw child stdout/stderr can be supplied to or observed by the agent. Requesting test-agent ID is only harness-level attribution; OpenBao machine-token scope authenticates the **executor machine identity**, not a federated agent principal.

**Negative suite:** unauthorized scope or argument request, prohibited command or path, expired/revoked token, incomplete resolution, backend/KMS/unavailable service, lost child result, prompt injection via status text, and secret sentinels in possible output surfaces. The executor must reject unsafe requests before credential retrieval, and failed resolution must not spawn a child. The fixture process itself receives the synthetic secret-bearing environment; therefore all observed outputs, inherited environment, crash paths, debugger hooks, build/test runners and child-process descendants belong to the executor's declared trust boundary. The harness does not establish confidential execution against arbitrary agent-controlled code, a compromised host, or hostile code loaded by the trusted fixture. Inspect model prompt/output, tool transcripts, child output boundary, argument vectors, executor/CLI logs, files, metrics, crashes and proxy events with explicit coverage limitations. The user-facing documentation must state that a malicious arbitrary-code executor with legitimate environment access can read/exfiltrate secrets. Close AC-1.53/-1.54 **after** controlled-use release; Stage 1's product is already complete without shipping a general agent runtime.

## 20. Architecture decision and scope-control register

| ID | Decision status | Owner / trigger | Required recorded result |
| --- | --- | --- | --- |
| DEC-01 | Conditional | G-PINS | Pinned Node/OpenBao/PG/Hono/Better Auth/Drizzle/Traefik/Scalar/CLI matrix and image/action digest manifest |
| DEC-02 | **Blocking** | G-AUTH | Supported protected session/recovery integration or explicit reviewed replacement with all negative proofs |
| DEC-03 | **Blocking** | G-BAO | Native KMIP vs external OVH plugin actual provider interoperability and restore plan |
| DEC-04 | **Blocking** | G-EFFECT | Per-effect intent/dispatch/exclusion/reconciliation/uncertainty rules, with successful kill-delay evidence |
| DEC-05 | Conditional | G-CLIENT | MyKey CLI vs OpenBao Agent comparative proof and four-platform distribution choice |
| DEC-06 | **Blocking before real secrets** | G-BACKUP | Paired capture, R2 retention/prune lifecycle, off-host key custody and clean-host quarantine |
| DEC-07 | Conditional | G-BAO + G-EFFECT | Co-resident issuer authority vs private issuer service, proven blast radius and issuance sequencing |
| DEC-08 | Conditional | G-OPS-DX | Owner interface/analytics minimum and private operator diagnostics test evidence |
| DEC-09 | Pre-implementation governance | P-01/P-02/P-03 originals | Signed reconciliation, FR/AC/PO amendments and decision log; no silent supersession |
| DEC-10 | Pre-roadmap | Document 07 | Risk-adjusted bottom-up estimates including independent review, **release-due actual aging**, field corrections and full-pair backup economics |
| DEC-11 | **Blocking for recovery claims** | G-BAO / G-BACKUP — KMS-L1 | Off-host seal-key/version custody, failure if referenced key permanently lost, non-destructive production handling |
| DEC-12 | **Blocking for recovery claims** | G-BACKUP — DB-G1 | Clean-host PostgreSQL global role/extension/grant restoration and least-privilege negative tests |
| DEC-13 | **Blocking for retention claims** | G-BACKUP — R2-L1 | Verified lock duration, per-object deletion errors/physical cleanup, oldest pair and release calendar |
| DEC-14 | Conditional CLI maturity decision | G-CLIENT — AGENT-B1 | Production thin CLI preference or separately reviewed beta exception with full contract proof |
| DEC-15 | Conditional feasibility/cost | G-BACKUP — COST-B1 | Measured full-pair storage/API/retrieval economics and capacity guardrails |

**Change control:** A failed compatibility/proof may justify a narrowly tested fallback and corresponding revised technical design. It may **not** authorize incomplete product functionality, an untracked scope deletion, reduced security, or a false PASS. Any removal/deferment of an approved FR requires synchronized Document 03/04/05/06 changes, AC/PO disposition, stage-boundary approval and an updated estimation/evidence plan. The session-preparation document (**07**) owns decomposition and logical ordering; the implementation roadmap (**08**) owns step-by-step runbooks, entry/exit tests and precise handoffs. Neither can invent architectural decisions to fill an unresolved safety gap.

## Appendix A — Functional requirement implementation index (102 entries)

This table is a **technical navigation and proof map**, not a replacement for the full normative wording in Document 04 or the per-requirement fit-gap analysis in Document 05. Every row refers to a concrete design section and recorded AC linkage; all `OPEN` until verified. Where a row targets a conditional component, the gate in §1.4 and Document 05 takes precedence over apparently definitive design language.

| Requirement | Scope label | Selected enforcing/design location | Principal AC linkage | Pre-release status |
| --- | --- | --- | --- | --- |
| FR-1.01 | Bootstrap. | §4 Auth + §1.4 G-AUTH | AC-1.01 | OPEN — RELEASE PROOF |
| FR-1.02 | Authentication. | §4 Auth + §1.4 G-AUTH | AC-1.02, AC-1.04 | OPEN — RELEASE PROOF |
| FR-1.03 | Enrollment/recovery codes. | §4 Auth + §1.4 G-AUTH | AC-1.02 | OPEN — RELEASE PROOF |
| FR-1.04 | Operator reset. | §4 Auth + §1.4 G-AUTH | AC-1.03 | OPEN — RELEASE PROOF |
| FR-1.05 | Password change. | §4 Auth + §1.4 G-AUTH | AC-1.04 | OPEN — RELEASE PROOF |
| FR-1.06 | Session lifecycle. | §4 Auth + §1.4 G-AUTH | AC-1.04 | OPEN — RELEASE PROOF |
| FR-1.07 | Throttling. | §4 Auth + §1.4 G-AUTH | AC-1.05 | OPEN — RELEASE PROOF |
| FR-1.08 | Organization provisioning. | §5 OpenBao + §7 credentials | AC-1.06 | OPEN — RELEASE PROOF |
| FR-1.09 | Tenant resolution. | §5 OpenBao + §7 credentials | AC-1.07, AC-1.46 | OPEN — RELEASE PROOF |
| FR-1.10 | Current authorization. | §5 OpenBao + §7 credentials | AC-1.07, AC-1.08 | OPEN — RELEASE PROOF |
| FR-1.11 | Hidden resources. | §5 OpenBao + §7 credentials | AC-1.07, AC-1.08 | OPEN — RELEASE PROOF |
| FR-1.12 | Backend inconsistency. | §5 OpenBao + §7 credentials | AC-1.09, AC-1.46 | OPEN — RELEASE PROOF |
| FR-1.13 | Privilege separation. | §5 OpenBao + §7 credentials | AC-1.06, AC-1.07 | OPEN — RELEASE PROOF |
| FR-1.14 | Projects. | §7.1 resources | AC-1.10 | OPEN — RELEASE PROOF |
| FR-1.15 | Environments. | §7.1 resources | AC-1.10 | OPEN — RELEASE PROOF |
| FR-1.16 | Readiness. | §7.1 resources | AC-1.10 | OPEN — RELEASE PROOF |
| FR-1.17 | Archive. | §7.1 resources | AC-1.11 | OPEN — RELEASE PROOF |
| FR-1.18 | Reactivate. | §7.1 resources | AC-1.11 | OPEN — RELEASE PROOF |
| FR-1.19 | No deletion. | §7.1 resources | AC-1.11 | OPEN — RELEASE PROOF |
| FR-1.20 | Values. | §6 effects + §7.2 secrets | AC-1.12 | OPEN — RELEASE PROOF |
| FR-1.21 | Metadata. | §6 effects + §7.2 secrets | AC-1.12 | OPEN — RELEASE PROOF |
| FR-1.22 | Reveal. | §6 effects + §7.2 secrets | AC-1.13, AC-1.50 | OPEN — RELEASE PROOF |
| FR-1.23 | Copy. | §6 effects + §7.2 secrets | AC-1.13, AC-1.50 | OPEN — RELEASE PROOF |
| FR-1.24 | Create. | §6 effects + §7.2 secrets | AC-1.14 | OPEN — RELEASE PROOF |
| FR-1.25 | Update. | §6 effects + §7.2 secrets | AC-1.14 | OPEN — RELEASE PROOF |
| FR-1.26 | History. | §6 effects + §7.2 secrets | AC-1.12, AC-1.15 | OPEN — RELEASE PROOF |
| FR-1.27 | Soft-delete. | §6 effects + §7.2 secrets | AC-1.15 | OPEN — RELEASE PROOF |
| FR-1.28 | Undelete. | §6 effects + §7.2 secrets | AC-1.15 | OPEN — RELEASE PROOF |
| FR-1.29 | Restore version. | §6 effects + §7.2 secrets | AC-1.15 | OPEN — RELEASE PROOF |
| FR-1.30 | Concurrency. | §6 effects + §7.2 secrets | AC-1.14, AC-1.15 | OPEN — RELEASE PROOF |
| FR-1.31 | Unknown result. | §6 effects + §7.2 secrets | AC-1.16 | OPEN — RELEASE PROOF |
| FR-1.32 | No destruction interface. | §6 effects + §7.2 secrets | AC-1.15 | OPEN — RELEASE PROOF |
| FR-1.33 | Format v1. | §8 import/exports | AC-1.17 | OPEN — RELEASE PROOF |
| FR-1.34 | Loader compatibility. | §8 import/exports | AC-1.17 | OPEN — RELEASE PROOF |
| FR-1.35 | Preview. | §8 import/exports | AC-1.17 | OPEN — RELEASE PROOF |
| FR-1.36 | Apply. | §8 import/exports | AC-1.17, AC-1.39 | OPEN — RELEASE PROOF |
| FR-1.37 | Export. | §8 import/exports | AC-1.17 | OPEN — RELEASE PROOF |
| FR-1.38 | Round trip. | §8 import/exports | AC-1.17, AC-1.21 | OPEN — RELEASE PROOF |
| FR-1.39 | Issue. | §5 OpenBao + §7 credentials | AC-1.18, AC-1.40, AC-1.47 | OPEN — RELEASE PROOF |
| FR-1.40 | Native scope. | §5 OpenBao + §7 credentials | AC-1.07, AC-1.19 | OPEN — RELEASE PROOF |
| FR-1.41 | Inventory. | §5 OpenBao + §7 credentials | AC-1.18 | OPEN — RELEASE PROOF |
| FR-1.42 | Revoke. | §5 OpenBao + §7 credentials | AC-1.18, AC-1.40 | OPEN — RELEASE PROOF |
| FR-1.43 | Uncertain/lost issuance. | §5 OpenBao + §7 credentials | AC-1.18, AC-1.40, AC-1.47 | OPEN — RELEASE PROOF |
| FR-1.44 | Machine routes. | §7.3 + §8 resolution | AC-1.19 | OPEN — RELEASE PROOF |
| FR-1.45 | Residual. | §7.3 + §8 resolution | AC-1.19 | OPEN — RELEASE PROOF |
| FR-1.46 | Credential input. | §10 CLI + §9 HTTP | AC-1.20, AC-1.52 | OPEN — RELEASE PROOF |
| FR-1.47 | keys. | §10 CLI + §9 HTTP | AC-1.20 | OPEN — RELEASE PROOF |
| FR-1.48 | run. | §10 CLI + §9 HTTP | AC-1.20 | OPEN — RELEASE PROOF |
| FR-1.49 | Failure. | §10 CLI + §9 HTTP | AC-1.20, AC-1.29, AC-1.37, AC-1.54 | OPEN — RELEASE PROOF |
| FR-1.50 | export. | §10 CLI + §9 HTTP | AC-1.21 | OPEN — RELEASE PROOF |
| FR-1.51 | Platforms. | §10 CLI + §9 HTTP | AC-1.20, AC-1.52 | OPEN — RELEASE PROOF |
| FR-1.52 | Contract. | §9 browser + §12 audit | AC-1.22 | OPEN — RELEASE PROOF |
| FR-1.53 | No passthrough. | §9 browser + §12 audit | AC-1.22 | OPEN — RELEASE PROOF |
| FR-1.54 | Reference. | §9 browser + §12 audit | AC-1.22 | OPEN — RELEASE PROOF |
| FR-1.55 | Operator surface. | §9 browser + §12 audit | AC-1.22 | OPEN — RELEASE PROOF |
| FR-1.56 | Coverage. | §9 browser + §12 audit | AC-1.13, AC-1.23, AC-1.50 | OPEN — RELEASE PROOF |
| FR-1.57 | Backend audit. | §9 browser + §12 audit | AC-1.23 | OPEN — RELEASE PROOF |
| FR-1.58 | Audit view. | §9 browser + §12 audit | AC-1.23 | OPEN — RELEASE PROOF |
| FR-1.59 | Correlation. | §9 browser + §12 audit | AC-1.23, AC-1.29 | OPEN — RELEASE PROOF |
| FR-1.60 | Limits. | §11 limits + §12 operations | AC-1.24 | OPEN — RELEASE PROOF |
| FR-1.61 | Disk pressure. | §11 limits + §12 operations | AC-1.24 | OPEN — RELEASE PROOF |
| FR-1.62 | Health. | §11 limits + §12 operations | AC-1.25, AC-1.49 | OPEN — RELEASE PROOF |
| FR-1.63 | Alerts. | §11 limits + §12 operations | AC-1.18, AC-1.25, AC-1.49 | OPEN — RELEASE PROOF |
| FR-1.64 | Auto-unseal. | §5 OpenBao + §7 credentials | AC-1.26 | OPEN — RELEASE PROOF |
| FR-1.65 | Certificate recovery. | §5 OpenBao + §7 credentials | AC-1.26 | OPEN — RELEASE PROOF |
| FR-1.66 | Paired backup. | §13–14 recovery | AC-1.27, AC-1.57 | OPEN — RELEASE PROOF |
| FR-1.67 | Restore quarantine. | §13–14 recovery | AC-1.28 | OPEN — RELEASE PROOF |
| FR-1.68 | Access revalidation. | §13–14 recovery | AC-1.28, AC-1.43 | OPEN — RELEASE PROOF |
| FR-1.69 | Measurements. | §13–14 recovery | AC-1.28 | OPEN — RELEASE PROOF |
| FR-1.70 | Staging. | §13–14 recovery | AC-1.28, AC-1.57 | OPEN — RELEASE PROOF |
| FR-1.71 | Transport. | §2 host + §14 delivery | AC-1.30 | OPEN — RELEASE PROOF |
| FR-1.72 | Host boundary. | §2 host + §14 delivery | AC-1.31 | OPEN — RELEASE PROOF |
| FR-1.73 | Supply chain. | §2 host + §14 delivery | AC-1.32 | OPEN — RELEASE PROOF |
| FR-1.74 | Runbooks/upgrades. | §2 host + §14 delivery | AC-1.33 | OPEN — RELEASE PROOF |
| FR-1.75 | Honest use. | §2 host + §14 delivery | AC-1.33, AC-1.60 | OPEN — RELEASE PROOF |
| FR-1.76 | Browser protection. | §4 Auth + §1.4 G-AUTH | AC-1.34 | OPEN — RELEASE PROOF |
| FR-1.77 | Fresh verification. | §4 Auth + §1.4 G-AUTH | AC-1.35 | OPEN — RELEASE PROOF |
| FR-1.78 | Retention/key custody. | §13–14 recovery | AC-1.36 | OPEN — RELEASE PROOF |
| FR-1.79 | Connection. | §10 CLI + §9 HTTP | AC-1.37 | OPEN — RELEASE PROOF |
| FR-1.80 | Secret-free diagnostics. | §9 browser + §12 audit | AC-1.13, AC-1.50 | OPEN — RELEASE PROOF |
| FR-1.81 | Audit integrity/retention. | §9 browser + §12 audit | AC-1.23, AC-1.36, AC-1.50 | OPEN — RELEASE PROOF |
| FR-1.82 | Durable operation lifecycle. | §6 effects + §7.2 secrets | AC-1.38, AC-1.48 | OPEN — RELEASE PROOF |
| FR-1.83 | Replay contract. | §6 effects + §7.2 secrets | AC-1.39, AC-1.40, AC-1.48 | OPEN — RELEASE PROOF |
| FR-1.84 | Complete read. | §7.3 + §8 resolution | AC-1.41 | OPEN — RELEASE PROOF |
| FR-1.85 | Setup/rotation. | §10 CLI + §9 HTTP | AC-1.42, AC-1.52 | OPEN — RELEASE PROOF |
| FR-1.86 | Human recovery after restore. | §4 Auth + §1.4 G-AUTH | AC-1.43, AC-1.57 | OPEN — RELEASE PROOF |
| FR-1.87 | Restore readiness. | §13–14 recovery | AC-1.44, AC-1.57 | OPEN — RELEASE PROOF |
| FR-1.88 | Reconciliation. | §6 effects + §7.2 secrets | AC-1.38, AC-1.48 | OPEN — RELEASE PROOF |
| FR-1.89 | Owner information architecture. | §18 DX | AC-1.45 | OPEN — RELEASE PROOF |
| FR-1.90 | Project and environment overview. | §18 DX | AC-1.46, AC-1.55 | OPEN — RELEASE PROOF |
| FR-1.91 | Credential understanding. | §18 DX | AC-1.47 | OPEN — RELEASE PROOF |
| FR-1.92 | Operation and activity timeline. | §18 DX | AC-1.48, AC-1.55 | OPEN — RELEASE PROOF |
| FR-1.93 | Actionable cross-surface errors. | §18 DX | AC-1.48 | OPEN — RELEASE PROOF |
| FR-1.94 | Truthful, useful product-local measurements. | §18 DX | AC-1.46, AC-1.50, AC-1.55 | OPEN — RELEASE PROOF |
| FR-1.95 | Private operator status. | §18 DX | AC-1.49 | OPEN — RELEASE PROOF |
| FR-1.96 | Interaction quality. | §18 DX | AC-1.45, AC-1.51 | OPEN — RELEASE PROOF |
| FR-1.97 | First-run and integration instructions. | §18 DX | AC-1.45, AC-1.52, AC-1.60 | OPEN — RELEASE PROOF |
| FR-1.98 | Controlled agent-initiated execution fixture — stage-completion evidence. | §19 agent validation | AC-1.53, AC-1.54 | FIELD — NOT YET DUE |
| FR-1.99 | Agent denial and leakage observation — stage-completion evidence. | §19 agent validation | AC-1.53, AC-1.54 | FIELD — NOT YET DUE |
| FR-1.100 | Field-use observation — stage completion only. | §15 evidence + §20 control | AC-1.58, AC-1.59 | FIELD — NOT YET DUE |
| FR-1.101 | Two distinct evidence gates. | §15 evidence + §20 control | AC-1.56, AC-1.57, AC-1.58 | OPEN — RELEASE PROOF |
| FR-1.102 | Evidence/provenance, release boundary and honest claims. | §15 evidence + §20 control | AC-1.46, AC-1.50, AC-1.55, AC-1.56, AC-1.59, AC-1.60 | OPEN — RELEASE PROOF |

## Appendix B — Acceptance scenario and release gate index (60 entries)

Every AC is normative only in Document 04; this compact index fixes its **evidence gate and implementation area**. Tests must be generated/reviewed from the complete AC text rather than these short descriptions. All 60 are presently **OPEN**.

| AC | Test intent (abbreviated) | Gate | Implementation focus |
| --- | --- | --- | --- |
| AC-1.01 | Inventory every account-creation path and call it directly: all refuse; operator bootstrap interrupted/retried… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.02 | Password-only and MFA-enabled-account/unverified-session states deny product access; enrollment and step-up… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.03 | Reset initiation blocks ordinary sign-in and invalidates sessions/challenges; only one link redeems, old links… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.04 | Sign-out/revocation/password change end intended sessions; 30-minute inactivity and 12-hour absolute expiry… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.05 | Password/TOTP/recovery-code abuse throttled per account/source across two API processes; error responses… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.06 | Interrupt provisioning at every boundary; retry yields one verified namespace/owner binding, never broader… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.07 | Guessed foreign IDs and forged backend selectors reveal no tenant data; organization A’s… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.08 | Exercise every authorization-matrix cell and parent-state override; grants combine correctly; revoked… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.09 | Remove or alter a required policy/mount/role on staging: 503, narrow review state, and alert; no fallback identity | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.10 | Create project/development environment; test NFC/case/length/whitespace rules and environment names; renames… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.11 | Archive racing creation/issuance cannot leave a usable token; restart resumes revocation; humans retain… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.12 | Boundary names and 65,536-byte multiline/empty/Unicode values pass; oversized/NUL/reserved names fail without… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.13 | Canary sweep after reveal/copy/export/issuance/reset/sign-out: no values or credentials in prohibited… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.14 | Two valid updates using the same version/tag: exactly one succeeds; stale/missing preconditions fail; creation… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.15 | Race lifecycle mutations across processes; capture a tag, delete and undelete the same version, then reject… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.16 | Timeout after a real backend write yields uncertain status, operation ID, blocked key, and no automatic replay | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.17 | Property-test codec boundaries/literal dollars/loader warnings; previews hide values, bind protected… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.18 | Issue once; inspect persistence; positive TTL enforced, actual expiry displayed, nonrenewal and seven-day… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.19 | Machine reads only bound current values via its own token; history selector fails; native write/delete/token… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.20 | CLI supplies complete values to Next.js/FastAPI fixtures without files or credentials; test argument vectors,… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.21 | Export creates, flushes, and closes a new 0600 file; existing paths/symlink traversal refused; own partial… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.22 | Product OpenAPI matches validation; auth-route inventory/native shapes and web mapping tested; breaking change… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.23 | Coverage and safe correlation verified; runtime cannot change audit; tenant/global separation and 365-day… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.24 | Input/output/list/rate/concurrency limits reject before exhaustion; failed limiter denies; low disk blocks… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.25 | Simulate every listed condition plus stopped host/checker, DNS failure, and invalid public certificate; alerts… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.26 | Restart container and host with real KMS; unavailable KMS during restart and revoked certificate prevent… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.27 | Capture while reads/audit continue and auth/resource/token/provisioning changes compete; paired state remains… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.28 | Restore stays closed despite active rows; failed step/stale report rejected; private service credential… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.29 | Product errors match envelope; native auth responses match documented web mapping; safe HTTP/CLI categories… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.30 | Public HTTPS/HSTS; no HTTP listener; internal plaintext/unverified TLS rejected; CLI cannot bypass TLS | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.31 | External exposure matches HTTPS plus WireGuard exception; SSH is VPN-only/key-only; private services… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.32 | Seeded dependency/image vulnerability and seeded secret block release; reviewed exceptions trace to verified… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.33 | Execute alert and recovery runbooks on staging; rehearse migrations, upgrade and supported rollback; compare… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.34 | Cross-site state changes rejected even through direct auth routes; inline/third-party scripts and framing… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.35 | Stale fresh-verification time or new session without recent TOTP gets 403 for every sensitive action; valid… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.36 | Eligibility and physical retention match documented rules; referenced KMS key destruction refused; oldest… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.37 | CLI rejects HTTP, invalid certificate, unsafe runtime configuration, incompatible API major, and… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.38 | Kill executors at intent/dispatch/backend-success/final-commit boundaries; also delay a backend request past… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.39 | Concurrent replay yields one effect; changed intent conflicts and unauthorized replay/status denies.… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.40 | Lose issuance response at each boundary; unfinished retry returns status, successful replay returns no token… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.41 | Resolve/export during mutations/import: coherent set or explicit failure. Empty set succeeds.… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.42 | Execute installation, endpoint verification, protected token supply, rotation, revocation, and post-restore… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.43 | Restore a stale pair containing old password/MFA/codes/reset links and obsolete grants; private recovery… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.44 | Recover using documented off-host material only, with unavailable old host/service; perform… | CONTROLLED RELEASE | §4–14 underlying system |
| AC-1.45 | From fully authenticated owner entry, exercise every declared owner operation end to end through the installed… | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.46 | Create active, pending, archived, revoking and review fixture resources and exercise visibility, counts,… | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.47 | Display active, expiring, expired, issuing, revoked, revoking and needs-review credentials using… | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.48 | Force a delayed secret mutation, unknown issuance and interrupted import. Operation/activity UI distinguishes… | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.49 | As web owner/admin, request private diagnostic routes directly and verify denial. As authorized VPN/private… | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.50 | Seed labeled synthetic secrets and identifiers; execute all owner UI reveals/exports,… | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.51 | Perform keyboard-only main flows and narrow-layout interaction with actual forms, modal confirmations, tables,… | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.52 | **Synthetic-only before release:** independent clean bootstrap/MFA/project/env/test-token/fixture-app/restore-instructions walkthrough; real consumer follow-up is AC-1.58 | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.53 | An external test agent makes one predetermined instruction request to the separate staging-only synthetic… | STAGE COMPLETION | §19 agent fixture |
| AC-1.54 | Use staging synthetic canaries to test agent requests for unauthorized scope, arbitrary command/arguments,… | STAGE COMPLETION | §19 agent fixture |
| AC-1.55 | Display a real, useful owner-scoped operation/outcome summary, chronological event timeline, and credential… | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.56 | Assemble the controlled-use evidence manifest from pinned release artifacts: identify each currently approved… | CONTROLLED RELEASE | §18 DX / §9 API |
| AC-1.57 | Before real-secret onboarding: clean-host restore with available KMS key, disposable irreversible-key-loss denial, R2 lock tests and **release-due AC-1.36/1.44** evidence | CONTROLLED RELEASE | §13–15 recovery / G-BAO |
| AC-1.58 | **Execute real first-consumer onboarding after release**, then record at least 28 calendar-day observations, daily use, backed-up data, alerts and staging restore | STAGE COMPLETION | §15 field evidence |
| AC-1.59 | Review the final evidence report: implemented-and-tested vs observed vs unknown vs failed vs deferred, agent… | STAGE COMPLETION | §15 field evidence |
| AC-1.60 | Walk through every published UI/API/CLI and error/help/documentation claim: no sham status, hidden… | CONTROLLED RELEASE | §18 DX / §9 API |

## Appendix C — Session design and evidence handoff to Documents 07–08

Document 07 must turn each of the nine G-* gates, six major subsystems, 102 FR implementation paths, 60 ACs, 24 inherited PO records **and five additional stable technical proof records** into dependency-ordered workloads with a risk-weighted **bottom-up** budget. Each candidate workload needs prerequisite evidence, explicit blocked dependencies, a coherent demonstrable deliverable, expected integration tests, reviewer assignment, calendar-constrained fixtures and handoff state. **Do not** assign a fixed 40-session sequence merely because 400/10 = 40; derive sessions from real dependency and completeness. Document 08 expands those sessions into complete runnable tasks with exact entry checks, commands, checkpoints, exits and handoff notes.

Minimum repository evidence layout (names proposed, not actual files yet):

```text
docs/decisions/DEC-*.md
docs/evidence/source-manifest.md
docs/evidence/requirements/FR-1.xx/
docs/evidence/acceptance/AC-1.xx/
docs/evidence/proofs/PO-xx/
docs/evidence/gates/G-*/
docs/runbooks/{bootstrap,consumer,alert,backup,restore,operator-reconcile,upgrade}.md
infra/dependencies.lock.json
packages/contracts/
packages/db/migrations/
tests/{unit,integration,browser,cli,fault,restore}/
```

**Independent audit status, v0.3:** Conditional baseline for Document 07 workload decomposition; no verified release, dependency or cloud proof. Before dependent coding, the stage owner must explicitly close G-PINS, G-AUTH, G-BAO and any prerequisite gate for that feature; updated G-BACKUP proof assignments include KMS-L1/DB-G1/R2-L1/COST-B1 and G-CLIENT includes AGENT-B1; final gate closure needs integrated evidence. Four field/agent ACs remain deliberately post-release. P-01/P-02/P-03 originals remain unavailable. **End-of-document status (7 November 2026):** architecture candidate only; source, vendor, and prior document claims are not executable passing evidence. **Document 04 v0.3 governs behavior and the release/field gate allocation; Document 05 v0.3 governs the updated risk/proof inventory**. Release authorization remains contingent on governing P-01/P-02/P-03 reconciliation, accepted Document 04 scope, proof completion, independent review and the synthetic-first controlled-use gate.

### C.1 Explicit risk-first handoff constraints (7 November 2026)

Before dependent feature coding, Document 07 must schedule: (1) signed P-01/P-02/P-03 and revised Document 04 scope reconciliation; (2) G-PINS exact-version/CLI runtime proofs; (3) G-AUTH and G-BAO including **KMS-L1**; (4) delayed-effect and coherent-read proofs; (5) **DB-G1, R2-L1, COST-B1** paired-backup and recoverability evidence; (6) **AGENT-B1** CLI decision and four-platform proof; (7) the complete owner/UI/API/CLI delivery, independent review and all 56 release cases; (8) real-consumer onboarding **after** controlled-use approval and the four stage-completion cases. **Real R2 thirty-day lock aging must start early enough to close the release-due AC-1.36 and AC-1.44.** A shorter test is supplemental, not a waiver. Do not move those inherited release cases after release without a formal governing amendment.

## Appendix D — Historical reference-label resolution (from inherited technical candidate)

These labels appear in the selectively retained protocol §§2–14. They establish the original design rationale, **not** approval of the final pinned implementation. Review the exact pinned vendor release and complete the corresponding proof.

| Label | Original primary source | Checked behavior (not proven integration) |
| --- | --- | --- |
| S1 | https://openbao.org/docs/api/secret/kv/kv-v2/ and https://openbao.org/docs/api/auth/token/ | KV CAS/version/deletion and token/role/accessor API |
| S2 | https://www.postgresql.org/docs/18/explicit-locking.html | Advisory lock lifetime and row/transaction locking semantics |
| S3 | https://better-auth.com/docs/concepts/database and https://better-auth.com/docs/adapters/drizzle | Native credential schema and adapter contracts; session defaults not contract compliant |
| S4 | https://orm.drizzle.team/docs/transactions and https://orm.drizzle.team/docs/kit-custom-migrations | Database transactions and custom SQL migrations |
| S5 | https://nodejs.org/api/permissions.html | Node permission limits as defense in depth only |
| S6 | https://restic.readthedocs.io/en/stable/040_backup.html and https://restic.readthedocs.io/en/stable/060_forget.html | Local snapshots, forget and prune lifecycle |
| S7 | https://developers.cloudflare.com/r2/buckets/bucket-locks/ | R2 lock capability and deletion restrictions |
| S8 | https://openbao.org/docs/configuration/seal/kmip/ | Native KMIP seal prerequisites; actual OVH interoperability unproven |
| S9 | https://openbao.org/docs/api/system/config-auditing/ | Audit header configuration, request correlation and data protection |
| S10 | https://docs.docker.com/engine/storage/bind-mounts/ | Read-only directory bind-mount behavior to prove on actual host |

