# MyKey Stage 1 — Session 2 (Infrastructure and make-or-break proofs) Execution Plan

> **For the executing agent:** carry this plan out run by run, in the order given in "Run order". If you have the superpowers skills, use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking. You do not re-decide anything in Doc 10 §3 / §8 or in the "Planner decisions" table below; if one proves wrong, write a one-paragraph decision record and continue (Doc 10 §1). The fallbacks of Doc 10 §8.1 are pre-authorised (D-09): when a first choice fails its proof inside its run, switch, record it, and go on.

**Goal:** By the end of Day 3 (12 November 2026) the four risky assumptions are proven or replaced — OpenBao tenancy and orphan token issuance, Better Auth protected storage, late-arriving backend writes, real KMS unseal — and two hardened OVHcloud hosts exist: staging runs OpenBao that unseals itself from OVHcloud KMS, an off-host probe alerts when the host goes dark, and one paired backup taken on staging has been restored into a new PostgreSQL cluster and a new OpenBao.

**Architecture:** Two tracks that meet at Run 2.9. The _local-proof track_ (Runs 2.1–2.4, 2.8) needs only the Session 1 Docker stack: it adds the narrow OpenBao client and the policy templates to `packages/openbao`, the protected Better Auth integration to `packages/auth`, and a throw-away intent → dispatch → effect → finalize loop to `packages/operations/src/spike`, each attacked by integration and fault tests. The _host track_ (Runs 2.5–2.7) hardens both servers from versioned files under `infra/hosts`, brings up one Compose configuration on both, deploys the Cloudflare Worker probe, and seals staging's OpenBao with the built-in KMIP seal. Run 2.9 uses both tracks for the paired-backup spike; Run 2.10 is the go/no-go gate.

**Tech stack:** everything pinned in Session 1, plus (pinned in the run that first uses them): `@hono/node-server`, `jose`, `otpauth`, `wrangler`; images `node` (API base), Toxiproxy (fault injection), nmap (outside scan), `okms-cli` (OVHcloud KMS client). On the hosts: Ubuntu 24.04 LTS, `docker.io` and `docker-compose-v2` from the Ubuntu archive, WireGuard, nftables.

**Spec:** `docs/doc_10_mykey_stage_1_compressed_implementation_plan_v1.0.md` §1–§5, §7 "Session 2", §8, §9. Design: Doc 06 §1.4, §2, §4.1–4.3, §5, §6, §12, §13.1–13.3, §15.2a/b, §17. Behaviour: Doc 04 FR-1.64, FR-1.65, FR-1.70–1.72, AC-1.26, AC-1.30, AC-1.31 and the "binding recovery interpretation" under FR-1.64. Audit: Doc 05 §3.5, §3.10, §3.11, §5, §6. Previous session: `docs/evidence/session-1/report.md`. Old runbooks for ideas only: D08-S03, S05, S06, S07, S08, S10, S11.

**Provider facts used here** were read on 11 November 2026 from the OpenBao `v2.7.2` documentation and source, the published `better-auth@1.7.19` package, and OVHcloud's documentation. Nothing was executed. Where a step says "(source reading)", the test in that step is the first real evidence — when the observation differs, the observation wins and goes into the run note.

---

## Global constraints

Every run's requirements include this section and the "Global constraints" of the Session 1 plan (synthetic data only, real stores for proof, a skipped test is not a pass, the forbidden components, pins, limits live once in `@mykey/contracts`).

- **Doc 10 §4.1 is at stake in every run of this session.** Read the eleven rules before starting. The ones most easily broken here: rule 2 (nothing secret in the transcript — see Review focus 2), rule 3 (a timeout is never recorded as a failure), rule 11 (no "healthy" without a measurement).
- **Statuses.** Session 2 proves things in isolation or on a host skeleton, never on the integrated product. The registry may therefore move an item to `SPIKE_PASS` or `FAIL`, never to `PASS` (`evidence:verify` refuses `PASS`). A `SPIKE_PASS` needs a run note that states the id and the status on one line, for example `PO-3 SPIKE_PASS — …`.
- **Three kinds of test, three commands.** `pnpm run test:integration` (local Docker stack; also `tests/fault`), `pnpm run test:cloud` (R2; fails on purpose from 15 Nov 2026 09:42 UTC), and the new `pnpm run test:staging` (the staging host, over the VPN). A staging suite begins by asserting its target: the host name from `~/.mykey/hosts.json` and, from Run 2.7 on, `seal-status.type` not equal to `static`. A staging test that could run against the local stack is a bug.
- **Staging and cloud tests describe real behaviour.** A failure is a finding to record, never something to fix by weakening the assertion.
- **A denial must be a denial.** Every "denied" assertion states the exact status and is paired with a control: the same request by an authorised identity succeeds. A 404 from a mistyped path or a timeout is not a denial.
- **Remote work.** Workstation code is TypeScript run by Node. Shell scripts run only on the Linux servers or inside containers, are stored with LF endings, and are pushed by `scripts/host.ts`, which refuses a file containing a carriage return. Quote every local path (the repository path has a space).
- **Production holds nothing yet.** In this session the production host is hardened, serves `/health` and is watched by the probe. It gets no OpenBao, no KMS material and no secret of the product. All destructive drills run on staging (FR-1.70).
- **OVHcloud belongs to the owner (D-11).** The agent never asks for the OVHcloud password or an OVHcloud API key. It tells the owner exactly what to click and what to send back. Certificates and identifiers may be sent in chat; private keys, tokens and recovery keys may not.
- **Every run ends with:** `pnpm run check` green, the run's tests green, a commit on branch `session-2`, and a run note `docs/evidence/session-2/run-2.N.md` (template of Run 1.1: `What was done`, `Commits`, `Commands and results`, `Deviations and decisions`, `Open issues`). Each proof run adds a line `Verdict: GO` / `GO WITH FALLBACK <name>` / `NO-GO` for Run 2.10 to collect.
- **Git.** Never commit on `main`. Parallel runs use `git worktree` checkouts under `C:/Users/gmpar/mykey-wt/` (outside OneDrive) and merge into `session-2` by fast-forward or rebase. The pull request to `main` is opened at the gate and merged only when the owner says so.

## Review focus

Five conditions the specifications imply but do not spell out, most likely to bite first. Each has a test pinned in the run named.

1. **Closing public SSH locks the operator out.** A wrong firewall rule or a socket that binds before the VPN interface exists leaves a host reachable only through OVHcloud rescue mode. → Run 2.5 Task B applies every network change with a timed automatic revert and confirms from a second connection before cancelling it; the reboot test proves SSH over the VPN comes back by itself.
2. **A secret reaches the transcript through a remote command.** `cat` of an init answer, `docker compose config`, `set -x`, an error that echoes a request body. → `scripts/host.ts` never prints a file under `/etc/mykey/secrets` or `/root/mykey-custody`; the OpenBao init answer goes to a root-only file and only a count is printed; a unit test feeds `sshExec` output containing a run-time canary through the logger and expects it redacted (Run 2.5 Task A).
3. **A restart is mistaken for a cold start.** An OpenBao that was already unsealed proves nothing about unseal, and after a reboot Docker starts containers before the egress sets and DNS are ready. → Run 2.7 asserts a new process id and start time before trusting an unseal, and the reboot test allows no operator command between boot and the unsealed reading.
4. **A test passes because the request was wrong, not because it was refused.** → the control rule in "Global constraints"; the authority matrix of Run 2.1 fails when a deny cell has no matching allow cell on the same path.
5. **Files written on Windows break on Linux.** CRLF in a shell script, a unit file or an nftables file; a secret file created with mode 0644; a path with a space cut in two by `scp`. → `host.ts` refuses CR, sets mode and owner explicitly on every pushed file and reads them back; `.gitattributes` gains the new extensions (Run 2.5 Task A).

## Planner decisions

Settled here so the executor does not have to choose. Each one marked **DR** gets a decision record in the run shown.

| # | Decision | Why | Run |
| --- | --- | --- | --- |
| P-19 | Code that later sessions keep goes into its final package (`packages/openbao`, `packages/auth`, `apps/api`, `workers/probe`, `infra/hosts`). Throw-away code goes into a directory named `spike` (`packages/operations/src/spike`, `infra/backup/pair-spike`, `tests/fixtures/agent-spike`) and is replaced by the run that owns the real thing. | A spike that looks finished gets shipped. | all |
| P-20 | New Vitest project `staging` = `tests/**/*.staging.test.ts`, excluded from the others; `test:staging` = `node scripts/require-staging-env.ts && vitest run --project staging`. Staging tests run from the workstation only, not in CI. | The VPN is not reachable from GitHub runners; a missing VPN must fail, not skip. | 2.5 |
| P-21 | The OpenBao audit device is declared in the server configuration file. The two correlation headers are `x-mykey-operation-id` and `x-mykey-dispatch-id`, registered through `sys/config/auditing/request-headers` with `hmac: false`. | 2.7.2 refuses audit devices created through the API; header registration exists only in the API. | 2.1 |
| P-22 | Each organization namespace `org-<organization_id>` has three AppRole roles — `runtime` (token 900 s), `issuer` (60 s), `provisioner` (300 s) — all service tokens without the default policy, logging in **inside** that namespace. Policies carry the same three names. | A token created from a parent namespace needs `sudo`; the issuer must not have it. | 2.1 |
| P-23 | Per environment: policy and token role are both named `machine-env-<environment_id>`. Soft delete is `POST kv/delete/<path>` with an explicit version list, so the runtime policy holds no `delete` capability anywhere. | One name to render, read back and audit; a delete always names its version. | 2.1, 2.2 |
| P-24 | Better Auth's `twoFactor` plugin is **not installed**. TOTP, recovery codes and factor state are a product-owned module in `packages/auth`. Better Auth keeps password verification and sessions, behind a wrapped adapter. **DR D-19.** | In 1.7.19 backup codes are stored recoverably, a TOTP code can be replayed inside its window, and trusted-device has no off switch — three contract failures configuration cannot remove. Run 2.3 Task B confirms each by test. | 2.3 |
| P-25 | No Better Auth catch-all handler is mounted. Each allowed native endpoint is called from its own route through `auth.api.<name>({ …, asResponse: true })`; `basePath` is `/v1/auth`. The product supplies the Origin check and throttling that this bypasses (Runs 3.7, 3.3). | Doc 06 §4.3; `disabledPaths` matches exact strings only and cannot name a parameterised path. | 2.3 |
| P-26 | A stored session token is `v1.<keyId>.<base64url(HMAC-SHA-256(lookup key, raw token))>`. No ciphertext copy. The native routes that need the raw token back (`/list-sessions`, `/revoke-session`, `/revoke-other-sessions`) are denied; Run 3.5 rebuilds them by session id. | Doc 06 §4.1: "If the proven adapter can operate with verifiers only, omit ciphertext." | 2.3 |
| P-27 | Fault injection: Toxiproxy (image by digest) between the executor and OpenBao; an executor death is a `SIGKILL` of a child process at a named boundary. | Real sockets and real process death; no mock of either store. | 2.4 |
| P-28 | The workstation reaches the hosts through **WireGuard for Windows**, installed once by the owner (two commands). One tunnel, two peers: production `10.77.1.1`, staging `10.77.2.1`, workstation `10.77.1.10` and `10.77.2.10`, UDP 51820. The hosts are not peers of each other. Fallback when the owner cannot install it: `wg-quick` and `ssh` inside WSL2 as root, with the extra key copy recorded in the custody list. | Every later session works over this tunnel; a container-based tunnel would have to be rebuilt each time. | 2.5 |
| P-29 | Hosts are configured by `scripts/host.ts`, which pushes `infra/hosts/**` and `infra/compose/host/**` and runs idempotent shell scripts on the server. No Ansible, no configuration agent. | One language on the workstation; nothing new to pin. | 2.5 |
| P-30 | Firewall: one nftables table `inet mykey` with its own input, forward and output chains (policy drop). Docker's chains are never edited. Compose bridges have fixed interface names. Outbound traffic is allowed per purpose to a named set of addresses, filled from a committed list of host names by a timer. `api`, `provisioner` and `postgres` have no route out at all. **DR D-21** records the remaining weakness: for names served from shared addresses (R2, ACME, the Worker) this is an address allowlist, not a name allowlist. | Doc 06 §2 asks for an endpoint allowlist; an SNI-filtering proxy is the stricter design and is left for the Session 8 review to demand or waive. | 2.5 |
| P-31 | First-party images are built on the workstation, moved with `docker save` → SSH → `docker load`, and referenced by image ID in the host's `.env`. Upstream images are pulled on the host by digest during a timed maintenance window that opens registry egress. Build-once-and-promote through a registry is Run 6.9. | No registry credential on a host and no standing registry egress in Session 2. | 2.5 |
| P-32 | Host names: production `mykey.<domain>`, staging `mykey-staging.<domain>`, probe `mykey-probe.<domain>` (or the `workers.dev` name when the zone is not on Cloudflare). Certificates: Let's Encrypt by TLS-ALPN-01, registered without an e-mail address, staging directory first. HSTS `max-age=63072000` without `includeSubDomains`. | The owner's other sub-domains are not ours to pin; the owner's address is not sent to a third party. | 2.5 |
| P-33 | Probe: one Worker `mykey-probe` with a cron trigger every minute and a D1 database; the decision logic is a pure function tested in the `unit` project. One alert sink — the one the owner chooses. Detecting that the Worker itself has stopped (Doc 06 §12 "checker disappearance") is left to Run 6.4 and listed as open. **DR D-22.** | Heartbeats from two hosts exceed the free daily write quota of Workers KV; D1 does not. | 2.6 |
| P-34 | OVHcloud KMS: two OKMS domains in the hosts' region — `mykey-staging-kms` and `mykey-losstest-kms`. The agent creates the KMIP keys with the `okms` CLI; the owner creates domains, identities, IAM policies and certificates (from CSRs, so no private key crosses the console). Production gets its own domain, key and certificate in the run that first starts OpenBao on production, not now. **DR D-23.** | IAM scopes KMIP rights per domain, not per key: a separate domain is the only wall between the loss test and the real seal key. | 2.7 |
| P-35 | Staging OpenBao is initialised with one recovery share, threshold one. The production split is decided with the owner when production is initialised. | One operator; staging holds synthetic data. | 2.7 |
| P-36 | The pair spike is driven from the workstation over SSH and runs pinned images with `docker run` on the host. Plaintext artifacts exist only in a root-only tmpfs on the host. Upload and download use `curl --aws-sigv4` on the host. Control rows are written as `maintenance`, the dump is read as `backup_reader`. The manifest is unsigned. | The capture coordinator, its image, its database grants and the signed manifest belong to Run 6.5; the spike must not grow into it. | 2.9 |
| P-37 | Run 2.8 is capped at two hours of agent time and one Linux container. | Doc 10: "This run is capped; it must not grow." | 2.8 |

## Session start (before Run 2.1)

- [ ] **Step 1 — Branch.** `git switch main && git pull && git switch -c session-2 && git push -u origin session-2`. Commit this plan as `docs: session 2 plan` if it is not on `main` yet.
- [ ] **Step 2 — One message to the owner**, then start Runs 2.1 and 2.3 without waiting. Save the text as `docs/evidence/session-2/owner-requests.md`. It contains:
  1. **Still open from OWN-1:** confirm D-01 … D-11 (an explicit yes for D-04 and D-05); the domain, and whether its DNS zone is on Cloudflare; where alerts should go — Telegram, a webhook URL, or e-mail (e-mail only if the zone is on Cloudflare).
  2. **OWN-2, needed for Run 2.5:** two Public Cloud instances `mykey-prod` and `mykey-staging`: model **C3-8** (4 vCPU, 8 GB, 100 GB NVMe; B3-16 if C3-8 is not offered), Ubuntu 24.04 LTS, the `mykey-ops` public key from `owner-kickoff.md`, hourly billing, in one region that has both Compute and KMS (Gravelines `GRA` / `eu-west-gra` and Strasbourg `SBG` / `eu-west-sbg` do). In the network step choose **public connectivity: "Basic IP"** — it is off by default, and without it the instance has no public address. Do not edit the `default` security group. Reply with both IPv4 addresses and the region. Before this, copy the private key `~/.mykey/ssh/mykey_ops_ed25519` into your password manager (custody list, row 1).
  3. **A Cloudflare API token for this session**, created in the dashboard and saved by you to `~/.mykey/secrets/cloudflare/session-2-token` (never pasted): Account → Workers Scripts: Edit; Account → D1: Edit; Zone → DNS: Edit for the chosen zone (leave the zone part out when the domain is elsewhere, and create the two A records yourself when asked).
  4. **The alert channel.** For Telegram: create a bot with @BotFather, send it any message from the account that should receive alerts, and save the bot token to `~/.mykey/secrets/alerts/telegram-bot-token`. For a webhook: save the URL to `~/.mykey/secrets/alerts/webhook-url`.
  5. **Announced now, done during Run 2.5:** install WireGuard for Windows (`winget install --id WireGuard.WireGuard`) and, when the agent says the tunnel file exists, run once in an elevated prompt: `wireguard /installtunnelservice "%USERPROFILE%\.mykey\wireguard\mykey-ops.conf"`.
  6. **Announced now, done before Run 2.7 (OWN-3):** the KMS steps of Run 2.7 Step 1 — about twenty minutes in the OVHcloud Control Panel, in two sittings.
- [ ] **Step 3 — When the owner answers** (in any run): set the Status of D-01 … D-11, record domain, region and alert channel in D-11, commit.

