# Prompt for the MyKey planning agent: automation access and long-lived runtime credentials

Paste everything below the line into the planning agent, started in the MyKey
repository. Attach `mykey-automation-credential-spec.md` (from this folder) after it, or
copy it into the repo first. It holds no secret, address or production id.

---

You are the **planning agent** for MyKey. You write ONE session plan in this repository's
three-layer form: Doc 10, then a session plan, then execution by another agent. You
write no code, no tests and no decision records beyond the plan's own "Planner
decisions" section. The deliverable is `docs/plans/session-11-plan.md`, or the name the
owner settles in decision 1 below, in the same shape as `docs/plans/session-10-plan.md`:
the testing cadence, global constraints, review focus, planner decisions, carried items,
session start, run order, file map, then one section per run with tasks, and the gate
run last. It is committed on a branch and opened as a pull request; it is merged on the
owner's word.

## What the session must deliver

The attached input specification, **"MyKey — automation access and long-lived runtime
credentials"**, adds three general capabilities and one property:

1. **An automation credential.** The owner issues it with a fresh TOTP. It is scoped to
   the projects it owns, bound to source addresses, and its rights are chosen at issue:
   create projects and environments, create secrets (create-only), optionally update
   them with an expected version, and manage runtime credentials. It can never read a
   value or touch a project it does not own.
2. **A runtime credential with a client secret.** It is bound to one environment and
   lives up to a lifetime the owner decides. It is exchanged for a short-lived,
   non-renewable machine token that the existing `machine.keys` / `machine.resolve`
   accept unchanged. It is supported by the `secrets` CLI beside today's 30-day token.
3. **`machine.metadata`.** Per-secret `version`, `createdAt` and `updatedAt` for a
   machine, never a value.
4. **After a restore, the owner's one action per automation credential is enough to
   bring every consumer back.**

**These are general product features of MyKey.** Plan them for any application,
platform or pipeline that uses MyKey, against the use cases in the spec's §0. Do not
shape any behaviour, default or name for one particular consumer. Everything that
exists today keeps working unchanged: today's machine credential, `cli-v0.1.2`, every
route, and every runbook's current path. The additions are documented in the API
reference, the runbooks, the workspace and the agent guide like any other feature.
**The spec's §5 lists what is NOT in scope. Build none of it.**

## Read first, in this order

