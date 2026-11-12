# Session 2 report — Infrastructure and make-or-break proofs

**Date:** 11–12 November 2026 · **Branch:** `session-2` · **Plan:** `docs/plans/session-2-plan.md` · **Go/no-go:** `go-no-go.md`

## Result

**GO.** All ten runs are complete and every make-or-break proof holds without a fallback: G-BAO (PO-2, PO-3), G-AUTH (PO-5, PO-15) and G-EFFECT (PO-16) are `SPIKE_PASS`. Two hosts run on OVHcloud behind a default-deny firewall and WireGuard-only SSH; staging's OpenBao unseals itself from OVHcloud KMS; an off-host probe alerts on Telegram; a paired backup of staging was restored from R2 into new stores. Nothing is `PASS`: every proof is in isolation and waits for the integrated product.

## What works now

The gate ran in a fresh clone outside OneDrive (`C:/Users/gmpar/mykey-gate`, commit `db5abe4`), then again on the fixes of the final review (below).

| Command                          | Result                | Notes                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | exit 0                | —                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm run check`                 | exit 0                | format, lint, types, pins, OpenAPI, schema drift, authority matrix, auth route contract, registry                                                                                                                                                                                                                                                     |
| `pnpm test`                      | 619/619               | 40 files                                                                                                                                                                                                                                                                                                                                              |
| `pnpm run test:integration`      | 394/396, then 395/396 | `exclusion.test.ts` "twenty executors…": 2 of 20 got `busy` under combined load (the image scan and the staging suite ran at the same time); passed on the rerun. `client-answers.test.ts` "a connection that breaks once the request has left … applied" failed twice: the test relay passed only the first TLS record of the request (fixed, below) |
| `pnpm run test:cloud`            | 8/8                   | the fixture guard starts on 15 Nov 2026 09:42 UTC                                                                                                                                                                                                                                                                                                     |
| `pnpm run test:staging`          | 46/49                 | the three failures are the boundary checks that predate OpenBao (review finding I1, fixed below); every other file passed — unseal (10, with the reboot), key-loss (2), pair (12, in one run), probe, transport                                                                                                                                       |
| `node scripts/ci-scan.ts images` | exit 0                | five upstream images and, new, the API image built from the repository (22 dependency targets, 0 findings)                                                                                                                                                                                                                                            |

After the fix pass: `pnpm run check` exit 0; the fixed tests RED → GREEN (below); the final suite run is recorded in the ledger and in the pull request.

What exists after Session 2:

- **Run 2.1 — OpenBao tenancy.** `@mykey/openbao` (narrow client, `paths.ts`, `policies.ts`, `authority.ts`), `@mykey/openbao/admin` (`OpenBaoAdmin`), `createOrgFixture`; the 860-cell authority matrix with real tokens; the audit device with correlation headers.
- **Run 2.2 — issuance.** Fixed-role orphan machine tokens issued by a 60 s issuer; every override refused or without effect.
- **Run 2.3 — auth.** `@mykey/auth`: Better Auth 1.7.19 behind five allowed native routes (27 denied answer 404), sessions stored as keyed verifiers, product-owned TOTP and recovery codes, one-transaction elevation; migration `0003_auth_base.sql`; `docs/auth-route-contract.md`.
- **Run 2.4 — effects.** The spike executor and reconciler, `tests/harness/tls-relay.ts`, D-20's late-write boundary.
- **Run 2.5 — hosts.** `scripts/host.ts` (bootstrap, push, apply with timed revert, confirm, image, acme, maint, up, db-init, status), firewall `mykey.nft` with egress sets, WireGuard, the host Compose file (edge, API, PostgreSQL), boundary and transport tests from outside.
- **Run 2.6 — probe.** Worker `mykey-probe` with D1, heartbeats from both hosts, Telegram alerts, drills.
- **Run 2.7 — KMS.** OpenBao on staging with the KMIP seal, `kms-*`, `env` and `bao-init` commands, unseal, certificate-replacement and key-loss drills, the `kms-cert-expiry` checkpoint.
- **Run 2.8 — CLI.** D-24: a thin CLI over OpenBao Agent.
- **Run 2.9 — backup.** `infra/backup/pair-spike/` (manifest, freeze, host steps, capture and restore), `applyDatabaseAccess`, the privilege matrix as a harness.

## What failed or was deferred

| Item                                     | State                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production                               | Not brought current at the gate: the deploy (`push`, the API image, `db-init` for `0003`, `up`) was refused by the session's permission check. Production runs migration `0002`, its Run 2.5 API image and Compose state; it holds no OpenBao, KMS material or product secret, as planned. |
| Checkpoint `kms-cert-expiry`             | Not due: from 12 Dec 2026 09:57 UTC. Needs a new losstest certificate then (`losstest-ops` also expires on 12 Dec).                                                                                                                                                                        |
| KMS certificate validity                 | 30 days (the console's only choice). `staging-seal-2` expires 12 Dec 2026 10:50 UTC.                                                                                                                                                                                                       |
| Heartbeat field for an unloaded firewall | Deferred to Run 6.4 (ruling on review finding I2).                                                                                                                                                                                                                                         |
| Independent outside scan (R30)           | Not done: AC-1.31 rests on the workstation's vantage point, whose network answers 53 itself.                                                                                                                                                                                               |
| `.trivyignore.images`                    | Expires 20 Nov 2026; not extended here.                                                                                                                                                                                                                                                    |

## Decisions taken

- **D-17** OpenBao identity model: runtime authenticates with inline AppRole (PO-3), not P-22's stored 15-minute login.
- **D-18** Issuer placement: a 60 s issuer, fixed-role orphan tokens.
- **D-19** Auth storage design: keyed session verifiers, product-owned factors, five native routes.
- **D-20** Late-write boundary: request duration cap 15 s, listener read limits, the restart as proof.
- **D-21** Host network and egress: default deny, address-set egress per purpose, VPN-only SSH.
- **D-22** Probe and alert path: one Worker, four conditions, Telegram.
- **D-23** Seal and KMS layout: built-in KMIP seal, two KMS domains, certificates from CSRs, 30-day validity.
- **D-24** Thin CLI over OpenBao Agent.
- **D-25** Paired backup format (spike).
- No pre-authorised fallback was used.

The executing agent's rulings (R1–R76 and the final-review rulings) are listed in the session's final message and summarised in each run note.

## Pins

| Component                | Version                                                    |
| ------------------------ | ---------------------------------------------------------- |
| Node                     | 24.22.2                                                    |
| PostgreSQL               | 18.6 (image by digest)                                     |
| OpenBao                  | 2.7.2 (image by digest)                                    |
| Traefik                  | 3.7.17 (image by digest; running on both hosts)            |
| Better Auth              | 1.7.19                                                     |
| Hono / @hono/node-server | 4.13.17 / 2.1.6                                            |
| Restic                   | 0.19.1 (image by digest)                                   |
| okms-cli                 | 0.6.0 (release archive by SHA-256, new section `binaries`) |
| nmap                     | image by digest (outside scans)                            |
| gitleaks, Trivy          | v8.30.1, 0.76.2                                            |

`infra/dependencies.lock.json` SHA-256 at `146aa04`: `fe4096e5670fd81c9b6490ee69773f0dcb852ffda5b6115c54cc3cc403af6555`. Toxiproxy was never adopted (R46: a TLS-aware relay replaced it), so it is not pinned.

## Reviewer findings

One fresh-context reviewer (Opus 5.5) read the whole branch `2dddf1e..0d11de6` (44 commits), the plan, Doc 10 §4.1 and every ruling (`.superpowers/sdd/session-2-plan/final-review.md`). **No critical finding; four important; seventeen minor.** It found no negative test in Runs 2.1–2.4 that passes because the request was wrong, no spike code imported by kept code, and no secret in Git or the evidence files.

### Fixed

| Finding                                                                                                                                                                                                             | Fix                                                                                                                                                                                                          | Test                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| I1 The boundary suite expected three containers and three bridges; since Run 2.7 staging also runs OpenBao on `mk-bao` and `mk-kms`, so `test:staging` was red and the new bridges were never checked from outside. | The suite reads `MYKEY_OPENBAO` from each host's `host.env`: OpenBao's container and both bridges are expected where it runs; `mk-bao` must reach nothing, `mk-kms` only the KMIP endpoint and the resolver. | `boundary.staging.test.ts` (RED in the gate run, 3 failures)                                                              |
| I2 A firewall revert deleted the whole table and disabled `nftables.service`; a failed DNS lookup during `apply` triggered it.                                                                                      | `apply` saves the loaded rules to `/etc/nftables.d/previous/`; `revert` restores and reloads them, and unloads only when nothing was loaded before; a failed refresh no longer fails the load.               | "returns to the previous rules, never to no firewall": RED on staging (the old revert left no table), GREEN after the fix |
| I3 A retried `bao-init` could truncate the only copy of the root token and recovery key.                                                                                                                            | Refuses when `openbao-init.json.new` exists; asks `GET sys/init` and refuses unless `initialized` is false.                                                                                                  | `deploy.test.ts` RED → GREEN                                                                                              |
| I4 `requireMfaComplete` checked only the session's phase.                                                                                                                                                           | It reads `account_state`: refuses unless the account is `active` and the session's auth epoch is current; without a pool it refuses.                                                                         | `factors.test.ts` "the product-route guard ends an elevated session of a disabled account or an older epoch" RED → GREEN  |
| (gate) The drop relay passed only the first TLS record of a request.                                                                                                                                                | Drop mode passes every request record until the cut; hold mode unchanged.                                                                                                                                    | `client-answers.test.ts` 6/6 three times                                                                                  |
| (gate) The API image was not scanned.                                                                                                                                                                               | `ci-scan.ts images` builds, saves and scans it (language packages; the base image's npm stays with the node image's scan).                                                                                   | `ci-scan.test.ts`; real scan exit 0                                                                                       |

### Open (minor, deferred to the owner's judgement)

1. M1 The OpenBao root token stays unrevoked in `/root/mykey-custody` on the host (revoke after setup; `generate-root` when needed) — before production.
2. M2 A failed pair capture leaves its secrets in the root-only tmpfs until it is closed; every pair container mounts all of `in/` (Run 6.5).
3. M3 `maint` runs any command and its output is redacted only against registered values.
4. M4 `scripts/probe.ts` registers secrets but prints without the redacting logger.
5. M5 `bao-init` registers the root token only inside the whole answer; a `JSON.parse` error may quote input.
6. M6 The OpenBao template's comment claims D-20 bounds for listener timeouts not measured on staging.
7. M7 The spike Compose file is pushed to production too.
8. M8 The real OpenBao mounts all of `/etc/mykey/secrets/kms`, losstest keys included, until 12 Dec.
9. M9 "rights are what was granted" asserts only a non-zero exit, not the refusal text.
10. M10 AC-1.31's line says "443/tcp only" while the scans also show 53 (answered by the workstation's network, R30).
11. M11 One shared `blocked` set: a drill on one purpose can cut another on a shared anycast address.
12. M12 `chronyOffsetMs` loses its sign.
13. M13 `kvRead(path, 0)` is accepted; `tokenRevokeSelf` maps a 5xx like a read; D-17 still says the foreign-accessor 500 maps to `invalid`.
14. M14 AppRole secret ids never expire and are not bound to addresses (Session 3).
15. M15 The auth key ring picks the current key by text order (`k10` < `k9`).
16. M16 The auth relay parses every 2xx body as JSON.
17. M17 `scripts/host.ts` takes its SSH and redaction code from `tests/harness/` (a plan issue; move with `apps/ops`).
18. (found at the gate) Each run of `key-loss.staging.test.ts` leaves its healthy key L-C active in the losstest domain ($0.07 a month each); it should destroy it at the end.

### Not judged by the reviewer

The bodies of the race, dump and stock-plugin tests and of the staging pair, probe, transport and key-loss tests (read in part; the gate's runs and the evidence files cover them), generated files, and decisions owned by later runs (listed with rulings in the ledger).

## What Session 3 must know

- **`@mykey/openbao`:** `OpenBaoClient` (`kvRead`, `kvWrite` with check-and-set, `kvMetadata`, token calls; a change whose answer is unclear is `unknown`, never a failure — R8), `appRoleLogin`, `secretPath`/`namespaceFor`/`machineName`, `renderPolicy`, `renderMachinePolicy`, `machineTokenRole`. Operator calls only through `@mykey/openbao/admin` (`OpenBaoAdmin`). Namespaces `org-<organizationId>`; KV v2 at `kv` (cas required, 20 versions); policies and AppRole roles `runtime`, `issuer`, `provisioner`; token roles `machine-env-<environmentId>`; root-namespace policy and AppRole `backup`. Runtime authentication is inline AppRole (D-17); the provisioner must never run in the API process.
- **`createOrgFixture(stack, { environments })`** builds a namespace with all of the above and drops it again; `effectsFixture(stack, { db })` adds the database rows and the spike executor.
- **Auth:** routes and bodies in `docs/auth-route-contract.md`; cookie `__Secure-better-auth.session_token` (Secure, HttpOnly, SameSite=Lax, 12 h); `loadAuthKeys(dir)` expects `<ring>.<keyId>.key` files (rings `cookie`, `session-lookup`, `seed-encryption`, `recovery-verifier`, mode 0600, base64url); a first account is created through the operator path (`password.hash` plus the `user`, `account`, `account_state` rows), never by sign-up. `requireMfaComplete(auth, headers, pool)` now checks phase, account state and auth epoch; **the 30-minute idle limit is not enforced anywhere yet**; sign-in does not check `account_state` (Run 3.4); change-password with `revokeOtherSessions` drops the session to `password_verified` (Runs 3.4/3.5).
- **The spike executor is not the protocol.** D-20 fixed: one effect per environment at a time, a request-duration cap of 15 s, and a restart as the only proof that nothing lands later.
- **Staging access:** VPN `mykey-ops`; staging 10.77.2.1 (public 40.160.47.50, `mykey-staging.nomikey.com`), production 10.77.1.1 (40.160.47.48, `mykey.nomikey.com`); `connectStaging({ openbao })`, `sshExec` (secrets only on stdin; `secretOutput` for anything naming `/etc/mykey/secrets` or `/root/mykey-custody`); `host.ts <host> <command>`; `stagingDatabase(staging)` uses the real database and passwords and never runs `applyRoles` (roles are cluster-wide).
- **What production still lacks:** OpenBao, its own OKMS domain, IAM user, policy, seal key and certificate, a recovery-share decision, migration `0003` and the current API image (see "What failed").
- **Dates:** R2 fixture guard 15 Nov 2026 09:42 UTC; `.trivyignore.images` 20 Nov 2026; all KMS certificates 12 Dec 2026 (seal 10:50 UTC); checkpoint `kms-cert-expiry` from 12 Dec 2026 09:57 UTC.
- **Open issues with owners:** reconciliation audit identity (Run 4.5); effects without an operation marker (Runs 4.6, 5.2, 5.3, 3.8); token lifetime via `creation_ttl` and `num_uses: 0` (Run 5.1); accessors per namespace (Runs 5.2, 6.8); Worker self-monitoring, KMS certificate-expiry and freeze alerts, an unloaded-firewall condition (Run 6.4); pair manifest signature, Restic password custody, control-row owner (Run 6.5); IPv6 scan and shared-address egress (Session 8); npm out of the API runtime image (Run 6.9); the deferred minors above.

## Owner actions pending

| Action                                                                                           | Needed by                                                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Allow (or do) the production update: `host.ts prod push`, `image api`, `db-init`, `up`           | before production's first OpenBao start; not needed for Session 3 |
| Replace the seal certificate `staging-seal-2` (a new CSR and a console sitting, about 5 minutes) | before 12 Dec 2026                                                |
| Issue `losstest-ops-2` for the `kms-cert-expiry` checkpoint                                      | 12 Dec 2026                                                       |
| Merge the pull request `session-2` → `main` when you agree                                       | Session 3 start                                                   |

Recurring cost added by Session 2 (estimated): OVHcloud KMS, four active keys (the staging seal key, L-B and two L-C) at $0.07 each a month; R2 1.8 MB stored, below every billing unit; Cloudflare Worker and D1 within the free allowances; the two OVHcloud servers as on the owner's invoice.