## Run order

```text
local-proof track                                host track (starts when OWN-2 arrives)

2.1 Task A ──┬─→ 2.1 Tasks B–C ─→ 2.2            2.5 ─→ 2.6
             ├─→ 2.4                               └──→ 2.7 (needs OWN-3)
             └─→ 2.8 (capped)
2.3 (independent; starts at once)
                         2.1 + 2.4 + 2.7 ─→ 2.9 ─→ 2.10
```

- Run 2.1 Task A (the OpenBao client, the audit device, the organization fixture) is merged first; Runs 2.2, 2.4 and 2.8 start from it in separate worktrees. Run 2.3 touches only `packages/auth`, `packages/db` and its own tests and can start immediately.
- Two runs add a migration: 2.3 (`0003_auth_base`) and possibly 2.4. Whoever merges second regenerates its migration number; never edit a merged migration.
- Run 2.5 does not depend on any proof run. If the servers are not there when the local-proof track is finished, do Run 2.5 Task A, Run 2.6 Steps 1–2 (Worker code and unit tests) and Run 2.9 Step 1 (local rehearsal) while waiting.
- Run 2.7 has one check that cannot finish inside the session (a certificate that expires after 24 hours). It is recorded as a checkpoint, like the retention fixture.

## File map

```text
packages/openbao/src/          client.ts admin.ts paths.ts policies.ts authority.ts index.ts
packages/auth/src/             auth.ts keys.ts session-verifier.ts protected-adapter.ts routes.ts
                               factors/{totp.ts,recovery.ts,seed.ts,elevate.ts}  index.ts
packages/db/src/schema/auth.ts                     Better Auth tables + factor tables (schema "auth")
packages/db/migrations/0003_auth_base.sql
packages/db/src/roles.ts                           + applyDatabaseAccess()
packages/operations/src/spike/ executor.ts reconcile.ts runner.ts                    (throw-away)
apps/api/src/                  app.ts health.ts server.ts                            (health stub)
apps/api/Dockerfile
workers/probe/src/             evaluate.ts store.ts sinks.ts index.ts   wrangler.jsonc  migrations/0001_init.sql
infra/compose/dev.compose.yml  dev/openbao.hcl                          (audit device; Toxiproxy profile)
infra/compose/host.compose.yml host/{traefik.yml,traefik-dynamic.yml,postgresql.conf,pg_hba.conf,openbao.hcl.tmpl,pki-init.sh}
infra/compose/kms-spike.compose.yml                                     (disposable OpenBao instances, staging only)
infra/hosts/bootstrap/         10-packages.sh 20-wireguard.sh 30-ssh.sh 40-sysctl.sh 50-docker.sh
infra/hosts/firewall/          mykey.nft egress-names.conf mykey-egress.sh apply-with-revert.sh
infra/hosts/systemd/           mykey-egress-refresh.{service,timer} mykey-heartbeat.{service,timer}
~/.mykey/ (workstation, not in Git)   hosts.json  wireguard/mykey-ops.conf  kms/*.crt  custody/staging/  secrets/hosts/staging/
infra/hosts/checks/            status.sh heartbeat.sh
infra/openbao/policies/        runtime.hcl issuer.hcl provisioner.hcl machine-env.hcl backup.hcl   (templates)
infra/backup/pair-spike/       capture.ts verify.ts restore.ts manifest.ts                          (throw-away)
scripts/                       host.ts probe.ts require-staging-env.ts authority-matrix.ts auth-route-contract.ts
tests/harness/                 stack.ts (+ audit log, Toxiproxy)  org-fixture.ts  staging.ts  privilege-matrix.ts  toxiproxy.ts
tests/unit/{openbao,auth,probe,hosts,backup}/…
tests/integration/openbao/     client.test.ts authority.test.ts audit.test.ts issuance.test.ts
tests/integration/api/         health.test.ts
tests/integration/backup/      pair-rehearsal.test.ts          tests/integration/database/access.test.ts
tests/integration/auth/        routes.test.ts storage.test.ts factors.test.ts race.test.ts dump.test.ts stock-plugin.test.ts
tests/fault/effects/           boundaries.test.ts late-write.test.ts exclusion.test.ts maintenance.test.ts
tests/staging/                 boundary.staging.test.ts transport.staging.test.ts probe.staging.test.ts
                               unseal.staging.test.ts key-loss.staging.test.ts pair.staging.test.ts
tests/fixtures/agent-spike/…                                                          (throw-away)
docs/auth-route-contract.md                        generated
docs/decisions/D-17 … D-25-*.md
docs/evidence/session-2/       owner-requests.md run-2.1 … run-2.10.md authority-matrix.md host-scan-*.txt
                               kms-checkpoints.json pair-spike.json go-no-go.md report.md
docs/runbooks/                 network.md kms-and-unseal.md custody-map.md probe.md   (+ credential-custody.md updated)
```

Decision records of this session: D-17 OpenBao identity model (2.1) · D-18 issuer placement (2.2) · D-19 auth storage design (2.3) · D-20 late-write boundary (2.4) · D-21 host network and egress model (2.5) · D-22 probe and alert path (2.6) · D-23 seal choice and KMS layout (2.7) · D-24 thin CLI over OpenBao Agent (2.8) · D-25 pair format (2.9).

---

## Run 2.1 — OpenBao tenancy and permissions spike (D08-S06) · ∥

**Files:** `packages/openbao/src/{client,admin,paths,policies,authority,index}.ts`, `infra/openbao/policies/{runtime,issuer,provisioner,machine-env,backup}.hcl`, `infra/compose/dev.compose.yml`, `infra/compose/dev/openbao.hcl`, `tests/harness/stack.ts`, `tests/harness/org-fixture.ts`, `scripts/authority-matrix.ts`, `tests/unit/openbao/{paths,policies,authority}.test.ts`, `tests/integration/openbao/{client,authority,audit}.test.ts`, `docs/evidence/session-2/authority-matrix.md`, `docs/decisions/D-17-openbao-identity-model.md`.

**Consumes:** `startStack`, `getSharedStack`, `freshNamespace`, `baoFetch`, `mountKvV2` (Session 1); id types and `checkSecretName` from `@mykey/contracts`.

**Produces** (`@mykey/openbao`, used by Runs 2.2, 2.4, 2.9 and by Sessions 3–5):

```ts
// paths.ts — the only place a backend path is built
export function namespaceFor(organizationId: OrganizationId): string;                    // "org-<uuid>"
export function environmentPrefix(projectId: ProjectId, environmentId: EnvironmentId): string; // "p/<pid>/e/<eid>/"
export function secretPath(projectId: ProjectId, environmentId: EnvironmentId, name: string): string; // prefix + NAME; throws on a bad id or name
export function machineName(environmentId: EnvironmentId): string;                       // "machine-env-<eid>"

// client.ts — runtime, issuer and machine use; no method takes a path string from a caller
export interface OpenBaoTarget { url: string; caCertPath: string }
export interface Correlation { operationId: string; dispatchId: string }                 // sent as x-mykey-operation-id / x-mykey-dispatch-id
export interface SecretEnvelope { value: string; operation_id: string; format: 1 }
export type BaoResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; kind: "denied" | "not_found" | "cas_mismatch" | "sealed" | "invalid"; status: number }
  | { ok: false; kind: "unknown"; cause: "timeout" | "connection_lost" };                // the request may have been applied
export class OpenBaoClient {
  constructor(target: OpenBaoTarget, opts: { namespace: string; token: string; deadlineMs?: number }); // default LIMITS.deadlines.backendCallMs
  kvWrite(path: string, envelope: SecretEnvelope, cas: number, c: Correlation): Promise<BaoResult<{ version: number }>>;
  kvRead(path: string, version?: number): Promise<BaoResult<{ envelope: SecretEnvelope; version: number }>>;
  kvMetadata(path: string): Promise<BaoResult<{ currentVersion: number; versions: Record<string, { deleted: boolean; destroyed: boolean }> }>>;
  kvList(prefix: string): Promise<BaoResult<{ names: string[] }>>;
  kvSoftDelete(path: string, version: number, c: Correlation): Promise<BaoResult<null>>;
  kvUndelete(path: string, version: number, c: Correlation): Promise<BaoResult<null>>;
  tokenCreateFromRole(role: string, ttlSeconds: number, c: Correlation): Promise<BaoResult<{ token: string; accessor: string; ttlSeconds: number }>>;
  tokenLookupSelf(): Promise<BaoResult<TokenInfo>>;
  tokenLookupAccessor(accessor: string): Promise<BaoResult<TokenInfo>>;
  tokenRevokeAccessor(accessor: string, c: Correlation): Promise<BaoResult<null>>;
  tokenRevokeSelf(): Promise<BaoResult<null>>;
}
export interface TokenInfo { accessor: string; policies: string[]; orphan: boolean; renewable: boolean; type: string;
                             ttlSeconds: number; explicitMaxTtlSeconds: number; namespacePath: string }
export function appRoleLogin(target: OpenBaoTarget, namespace: string, roleId: string, secretId: string):
  Promise<BaoResult<{ token: string; accessor: string; ttlSeconds: number }>>;

// admin.ts — operator authority; apps/api must never import it (a skeleton test checks the import graph)
export class OpenBaoAdmin {
  constructor(target: OpenBaoTarget, operatorToken: string);
  registerAuditHeaders(): Promise<void>;                                                  // root namespace, idempotent
  createNamespace(namespace: string): Promise<void>;
  mountKv(namespace: string): Promise<void>;                                              // kv v2, cas_required, max_versions 20, delete_version_after "0s"; waits out "Upgrading"
  enableAppRole(namespace: string): Promise<void>;
  putPolicy(namespace: string, name: string, hcl: string): Promise<void>;
  readPolicy(namespace: string, name: string): Promise<string | null>;
  putAppRole(namespace: string, name: "runtime" | "issuer" | "provisioner", ttlSeconds: number): Promise<{ roleId: string }>;
  newSecretId(namespace: string, name: string): Promise<{ secretId: string }>;
  putTokenRole(namespace: string, name: string, role: MachineTokenRole): Promise<void>;
  readTokenRole(namespace: string, name: string): Promise<MachineTokenRole | null>;
  listAccessors(namespace: string): Promise<string[]>;                                    // LIST auth/token/accessors, needs sudo; "" = root namespace
}

// policies.ts
export function renderPolicy(kind: "runtime" | "issuer" | "provisioner" | "backup"): string;
export function renderMachinePolicy(projectId: ProjectId, environmentId: EnvironmentId): string;
export interface MachineTokenRole { allowed_policies: string[]; orphan: true; renewable: false; token_no_default_policy: true;
                                    token_explicit_max_ttl: number; token_type: "service"; token_period: 0; token_num_uses: 0 }
export function machineTokenRole(environmentId: EnvironmentId): MachineTokenRole;        // max TTL = LIMITS.machineToken.maxTtlSeconds

// authority.ts
export type Identity = "runtime" | "issuer" | "provisioner" | "machine" | "backup";
export interface AuthorityCell { identity: Identity; action: string; request: { method: string; path: string; body?: unknown };
  target: "own" | "other_environment" | "other_organization" | "root"; expect: "allow" | "deny" }
export const AUTHORITY_MATRIX: readonly AuthorityCell[];
```

Harness additions (`tests/harness/org-fixture.ts`, `tests/harness/stack.ts`):

```ts
export interface OrgFixture {
  organizationId: OrganizationId; namespace: string; projectId: ProjectId;
  environments: { id: EnvironmentId; machineName: string }[];
  login(identity: "runtime" | "issuer" | "provisioner"): Promise<string>;                 // a fresh AppRole login token
  drop(): Promise<void>;
}
export function createOrgFixture(stack: Stack, opts?: { environments?: number }): Promise<OrgFixture>; // default 2 environments
export interface AuditEntry { type: "request" | "response"; namespacePath: string; path: string; operation: string;
  headers: Record<string, string[]>; raw: string }
export function readAuditLog(stack: Stack): Promise<AuditEntry[]>;                        // docker compose exec, parsed JSON lines
```

Design fixed here:

- **Audit device** (P-21), added to `infra/compose/dev/openbao.hcl`; a named volume `baoaudit` is mounted at `/openbao/audit`, writable by the OpenBao uid:

  ```hcl
  audit "file" "main" {
    options {
      file_path = "/openbao/audit/audit.log"
      mode      = "0600"
    }
  }
  ```

  After init the harness calls `registerAuditHeaders()`: `POST /v1/sys/config/auditing/request-headers/x-mykey-operation-id` and `…/x-mykey-dispatch-id`, each with `{"hmac": false}`. OpenBao does not answer a request it cannot audit, so a wrong volume owner shows up as a hanging stack: read the uid with `docker run --rm <image> id` as Session 1 did.
- **Policy templates** (`infra/openbao/policies/*.hcl`; `policies.ts` reads them and substitutes only validated ids). All four namespace policies are written inside `org-<id>`; `backup` is written in the root namespace.

  ```hcl
  # runtime.hcl
  path "kv/data/p/*"            { capabilities = ["create", "update", "read"] }
  path "kv/metadata/p/*"        { capabilities = ["read", "list"] }
  path "kv/delete/p/*"          { capabilities = ["update"] }
  path "kv/undelete/p/*"        { capabilities = ["update"] }
  path "auth/token/lookup-self" { capabilities = ["read"] }
  path "auth/token/revoke-self" { capabilities = ["update"] }

  # issuer.hcl
  path "auth/token/create/machine-env-*" { capabilities = ["update"] }
  path "auth/token/roles/machine-env-*"  { capabilities = ["read"] }
  path "sys/policies/acl/machine-env-*"  { capabilities = ["read"] }
  path "auth/token/lookup-accessor"      { capabilities = ["update"] }
  path "auth/token/revoke-accessor"      { capabilities = ["update"] }
  path "auth/token/revoke-self"          { capabilities = ["update"] }

  # provisioner.hcl
  path "sys/policies/acl/machine-env-*"  { capabilities = ["create", "update", "read"] }
  path "auth/token/roles/machine-env-*"  { capabilities = ["create", "update", "read"] }
  path "auth/token/revoke-self"          { capabilities = ["update"] }

  # machine-env.hcl  ({{pid}} and {{eid}} are substituted)
  path "kv/data/p/{{pid}}/e/{{eid}}/*"    { capabilities = ["read"] }
  path "kv/metadata/p/{{pid}}/e/{{eid}}/" { capabilities = ["list"] }
  path "auth/token/lookup-self"           { capabilities = ["read"] }

  # backup.hcl  (root namespace)
  path "sys/storage/raft/snapshot" { capabilities = ["read"] }
  ```

- **Bootstrap of one organization** (done by `createOrgFixture` with the root token; Run 3.8 turns it into the provisioner): create namespace → mount `kv` → enable AppRole → write the three policies → three AppRole roles with `token_policies` = its own policy, `token_no_default_policy: true`, `token_type: "service"`, `token_ttl` = `token_max_ttl` = P-22 values, `secret_id_num_uses: 0` → per environment: machine policy, then token role → read every object back and compare.
- **The client never retries and never guesses.** Once request bytes may have left, a deadline or a broken connection returns `kind: "unknown"`. Before that point (TLS failure, connection refused) it is `invalid` or `sealed`. No method accepts a namespace or path from outside `paths.ts`.

### Task A — client, paths, audit device, organization fixture (Runs 2.2, 2.4 and 2.8 start when this is merged)

