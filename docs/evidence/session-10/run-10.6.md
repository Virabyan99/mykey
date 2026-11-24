# Run 10.6 — The staging restore re-drill, and the credential drill

**Date:** 23–24 Nov 2026. **Branch:** `session-10`. With the owner's answer 2 ("we can do it as well"). D-77, D-78.

## Task A — Before the owner reinstalls

### The inventory (Step 1)

What lives only on staging's disk, read by name on 23 Nov (never by content), and where each comes from after the reinstall.

| On staging                                                                                          | After the reinstall                                                                                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/etc/mykey/host.env`                                                                               | `host.ts up` (a new host instance id), `deploy` (the images), the restore's step 7 (the incarnation), `ops-secrets`                              |
| `/etc/mykey/openbao/openbao.hcl`, `/opt/mykey/compose/*`                                            | `host.ts` (`push`, `up`, `deploy --install-only`): from this repository and the release                                                          |
| `/etc/mykey/pki/*` (the host CA and server certificates)                                            | new ones: `pki-init` in `up`                                                                                                                     |
| `/etc/mykey/kms-csr/staging-seal-{1,2}.csr`                                                         | lost on purpose; copies in `~/.mykey/kms/`. A new CSR for `staging-seal-3`                                                                       |
| `secrets/kms/staging-seal-2.{crt,key}` and the `seal.*` links                                       | **new**: `kms-csr staging-seal-3`, the owner's certificate, `kms-cert`, `kms-use`. The old key has no copy, by design                            |
| `secrets/kms/losstest-*`, `openbao/spike-expiry.hcl`, volumes `mykey-spike-expiry-{data,audit}`     | the saved archive (Step 3), put back in Task C                                                                                                   |
| `/opt/mykey/bin/okms`                                                                               | `kms-install` with the pinned archive                                                                                                            |
| `secrets/api-keys/*` (eight rings)                                                                  | the workstation's copy (`~/.mykey/secrets/hosts/staging/auth-keys/`, eight files): `keys init` creates only missing rings                        |
| `secrets/postgres/superuser-password`, `secrets/api/db-password`, `secrets/provisioner/db-password` | `db-init` makes new ones; the restore's step 3 replaces the role passwords                                                                       |
| `secrets/ops/{backup_reader,maintenance}`                                                           | `ops-secrets`, after the restore                                                                                                                 |
| `secrets/api/*` and `secrets/provisioner/*` (AppRole credentials, the organization id)              | the restore (steps 5–7 invalidate every credential class and issue the services' own)                                                            |
| `secrets/backup/password`                                                                           | the restore installs the source's password from `~/.mykey/custody/staging/backup/password`                                                       |
| `secrets/backup/signing-key`, `secrets/backup-approle/*`                                            | **new**: `backup-init` (a new key id; its trust anchor committed), then `backup-custody`                                                         |
| `secrets/r2-{pairs,pairs-cleanup,audit-archive}/*`                                                  | `r2-install` for the three, from `~/.mykey/secrets/r2/`                                                                                          |
| `secrets/heartbeat/curl.conf`                                                                       | `probe.ts secrets --host staging`, from the workstation's existing heartbeat token                                                               |
| `/etc/mykey/gate/gate.json`                                                                         | `deploy` (closed), the restore (closed + verifying), `restore-verify --open`                                                                     |
| `/etc/mykey/gate/capacity.json`                                                                     | `status.sh`, each minute once the timers run                                                                                                     |
| `/root/mykey-custody/openbao-init.json`                                                             | `bao-init` (the new server's answer, dated beside the workstation's copy, R4-10)                                                                 |
| volumes `mykey_pgdata`, `mykey_baodata`                                                             | the restore, from the pair                                                                                                                       |
| volume `mykey_baoaudit` (OpenBao's audit device)                                                    | lost on purpose; its archived segments stay in R2                                                                                                |
| volume `mykey_acme`                                                                                 | new: `acme production`                                                                                                                           |
| three unnamed volumes                                                                               | lost on purpose: the postgres image's own `VOLUME`, made anew for the one-shot containers `pki-init` and `prepare` (and one left over, dangling) |
| `/var/lib/mykey/field/` (one day record, `labels.json`)                                             | the record pulled first (`field-pull`, 1 record); `labels.json` lost on purpose: staging's labels start again                                    |
| the journals, the WireGuard key, the host key                                                       | lost on purpose; `bootstrap` gives a new WireGuard key (the owner restarts the tunnel), and the new host key is taken once                       |
| the systemd units and timers                                                                        | `timers`; the boot service by `up`                                                                                                               |

Every class has an answer. The workstation holds what restore.md's "Before" needs: the pinned `okms` archive (`~/mykey-tmp/`, its SHA-256 equal to the pin), the release directories `host-v0.9.1` and `host-v0.9.2`, staging's custody set (`openbao-init.json`, the backup password and signing key), the R2 tokens and the trust anchor `staging-k1.pub`.

### The window, estimated (Step 2)

Staging has 189 active environments. At 19 s each (Run 6.8) plus 30 minutes, that is 90 minutes, within the plan's 100, so no project was archived.

### The KMS instance `expiry`, saved (Step 3)

Its Compose project was already stopped (`exited(2)`). Its two volumes, `spike-expiry.hcl` and the four `losstest-*` files are in one archive, `~/.mykey/drill/spike-expiry.tar.gz`. Size: 71,927 bytes, 12 entries. SHA-256: `01feb26b5a3c4922f178c105c70d415605618f1efb41e0ca0ed8a32eb28b8409`, the same on the host and on the workstation. Nothing of it was printed.

### Pair P, and staging declared lost (Steps 4 and 5)

- `MYKEY_REDRILL_PHASE=before`: PASS (4 tests, 158 s). The drill's content was seeded, pair P recorded, and the changes after P made. Staging stayed open.
- `MYKEY_REDRILL_PHASE=lost`: PASS (5 tests, 60 s). Staging was closed and quiesced, so the probe's `health_failing` is expected until the opening.

## Task B — The owner's sitting (24 Nov)

- The owner reinstalled staging in the OVH console and changed the expired `ubuntu` password. The new host key (`SHA256:PJa7qrxzY5JfiWDCKBcX6XGEZ8w4ftMQXajRgpowFXc`) was taken once, right after; the old `known_hosts` is kept beside it.
- `bootstrap` gave the server a new WireGuard key. The owner restarted the tunnel **before** `apply ssh|firewall`, because `confirm` must come from a new VPN connection (a ruling: the plan had the restart after). Both were confirmed.
- `kms-install` (the pinned archive), `kms-csr staging-seal-3`. The owner issued the certificate in the console. Checked before use: its subject is `staging-seal-3`, its issuer is the same KMS user CA as `staging-seal-2`'s, and its public key equals the CSR's. Valid from 24 Nov 2026, 10:28:57 UTC to **24 Dec 2026, 10:28:57 UTC**.

## Task C — The restore, timed

### Three runs of the restore phase

| Run | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **C1 failed** after 333 s, before anything was restored. The reinstalled server's `host.env` had none of the four OpenBao and KMS settings, and `compose pull` needs `MYKEY_BASE_URL`, which only the first `up` writes. `restore.md`'s "Before" said neither. C2 had started the clock although C1 failed; that time was removed by hand, and C2 now refuses to start unless C1 is done.                                                                                                                                                                                                                                                                                                                                                                          |
| 2   | C1 passed (350 s). **C2 restored a pair, but not P**: `2994bad4`, staging's 03:00 nightly of 24 Nov. Staging was closed and quiesced at 20:31 on 23 Nov, but `quiesce` stops the executors, not the timers. Steps 1–7 took 184 s and ended closed + verifying; C2's assertion wanted P's id. C3 passed: 163 environments reconciled in 2,672 s, all exit 0 (16 spike organizations and their 28 environments marked for review, as in Run 6.8). **C4's report was 19 of 20:** `catalog_matches_backend` answered `unknown (Error)`. The same two loops, run ten minutes later with the restore's token, found 1 organization, 163 environments and no error. The rest of the file failed after C4, and E's redeploy failed its journey with the gate still closed. |
| 3   | C2 was marked done by hand with the pair it restored (a ruling; a rerun is refused on a database with organizations). **15 of 16 passed.** C4 20 of 20, C9 opened the gate at 12:02:19 UTC, E redeployed with the new root token. The one failure is the check that the secret written after P is absent: the restored pair holds it.                                                                                                                                                                                                                                                                                                                                                                                                                              |

### What was measured (`redrill.json`)

- **From step 4 to the opening: 75.6 minutes**, against RR-2's 120. Run 6.8: 42 minutes of work on 84 environments.
- **`reconcile-credentials`:** 163 environments in 2,672 s, about 16 s each (Run 6.8: 19 s).
- **Steps 1–7:** 184 s. **C1 (the clean host's "Before"):** 350 s. **C4 (reset and report):** 311 s. **C9 (the opening):** 367 s.
- **The report:** all 20 checks `ok`, 1 member confirmed.
- **Refused before the opening:** gate open without a report, with one older than 30 minutes, with another incarnation's; the public listener answered 503 `quarantined`.
- **Refused after it:** all seven old credentials, three machine tokens, two sessions and two passwords, each 401.
- **What this session's fixes promised:** R4-2 (a new root token under the same recovery key), R4-4 (no restore state left), R4-10 (two dated custody copies).
- **The data:** the 30 seeded secrets revealed with their digests, and a new machine token read the environment through the machine route.

The figure "lost to open" (931 minutes) includes the night and the owner's reinstall. It measures nothing about the restore.

### Put back and set up afterwards

- **The KMS instance `expiry`:** the archive's SHA-256 equal to the saved one. Volumes and files restored, started once: `initialized: true`, `sealed: false` (KMIP, `losstest-1day`). Then stopped, as it was. The checkpoint `kms-cert-expiry` keeps its subject and its date.
- **The API's key rings:** `keys init` installed the workstation's copy (`auth-keys/`), creating only what was missing.
- **The pair signing key `k1` came back from custody** (a ruling, D-77 point 3). Its public half was checked equal to `staging-k1.pub` before it was installed, on stdin. Then `backup-init` (a new AppRole secret id; the anchor unchanged), `backup-custody` (both files "already holds"), `r2-install` for `pairs`, `pairs-cleanup` and `audit-archive`, `push` and `timers`.
- **The first pair by hand:** `e7dff001…` eligible in 57 s.
- **The staging test owner** was re-established (`reestablishStagingOwner`).
- `restore.md` now has "Before" corrected and a new part, "After, on the host's own server".

### Changed in the drill file

- C1 sets the four settings and pulls by digest.
- C2 refuses to start without C1.
- B4 stops `mykey-backup.timer` when it declares the host lost.
- E writes `restoredPairId`.

### The pass on the restored host (Step 7)

| File        | Result    | Notes                                                                                                                                                                                                                                                                          |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api`       | PASS (12) |                                                                                                                                                                                                                                                                                |
| `status`    | PASS (3)  |                                                                                                                                                                                                                                                                                |
| `identity`  | PASS (15) | The first run lost the VPN; the second, its database tunnel during the canary sweep. The third passed the sweep, and its clean-up found `reviewOpen` 44 (the spike organizations, below). After they were retired, the fourth passed.                                          |
| `workspace` | PASS (1)  | The test was stale. Home lists the first 100 projects by id, and staging's organization now holds 157. The new project appeared on Home in about six runs in ten. The test now goes the way Home's note points, to the project's own page, when the project is not among them. |
| `backup`    | PASS (6)  | It named `staging-seal-2`. Staging's seal names are now one constant pair in `tests/harness/staging.ts`.                                                                                                                                                                       |
| `machine`   | PASS (1)  | After the provisioner fix (below).                                                                                                                                                                                                                                             |
| `cli`       | PASS (1)  | After the provisioner fix.                                                                                                                                                                                                                                                     |
| `sweep`     | PASS (10) | After the provisioner fix.                                                                                                                                                                                                                                                     |
| `unseal`    | PASS (10) | It named `staging-seal-1` and `-2`; now the constants.                                                                                                                                                                                                                         |

Each run's rewritten evidence files of earlier sessions were restored with `git checkout`.

### A defect: the provisioner had no organization (fixed)

In the first pass, `backup`, `machine`, `cli` and `sweep` all stopped at "environment stayed pending". The provisioner's log deferred every job and the sweep with cause `incarnation`. The cause was not the incarnation itself, which was equal in `host.env`, the container, the gate and the database. On a clean server, the restore wrote `organization-id` only into `secrets/api/`. The provisioner's `readCredential` then returned nothing, its OpenBao client was never made, and no incarnation was read.

- **Fix:** `scripts/host-restore.ts` (`deliver`) writes the id beside the provisioner's credential too. This is a host script (D-69 point 1).
- **Test:** `tests/unit/hosts/host-restore.test.ts`, "the provisioner's credential goes beside the organization id too". RED, then GREEN; the three restore and deploy unit files pass, 43 of 43.
- **Staging:** repaired by hand, by copying the API's file with the same owner and mode. The four deferred jobs ran within a minute, and 167 environments were active.
- **Not proven:** a second real restore with the fix.
- **Why the drill missed it:** the report's checks do not cover it, and the drill's "after" checks create no environment (D-77).

### The 16 spike organizations, retired (the owner's answer)

The restore marked Session 2's 16 member-less spike organizations and their 28 environments `needs_review` (`namespace_missing`), as Run 6.8 did on its drill host. Before the reinstall they were `active`.

- With them, `reviewOpen` was 44, so the probe's `review_open` stayed open on staging. The credential drill and `identity`'s clean-up both expect 0.
- D-56 had left these organizations to the owner, and the permission check refused the change until the owner was asked. **The owner chose to retire them.**
- The organizations are now `failed` and their environments `archived` (origin `self`). Only the rows the drill marked were changed: `namespace_missing`, no member. They stay in the database. `reviewOpen` is 0.

## Task D — The credential drill, re-aimed (D-78)

Run on the restored staging, with nothing else running there.

- **Step 1, the order.** One issuance, with the trigger armed and a hold of 0 s:
  - the answer was 201, and the trigger matched;
  - the match came 616 ms after the request was sent and 114 ms before the 201. The match is on the host's clock and the answer on the workstation's; staging's chrony offset was 0.03 ms;
  - it froze 1.2 ms after matching.

  As expected, the request record comes before the answer. The issuance was revoked. Its project (`s10-order-…`) stays, as projects cannot be deleted.

- **Step 2, the drill.** PASS (1 test). **Caught on attempt 1 of 5:**
  - `503 outcome_unknown`, the trigger's reaction 0.98 ms, the credential `needs_review`;
  - the next issuance for that environment refused with `409 state_conflict`;
  - `operations_unresolved` delivered at 15:05:33Z, 21 s after the send;
  - quiesce at 15:06:40Z, then `reconcile-credentials --executors-excluded yes` (`issuances-settled 1`), then resume and the gate open again at 15:10:06Z;
  - the alert cleared at 15:10:10Z (`credential-drill.json`).
- **Step 3:** D-78, and `known-limits.md`'s line rewritten.
- **Step 4** (nothing caught) did not arise.

The four ids AC-1.18, AC-1.40, AC-1.57 and PO-18 can name this file at Run 10.7's manifest.
