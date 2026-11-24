# D-77 — Staging is restored onto its own reinstalled server

**Date:** 2026-11-24

**Status:** DECIDED (P-177; Runs 10.2 and 10.6). Evidence: `docs/evidence/session-10/redrill.json`, `run-10.6.md`, `tests/staging/redrill.staging.test.ts`, `docs/runbooks/restore.md`.

## Context

The restore code changed in Session 9 (R4-2, R4-3, R4-4, R4-7, R4-10, RR-1, RR-3) and was proven by local tests only (D-73). Its hardest case, a host restored onto its own reinstalled server, keeps two OpenBao answers under one name (R4-10). Production's first restore should not be the first time that case runs. Staging's own disk also held things no pair carries: the KMS instance `expiry` (the subject of the checkpoint `kms-cert-expiry`), the seal certificate's key, the pair signing key and the R2 tokens.

## Decision

1. **Staging is the drill's target, onto its own server.** The owner reinstalled it in the OVH console. Its custody copy was kept, and `bao-init` wrote the new server's answer beside it, dated (R4-10).
2. **Three things were settled before the reinstall.** The `expiry` instance was archived and put back afterwards. The heartbeat came back through `probe.ts secrets --host staging`. The new certificate, `staging-seal-3`, is also the replacement that was due by 5 Dec 2026: it ends on 24 Dec 2026, 10:28:57 UTC.
3. **The pair signing key comes back from custody, not new.** A pair names no signing key id, and a host has one trust anchor (`<host>-k1.pub`). A new key would make every earlier pair unverifiable, and a second id needs a change to the restore's trust lookup, which is product code (D-69). `restore.md` has the order in its part "After, on the host's own server".
4. **`restore.md`'s "Before" is corrected for a clean host.**
   - It now sets the four OpenBao and KMS settings in `host.env`.
   - It pulls the three upstream images by digest in a `maint` window, not by `compose pull`, which needs `MYKEY_BASE_URL` before the first `up` has written it.

## Result

- **The restore ran** onto the reinstalled server on `host-v0.9.2`:
  - steps 1–7 took 184 s;
  - `reconcile-credentials` reconciled 163 environments in 2,672 s;
  - all 20 report checks were `ok`;
  - the gate opened 75.6 minutes after step 4, against RR-2's 120.
- **What stayed closed:**
  - the four refusals before the opening were all refused;
  - all seven old credentials were refused after it.
- **R4-2, R4-4 and R4-10 held:**
  - a new root token under the same recovery key;
  - no restore state file left;
  - two dated copies.
- **A redeploy with the new root token passed.**
- **The first pair of the restored host became eligible.**
- **Not as planned:**
  - **The pair was not P.** Staging was closed and quiesced when it was declared lost, but its backup timer still ran at 03:00. `--newest` took that pair, so the check that the secret written after P is absent failed: the pair holds it. The drill now stops `mykey-backup.timer` when it declares the host lost.
  - **One report check came back `unknown`.** In the first report, `catalog_matches_backend` answered `unknown (Error)`. The same loops, run ten minutes later, found no error, and the next report was 20 of 20.
  - **A defect found after the opening, and fixed.** The restore onto a clean server wrote the organization id only for the API, not for the provisioner. Its OpenBao client then read no incarnation, so every environment job and the sweep were deferred as `incarnation`, and new environments stayed `pending`. Run 6.8's drill host never created an environment after its restore, so this went unseen. `scripts/host-restore.ts` now writes the id into both directories (a host script, D-69 point 1). A unit test failed first and passes now. Staging was repaired by hand the same way, and its four waiting jobs ran at once. The fix is proven by that test, not by a second real restore.

## Consequences

- AC-1.43, AC-1.44 and PO-22 can name this drill at the gate (Run 10.7).
- The window's margin is 44 minutes at 163 environments. At about 16 s per environment, about 330 active environments fill it (`known-limits.md`).
- A restore's report does not show whether the provisioner can work. None of its 20 checks reads the provisioner's credential, and the drill's own "after" checks create no environment. Run 10.6 found the defect only through the staging files that create one (`backup`, `machine`, `cli`, `sweep`). A check for it is a candidate for a later session.
- Staging's 16 member-less spike organizations of Session 2, marked for review by the restore, were retired on the owner's answer. The organizations are `failed` and their 28 environments `archived`, so staging's `reviewOpen` is 0 again (`run-10.6.md`).
- `host.ts` has no command that puts the signing key back from custody. Run 10.6 used a one-off script.
- The owner deletes `staging-seal-2` in the console, and `drill-seal-1` if it is still listed.