- [ ] **Step 1 — Failing unit tests.** `paths.test.ts`: `namespaceFor` of a known UUID is `org-<uuid>`; `secretPath` gives `p/<pid>/e/<eid>/NAME`; a name with `/`, `..`, a lower-case letter or the prefix `SECRETS_` throws; an id that is not a UUID throws; the thrown text does not contain the input. `policies.test.ts`: each rendered policy equals a committed snapshot; `renderMachinePolicy` contains exactly three `path` blocks and both ids; `machineTokenRole` deep-equals `{allowed_policies:["machine-env-<eid>"], orphan:true, renewable:false, token_no_default_policy:true, token_explicit_max_ttl:2592000, token_type:"service", token_period:0, token_num_uses:0}`.
- [ ] **Step 2 — Failing integration tests** `client.test.ts` (shared stack, `createOrgFixture`):
  - `fixture reads back what it wrote` — every policy equals its template; every token role equals `machineTokenRole`; `kv/config` shows `cas_required: true`, `max_versions: 20`.
  - `runtime writes and reads an envelope` — `kvWrite(path, {value:"synthetic-1", operation_id, format:1}, 0, c)` → version 1; `kvRead` returns the same envelope.
  - `a stale cas is a cas_mismatch, not an error` — second write with `cas: 0` → `{ok:false, kind:"cas_mismatch"}`.
  - `soft delete and undelete name their version` — after `kvSoftDelete(path, 1, c)` a read is `not_found` and metadata shows `deleted: true`; after `kvUndelete(path, 1, c)` the value is back with version 1.
  - `a deadline is unknown, never a failure` — against a listener that accepts and never answers (a local TCP server with the stack's certificate is not needed: use `deadlineMs: 1` against the real server) the result is `{ok:false, kind:"unknown", cause:"timeout"}`.
  - `no automatic retry` — one `kvWrite` produces exactly one audit `request` entry for that dispatch id.
  - `AppRole tokens carry only their policy` — `tokenLookupSelf` for `runtime`: policies `["runtime"]`, no `default`, `ttlSeconds` ≤ 900.
- [ ] **Step 3 — Run:** `pnpm test -- tests/unit/openbao` and `pnpm run test:integration -- tests/integration/openbao/client.test.ts` → FAIL (module not found).
- [ ] **Step 4 — Implement** the audit stanza and volume, `registerAuditHeaders` in harness init, `paths.ts`, `policies.ts`, `client.ts`, `admin.ts`, `org-fixture.ts`, `readAuditLog`. Add a skeleton test: no file under `apps/api` imports `admin.ts`.
- [ ] **Step 5 — Run:** PASS, including the whole Session 1 integration suite (the audit device must not have slowed or broken it). Commit `feat(openbao): narrow client, policy templates, audit device and organization fixture`.

### Task B — audit evidence

- [ ] **Step 1 — Failing test** `audit.test.ts`: after a `kvWrite` whose value is a run-time canary — one `request` and one `response` entry exist for the dispatch id; both carry `x-mykey-operation-id` and `x-mykey-dispatch-id` in clear; `namespacePath` is `org-<id>/`; the raw audit file does not contain the canary and does not contain the client token; a denied request (machine token writing) is recorded too; a header sent as `X-MyKey-Operation-Id: evil` by a caller of the product client cannot be set (the client overwrites both headers — assert the audit value equals the `Correlation` passed).
- [ ] **Step 2 — Run, implement what is missing, run:** PASS. Commit `test(openbao): audit correlation headers, no value and no token in the audit file`.

### Task C — authority matrix and attacks

- [ ] **Step 1 — Write `AUTHORITY_MATRIX`.** One cell per identity × action × target. Actions, each a concrete request:
  - **KV:** write, read current, read version 1 (`?version=1`), list environment, list `kv/metadata/p/<pid>/e/`, list `kv/metadata/p/`, list `kv/metadata/`, soft delete (`kv/delete`), `DELETE kv/data/…`, undelete, `kv/destroy`, `DELETE kv/metadata/…`, read metadata, `PATCH kv/data/…`, read `kv/subkeys/…`, write `kv/config`, read and tune `sys/mounts/kv`.
  - **Tokens:** `auth/token/create`, `auth/token/create-orphan`, `auth/token/create/machine-env-<own>`, `auth/token/renew-self`, lookup-self, lookup-accessor, revoke-accessor, `LIST auth/token/accessors`, read and write `auth/token/roles/machine-env-<own>`, write `auth/token/roles/other`.
  - **Policies and auth:** read and write `sys/policies/acl/machine-env-<own>`, write `sys/policies/acl/runtime`, list `sys/policies/acl`, read `sys/auth`, enable an auth method, write `auth/approle/role/issuer`, create `auth/approle/role/runtime/secret-id`.
  - **System:** `LIST sys/namespaces`, create a child namespace, `GET sys/storage/raft/snapshot`, `sys/audit`, `sys/config/auditing/request-headers`, `sys/seal`, `sys/raw/…`.
  - **Targets:** `own`; `other_environment` (same organization, second environment — matters for `machine`); `other_organization` (the same request with organization B's namespace header, and again with the root namespace and the path prefixed `org-<B>/`); `root`.
  - **Expected allows** are exactly the rows of the Doc 06 §5 table as rendered above. Everything else is `deny`. The machine cell "read version 1 of its own environment" is `allow`: record it as the known property Doc 06 §5 describes (a raw machine token can read retained versions; the product API does not).
- [ ] **Step 2 — Failing tests.** `authority.test.ts` (unit, structure): every identity × action has an `own` cell; every `deny` cell has an `allow` cell for the same request by some identity or by the root token (Review focus 4); no two cells are equal. `authority.test.ts` (integration): two fixtures A and B; for every cell issue the request with a real token of that identity (machine tokens are issued with the root token here — Run 2.2 owns issuance) and assert `allow` → 200 or 204, `deny` → exactly 403, except the cells where OpenBao answers before policy (root-only `sys/` paths from a namespace answer 400): those cells carry `expectStatus` and the reason.
- [ ] **Step 3 — Run and resolve.** Every surprise is one of: a wrong template (fix the template), a wrong expectation (fix the cell and say why in D-17), or a real exposure (record it, do not hide it).
- [ ] **Step 4 — PO-3: runtime identity.** Doc 06 §5 calls the runtime identity "inline runtime AppRole … subject to PO-3". Read the pinned 2.7.2 documentation for an inline or per-request authentication mode. If it exists, test it against the same matrix; choose it only if it removes a stored login token without adding rights. Otherwise the P-22 login stands. Either way D-17 states the choice and the reason.
- [ ] **Step 5 — Measure what a hostile API process holds** (Doc 06 §1.2 item 5, §17.4): with a runtime token and an issuer token of organization A together, list what can be done — read and write every environment of A, mint a 30-day read token for any environment of A, revoke any accessor of A it knows — and what cannot: anything in B, any policy or role change, any token outside the role family. With a provisioner token: it can write any policy text under the `machine-env-*` names; together with the issuer that is every right inside the namespace. Write these sentences, with the test names that prove them, into D-17.
- [ ] **Step 6 — Render the matrix.** `scripts/authority-matrix.ts` writes `docs/evidence/session-2/authority-matrix.md` from `AUTHORITY_MATRIX` (identity rows, action columns, observed status); `--check` fails when the file is stale. Add `authority:check` to `check`.
- [ ] **Step 7 — D-17, run note, commit** `feat(openbao): authority matrix verified with real tokens (PO-3)`.

**Registry:** `PO-3 SPIKE_PASS`. PO-4 and FR-1.13 stay `OPEN`; the run note is listed as contributing evidence.

**Covers:** PO-3; early evidence for PO-4, FR-1.13. **Done when:** the written authority matrix shows every allowed and denied action, verified with real tokens.

---

## Run 2.2 — Machine-token issuance proof · ∥

**Files:** `tests/integration/openbao/issuance.test.ts`, `docs/decisions/D-18-issuer-placement.md`.

**Consumes:** `OpenBaoClient`, `OpenBaoAdmin`, `createOrgFixture`, `machineName` (Run 2.1 Task A).

**Produces:** the verdict Run 5.1 builds on, and the list of request parameters an issuer may and may not influence.

The issuance sequence under test is the one Run 5.1 will use: `issuer` AppRole login (60 s token) → `tokenCreateFromRole(machineName(env), ttl, c)` with body `{ "ttl": "<n>s", "policies": ["machine-env-<eid>"], "no_default_policy": true }` → `tokenLookupAccessor` → `tokenRevokeSelf` of the issuer.

- [ ] **Step 1 — Failing tests** (shared stack, fixture with two environments E1 and E2, second fixture B):
  - `issued token has the required shape` — lookup by accessor and lookup-self agree: `orphan: true`, `renewable: false`, `type: "service"`, `policies` exactly `["machine-env-<E1>"]`, `explicitMaxTtlSeconds: 2592000`, `ttlSeconds` within 5 s of the requested 2,592,000, `namespacePath` `org-<A>/`.
  - `the issuer cannot widen anything` — each request by the issuer is refused or has no effect, and the resulting token (if any) is looked up to prove it: `policies: ["runtime"]` → 400 or 403, no token; `policies: ["default"]` → refused; `ttl` of 2,592,001 s → token capped at 2,592,000; `explicit_max_ttl: "9000h"` → 2,592,000; `renewable: true` → still `false`; `period: "1h"` → refused; `no_parent: false` → still `orphan: true`; `no_default_policy: false` → policies still without `default`; `id: "chosen"` → refused; `type: "batch"` → still `service`; role `machine-env-<E1>` of organization B with A's issuer → 403.
  - `the issuer has no other way to make a token` — `auth/token/create`, `auth/token/create-orphan`, `auth/token/create/unknown-role` → 403 (control: the root token can).
  - `the token outlives its issuer` — issue; let a 3-second issuer login expire (a test-only AppRole role with `token_ttl: 3`); the machine token still reads. Issue again; `tokenRevokeSelf` the issuer; the machine token still reads. Issue again; revoke the issuer by accessor with the root token; still reads.
  - `revoking the accessor kills it` — `tokenRevokeAccessor` → the next read is 403 and lookup by accessor is an error.
  - `a short token expires by itself` — `ttl: "2s"` → after 3 s the read is 403.
  - `the machine token can only read its environment` — with the token itself, straight at OpenBao: read a secret of E1 → 200; list E1 → 200; write, soft delete, undelete, destroy, metadata delete, `renew-self`, `auth/token/create`, read a secret of E2, list `kv/metadata/p/<pid>/e/`, the same read with B's namespace header → 403 each; `lookup-self` → 200. (These overlap the matrix on purpose: here the token was issued by the issuer, there by root.)
  - `an operator can find a token nobody recorded` — issue with the issuer and throw the answer away; `admin.listAccessors(namespace)` contains an accessor whose lookup shows the `machine-env-<E1>` policy and `orphan: true`; revoke it; list again without it. Then: `listAccessors` of organization B and of the root namespace do **not** contain it — enumeration is per namespace, so an operator must walk every namespace (write this into D-18 for Runs 5.2 and 6.8).
- [ ] **Step 2 — Run:** FAIL where the fixture lacks the 3-second role; add it to the test, not to the product templates. Run again: every assertion is an observation — do not adjust an expectation without writing the observed behaviour into the run note.
- [ ] **Step 3 — Verdict.** The first choice holds when every test passes with the issuer policy exactly as rendered in Run 2.1 (no `sudo`, no generic create). If a test can only pass with a wider issuer policy, take the Doc 10 §8.1 fallback — a separate private issuer process holding the issuer credential — record which later runs change (5.1, 5.2, 5.3) and continue.
- [ ] **Step 4 — D-18, run note, commit** `test(openbao): fixed-role orphan issuance proven on 2.7.2 (early PO-2)`.

**Registry:** `PO-2 SPIKE_PASS` (owner run 5.4 closes it).

**Covers:** early PO-2. **Done when:** all of the above observed, or the fallback is recorded.

---

## Run 2.3 — Better Auth secure-storage spike (D08-S07, G-AUTH) · ∥

**Files:** `packages/auth/src/{auth,keys,session-verifier,protected-adapter,routes,index}.ts`, `packages/auth/src/factors/{seed,totp,recovery,elevate}.ts`, `packages/db/src/schema/auth.ts`, `packages/db/migrations/0003_auth_base.sql`, `scripts/auth-route-contract.ts`, `docs/auth-route-contract.md`, `tests/unit/auth/{verifier,routes,seed,recovery}.test.ts`, `tests/integration/auth/{routes,storage,factors,race,dump,stock-plugin}.test.ts`, `tests/integration/database/privileges.test.ts` (matrix extended), `docs/decisions/D-19-auth-storage-design.md`; pins for `better-auth`, `jose`, `otpauth` in the lock file and catalog.

**Consumes:** `freshDatabase`, `applyRoles`, `migrate`, `createPool` (Session 1); `LIMITS`.

**Produces** (`@mykey/auth`, used by Session 3):

```ts
// keys.ts
export interface KeyRing { current: string; keys: Readonly<Record<string, Uint8Array>> } // key id → 32 bytes
export interface AuthKeys { cookieSecret: string; sessionLookup: KeyRing; seedEncryption: KeyRing; recoveryVerifier: KeyRing }
export function loadAuthKeys(directory: string): AuthKeys;                                // files "<ring>.<keyId>.key", mode 0600; throws when a ring is empty
// session-verifier.ts
export function sessionVerifier(ring: KeyRing, rawToken: string, keyId?: string): string;  // "v1.<keyId>.<base64url>"
export function sessionVerifierCandidates(ring: KeyRing, rawToken: string): string[];      // one per key id, current first
// protected-adapter.ts
export class UnsupportedTokenOperation extends Error {}
export function protectedAdapter<A>(inner: (options: BetterAuthOptions) => A, ring: KeyRing): (options: BetterAuthOptions) => A;
// auth.ts
export function createAuth(deps: { db: NodePgDatabase; keys: AuthKeys; baseURL: string }): Auth;
// routes.ts
export interface NativeRoute { method: string; path: string }
export function nativeRoutes(auth: Auth): NativeRoute[];                                   // from auth.api, HTTP-reachable only
export const NATIVE_ALLOWED: readonly NativeRoute[];
export const NATIVE_DENIED: readonly NativeRoute[];
export function mountAuthRoutes(app: Hono, auth: Auth): void;                              // explicit routes under /v1/auth, nothing else
// factors
export function encryptSeed(ring: KeyRing, seed: Uint8Array, bind: { userId: string; enrollmentId: string }): Promise<string>;
export function decryptSeed(ring: KeyRing, jwe: string, bind: { userId: string; enrollmentId: string }): Promise<Uint8Array>;
export function generateRecoveryCodes(): string[];                                         // LIMITS.recovery.codeCount codes
export function recoveryVerifier(ring: KeyRing, enrollmentId: string, code: string): Buffer;
export type ElevateResult = { ok: true; setCookie: string } | { ok: false; reason: "invalid" | "replayed" | "expired" | "wrong_state" };
export function elevateWithTotp(deps: FactorDeps, input: { sessionToken: string; code: string; now?: Date }): Promise<ElevateResult>;
export function elevateWithRecoveryCode(deps: FactorDeps, input: { sessionToken: string; code: string }): Promise<ElevateResult>;
```

What the published 1.7.19 package shows (source reading; the tests below turn each line into an observation):

- Core registers 30 HTTP paths whether or not they are configured, among them `/sign-up/email`, `/request-password-reset`, `/reset-password`, `/reset-password/:token`, `/update-user`, `/update-session`, `/verify-password`, `/sign-in/social`, `/callback/:id`, `/list-sessions`. Each endpoint in `auth.api` carries `.path` and `.options.method`; server-only ones have no path or `options.metadata.SERVER_ONLY`.
- `session.token` is stored as generated, in clear. There is no hashing option. `/list-sessions` returns every token to the client; `/revoke-session` takes one. `databaseHooks` cannot change the stored value without changing the cookie.
- `database` accepts a function `(options) => adapter`, so an adapter can be wrapped; the wrapper must also wrap the object handed to `transaction` callbacks. Adapter methods: `create`, `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`, `consumeOne`, `incrementOne`, `transaction`.
- `advanced.disableOriginCheck` defaults to **true under a test environment**, and then the CSRF check is skipped too: the spike sets both `disableOriginCheck: false` and `disableCSRFCheck: false` explicitly.
- Calling `auth.api.<endpoint>` directly bypasses `disabledPaths`, the built-in rate limiter and the origin check.
- `twoFactor`: backup codes are stored as one encrypted, decryptable list (`"plain" | "encrypted" | custom`), no step is remembered so a code works twice in its window, and `trustDevice` is a body field with no configuration switch.

Design fixed here:

- **Configuration:** `basePath: "/v1/auth"`; `emailAndPassword: { enabled: true, disableSignUp: true }`; no `sendResetPassword`; no social provider; no plugin; `session: { expiresIn: LIMITS.session.absoluteSeconds, disableSessionRefresh: true, freshAge: 0, cookieCache: { enabled: false } }`; no `secondaryStorage`; `rateLimit: { enabled: false }` (Run 3.3 owns throttling); `verification: { storeIdentifier: "hashed" }`; `advanced.database.generateId` returns `crypto.randomUUID()`; Drizzle adapter with `provider: "pg"`, the hand-written tables of schema `auth`, `transaction: true`; `database: protectedAdapter(drizzleAdapter(…), keys.sessionLookup)`. Session fields `phase`, `authEpoch`, `authenticatedAt`, `lastUserActivityAt`, `totpVerifiedAt`, `enrollmentId` are `additionalFields` with `input: false`.
- **Wrapped adapter (P-26).** For model `session`: in `create` and `update` data, `token` is replaced by `sessionVerifier(ring, token)`; a `where` clause `token = x` becomes `token in sessionVerifierCandidates(ring, x)`, and `token in [...]` likewise; the row returned from `create` and from a lookup by token carries the raw token the caller supplied, so the cookie is still built from the raw value. Rows returned by any other route (`findMany` by `userId`) carry `token: ""`. Any other operator on `token`, a sort on it, or a `count` filtered by it throws `UnsupportedTokenOperation`. Every other model passes through untouched.
- **Routes (P-25).** `NATIVE_ALLOWED`: `POST /sign-in/email`, `POST /sign-out`, `GET /get-session`, `POST /change-password`, `POST /revoke-sessions`. Every other native route is in `NATIVE_DENIED`. `mountAuthRoutes` registers the allowed five plus the factor routes `POST /v1/auth/totp/enroll`, `/totp/activate`, `/totp/verify`, `/recovery/verify`, `/recovery/regenerate`; anything else under `/v1/auth` answers the contract's `404 not_found` envelope. The sign-in response body is rewritten to drop `token`. Strict body schemas: an unknown field such as `trustDevice` is a `400 malformed_request`.
- **Tables** (`0003_auth_base.sql`, schema `auth`, ids `uuid` without default, `timestamptz`): Better Auth's `user`, `session`, `account`, `verification` with snake_case columns, plus on `session`: `phase` text check in (`password_verified`, `enrollment`, `mfa_complete`) default `password_verified`, `auth_epoch` bigint, `authenticated_at`, `last_user_activity_at`, `totp_verified_at` null, `enrollment_id` uuid null. Product tables:

  | Table | Columns and constraints |
  | --- | --- |
  | `auth.account_state` | `user_id` pk → `user`; `state` in (`enrollment_pending`, `active`, `recovery_pending`, `disabled`); `auth_epoch` bigint default 0; `credential_epoch` bigint default 0; `updated_at` |
  | `auth.totp_enrollment` | `id` pk; `user_id` → `user`; `seed_jwe` text; `key_id` text; `state` in (`pending`, `active`, `retired`); `created_at`; `activated_at` null; unique (`user_id`) where `state = 'active'` |
  | `auth.totp_step_used` | pk (`enrollment_id`, `step`); `enrollment_id` → `totp_enrollment`; `step` bigint; `used_at` default `now()` |
  | `auth.recovery_code` | `id` pk; `enrollment_id` → `totp_enrollment`; `verifier` bytea; `key_id` text; `consumed_at` null; `consumed_by_session` uuid null; unique (`enrollment_id`, `verifier`) |

  The migration also adds the foreign key `app.membership.user_id` → `auth.user(id)` (Session 1, P-14) and narrows the default grants: `api_runtime` gets `SELECT, INSERT` only on `totp_step_used`, and on `recovery_code` `SELECT, INSERT` plus `UPDATE (consumed_at, consumed_by_session)`. Extend the expected-grants matrix of `privileges.test.ts` in the same commit — the catalog sweep fails on an unknown table.
- **Seed and codes.** Seed: 20 random bytes, stored only as a compact JWE (`jose`, `alg: "dir"`, `enc: "A256GCM"`) whose protected header carries `kid`, `purpose: "totp-seed"`, `sub` (user id) and `enr` (enrollment id); `decryptSeed` rejects a header that does not match its `bind` argument. TOTP through `otpauth`: SHA-1, 6 digits, 30 s, window ±1 (`LIMITS.totp`). Recovery codes: ten codes of 20 characters from a 32-symbol alphabet (100 bits), shown as four groups of five; stored as `HMAC-SHA-256(recovery key, enrollmentId || code)`.
- **Elevation is one transaction** on one connection: lock the `account_state` row and the session row → check state, epochs and expiry → find the matching step by comparing the code against steps −1, 0, +1 in that fixed order, **without** looking at used steps first → `INSERT` into `totp_step_used`; a unique violation is `replayed` → insert the new `mfa_complete` session row (new random token, stored as verifier, same `authenticated_at`) and delete the old row → commit → only then build `setCookie` with Better Auth's own cookie signing. A recovery code does the same with `UPDATE … SET consumed_at = now() WHERE consumed_at IS NULL RETURNING`, and leaves `totp_verified_at` empty.

### Task A — inventory and closed routes

- [ ] **Step 1 — Pins.** Install `better-auth` (catalog), add `jose` and `otpauth` to the catalog and to `infra/dependencies.lock.json` after the advisory check of Run 1.3 Step 2; if either has an open advisory or no stable release, name the replacement in D-19.
- [ ] **Step 2 — Failing tests.**
  - `routes.test.ts` (unit): `nativeRoutes(auth)` is non-empty; every route is in exactly one of `NATIVE_ALLOWED` and `NATIVE_DENIED` (a route in neither fails with its name — this is what catches an upgrade that adds one); no allowed route has a path parameter; `NATIVE_ALLOWED` has the five entries above.
  - `routes.test.ts` (integration, a Hono app with `mountAuthRoutes`, real database): every denied native route, called with its real method on `/v1/auth<path>` (parameters filled with `x`), with and without a valid `mfa_complete` cookie, answers 404 with the `not_found` envelope and creates no row; named cases with realistic bodies: sign-up, reset request, reset with a token, `/update-user`, `/change-email`, `/delete-user`, `/list-sessions`, `/revoke-session`, `/sign-in/social`, `/callback/x`, `/verify-password`, `/update-session`, and the plugin paths that must not exist at all (`/two-factor/disable`, `/two-factor/enable`, `/two-factor/verify-totp`); doubled and trailing slashes (`/v1/auth//sign-up/email`, `/v1/auth/sign-up/email/`) are 404 too; `auth.api.signUpEmail` called in-process is refused; `trustDevice: true` on `/totp/verify` is 400; control: sign-in with a seeded user answers 200 and sets one cookie.
  - `origin and CSRF checks are on in this test run` — `auth.options.advanced.disableOriginCheck === false` and `disableCSRFCheck === false`.
- [ ] **Step 3 — Implement** `createAuth`, `routes.ts`, the migration and schema; seed test users through the operator path a bootstrap will use (`(await auth.$context).password.hash` plus rows for `user`, `account`, `account_state`) — proving that an account can be created while sign-up stays closed.
- [ ] **Step 4 — Run:** PASS. Commit `feat(auth): Better Auth behind an explicit route allowlist`.

### Task B — why the stock plugin is not used (capped at 45 minutes)

- [ ] **Step 1 — `stock-plugin.test.ts`**, a throw-away Better Auth instance with `twoFactor()` on its own fresh database, three observations: `a TOTP code is accepted twice inside its window`; `stored backup codes decrypt with the server secret` (read the row, decrypt with the documented helper or by calling the server-only view function); `verify-totp with trustDevice: true sets a trust cookie`. Each test asserts the weakness is present; if one of them is **absent** on the pinned version the test fails and D-19 must say so.
- [ ] **Step 2 — Commit** `test(auth): the stock two-factor plugin fails three contract rules`.

### Task C — protected sessions

- [ ] **Step 1 — Failing tests.**
  - `verifier.test.ts` (unit): format `v1.<keyId>.<43 base64url characters>`; same token and key → same verifier; different key id → different verifier; `sessionVerifierCandidates` lists the current key first; a ring with no current key throws.
  - `storage.test.ts` (integration): after sign-in the cookie token is not in `auth.session.token`, and the stored value equals `sessionVerifier`; `get-session` with the cookie works; with the stored verifier used as a cookie value it does not; sign-out removes the row; `change-password` with `revokeOtherSessions` leaves exactly one row; `revoke-sessions` leaves none; after the lookup key is rotated (new current key, old key still in the ring) an old session still resolves and a new one is stored under the new key id; with the old key removed the old session is dead.
  - `the wrapper sees every token path` — a recording layer under the wrapper logs `(model, method, fields in where, fields in data)` for the whole flow (sign-in, get-session, elevate, change-password, revoke-sessions, sign-out); the set of calls that mention `token` equals a committed list, and no logged argument contains a raw token.
  - `unsupported token operations fail closed` — `findMany` on `session` with `token` under `contains`, `starts_with`, `ne`, and a sort by `token`, each throw `UnsupportedTokenOperation`.
  - `client input cannot set factor state` — sign-in with extra body fields `phase`, `totpVerifiedAt` → 400, session row has `password_verified`.
- [ ] **Step 2 — Implement** `session-verifier.ts`, `protected-adapter.ts`. **Step 3 — Run:** PASS. Commit `feat(auth): session tokens stored as keyed verifiers`.

### Task D — factors, races and the dump

- [ ] **Step 1 — Failing tests.**
  - `seed.test.ts`, `recovery.test.ts` (unit): the JWE has five parts and header `alg: dir`, `enc: A256GCM`; decrypt with another `userId` or `enrollmentId` throws; decrypt after the key id is removed throws; ten codes, all different, each 20 symbols; the verifier is 32 bytes and differs per enrollment for the same code.
  - `factors.test.ts`: a `password_verified` session is refused by a product-route guard stub (`requireMfaComplete`) and accepted after elevation; elevation rotates the bearer — the old cookie is dead, the new one resolves, `authenticated_at` is unchanged, `totp_verified_at` is set; a code for step −1 and +1 is accepted, −2 and +2 refused (clock passed as `now`); the same code a second time is `replayed`, also after the process is restarted and with the clock set back one step; a recovery code elevates once, leaves `totp_verified_at` null, and is `invalid` the second time; regeneration makes all ten old codes invalid before the new ones are returned.
  - `race.test.ts` (two child processes, each with its own pool and `createAuth`, started together against one database; 50 rounds): two elevations with the same valid code on the same pending session → exactly one `ok`; on two different pending sessions of the same user → exactly one `ok`, the other `replayed`; two uses of one recovery code → exactly one `ok`; in every round the table holds one `mfa_complete` session per success and no elevated session without a consumed step or code.
  - `dump.test.ts`: run the whole flow while collecting every raw session token, the base32 seed, all ten recovery codes and the password; then `pg_dump` the database in plain format through the PostgreSQL container and read the PostgreSQL log (`docker compose logs postgres`) — after forcing one failing statement that has a raw token as a bind parameter; none of the collected strings appears in the dump or in the log. Control: the user's e-mail address does appear in the dump (the search works).
- [ ] **Step 2 — Implement** `factors/*`. **Step 3 — Run:** PASS, three times in a row for `race.test.ts`. Commit `feat(auth): product-owned TOTP and recovery codes with one-use steps`.

### Task E — contract, verdict

- [ ] **Step 1 — `docs/auth-route-contract.md`.** `scripts/auth-route-contract.ts` generates it: the pinned Better Auth version; one table of all native routes with `allowed`/`denied`; for each allowed and each factor route — method, path, request schema, success status and body, error codes, cookies set (name, attributes — this also settles the cookie name left open by D-15), account states and session phases allowed, and "Origin check: product (Run 3.7)". `--check` fails when the file is stale; add `auth:contract:check` to `check`.
- [ ] **Step 2 — Verdict (G-AUTH).** GO when Tasks A, C and D pass with: session rows written only through the wrapped adapter or through `elevate.ts` using the same verifier function; the cookie built only by Better Auth's signing; no test relying on a hook alone. **Fallback (Doc 10 §8.1)** when the wrapper cannot cover a token path, or elevation cannot be made one transaction, or the cookie cannot be produced without copying Better Auth internals: Better Auth for password verification only, with a product-owned session table and cookie in `packages/auth`; Tasks C and D are re-run against that design before the run ends. Plain token storage is never the outcome.
- [ ] **Step 3 — D-19, run note, commit.** D-19 records P-24, P-25, P-26, the libraries, the five allowed native routes and the factor routes (an addition to the route set of D-15, which left auth routes to this run), the verdict, and under a fallback the runs that change (3.2, 3.4, 3.5, 3.6, 7.2). Commit `docs(auth): route contract and G-AUTH verdict`.

**Registry:** `PO-15 SPIKE_PASS`, `PO-5 SPIKE_PASS`. PO-6 stays `OPEN` (reset and the full flow are Runs 3.5–3.6).

**Covers:** early PO-5, PO-6, PO-15. **Done when:** `docs/auth-route-contract.md` exists and no usable session token or recovery code is found at rest; otherwise the fallback is taken and recorded.

---

## Run 2.4 — Late-write and exclusion spike (D08-S08, G-EFFECT) · ∥

**Files:** `packages/operations/src/spike/{executor,reconcile,runner}.ts`, `tests/harness/toxiproxy.ts`, `tests/harness/stack.ts` (fault profile), `infra/compose/dev.compose.yml` (service `toxiproxy`, profile `fault`), `tests/fault/effects/{boundaries,late-write,exclusion,maintenance}.test.ts`, `docs/decisions/D-20-late-write-boundary.md`; Toxiproxy image in the lock file.

**Consumes:** `OpenBaoClient`, `Correlation`, `createOrgFixture`, `readAuditLog` (Run 2.1 Task A); `@mykey/db` schema (`operation`, `operation_step`, `effect_slot`, `secret_index`, `environment`, `service_control`, `audit.event`); `restartService`.

**Produces** (throw-away; Run 4.2 writes the real protocol, Run 2.9 uses this one to create load and a held effect):

```ts
export type Boundary = "after_intent" | "after_dispatch_marker" | "after_backend_success" | "after_finalize";
export interface SpikeDeps { runtimePool: pg.Pool; lockTarget: DbTarget; bao: OpenBaoClient; bootId: string;
  crashAt?: Boundary; hangAfterSend?: boolean }
export interface SpikeWrite { organizationId: string; projectId: string; environmentId: string; name: string; value: string;
  expectedVersion: number; idempotencyKey: string }
export type SpikeOutcome =
  | { operationId: string; state: "succeeded"; version: number }
  | { operationId: string; state: "rejected"; code: ErrorCode }
  | { operationId: string; state: "uncertain" };
export function executeWrite(deps: SpikeDeps, input: SpikeWrite): Promise<SpikeOutcome>;
export interface ReconcileDeps { maintenancePool: pg.Pool; operatorBao: OpenBaoClient }
export function reconcile(deps: ReconcileDeps, operationId: string, opts: { executorsExcluded: boolean }):
  Promise<{ state: "succeeded" | "rejected" | "uncertain"; evidence: string[] }>;
// tests/harness
export function startStack(opts?: { project?: string; fixedPorts?: boolean; faultProxy?: boolean }): Promise<Stack>; // adds stack.bao.proxyUrl and stack.toxiproxy
export interface Toxiproxy { delayResponses(ms: number): Promise<void>; delayRequests(ms: number): Promise<void>; clear(): Promise<void> }
```

The loop, following Doc 06 §6.2 with one step per operation:

1. Look up the replay identity (`principal`, `action`, `target`, `idempotencyKey`); an existing operation is answered from its row and never dispatches.
2. Take the session advisory lock on `environment.lock_key` on a dedicated connection (wait ≤ `LIMITS.deadlines.advisoryLockMs`). In one transaction as `api_runtime`: lock `service_control` (`FOR SHARE`) and refuse unless `capture_mode = 'idle'`; refuse when an `effect_slot` row with `scope_key = 'env:<environment_id>'` exists; check `secret_index.current_version` against `expectedVersion`; insert `operation` (`accepted`), `operation_step` (ordinal 0), `effect_slot` and the audit intent. → boundary `after_intent`.
3. One transaction: `operation.state = 'executing'`, `executor_boot_id`, `dispatched_at`, and `operation_step.dispatch_attempt_id = <new uuid>`. → boundary `after_dispatch_marker`.
4. One `kvWrite(path, { value, operation_id, format: 1 }, expectedVersion, { operationId, dispatchId })`. → boundary `after_backend_success`.
5. `ok` → read back, then one transaction: `secret_index` version, fresh random `state_tag`, `environment.metadata_generation + 1`, operation `succeeded`, audit completion, delete the slot. → boundary `after_finalize`. `cas_mismatch`, `denied`, `invalid` → operation `rejected`, slot deleted (the backend answered: no effect). `unknown` → operation `uncertain`, `secret_index.state = 'needs_review'`, **slot kept**.

`reconcile` (as `maintenance`, with an operator token): an operation without `dispatched_at` is `rejected` only when `executorsExcluded` is true; a dispatched one is `succeeded` when the backend holds a version whose envelope carries this `operation_id` (finalize as in step 5), `rejected` when `executorsExcluded` is true and no version carries it and the current version still equals `expectedVersion`, and `uncertain` in every other case. It never changes a terminal operation, always writes a fresh state tag, and returns the evidence it used. It writes no audit event: `maintenance` has no `INSERT` on `audit.event` — record that as a finding for Run 4.5 (which identity records a reconciliation?).

Rejections use contract codes: capture mode not `idle` → `busy`; occupied slot → `state_conflict`; wrong `expectedVersion` → `version_conflict`. The spike's operations are inserted with `principal_kind = 'system'` and action `secret.write`.

- [ ] **Step 1 — Harness.** Toxiproxy as a Compose service under profile `fault`, proxying TCP to `openbao:8200` (TLS passes through untouched; the certificate already names `localhost`), published on an ephemeral loopback port; `tests/harness/toxiproxy.ts` talks to its HTTP API. Test: with `delayResponses(300)` a `kvRead` through `proxyUrl` takes ≥ 300 ms and still verifies the certificate.
- [ ] **Step 2 — Failing tests.** Every scenario ends with the same three checks — `no duplicate`: the audit log holds exactly one `kv/data` write request for the operation id (zero where stated); `no false failure`: an operation is `rejected` only if the backend holds no version with its operation id; `index is true`: `secret_index.current_version` equals the backend's or the row is `needs_review`.
  - `boundaries.test.ts` — the executor runs as a child process (`runner.ts`, job on stdin) and kills itself with `SIGKILL` at the boundary:
    - `after_intent`: operation `accepted`, slot held, zero backend requests. `reconcile(executorsExcluded: false)` → `uncertain`; with `true` → `rejected`; slot gone; a new write with a new key succeeds.
    - `after_dispatch_marker`: operation `executing`, zero backend requests — and yet `reconcile(false)` → `uncertain` (a committed marker counts as possibly sent). After the exclusion of Step 4 below, `reconcile(true)` → `rejected`.
    - `after_backend_success`: backend has version N with the operation id; operation still `executing`. `reconcile(false)` → `succeeded`, index at N, new state tag, slot gone.
    - `after_finalize`: operation `succeeded`. The same request again (same idempotency key) → `succeeded` with the same version and **no** new backend request. `reconcile` changes nothing.
  - `late-write.test.ts` (own stack, `faultProxy: true`):
    - `a delayed answer is uncertain, not failed` — `delayResponses(8000)`, client deadline 5 s → `executeWrite` returns `uncertain`; the backend already has the version; a second write to the same environment is refused with `409 state_conflict` and sends nothing; `reconcile(false)` → `succeeded`.
    - `a write can land after everyone has stopped waiting` — `delayRequests(12000)` and an executor child with `hangAfterSend` (it keeps its socket, like a frozen process): at 6 s the operation is still `executing`, the backend has no version, a second executor is refused; at about 12 s the version appears. This is the late write; record the observed times.
    - `no state is trusted while the old request may still arrive` — same set-up; `reconcile(false)` at 6 s → `uncertain`, never `rejected`.
  - `exclusion.test.ts`: twenty executors started together for one environment with the same `expectedVersion` → exactly one `succeeded`, the rest `rejected` (`version_conflict` or `state_conflict`), one backend write; two environments proceed independently; a slot row cannot be inserted twice (SQLSTATE `23505`); an executor with a different `bootId` cannot finalize another's operation.
  - `maintenance.test.ts` (own stack, `faultProxy: true`) — Doc 06 §6.4 once, end to end:
    - `restart ends a request held on the wire` — `delayRequests(15000)`, hanging executor; at 5 s: kill the executor child, verify it is gone; `docker compose stop openbao`, verify the container is not running; start it; clear the toxic; poll the key for 30 s → no version ever appears; `reconcile(true)` → `rejected`, fresh state tag; the next write succeeds.
    - `restart ends a request the server had accepted but not processed` — `docker compose pause openbao`; send the write (the kernel accepts it); `docker compose kill openbao`, start; poll 30 s → no version; `reconcile(true)` → `rejected`.
    - `a graceful stop may still complete it — and that is visible` — hanging executor with `delayResponses(15000)` (request already inside OpenBao); stop and start; the version **is** there; `reconcile(true)` → `succeeded`. After a restart the backend state is final either way: nothing lands later (poll 30 s, version count unchanged).
- [ ] **Step 3 — Run:** FAIL (module not found). Implement `executor.ts`, `reconcile.ts`, `runner.ts`. Run until green three times in a row; a test that passes only sometimes is a finding, not a flake.
- [ ] **Step 4 — Measure and write down.** (a) How long can a request live inside OpenBao after its client is gone? With the default `default_max_request_duration` (90 s, source reading) and with `"15s"` set in a test stack: record what happens to the delayed request in each case. A shorter value is defence in depth for the staging configuration of Run 2.7, never a substitute for the restart. (b) Which effects this spike did **not** exercise: soft delete, undelete, token issuance, revocation, provisioning, archive — they have no operation marker inside OpenBao and are proven in Runs 4.6, 5.2, 5.3 and 3.8.
- [ ] **Step 5 — Verdict (G-EFFECT) and D-20.** GO when no scenario shows a duplicate write or a false `rejected`, and the two restart tests show nothing arriving after the restart. If a write is ever observed after a restart, the per-environment boundary does not hold: take the Doc 10 §8.1 fallback (any uncertain effect closes the whole service for operator reconciliation), state which runs change (4.5, 4.6, 6.4) and continue. D-20 holds the verdict, the measured times, the chosen `default_max_request_duration`, the unproven effect list and the sentence "a heartbeat that stops never lets another worker take over".
- [ ] **Step 6 — Run note, commit** `test(operations): late-write and exclusion spike with real process death and network delay (early PO-16)`.

**Registry:** `PO-16 SPIKE_PASS` (owner run 8.3 closes it).

**Covers:** early PO-16. **Done when:** no scenario produces a duplicate write or a false "failed"; the maintenance procedure of Doc 06 §6.4 is demonstrated once.

---

## Run 2.5 — Host hardening and network skeleton (D08-S03) · OWNER (OWN-2)

**Files:** `scripts/host.ts`, `scripts/require-staging-env.ts`, `tests/harness/staging.ts`, `vitest.config.ts` (project `staging`), `package.json` (`test:staging`, `host`), `.gitattributes`, `infra/hosts/bootstrap/{10-packages,20-wireguard,30-ssh,40-sysctl,50-docker}.sh`, `infra/hosts/firewall/{mykey.nft,egress-names.conf,mykey-egress.sh,apply-with-revert.sh}`, `infra/hosts/systemd/mykey-egress-refresh.{service,timer}`, `infra/hosts/checks/status.sh`, `infra/compose/host.compose.yml`, `infra/compose/host/{traefik.yml,traefik-dynamic.yml,postgresql.conf,pg_hba.conf,pki-init.sh}`, `apps/api/src/{app,health,server}.ts`, `apps/api/Dockerfile`, `tests/unit/hosts/{redact,push,egress-names,wireguard-conf}.test.ts`, `tests/integration/api/health.test.ts`, `tests/staging/{boundary,transport}.staging.test.ts`, `docs/runbooks/network.md`, `docs/decisions/D-21-host-network-and-egress.md`; pins for `@hono/node-server`, the `node` image and the nmap image.

**Consumes:** `Stack` (Session 1 harness); `applyRoles`, `migrate`, `createPool` from `@mykey/db`; route `health.get` and the error envelope from `@mykey/contracts`; the dev `pki-init` script as the model for the host one.

**Produces** (used by Runs 2.6, 2.7, 2.9 and every later session that touches a host):

```ts
// tests/harness/staging.ts
export interface HostEntry { name: "staging" | "prod"; publicIp: string; vpnIp: string; hostname: string; sshUser: "ubuntu" }
export function loadHosts(): { region: string; staging: HostEntry; prod: HostEntry };      // ~/.mykey/hosts.json; throws when missing
export interface SshResult { code: number; stdout: string; stderr: string }
export function sshExec(host: HostEntry, command: string,
  opts?: { stdin?: string | Uint8Array; sudo?: boolean; timeoutMs?: number; address?: "vpn" | "public"; secretOutput?: boolean }): Promise<SshResult>;
export function registerSecret(value: string): void;                                       // every later log line has it replaced by "[redacted]"
export function redact(text: string): string;
export interface HostStatus { host: string; bootId: string; time: string; clockOffsetMs: number;
  containers: Record<string, { state: string; pid: number; startedAt: string; imageId: string }>;
  sealed: boolean | null; sealType: string | null; kmsReachable: boolean | null; pendingRevert: string[] }
export interface StagingStack extends Stack { host: HostEntry; status(): Promise<HostStatus>;
  reboot(): Promise<{ secondsUntilSsh: number }>; close(): Promise<void> }
export function connectStaging(opts?: { openbao?: boolean }): Promise<StagingStack>;       // SSH -L tunnels; `openbao: true` only from Run 2.7 on
```

```text
node scripts/host.ts <staging|prod> bootstrap           first contact over the public address; idempotent
node scripts/host.ts <host> push                        infra/hosts/** → /opt/mykey/hosts, infra/compose/host* → /opt/mykey/compose; refuses CR; sets and reads back owner and mode
node scripts/host.ts <host> apply <firewall|ssh>        through apply-with-revert.sh (300 s)
node scripts/host.ts <host> confirm                     cancels the pending revert — only from a connection opened after the apply
node scripts/host.ts <host> image <name> <tar>          docker load from stdin; writes <NAME>_IMAGE=sha256:… into /etc/mykey/host.env
node scripts/host.ts <host> maint <minutes> -- <cmd>    opens registry egress for a timed window, runs the command, closes it
node scripts/host.ts <host> up                          docker compose up -d with /etc/mykey/host.env
node scripts/host.ts <host> db-init                     roles and migrations through the tunnel
node scripts/host.ts <host> status                      runs checks/status.sh, prints the HostStatus JSON
```

Design fixed here:

- **Host layout.** `/opt/mykey/` pushed files (root, 0644; scripts 0755). `/etc/mykey/host.env` non-secret settings (host name, region, image IDs, ACME directory). `/etc/mykey/secrets/<service>/` (0700, owned by the uid of the container that reads it; files 0400). `/root/mykey-custody/` (0700). Docker named volumes for data. Nothing of the product under `/home`.
- **Secrets never cross the terminal.** `sshExec` refuses a command that mentions `/etc/mykey/secrets` or `/root/mykey-custody` unless `secretOutput: true`; then the output is registered with `registerSecret` before it is returned and is never passed to a logger. Values travel workstation → host only on stdin (`sudo install -m 0400 -o <uid> /dev/stdin <path>`). `set -x`, `docker compose config` and `docker inspect` of a container with secrets in its environment are not used on a host; services read secrets from files, never from environment variables.
- **VPN (P-28).** Host key generated on the host (`wg genkey`, umask 077). Workstation key generated by `host.ts` with `crypto.generateKeyPairSync("x25519")` (WireGuard wants the raw 32 bytes in standard base64, not base64url) and written, with both peers, to `~/.mykey/wireguard/mykey-ops.conf`: `Address = 10.77.1.10/32, 10.77.2.10/32`; peer production `AllowedIPs = 10.77.1.1/32`, peer staging `AllowedIPs = 10.77.2.1/32`; `PersistentKeepalive = 25`; no `DNS` line. Host side: `wg0`, `10.77.N.1/24`, `ListenPort = 51820`, one peer `10.77.N.10/32`.
- **SSH.** Ubuntu 24.04 starts `sshd` from `ssh.socket`. Drop-in: `ListenStream=` (empty, clears the default), `ListenStream=10.77.N.1:22`, `FreeBind=yes` (the socket must bind before `wg0` exists). `sshd_config.d/10-mykey.conf`: `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin no`, `AllowUsers ubuntu`, `AllowTcpForwarding local`, `X11Forwarding no`, `AllowAgentForwarding no`. Break-glass when everything fails: OVHcloud rescue mode, by the owner (written into `network.md`).
- **Every network change is applied with a timed revert** (Review focus 1): `apply-with-revert.sh <name> <apply-script> <revert-script> 300` first starts `systemd-run --on-active=300 --unit=mykey-revert-<name> <revert-script>`, then applies. `confirm` stops that timer.
- **Networks** (Compose, fixed bridge names through `com.docker.network.bridge.name`, static container addresses, IPv4 only):

  | Bridge | Subnet | Internal | Members | Allowed out |
  | --- | --- | --- | --- | --- |
  | `mk-pub` | 10.78.0.0/28 | no | `edge` | ACME set, TCP 443 |
  | `mk-edge` | 10.78.1.0/28 | yes | `edge`, `api` | — |
  | `mk-db` | 10.78.2.0/28 | yes | `api`, `postgres` (later `provisioner`) | — |
  | `mk-bao` | 10.78.3.0/28 | yes | `api`, `openbao` (Run 2.7; later `provisioner`) | — |
  | `mk-kms` | 10.78.4.0/28 | no | `openbao` (Run 2.7) | KMS set, TCP 5696 |

  No port is published except `443:8443` of `edge`. PostgreSQL and OpenBao are reached by the operator through `ssh -L` to their static addresses (`10.78.2.2:5432`, `10.78.3.2:8200`); server certificates name `postgres`, `openbao`, `api`, `localhost` and `127.0.0.1`, so verification works through a tunnel.
- **Firewall (P-30).** `/etc/nftables.d/mykey.nft`, table `inet mykey`, three base chains with `policy drop`, priority `filter - 5` (a drop in our chain is final whatever Docker's chains say).
  - `input`: established/related; `lo`; ICMP and ICMPv6 needed for path MTU and neighbour discovery, echo rate-limited; `udp dport 51820`; `iifname "wg0" tcp dport 22`. Nothing from `mk-*` to the host.
  - `forward`: established/related; new TCP 443→8443 into `mk-pub` (the published port; Docker's DNAT happens before this hook); `iifname "mk-pub" ip daddr @acme tcp dport 443`; `iifname "mk-kms" ip daddr @kms tcp dport 5696`; container DNS as observed (see Task D). Everything IPv6 is dropped here.
  - `output` (the host itself): `lo`; established; to `mk-*`; DNS to `@dns`; NTP to `@ntp`; `@apt` TCP 80/443; `@probe` TCP 443; `@r2` TCP 443; `@kms` TCP 5696; `@registry` TCP 443 (empty except in a maintenance window); `udp sport 51820`.
  - Sets are `type ipv4_addr; flags timeout`. `mykey-egress.sh refresh` resolves `egress-names.conf` (lines `purpose name`) and adds each address with `timeout 1h`; `mykey-egress-refresh.timer` runs it every 5 minutes and once at boot `After=network-online.target`, `Before=docker.service` (Review focus 3). `mykey-egress.sh block <purpose> <seconds>` empties a set and keeps it empty until the time is over — it always unblocks by itself; `maint <minutes>` fills `@registry`.
  - The DNS resolvers and NTP servers are the fixed addresses the instance was given; D-21 lists them and the rule that a container never gets a general port 53 or 443.
- **Containers.** Every service: `user` non-root, `read_only: true`, `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]`, `pids_limit`, `mem_limit`, `tmpfs` for scratch, `restart: unless-stopped`, image by digest (upstream) or by image ID (ours). Docker `daemon.json`: `"icc": false`, `"userland-proxy": false`, `"no-new-privileges": true`, `"log-driver": "journald"`. No container mounts the Docker socket.
- **Edge.** Traefik with a static file and the file provider only (no Docker provider, no dashboard, no API). One entry point `:8443`; TLS options `minVersion: VersionTLS12`, `sniStrict: true`; resolver `le` with `tlsChallenge`, `caServer` from `host.env`, storage in a named volume; no trusted forwarded-header sources, so client-supplied `X-Forwarded-*` are dropped; `headers` middleware `stsSeconds: 63072000`. Upstream `https://api:8443` through a `serversTransport` with `rootCAs` = the host's private CA and `serverName: api` — Doc 06 §2 requires verified TLS on the proxy–API hop.
- **API stub** (`apps/api`, replaced piece by piece from Run 3.1): Hono on `@hono/node-server` with `createServer: https.createServer`, certificate and key from files. `GET /health` → `200 {"status":"up"}` when a `SELECT 1` as `api_runtime` over verified TLS answers within 2 s, otherwise `503 {"status":"down"}`; every other path and method → `404` with the `not_found` envelope and a request id. One JSON log line per request with the peer address and the `X-Forwarded-For` value Traefik set (the test needs it). The Dockerfile starts Node with the permission model as far as the pinned Node allows (`--permission`, read access to the application and secret directories only, no child processes, no workers) — PO-11; when a flag breaks a dependency, record which and why.

### Task A — workstation tooling (can be written before the servers exist)

- [ ] **Step 1 — Failing unit tests** (`tests/unit/hosts/`):
  - `redact.test.ts`: a run-time canary passed to `registerSecret` is replaced in `redact(...)`, in the text `host.ts`'s logger writes, and in an `Error.message` built from a failed `sshExec`; `sshExec` with a command containing `/etc/mykey/secrets/x` and no `secretOutput` rejects before connecting (Review focus 2).
  - `push.test.ts`: the file collector rejects any file containing `\r` and names it; every collected file has an explicit owner and mode; a path with a space is passed to `ssh` as one argument (Review focus 5).
  - `wireguard-conf.test.ts`: the generated configuration has one `[Interface]` and two `[Peer]` blocks with the addresses above; the private key is 44 base64 characters ending in `=`; `host.ts` writes the file with mode 0600 and never returns the key.
  - `egress-names.test.ts`: `egress-names.conf` parses; purposes are exactly `acme`, `kms`, `r2`, `probe`, `apt`, `registry`; no line is a bare IP address or a wildcard.
- [ ] **Step 2 — Implement** `staging.ts`, `host.ts`, `require-staging-env.ts` (exit 1 naming what is missing: `~/.mykey/hosts.json`, the SSH key, a VPN address that answers on port 22 within 5 s), the Vitest project, `test:staging`. `.gitattributes`: `*.sh`, `*.nft`, `*.conf`, `*.service`, `*.timer`, `*.hcl`, `*.tmpl`, `Dockerfile` → `text eol=lf`.
- [ ] **Step 3 — Run:** unit tests PASS; `pnpm run test:staging` exits 1 with the "missing" message (no servers yet). Commit `feat(hosts): host tool, staging harness and staging test project`.

### Task B — bootstrap and lock-down (both hosts; staging first, production only after staging is green)

- [ ] **Step 1 — Record the servers.** Write `~/.mykey/hosts.json` from the owner's answer. `ssh -i ~/.mykey/ssh/mykey_ops_ed25519 ubuntu@<public IP>` once per host; record the host key fingerprints in `docs/runbooks/network.md` and pin them in `~/.mykey/ssh/known_hosts` (`StrictHostKeyChecking yes` from then on).
- [ ] **Step 2 — `bootstrap`.** `10-packages.sh`: `docker.io`, `docker-compose-v2`, `wireguard-tools`, `nftables`, `chrony`, `unattended-upgrades`, `jq`, `curl` from the Ubuntu archive; record the installed versions in the run note. `40-sysctl.sh`: core dumps off (`kernel.core_pattern=|/bin/false`, `fs.suid_dumpable=0`, `Storage=none`), no active swap, `unattended-upgrades` for security updates without automatic reboot. `50-docker.sh`: `daemon.json` as above. `20-wireguard.sh`: key, `wg0`, `wg-quick@wg0` enabled; prints the host's public key only. Each script can run twice with no change the second time (the test runs it twice).
- [ ] **Step 3 — Tunnel.** `host.ts` writes `mykey-ops.conf`. Ask the owner to run the two commands of "Session start" item 5. Verify `ssh ubuntu@10.77.2.1` and `ssh ubuntu@10.77.1.1`. If the owner cannot install WireGuard, take the WSL2 fallback of P-28 and record it.
- [ ] **Step 4 — Firewall, with public SSH still allowed** (a temporary rule `tcp dport 22 accept` in a separate include file). `apply firewall`; open a new VPN connection; `confirm`.
- [ ] **Step 5 — Prove the revert before relying on it** (staging only): apply a rule set that drops port 22 on `wg0`, do **not** confirm, and measure: SSH fails, and works again within 300 s plus 10 s. Record the time.
- [ ] **Step 6 — Close public SSH.** `apply ssh` (socket drop-in, `sshd` settings, removal of the temporary rule) → from a new connection over the VPN: `confirm`. Then `ssh ubuntu@<public IP>` must fail to connect, not merely fail to authenticate.
- [ ] **Step 7 — Reboot test.** `sudo systemctl reboot`; without any command on the host, SSH over the VPN answers again; `status` shows `pendingRevert: []`, the firewall loaded, the sets filled, chrony synchronised (`clockOffsetMs` under 500). Record the seconds.
- [ ] **Step 8 — Commit** `feat(hosts): bootstrap, WireGuard, VPN-only SSH and default-deny firewall`.

### Task C — the stack skeleton

- [ ] **Step 1 — Failing integration test** `tests/integration/api/health.test.ts` (local stack, the API started in-process with the stack's CA): `GET /health` → 200 `{"status":"up"}` and the body validates against the contract schema; after `docker compose stop postgres` → 503 `{"status":"down"}` within 3 s, and 200 again after start; with a CA that did not sign the server certificate → 503 and the log names a certificate failure (never a silent fallback to plaintext); `GET /`, `POST /health`, `GET /v1/anything` → 404 `not_found` envelope; no response carries a `Server` or `X-Powered-By` header.
- [ ] **Step 2 — Implement** `apps/api`, the Dockerfile on the pinned `node` image (digest in the lock file; add `node` to `REQUIRED_IMAGES` and to the image scan), `host.compose.yml` with `pki-init`, `postgres`, `api`, `edge`. `postgresql.conf`: `ssl = on`, `ssl_min_protocol_version = 'TLSv1.3'`, `password_encryption = 'scram-sha-256'`, `log_parameter_max_length = 0`, `log_parameter_max_length_on_error = 0`, `max_connections` from `LIMITS.db`. `pg_hba.conf`: `hostssl all all 10.78.2.0/28 scram-sha-256`, then `host all all all reject`. Run: PASS locally (`docker compose -f infra/compose/host.compose.yml config` validates on the workstation — it holds no secret).
- [ ] **Step 3 — Deploy to staging.** `push`; `maint 20 -- docker compose pull` (upstream images by digest); build the API image locally for `linux/amd64`, `docker save`, `image api <tar>`; generate the PostgreSQL superuser password and the five role passwords in memory and install them through stdin as root-only files (the host keeps only what a service on it needs: the superuser file and `api_runtime`; the other four are written to `~/.mykey/secrets/hosts/staging/` with mode 0600 and listed in the custody list); `up`; `db-init` (`applyRoles` + `migrate` through the tunnel, as `migration_owner`).
- [ ] **Step 4 — DNS and certificate.** Create the A records `mykey-staging.<domain>` and `mykey.<domain>` (DNS only, not proxied) with the session token — or ask the owner to create them when the zone is elsewhere. Start with the Let's Encrypt **staging** directory; when a certificate is issued, switch `host.env` to the production directory, empty the ACME volume, `up`. Never loop on the production directory: one failure there means stop and read the Traefik log.
- [ ] **Step 5 — Production host:** the same Steps 3–4 on `prod`. Its database stays empty apart from roles and migrations.
- [ ] **Step 6 — Commit** `feat(hosts): edge, API health stub and PostgreSQL on both hosts`.

### Task D — proof from outside

- [ ] **Step 1 — `tests/staging/boundary.staging.test.ts`** (run against staging; the scan also against production):
  - `only 443/tcp answers from the internet` — the pinned nmap image on the workstation, `-Pn -p-` against the public address and `-sU -p 51820,53,123,500`; the result file is saved as `docs/evidence/session-2/host-scan-<host>.txt`; open TCP ports = exactly `443`. WireGuard does not answer a packet it cannot authenticate, so nmap can only report 51820/udp as `open|filtered`: the proof that it is open is the working tunnel, and the proof for the other UDP ports is `closed` or no answer with an ICMP rule to match. (The workstation is on the VPN but the scan targets the public address; assert the route used is not `wg`.)
  - `no plain HTTP listener` — a TCP connect to port 80 is refused or times out; it is never a redirect.
  - `SSH is VPN-only and key-only` — connect to `<public IP>:22` fails; over the VPN `ssh -o PubkeyAuthentication=no` is refused with `Permission denied (publickey)`.
  - `private services are not reachable` — from the workstation without a tunnel, ports 5432, 8200, 8443 on the public and on the VPN address do not answer; through the tunnel PostgreSQL answers (control).
  - `containers are restricted` — for each running container: uid ≠ 0, `ReadonlyRootfs` true, `CapAdd` empty and `CapDrop` contains `ALL`, `no-new-privileges` set, a memory and a pids limit, no Docker socket mount (`docker inspect --format` of those fields only).
  - `egress is what the table says` — a probe container (the pinned `curl`-capable image already used by the stack) attached in turn to each bridge tries: TCP 443 to a public address outside every set, TCP 443 to an ACME address, TCP 5696 to a KMS address, UDP 53 to a public resolver, and a DNS lookup through Docker's resolver. Expected: everything fails from `mk-edge`, `mk-db`, `mk-bao`; from `mk-pub` only ACME; from `mk-kms` only KMS. The DNS line is an observation first: write down what Docker's resolver does on an internal and on a normal bridge with this Docker version, then fix the forward rule and the expectation to the minimum that lets ACME (and later KMIP) resolve.
  - `the host itself cannot reach an arbitrary site` — `curl` from the host to an address outside every set fails; to the probe host name it connects.
  - `a reboot restores all of it` — after `reboot()`: every assertion above still holds, `/health` is 200, with no command in between.
- [ ] **Step 2 — `tests/staging/transport.staging.test.ts`:**
  - `public HTTPS with a valid chain and HSTS` — `GET https://<hostname>/health` → 200, certificate valid for the host name under the system roots, `strict-transport-security: max-age=63072000` without `includeSubDomains`.
  - `old TLS is refused` — a TLS 1.1 handshake fails; TLS 1.2 and 1.3 succeed; a request with another SNI or with the bare IP gets no application response.
  - `forwarded headers from the client are ignored` — a request with `X-Forwarded-For: 203.0.113.9` and `X-Forwarded-Proto: http`: the API log line for that request id shows the workstation's real address and `https`.
  - `PostgreSQL refuses plaintext and unverified peers` — through the tunnel: `sslmode=disable` is rejected by `pg_hba`; a client with the wrong CA fails verification; the right CA connects (control). From the `api` container's point of view the same is proven by the health test of Task C.
  - `the proxy verifies the API` — replace the API certificate with one from another CA (staging only), restart `api`: the public `/health` is 502 or 503 and Traefik logs a certificate error; restore, 200.
- [ ] **Step 3 — Run:** `pnpm run test:staging` → PASS on staging. Run the scan and the header checks against production and attach the files.
- [ ] **Step 4 — `docs/runbooks/network.md`:** addresses and names, the bridge table, the firewall rule sets in words, how to open a maintenance window, how to block and unblock a purpose, the lock-out procedure (revert timer, then rescue mode), the host key fingerprints.
- [ ] **Step 5 — D-21, registry, run note, commit** `test(hosts): boundary and transport proven from outside`. D-21 states P-28 to P-32, the observed DNS behaviour, and the open weakness of P-30 (shared provider addresses) for the Session 8 review.

**Registry:** `FR-1.70`, `FR-1.71`, `FR-1.72`, `AC-1.30`, `AC-1.31`, `PO-11` → `SPIKE_PASS`. Notes on what is still missing for `PASS`: AC-1.30 "CLI cannot bypass TLS" (Run 5.5), AC-1.31 TOTP drift (unit-proven in Run 2.3, product-proven in Run 3.4), OpenBao and KMS hops of FR-1.71 (Run 2.7), FR-1.70 "deployed release configuration" (Run 6.9).

**Covers:** FR-1.70, FR-1.71, FR-1.72; AC-1.30, AC-1.31; PO-11. **Done when:** an outside scan shows exactly the two open ports on both hosts (443/tcp, and 51820/udp proven by the tunnel); spoofed forwarded headers and plain HTTP are refused.

---

## Run 2.6 — Off-host probe and alert path

**Files:** `workers/probe/src/{evaluate,store,sinks,index}.ts`, `workers/probe/wrangler.jsonc`, `workers/probe/migrations/0001_init.sql`, `scripts/probe.ts`, `infra/hosts/systemd/mykey-heartbeat.{service,timer}`, `infra/hosts/checks/heartbeat.sh`, `tests/unit/probe/{evaluate,sinks,auth}.test.ts`, `tests/staging/probe.staging.test.ts`, `docs/runbooks/probe.md`, `docs/decisions/D-22-probe-and-alert-path.md`; pin for `wrangler`.

**Consumes:** `LIMITS.monitoring`; `host.ts`, `mykey-egress.sh block`, `status.sh`, `connectStaging` (Run 2.5); the Cloudflare session token and the alert channel files (owner).

**Produces:**

```ts
// workers/probe/src/evaluate.ts — pure, no I/O
export type Condition = "heartbeat_missing" | "health_failing" | "openbao_sealed" | "kms_unreachable";
export interface Heartbeat { bootId: string; sealed: boolean | null; kmsReachable: boolean | null }
export interface HostState { host: string; lastHeartbeatAt: number | null; lastHeartbeat: Heartbeat | null; failingSince: number | null;
  reportedSince: Partial<Record<"openbao_sealed" | "kms_unreachable", number>>;
  open: Partial<Record<Condition, { openedAt: number; lastAlertAt: number | null }>> }
export interface ProbeLimits { heartbeatGraceSeconds: number; healthGraceSeconds: number; reportedGraceSeconds: number; reminderSeconds: number }
export interface AlertIntent { host: string; condition: Condition; kind: "opened" | "reminder" | "resolved"; sinceMs: number }
export function recordHeartbeat(state: HostState, nowMs: number, beat: Heartbeat): HostState;
export function evaluate(nowMs: number, state: HostState, probeOk: boolean, limits: ProbeLimits): { next: HostState; alerts: AlertIntent[] };
export function markDelivered(state: HostState, alert: AlertIntent, nowMs: number): HostState;
// sinks.ts
export type SinkConfig = { kind: "telegram"; botToken: string; chatId: string } | { kind: "webhook"; url: string } | { kind: "email"; to: string };
export function formatAlert(alert: AlertIntent): string;                                    // host, condition, kind, UTC time; nothing else
export function deliver(sink: SinkConfig, text: string, fetcher?: typeof fetch): Promise<boolean>;
```

```text
node scripts/probe.ts deploy     wrangler deploy with the token from ~/.mykey/secrets/cloudflare/session-2-token; vars from LIMITS.monitoring
node scripts/probe.ts secrets    generates the per-host heartbeat tokens and the read token, puts them as Worker secrets (stdin), installs the host files
node scripts/probe.ts state <host>   GET /v1/state/<host> with the read token
```

Design fixed here:

- **Limits:** probe every `probeIntervalSeconds` (60, cron `* * * * *`); `heartbeatGraceSeconds` 180; `healthGraceSeconds` 180 and `reportedGraceSeconds` 180 (Doc 06 §12 gives one grace value; D-22 says they are the same number on purpose); `reminderSeconds` 3600. The values reach the Worker as `vars` written by `probe.ts deploy`; a unit test compares them with `LIMITS`.
- **Time is the Worker's.** A heartbeat is stamped with the Worker's clock on arrival; nothing the host says about time is used.
- **Rules of `evaluate`.** `heartbeat_missing` opens when `now − lastHeartbeatAt > grace` (or no heartbeat ever and the host has been known for longer than grace). `health_failing` opens when the probe has failed continuously for ≥ grace. `openbao_sealed` / `kms_unreachable` open when the last heartbeats have reported `sealed: true` / `kmsReachable: false` continuously for ≥ grace; `null` never opens them. A condition resolves at the first good observation. An `opened` or `reminder` intent is produced again on every evaluation until `markDelivered` has set `lastAlertAt` — a sink that fails is retried a minute later, and nothing is marked sent that was not sent.
- **Probe request:** `GET https://<hostname>/health`, `redirect: "manual"`, 10 s timeout; OK only for status 200 and a body that is exactly `{"status":"up"}`.
- **Worker routes:** `POST /v1/heartbeat/<host>` with `Authorization: Bearer <host token>` (compare SHA-256 digests with `crypto.subtle.timingSafeEqual`; unknown host and wrong token both → 404); `GET /v1/state/<host>` with the read token; everything else 404. D1: `host_state(host primary key, json, updated_at)` and `alert_log(id, host, condition, kind, at, delivered)`.
- **Host side:** `mykey-heartbeat.timer` every 60 s runs `heartbeat.sh`: reads `status.sh`, posts `{bootId, sealed, kmsReachable}` with `curl -K /etc/mykey/secrets/heartbeat/curl.conf` (URL and header in a root-only file), 10 s timeout, no retry loop.

- [ ] **Step 1 — Failing unit tests** (`evaluate.test.ts`, time passed in):
  - `nothing opens inside the grace period` — heartbeat at t, evaluate at t + 180 s → no alert; at t + 181 s → one `opened heartbeat_missing`.
  - `an undelivered alert is asked for again` — second evaluation without `markDelivered` → the same `opened` intent; after `markDelivered` → none until t + 3600 s, then `reminder`.
  - `one failed probe is not an outage` — fail, ok, fail over three minutes → no alert; three minutes of continuous failure → `opened health_failing`.
  - `recovery is announced once` — after a delivered `opened`, the first good observation yields `resolved` and removes the condition; a condition that never delivered an `opened` resolves silently.
  - `host-reported conditions` — `kmsReachable: false` for 181 s → `opened kms_unreachable` while `heartbeat_missing` and `health_failing` stay closed; `null` values open nothing.
  - `conditions are independent` — heartbeat missing and health failing together produce two intents.
  - `auth.test.ts`: wrong token, token of the other host, unknown host → 404 and no state change; `sinks.test.ts`: `formatAlert` contains host, condition and kind and no address, token or URL; `deliver` returns false on a non-2xx answer and on a thrown fetch.
- [ ] **Step 2 — Implement**, run: PASS. Commit `feat(probe): heartbeat and health probe Worker with a pure decision function`.
- [ ] **Step 3 — Deploy.** Create the D1 database and apply the migration; `probe.ts deploy`; `probe.ts secrets`; for Telegram, read the chat id once with `getUpdates` and store it as a Worker secret (print neither). Custom domain `mykey-probe.<domain>` when the zone is on Cloudflare, otherwise the `workers.dev` name; put the name into `egress-names.conf` (purpose `probe`), push, refresh. Install the heartbeat units on both hosts.
- [ ] **Step 4 — `tests/staging/probe.staging.test.ts`:**
  - `heartbeats arrive from both hosts` — `state staging` and `state prod` show a heartbeat younger than 90 s.
  - `a dark host raises an alert on the real channel` — `mykey-egress.sh blackout 480` on staging (added in this run: it first starts a timer that restores the rule set after 480 s, then drops every packet in and out, VPN included — from outside the host is switched off, and it comes back without the owner having to start an instance); poll `state staging` from the workstation: `heartbeat_missing` and `health_failing` are both open with `lastAlertAt` set no later than 300 s after the blackout began (180 s grace + two probe intervals); after the automatic restore both are gone and `alert_log` holds `opened` and `resolved` for each, all `delivered = 1`; SSH over the VPN works again. Record the measured seconds.
  - `a dead endpoint raises an alert while the host is alive` — stop `edge` on staging with a scheduled start five minutes later (`systemd-run --on-active=300 docker start …`): `health_failing` opens and resolves; `heartbeat_missing` stays closed.
  - `a sink failure is not recorded as sent` — deploy a preview Worker bound to the same code with a webhook sink that answers 500: `lastAlertAt` stays null across three evaluations.
- [ ] **Step 5 — The owner confirms** that the six messages (three opened, three resolved) arrived on the chosen channel; write the confirmation and the times into the run note. Without an alert channel from the owner this step and the registry line wait, and Run 2.10 reports it; everything before it is still done.
- [ ] **Step 6 — `docs/runbooks/probe.md`** (what each alert means, first look, how to silence during planned work — by nothing other than finishing the work), **D-22** (P-33, the four conditions, open point "nobody notices when the Worker itself stops" for Run 6.4), run note, commit `feat(probe): off-host alert path proven by a blackout drill (early PO-14)`.

**Registry:** `PO-14 SPIKE_PASS` (owner run 6.4 closes it).

**Covers:** early PO-14. **Done when:** stopping the staging host — here: cutting it off from the network completely — produces a delivered alert within the grace period.

---

## Run 2.7 — Real KMS auto-unseal (D08-S05) · OWNER (OWN-3, OWN-4)

**Files:** `infra/compose/host.compose.yml` (service `openbao`, networks `mk-bao`, `mk-kms`), `infra/compose/host/openbao.hcl.tmpl`, `infra/compose/kms-spike.compose.yml`, `infra/hosts/checks/status.sh`, `infra/hosts/firewall/egress-names.conf`, `apps/api/src/health.ts`, `scripts/host.ts` (`kms-csr`, `bao-init`, `kms`), `tests/harness/staging.ts`, `tests/unit/hosts/openbao-config.test.ts`, `tests/integration/api/health.test.ts`, `tests/staging/{unseal,key-loss}.staging.test.ts`, `docs/evidence/session-2/kms-checkpoints.json`, `docs/runbooks/{kms-and-unseal,custody-map,credential-custody}.md`, `docs/decisions/D-23-seal-and-kms-layout.md`; pin for the `okms-cli` image.

**Consumes:** everything of Run 2.5; `OpenBaoAdmin`, policy templates and `createOrgFixture` (Run 2.1); the probe's `openbao_sealed` and `kms_unreachable` conditions (Run 2.6); the value chosen for `default_max_request_duration` (D-20).

**Produces:** staging OpenBao on the KMIP seal; `connectStaging({ openbao: true })`; `host.ts <host> kms <okms arguments>` (runs the pinned `okms` image on the host with the named certificate); the custody map; the seal layout production will copy.

What the documentation says (source reading, 11 Nov 2026):

- OpenBao 2.7.2 has three built-in seals: `static`, `transit`, `kmip`. `seal "kmip"` takes `endpoint`, `kms_key_id`, `client_cert`, `client_key`, optional `ca_cert`, `server_name`, `timeout`. The key must already exist and be **Active**. If the KMS cannot be reached or the certificate is refused at start, **the process exits with code 1 and does not retry** — unattended recovery therefore comes from the container restart policy. Once unsealed, a failing KMS only produces log warnings.
- With auto-unseal, `sys/init` takes `recovery_shares` and `recovery_threshold`; recovery keys authorise operations and **cannot decrypt the data when the seal key is gone**.
- OVHcloud KMS: KMIP endpoint `<region>.okms.ovh.net:5696`, public CA, authentication by client certificate only. A certificate belongs to one OKMS domain and one or more IAM identities, is valid for at most 365 days, cannot be renewed (issue a new one, delete the old), and can be issued from a CSR. IAM rights (`okms:kmip:<operation>`) are granted per domain. The service's addresses are not published as stable.

Design fixed here:

- **Keys and certificates (P-34).**

  | Object | Domain | Used for | Private key lives |
  | --- | --- | --- | --- |
  | seal key `mykey-staging-seal-1` (AES-256) | `mykey-staging-kms` | staging OpenBao | never leaves the KMS (`--extractable=false --sensitive`) |
  | certificate `staging-seal-1`, later `staging-seal-2` | `mykey-staging-kms` | staging OpenBao | generated on the staging host, `/etc/mykey/secrets/kms/` |
  | keys `L-A`, `L-B`, `L-C` | `mykey-losstest-kms` | loss, expiry and wrong-key tests | KMS |
  | certificate `losstest-ops` (365 days) | `mykey-losstest-kms` | `okms` and the disposable instances | workstation `~/.mykey/kms/`, copied to staging for the test, removed after |
  | certificate `losstest-1day` (1 day) | `mykey-losstest-kms` | expiry test | same |

- **Server configuration** (`openbao.hcl.tmpl`, rendered by `host.ts` from `host.env`; a unit test renders it and checks every line below):

  ```hcl
  storage "raft" {
    path    = "/openbao/file"
    node_id = "{{host}}"
  }
  listener "tcp" {
    address         = "0.0.0.0:8200"
    tls_cert_file   = "/openbao/tls/server.crt"
    tls_key_file    = "/openbao/tls/server.key"
    tls_min_version = "tls13"
  }
  seal "kmip" {
    endpoint    = "{{region}}.okms.ovh.net:5696"
    server_name = "{{region}}.okms.ovh.net"
    kms_key_id  = "{{seal_key_id}}"
    client_cert = "/openbao/kms/seal.crt"
    client_key  = "/openbao/kms/seal.key"
  }
  audit "file" "main" {
    options {
      file_path = "/openbao/audit/audit.log"
      mode      = "0600"
    }
  }
  api_addr                     = "https://openbao:8200"
  cluster_addr                 = "https://openbao:8201"
  default_max_request_duration = "{{max_request_duration}}"
  ```

  No `ca_cert`: the endpoint has a public certificate and the system roots must verify it. If the pinned image cannot, mount the public chain as a file — never switch verification off. Container: `restart: unless-stopped`, static addresses `10.78.3.2` (`mk-bao`) and `10.78.4.2` (`mk-kms`).
- **Init (P-35):** `PUT /v1/sys/init` with `{"recovery_shares":1,"recovery_threshold":1}` run **on the host**; the answer goes straight into `/root/mykey-custody/openbao-init.json` (0400) and the command prints only `initialized: true` and the number of recovery keys. A second copy goes over SSH stdout directly into `~/.mykey/custody/staging/openbao-init.json` (0600), unseen. Then `registerAuditHeaders()` and a root-namespace `backup` policy.
- **Health.** `/health` is `up` only when PostgreSQL answers **and** `GET https://openbao:8200/v1/sys/health` over verified TLS answers 200. `status.sh` reports three separate facts: `sealed` (from `seal-status`), `sealType`, and `kmsReachable` — a TLS handshake with the client certificate to the KMIP endpoint (`openssl s_client -verify_return_error`), independent of OpenBao. FR-1.64: a KMS outage does not seal a running process, so it has its own alert (`kms_unreachable`).
- **A cold start is proven, not assumed** (Review focus 3): every unseal assertion first checks that the container's process id and `StartedAt` differ from the values read before the action.

- [ ] **Step 1 — Owner, sitting 1 (about fifteen minutes).** Send these instructions; the agent prepares the three CSRs first (`host.ts staging kms-csr staging-seal-1` creates key and CSR on the host and prints the CSR only; the two losstest keys and CSRs are created on the workstation by Node `crypto`; EC P-256 — if the console refuses it, RSA 3072, and record which).
  1. Control Panel → Identity, Security & Operations → Key Management Service → **Order an OKMS domain**, twice, region = the hosts' region: `mykey-staging-kms`, `mykey-losstest-kms`.
  2. IAM → local users: create `mykey-staging-seal` and `mykey-losstest-ops` (no console password needed).
  3. IAM → policies: `mykey-staging-kms-seal` — identity `mykey-staging-seal`, resource the staging domain, actions `okms:kmip:encrypt`, `decrypt`, `locate`, `get`, `getAttributes`, `create`, `activate`. `mykey-losstest-kms-all` — identity `mykey-losstest-ops`, resource the losstest domain, all `okms:kmip:*` actions.
  4. In each domain → **Access certificates** → **Generate an access certificate** → "I already have a CSR": paste the CSR, choose the matching identity; validity 365 days — except `losstest-1day`: **1 day**. Download each certificate and save it as `~/.mykey/kms/<name>.crt`. Never choose root as identity.
  5. Reply with the two OKMS domain ids and the exact time the 1-day certificate was issued.
- [ ] **Step 2 — Keys.** Open the `kms` purpose in `egress-names.conf` (`<region>.okms.ovh.net`), pull the `okms-cli` image in a maintenance window. `host.ts staging kms kmip create symmetric --alg AES --size 256 --usage encrypt,decrypt --name mykey-staging-seal-1 --extractable=false --sensitive`, then `kmip activate <id>`, then `kmip locate --details` → state Active. The same for `L-A`, `L-B`, `L-C` with `losstest-ops`. Record key ids (identifiers, not secrets) in `custody-map.md`.
- [ ] **Step 3 — Failing tests.**
  - `openbao-config.test.ts` (unit): the rendered file has exactly one `seal` block of type `kmip`, no `static` seal, TLS 1.3, the audit stanza, no placeholder left.
  - `health.test.ts` (integration, extended): `/health` is 503 while OpenBao is sealed or stopped and 200 when it is unsealed; a connection refused counts as down.
  - `unseal.staging.test.ts` — first assertion of the file: `sealType` is not `static` and the target host name is staging.
    - `initialised on the real KMS` — `seal-status`: `initialized: true`, `sealed: false`, `recovery_seal: true`, `storage_type: "raft"`; record the observed `type` string.
    - `container restart unseals alone` — write a secret through `createOrgFixture`; `docker restart`; new pid; unsealed within 60 s; the secret reads back; record seconds.
    - `cold start unseals alone` — `docker compose down` for the service (volume kept), `up`; same checks.
    - `host reboot unseals alone` — `reboot()`; no command on the host until `/health` is 200 from outside; record seconds from SSH loss to 200. Fail if it needed more than 300 s.
    - `KMS away at start: stays sealed, says 503, recovers alone` — `mykey-egress.sh block kms 240`; restart OpenBao; for the next 60 s: the container exits and is restarted (restart count grows), `seal-status` is unreachable or sealed, public `/health` is 503, the heartbeat reports `sealed: true` or `kmsReachable: false`; after the automatic unblock it unseals with no command. No unseal key was typed anywhere (FR-1.64 "no silent manual-key fallback": assert `sys/unseal` with the recovery key is refused while sealed).
    - `KMS away while running: still serving, separately visible` — unsealed; `block kms 300`: reads and writes still succeed, `status()` shows `sealed: false` and `kmsReachable: false`, and the probe opens `kms_unreachable` (not `openbao_sealed`); it resolves after the unblock.
    - `rights are what was granted` (after sitting 2) — with the seal certificate: `kmip create` → denied; `kmip locate` → works (control).
    - `a deleted certificate cannot unseal; a reissued one can` (after sitting 2) — see Step 6.
- [ ] **Step 4 — Bring it up.** Add the service; render the configuration; install certificate and key (owner uid = the OpenBao uid, read from the image as in Session 1); `up`; `bao-init`; copy custody; enable the fixture's namespace bootstrap against staging. Run the first six tests: PASS. If the built-in KMIP seal cannot be made to unseal from OVHcloud after two hours of diagnosis (keep the server log lines), take the Doc 10 §8.1 fallback: the OVHcloud-published KMS plugin (`seal "ovhcloud"`, release `kms-ovhcloud-v0.0.2` of `openbao/openbao-plugins`, loaded through `plugin_directory` and a `plugin "kms" "ovhcloud"` block) — after checking its publisher, release checksum and licence, and pinning the binary by SHA-256. If that fails too: stop Run 2.7 and ask the owner; Runs 2.8 and the local rehearsal of 2.9 continue meanwhile.
- [ ] **Step 5 — Owner, sitting 2 (about five minutes).** `host.ts staging kms-csr staging-seal-2` (a new key on the host). Ask the owner to: (a) remove `create` and `activate` from policy `mykey-staging-kms-seal`; (b) issue certificate `staging-seal-2` from the new CSR, identity `mykey-staging-seal`, 365 days, and save it as `~/.mykey/kms/staging-seal-2.crt`; (c) **not** delete `staging-seal-1` yet.
- [ ] **Step 6 — Certificate replacement (FR-1.65), in this order:** install `staging-seal-2` next to `-1` without switching; ask the owner to delete certificate `staging-seal-1` in the console; restart OpenBao still configured with `-1` → it must stay sealed (exit and restart loop, `/health` 503) — the revoked-certificate half of AC-1.26; switch the two symlinks `seal.crt`/`seal.key` to `-2`, restart → unsealed, the earlier secret reads back; shred the `-1` key file. Nothing from the old certificate or key was needed to get the new one working. Run the last two tests of `unseal.staging.test.ts`: PASS.
- [ ] **Step 7 — `key-loss.staging.test.ts`** on disposable instances from `kms-spike.compose.yml` (bridge `mk-spike` 10.78.5.0/28, KMS egress only; the same OpenBao image and the same configuration template):
  - `bao-losstest` with key `L-A`: init, write one synthetic secret, take a Raft snapshot, stop. `okms kmip revoke L-A`, `kmip destroy L-A`. Start → never unseals (60 s). Reconfigure to `L-C` (a healthy key that is not the one used) → does not unseal. `sys/unseal` with the recovery key → refused. A fresh instance on `L-C` given the snapshot → restore refused or the data unreadable. Verdict line in the run note: `KMS-L1 SPIKE_PASS — seal key lost: UNRECOVERABLE, as Doc 04 says; a backup pair is only as recoverable as its seal key`.
  - `bao-expiry` with key `L-B` and certificate `losstest-1day`: init, write, stop. Write `docs/evidence/session-2/kms-checkpoints.json`: `[{ "id": "kms-cert-expiry", "notBefore": "<issue time + 24 h 10 min, UTC>", "command": "pnpm run test:staging -- tests/staging/key-loss.staging.test.ts -t expiry", "expects": "start with the expired certificate stays sealed; start with losstest-ops unseals and the secret reads back" }]`. The `expiry` test fails with "checkpoint not due" before `notBefore` when called directly, and is left out of the default `test:staging` run until then (by the checkpoint file, not by `.skip`).
- [ ] **Step 8 — Runbooks.** `kms-and-unseal.md`: how the seal works, what each state looks like in `status`, replace a certificate (the steps just performed), rotate the seal key (new key id, restart, the old key must stay), what is lost when (certificate lost → reissue; seal key lost → nothing recovers), the certificate's expiry date and the 30-day warning owed by Run 6.4. `custody-map.md`: one row per thing needed to rebuild staging — what, where it is kept, a second place, who can reissue it, expiry. Update `credential-custody.md` with the new files (names and paths only).
- [ ] **Step 9 — OWN-4.** Ask the owner to copy `~/.mykey/custody/staging/openbao-init.json` and the SSH key into the password manager and to reply "custody confirmed"; record the reply in D-23.
- [ ] **Step 10 — D-23, registry, run note, commit** `feat(hosts): OpenBao on staging unseals from OVHcloud KMS; certificate replacement and key-loss proven`.

**Registry:** `FR-1.64`, `FR-1.65`, `AC-1.26`, `PO-1`, `KMS-L1` → `SPIKE_PASS`. Open for `PASS`: the same on production (first production start), the expired-certificate checkpoint, the certificate-expiry alert (Run 6.4).

**Covers:** FR-1.64, FR-1.65; AC-1.26; PO-1; early KMS-L1. **Done when:** unseal works unattended after a reboot, each failure case behaves as documented (the expired certificate as a dated checkpoint), and the custody map is written. If KMIP cannot be made to work, the §8.1 seal fallback is taken and recorded.

---

## Run 2.8 — CLI approach decision (capped: 2 hours) · ∥

**Files:** `tests/fixtures/agent-spike/{agent.hcl,child.sh,run.sh,README.md}`, `docs/decisions/D-24-thin-cli-over-openbao-agent.md`.

**Consumes:** the dev stack and `createOrgFixture` (Run 2.1 Task A); a machine token issued with the root token.

**Produces:** D-24, and the list of properties the thin CLI of Run 5.5 must have that the measured alternative lacks.

D-08 already chose the thin CLI. This run only makes that choice defensible with one measured comparison, in one Linux container from the pinned OpenBao image running `bao agent` with an `env_template` block per secret name and an `exec` block that starts `child.sh` (prints the **names** of its environment variables and its exit code path — never values).

- [ ] **Step 1 — Observe and fill the table in D-24** (one line each, "observed" or "documented", with the command):

  | # | Question | Why it matters (Doc 04) |
  | --- | --- | --- |
  | 1 | Is process-supervisor mode marked beta or experimental in the pinned documentation? | D-01: no pre-release component in the product path |
  | 2 | Must every secret name be written into the configuration beforehand? Can it deliver "all secrets of an environment"? | complete-set delivery without a name list |
  | 3 | One of three names does not exist: does the child start, and with what? | never start an application with an incomplete set |
  | 4 | Does the workstation need a direct network path to OpenBao? | the product exposes only the API on 443 |
  | 5 | Where does the token sit, and can the child read it (environment, file, sink)? | least exposure of the credential |
  | 6 | With the same raw token, can a retained old version be read? | Doc 06 §5: product API returns only current values |
  | 7 | Child exit code and signals: is the child's code returned, is SIGTERM forwarded? | wrapper transparency |
  | 8 | A value changes while the child runs: restart, signal or nothing? | no surprise restarts |
  | 9 | Which platforms have a supported binary? | the CLI matrix of Session 5 (Windows, macOS, Linux) |

- [ ] **Step 2 — D-24:** the table, the verdict (thin CLI stands, or — only if the Agent beats it on every line — a note for the owner), and the requirements it hands to Run 5.5. Stop at two hours with whatever lines are filled; unfilled lines are marked "not observed".
- [ ] **Step 3 — Run note, commit** `docs(decisions): D-24 thin CLI over OpenBao Agent, with measurements`.

**Registry:** AGENT-B1 stays `OPEN` (owner run 5.7); this run note is contributing evidence.

**Covers:** early AGENT-B1. **Done when:** the decision record exists.

---

## Run 2.9 — Paired backup spike (part of D08-S11)

**Files:** `infra/backup/pair-spike/{capture,verify,restore,manifest}.ts`, `packages/db/src/roles.ts` (`applyDatabaseAccess`), `tests/harness/privilege-matrix.ts` (extracted from `tests/integration/database/privileges.test.ts`), `tests/unit/backup/manifest.test.ts`, `tests/integration/backup/pair-rehearsal.test.ts`, `tests/integration/database/access.test.ts`, `tests/staging/pair.staging.test.ts`, `docs/evidence/session-2/pair-spike.json`, `docs/evidence/cost-sheet.md`, `docs/runbooks/db-globals-inventory.md` (updated), `docs/decisions/D-25-pair-format.md`.

**Consumes:** `connectStaging({ openbao: true })`, `sshExec`, `host.ts maint` (Runs 2.5, 2.7); `executeWrite`, `reconcile` (Run 2.4); `createOrgFixture`, `OpenBaoAdmin`, the `backup` policy (Run 2.1); `applyRoles`, `migrate`, `infra/db/roles.sql`; the R2 credential file `~/.mykey/secrets/r2/mykey-staging-pairs-upload.json` and bucket `mykey-staging-pairs` (no lock rule yet — Run 6.5 owns it); Restic 0.19.1 and PostgreSQL 18.6 images.

**Produces:**

```ts
// infra/backup/pair-spike/manifest.ts
export interface PairManifest {
  format: "mykey-pair-spike/1"; pairId: string; synthetic: true;
  captureStartedAt: string; captureFinishedAt: string; captureEpoch: string;
  releaseCommit: string; schemaRevision: string;                       // last applied migration name + checksum
  versions: { postgres: string; openbao: string; restic: string };
  seal: { type: string; keyIds: string[] };
  namespaces: string[];
  boundary: { lastOperationId: string | null; executingOperations: 0; heldEffectSlots: 0 };
  artifacts: Record<"postgres.dump" | "globals.sql" | "openbao.snap", { sha256: string; bytes: number }>;
  rolesChecksum: string;                                                // sha256 of infra/db/roles.sql
}
export function buildManifest(input: Omit<PairManifest, "format" | "synthetic">): PairManifest;
export function verifyArtifacts(manifest: PairManifest, directory: string): Promise<{ ok: boolean; problems: string[] }>;
// capture.ts / restore.ts — orchestration from the workstation, every step an sshExec
export type CaptureResult = { ok: true; pairId: string; manifest: PairManifest; timings: Record<string, number> }
  | { ok: false; stage: "admission" | "drain" | "capture" | "seal" | "upload"; reason: string; freezeHeld: boolean };
export function capturePair(staging: StagingStack, opts?: { failAt?: "after_dump" | "after_snapshot" }): Promise<CaptureResult>;
export function abortCapture(staging: StagingStack, pairId: string): Promise<void>;
export function restorePair(staging: StagingStack, pairId: string, resticPassword: Uint8Array):
  Promise<{ postgres: { database: string; port: number }; openbao: { url: string }; timings: Record<string, number> }>;
// packages/db/src/roles.ts
export function applyDatabaseAccess(pool: pg.Pool, database: string): Promise<void>;       // the database-level statements of 0001_grants.sql, idempotent
```

Design fixed here (P-36):

- **Freeze.** As `maintenance`, one transaction: lock the `service_control` row; refuse unless `capture_mode = 'idle'`; set `draining`, `epoch + 1`, `pair_id`. Then wait (≤ 30 s) until no `effect_slot` row exists and no operation is `accepted` or `executing`; an `uncertain` operation makes the pair impossible: release and return `stage: "drain"`. Then `capturing`. The spike executor of Run 2.4 already refuses to admit while the mode is not `idle`.
- **Capture**, all on the host, artifacts in a root-only tmpfs `/run/mykey-pair/<pairId>/`:
  - `pg_dump --format=custom` as `backup_reader`, and `pg_dumpall --globals-only --no-role-passwords` as the superuser, both from the pinned PostgreSQL image on `mk-db` with `sslmode=verify-full`.
  - `GET /v1/sys/storage/raft/snapshot` with a token of the root-namespace `backup` identity (an AppRole `backup` in the root namespace, token 600 s, policy `backup` only).
  - Insert the `backup_pair` row as `candidate`; write `manifest.json`.
  - **Release the freeze** (`idle`) — before encryption and upload. Record the frozen seconds.
- **Seal the bundle.** A new Restic repository per pair inside the tmpfs, password = 32 random bytes generated on the workstation, sent on stdin, stored at `~/.mykey/custody/staging/pair-<pairId>.key` (0600) and never on the host's disk; `restic backup`, then `restic check --read-data`; `tar` the repository → `repo.tar`.
- **Upload** with `curl --aws-sigv4 "aws:amz:auto:s3" -K <root-only config>` to `pairs/<pairId>/manifest.json` and `pairs/<pairId>/repo.tar` (the staging upload credential is installed on the host for this — custody list updated). If the host cannot reach R2 through the `r2` egress set, move the ciphertext through the workstation and record it.
- **Restore** — from the bucket only, with the key from the workstation: download; `verifyArtifacts` after `restic restore`; then
  - PostgreSQL: a **new** cluster (`initdb` in a fresh volume, container `pg-restore` on `mk-db`), following `db-globals-inventory.md` in order: roles from `roles.sql` (`applyRoles`), `CREATE DATABASE`, `applyDatabaseAccess`, `pg_restore --no-owner=false --exit-on-error`, then the checks.
  - OpenBao: a disposable instance from `kms-spike.compose.yml` on the **same** seal key `mykey-staging-seal-1`: init, then `POST sys/storage/raft/snapshot` with its own root token; if refused, `snapshot-force`; record which was needed. After the restore the **source** cluster's tokens and recovery key apply.
- **Eligibility.** A pair becomes `eligible` only after its own restore passed every check; anything else leaves it `candidate` or sets `ineligible`. Nothing in this spike is ever called a backup of real data.

- [ ] **Step 1 — Local rehearsal** (can be done while waiting for the servers). `manifest.test.ts` (unit): `buildManifest` output validates; `verifyArtifacts` reports a changed byte, a missing file and an extra file. `access.test.ts` (integration): on a database created by hand in a fresh cluster, `applyRoles` + `applyDatabaseAccess` + a restored dump gives the same result as `migrate` on an empty database — proven by running the extracted privilege matrix (`tests/harness/privilege-matrix.ts`) against both. `pair-rehearsal.test.ts` (own stack): freeze → dump → snapshot → release → restore the dump into a second database and the snapshot into the same OpenBao with `snapshot-force`; a write through `executeWrite` during the freeze is `rejected` with code `busy` (503) and dispatches nothing. Make them pass; commit `feat(backup): pair-spike manifest, database access function and local rehearsal`.
- [ ] **Step 2 — Seed staging.** Two fixtures (organizations A and B, two environments each), 40 secrets written through `executeWrite` (values = run-time canaries; keep their SHA-256 only), two machine tokens issued. Keep a background writer running at one write per second until the freeze.
- [ ] **Step 3 — `tests/staging/pair.staging.test.ts`, the good path:**
  - `capture produces a matched pair` — `capturePair` ok; the manifest boundary shows zero executing operations and zero slots; the freeze lasted under 60 s (record it); the background writer saw only `503` during the freeze and success after; no backend write carries an operation id newer than `boundary.lastOperationId`.
  - `the bucket holds ciphertext only` — the two objects exist with the manifest's sizes; `repo.tar` contains none of the canaries (search the bytes); the manifest contains no value, token or password.
  - `restore into new stores` — `restorePair` ok; record seconds per stage.
  - `PostgreSQL is whole` — row counts of every table equal the source at the boundary; `meta.schema_migration` identical; the privilege matrix passes on the restored database; `pg_dumpall --globals-only` of the new cluster equals the captured `globals.sql` apart from password lines; `SELECT` as `api_runtime` works over TLS.
  - `OpenBao is whole` — every one of the 40 secrets reads back from the restored instance with the **source** runtime identity and matches its hash; namespaces, policies and token roles equal the source (read-back through `OpenBaoAdmin`); a machine token issued before the capture still reads its environment; one issued after the capture does not exist there.
  - `the two halves agree` — for every `secret_index` row, `current_version` equals the restored KV metadata; no operation is `executing`.
  - Mark the pair `eligible`.
- [ ] **Step 4 — The bad paths:**
  - `an unresolved effect blocks the capture` — start a write with `hangAfterSend` through a delayed path, then `capturePair` → `{ok:false, stage:"drain"}`, the mode is back to `idle`, no pair row is `eligible`. After `reconcile` the next capture works.
  - `a capture that dies keeps the freeze` — `capturePair({failAt:"after_dump"})` (the orchestrator stops): `capture_mode` is still `capturing`, writes are refused, the pair row is `candidate`; only `abortCapture` returns to `idle`, and it sets the pair `ineligible`. (The freeze alert of `LIMITS.backup.freezeAlertSeconds` is Run 6.4.)
  - `a swapped manifest is rejected` — restore pair X's `repo.tar` with pair Y's manifest → `verifyArtifacts` fails, nothing is restored.
  - `a missing role is detected` — restore into a cluster where `roles.sql` was applied without `backup_reader`: `pg_restore --exit-on-error` fails or the privilege matrix does — either way the restore is reported failed, not "restored with warnings".
  - `changed default privileges are detected` — skip `applyDatabaseAccess`: the matrix fails on the `PUBLIC` connect check.
  - `a different seal key cannot open the snapshot` — restore the snapshot into an instance sealed with `L-C` → refused or unreadable (ties the pair to KMS-L1).
- [ ] **Step 5 — Measure.** `pair-spike.json`: sizes, seconds per stage (freeze, dump, snapshot, restic, upload, download, restore PostgreSQL, restore OpenBao), image digests, the snapshot endpoint used. `docs/evidence/cost-sheet.md`: add stored bytes and request counts of this pair and the projected daily cost.
- [ ] **Step 6 — Clean up.** Remove the tmpfs, the restore containers and volumes, the R2 credential from the host if Run 6.5 will install its own; leave the pair objects in the bucket and list their keys in the run note for Run 6.6. Update `db-globals-inventory.md` (the open point "re-apply database-level access" is now `applyDatabaseAccess`).
- [ ] **Step 7 — D-25, registry, run note, commit** `test(backup): one paired backup captured on staging and restored into new stores`. D-25 records the manifest format, the freeze sequence, the measured freeze time, which snapshot-restore call works, and the findings for Session 6: `backup_reader` cannot write the control rows (who should?), the manifest needs a signature, the Restic key needs a custody design, and — if the first-choice format failed — the Doc 10 §8.1 fallback taken (another encrypted archive format; pair-level proof kept).

**Registry:** `PO-13`, `PO-21`, `DB-G1` → `SPIKE_PASS` (owner runs in Session 6).

**Covers:** early PO-13, PO-21, DB-G1. **Done when:** a pair captured on staging is restored into a disposable PostgreSQL and a disposable OpenBao and both are readable.

---

## Run 2.10 — Go/no-go gate

**Files:** `docs/evidence/session-2/{go-no-go,report}.md`, `docs/evidence/registry-overrides.json`, `docs/evidence/registry.json`, `infra/dependencies.lock.json`, `scripts/pins-verify.ts`, `.github/workflows/*` (image scan list), `CLAUDE.md`.

**Consumes:** every run note of the session and its `Verdict:` line.

- [ ] **Step 1 — Full suite on `session-2`,** from a clean checkout outside OneDrive: `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test`, `pnpm run test:integration`, `pnpm run test:cloud` (must still pass: the fixture guard starts on 15 Nov 2026, 09:42 UTC), `pnpm run test:staging`. CI green on the branch. Paste the summary lines into the report; a failing or skipped test is listed by name with its reason.
- [ ] **Step 2 — Pins.** Every new package, image and binary is in `infra/dependencies.lock.json` exactly (packages by version, images by digest); `REQUIRED_IMAGES` in `scripts/pins-verify.ts` gains `node`, Toxiproxy, nmap, `okms-cli`; the image-scan job scans the API image. `.trivyignore.images` still expires on 20 Nov 2026 — do not extend it here; list it in the report.
- [ ] **Step 3 — Checkpoints.** Read `kms-checkpoints.json`: if `kms-cert-expiry` is due, run it and record the result; if not, carry it into the report as owed by the Session 3 gate. The retention-fixture checkpoint `pairs-lock-session-gate` is not due before 15 Nov.
- [ ] **Step 4 — Staging demonstration,** recorded as commands and results: reboot staging → `/health` 200 and `sealed: false` with no operator action (seconds); the outside scan of both hosts; `probe.ts state` for both hosts; the alert drill reference from Run 2.6.
- [ ] **Step 5 — Fresh-context review.** A reviewer agent with no history of this session gets `git diff main...session-2`, this plan and Doc 10 §4.1, and is asked specifically: (a) for each proof run 2.1–2.4, find a negative test that would still pass if the protection were removed; (b) any place a secret, token, key or recovery value could reach Git, a log, an evidence file or the terminal; (c) any step on a host that could lock the operator out or widen exposure; (d) spike code imported by non-spike code. Every finding is fixed or listed in the report with an owner run.
- [ ] **Step 6 — Registry.** Apply the statuses named in each run through `registry-overrides.json`, each with its evidence file; `pnpm run evidence:build`; `pnpm run check`. Nothing is `PASS`. The three gates of Doc 06 §1.4 are not registry ids; they map to: **G-BAO** = PO-3 and PO-2 (Runs 2.1, 2.2), **G-AUTH** = PO-5 and PO-15 (Run 2.3), **G-EFFECT** = PO-16 (Run 2.4). Each of these five items is `SPIKE_PASS`, or `FAIL` with the fallback's decision record as evidence.
- [ ] **Step 7 — `docs/evidence/session-2/go-no-go.md`,** one page:

  | Proof | Run | Verdict | Fallback taken | Evidence | What later sessions must change |
  | --- | --- | --- | --- | --- | --- |
  | OpenBao tenancy and permissions | 2.1 | | | | |
  | Fixed-role orphan issuance | 2.2 | | | | |
  | Protected session and factor storage (G-AUTH) | 2.3 | | | | |
  | Late write and exclusion (G-EFFECT) | 2.4 | | | | |
  | Host boundary and transport | 2.5 | | | | |
  | Off-host alert | 2.6 | | | | |
  | KMS auto-unseal | 2.7 | | | | |
  | CLI approach | 2.8 | | | | |
  | Paired backup | 2.9 | | | | |

  Below the table: the overall line `Session 2: GO` / `GO WITH FALLBACKS` / `NO-GO`, and — for a `NO-GO` on any make-or-break proof with no working fallback — the question for the owner. A fallback that was taken lists the runs of Sessions 3–6 whose plans must be written differently.
- [ ] **Step 8 — `docs/evidence/session-2/report.md`,** same headings as the Session 1 report. Its section "What Session 3 must know" contains at least: the `@mykey/openbao` API and the names of policies, AppRole roles and token roles; `createOrgFixture`; the auth route contract, the cookie name, the key files `loadAuthKeys` expects and the bootstrap path for a first account; that the spike executor is not the protocol and what D-20 fixed; `connectStaging`, `host.ts` commands and the VPN addresses; what production still lacks (OpenBao, its own OKMS domain, key and certificate, recovery-share decision); open checkpoints and dates (KMS certificate expiry, `.trivyignore.images` 20 Nov, R2 fixture 15 Nov); every open issue with its owner run.
- [ ] **Step 9 — `CLAUDE.md`:** update "Where we stand" (table, what exists, what Session 3 needs) and "Things already learned" (only what every later session needs: host access, the secrets-over-stdin rule, the DNS and firewall behaviour found, the KMIP exit-and-restart behaviour, Better Auth facts confirmed by test). Commit `docs: session 2 report, go/no-go and registry`.
- [ ] **Step 10 — Pull request** `session-2` → `main` with the go/no-go table in the description. Do not merge. Message to the owner: the verdict, the fallbacks taken, what was bought and what it costs per day, the two custody confirmations still owed if any, and "merge when you agree".

**Covers:** the Session 2 gate (Doc 10 §4.5). **Done when:** the owner has a one-page go/no-go and the registry shows `SPIKE_PASS` or a recorded fallback for G-AUTH, G-BAO and G-EFFECT; later sessions that change because of a fallback are named.

---

## Session 2 end state

- **Proven or replaced:** OpenBao authority matrix with real tokens (PO-3); fixed-role orphan issuance (early PO-2); protected session, TOTP and recovery storage behind an explicit route allowlist, or the recorded auth fallback (early PO-5, PO-15); the late-write boundary and exclusive effects, or the recorded global-close fallback (early PO-16); KMIP auto-unseal on real OVHcloud KMS with certificate replacement and the key-loss verdict (PO-1, early KMS-L1).
- **Hosts:** `mykey-prod` and `mykey-staging` hardened from versioned files; only 443/tcp and 51820/udp answer; SSH over WireGuard only; default-deny egress by purpose; both serve `/health` through Traefik with a Let's Encrypt certificate and HSTS. Staging additionally runs OpenBao on the KMIP seal. Production holds no OpenBao and no secret.
- **Watching:** Worker `mykey-probe` with heartbeats from both hosts and four alert conditions, proven by a blackout drill on the owner's channel.
- **Backup:** one synthetic pair captured under a write freeze on staging, encrypted, stored in R2, restored into a new PostgreSQL cluster and a new OpenBao, and checked; six negative cases recorded.
- **Code that stays:** `packages/openbao`, `packages/auth`, `packages/db` (schema `auth`, `applyDatabaseAccess`), `apps/api` health stub, `workers/probe`, `infra/hosts`, `infra/compose/host*`, `infra/openbao/policies`, `scripts/host.ts`, `scripts/probe.ts`, the `staging` test project. **Code to be replaced:** everything in a `spike` directory.
- **Registry:** `SPIKE_PASS` for PO-1, PO-2, PO-3, PO-5, PO-11, PO-13, PO-14, PO-15, PO-16, PO-21, DB-G1, KMS-L1, FR-1.64, FR-1.65, FR-1.70–1.72, AC-1.26, AC-1.30, AC-1.31 — or `FAIL` with a fallback named. Nothing is `PASS`.
- **Documents:** decision records D-17 … D-25; runbooks `network.md`, `probe.md`, `kms-and-unseal.md`, `custody-map.md`; `docs/auth-route-contract.md`; `authority-matrix.md`; `go-no-go.md`; `report.md`.
- **Owed to later sessions:** the expired-certificate checkpoint; production's KMS material and OpenBao; signed manifests and the capture coordinator (6.5); checker-disappearance alert and certificate-expiry alert (6.4); the SNI-level egress question (8.x); the real operation protocol (4.2).
- **Pull request** `session-2` → `main` open, merged only on the owner's word.