1. `CLAUDE.md` whole: "Where we stand", the open items, the dated items.
2. Doc 10: §4.1 (every rule, each mapped in the spec's §3; check the mapping, do not
   trust it), §4.2 (it says machine tokens are "default and maximum 30 days,
   non-renewable", and this work changes that line), §4.3, and the scope valves (D-10).
3. Doc 02's stage map, especially where machine and workload identity sit by stage, and
   what this work must not block. Then Doc 09 (the Stage 2 hypothesis, NOT APPROVED).
4. Decisions:
   - D-15 (the route freeze, and what a `contract:` commit must change);
   - D-17 with its amendment (identities, the authority matrix, the hostile-API
     section);
   - D-31 (authorization), D-32 (provisioning), D-34 (one organization per process,
     inline AppRole), D-35, D-36, D-38 (operations, mutation protocol, uncertainty);
   - D-40 (the credential lifecycle), D-42 (machine requests), D-43, D-44 (the CLI and
     its distribution), D-46 (audit coverage), D-49 (limits), D-55 (restore by class);
   - D-57, D-58, D-63, D-64 (release, cadence, what PASS means, production opened by
     the owner);
   - D-65, D-68, D-70, D-74 to D-79.
5. `docs/runbooks/known-limits.md`, `machine-credentials.md`, `consumer-local.md`,
   `consumer-deploy.md`, `restore.md`, `credential-custody.md`, `limits.md`;
   `docs/agents/connect-an-application.md` and its test.
6. `packages/contracts/src/routes.ts` and `limits.ts`; `apps/api/src/pipeline/machine.ts`
   and `routes/machine.ts`; `routes/credentials.ts`; `apps/cli/src/`;
   `infra/openbao/policies/*.hcl`; the authority matrix and its test.

## Check the spec against the tree in both directions

The spec was written from an outside read of commit `472cda4`. **Where the spec and the
tree disagree, the tree wins.** Record every disagreement in the plan as a numbered
planner finding. Look for both kinds:

- the spec asks for something that already exists, or that exists in a different shape;
- the spec assumes something exists that does not.

Every OpenBao behaviour the design depends on is a **measurement a run owes on the
pinned OpenBao, with a control**, never an assumption. This includes:

- one AppRole per credential: a CIDR-bound secret id, and a login that returns a token
  carrying exactly `machine-env-<eid>` at a fixed TTL that cannot be renewed;
- whether deleting a role or a secret id revokes tokens already minted from it;
- revoking by accessor;
- the identity that mints secret ids, and its new rights in the matrix.

## Decisions that are the owner's: ask them in the plan's first section, before any run is fixed

1. **Where this work sits.** Stage 1 is open under Gate F HARDEN, re-decided at W-2 (20
   Dec 2026) on 28 days of real use of the current release. Choose one, and state what
   each costs Gate F's evidence and the real-use clock:
   - (a) start after W-2;
   - (b) now, as a Stage 1 amendment on staging only, production after W-2;
   - (c) the first session of a re-scoped next stage that replaces Doc 09.
2. **The runtime credential's maximum lifetime.** 365 days is recommended; "no expiry"
   is the alternative. This rewrites the machine-token line of Doc 10 §4.2.
3. **The automation credential's lifetime range**, and whether bound addresses are
   mandatory (recommended: yes).
4. **Whether `secrets.update` (expected version) is in this session or deferred.**
5. **Where credential material lives**: OpenBao AppRole secret ids (recommended in the
   spec's §1.3), or verifiers in PostgreSQL.
6. **Production rollout**: whether this session opens production with the new host and
   CLI releases, under D-64's `--stay-closed`, owner journey, `--owner-confirmed`.

Write each as a question with its options and consequences, and your recommendation.
Then plan on your recommendation, marked as pending the owner's word, and say which
runs change if the owner picks otherwise.

## What the plan must contain

- **The contract change** as one early run: every new route in `ROUTES`, the route test
  table (41 → the new count), the OpenAPI file, D-15's record and `AUDIT_COVERAGE`, all
  in one `contract:` commit. Then the owning runs fill the bodies.
- **The new identities and rights**, with the authority matrix regenerated, and a
  hostile-API paragraph in D-17's form for every right added.
- **The ownership and rights model.** Owned projects; assignment and unassignment by the
  owner; rights chosen at issue; every non-owned project answering the same 404 as an
  absent one.
- **The issuance and revocation of both new kinds** under D-40's states: `issuing`,
  `needs_review`, `revoking`, and the uncertain-issuance block. Extend
  `reconcile-credentials`.
- **Exchange and metadata** (M1, M2), and their limits in `limits.ts`, with the fleet
  boot (spec §6 item 8) passing under the defaults or the defaults moved by decision.
- **The CLI release**: runtime credential support, the token step's one-command form for
  the client secret, the same exit codes, existing installs unaffected, and the release
  and distribution as D-44 does.
- **The workspace screens**: issuing, listing, revoking and assigning automation
  credentials; runtime credentials beside today's; "Connect an application" explaining
  both kinds. Consistent with D-70's design system.
- **Restore.** Both kinds revoked; one owner action per automation credential; the
  restore runbook updated; the restore-window cost re-measured.
- **Documentation**:
  - the API reference with language-neutral examples;
  - `machine-credentials.md`;
  - a new `automation.md`;
  - `known-limits.md` (every new residual named honestly);
  - the agent guide and its consistency test.
- **Proofs.** Every acceptance item of the spec's §6 assigned to a run, as a test or a
  staging measurement with a control:
  - every denial paired with a success;
  - the canary and leak sweep extended to the three new secret shapes;
  - the D-78 trigger aimed at an automation issuance;
  - the no-regression item (§6 item 12) run against today's credential and
    `cli-v0.1.2`.
- **The gate run**, in this project's existing form. State the decision numbers you will
  use; the next free one is D-80.

## Constraints

- **Synthetic data only, in Git and in evidence.** Fixtures are generic (a "tenant
  provisioner" script, a sample server). No real consumer's names, addresses or values
  appear anywhere; a staging proof uses a test address the owner supplies at the
  sitting.
- §4.1's rules are never traded for speed. A run that cannot keep one stops and reports.
- Keep the plan executable by an agent that starts cold. Name every path, route id,
  flag, fixture, exit code and expected status.
