# Gate R — controlled-use release of Stage 1

_21 Nov 2026. Plan: `docs/plans/session-8-plan.md`, Run 8.9 (P-156, OWN-7). Everything the owner signs is above the signature line._

## 1. The candidate

| Part           | Value                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| Host release   | `host-v0.8.1`, built from `9af7051` (21 Nov 2026, 12:11 UTC), `release.json` `95521bcb…` |
| CLI release    | `cli-v0.1.2`                                                                             |
| Images         | api `753c2604…`, provisioner `9a647b86…`, ops `c25e7102…`; base node `a34ab6d7…`         |
| Host files     | `d53254e`; no `tooling` line after the freeze                                            |
| Last migration | `0018_incarnation`                                                                       |
| Staging        | runs it **open**, gate epoch 315 (since 12:23 UTC)                                       |
| Production     | runs it **closed**, gate epoch 3 (since 12:27 UTC)                                       |

The whole record is in `candidate.json`. There was one change after the freeze. The claims walk found four texts of the page that claimed more than the product does (FR-1.102), and that made `host-v0.8.1` out of `host-v0.8.0`. Every proof was then run again on `v0.8.1`.

## 2. The manifest's counts (`manifest.md`, built by `scripts/release-manifest.ts`, no force)

- **PASS: 144** items. **9** of them are `earlier` (section 3).
- **NOT PROVEN: 9** items (section 4).
- **NOT YET DUE: 7** items (section 9).
- **Below PASS: 31 FRs**, because a release scenario that names them is not proven (each line of `manifest.md` names the scenario).

Every PASS has a green result of its kind on the candidate (`results.json`):

- two full CI runs, at `9af7051` and `a11669e`;
- `cli-matrix` on four platforms;
- 33 staging runs of the pass;
- `test:cloud` (14/14) and `test:consumers` (7/7);
- the six reviews and the claims walk;
- the owner's hour.

## 3. The `earlier` items: proven once, on an older release

Each was proven in a drill that needs a clean server or a calendar. The manifest names what changed in its area since, and the files on the candidate that cover the change. The full text is in `manifest.md`.

| Item    | Proven in                                               | What changed since                                                                                           | Covered on the candidate by                                     |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| AC-1.33 | the clean-host drill of Run 6.8 (`host-v0.6.1`, 18 Nov) | the restore code is unchanged and there is no new migration; the deploy's first opening, AppRole lockout off | `restore/full`, `fault/restore/interrupted`, `deploy.staging`   |
| AC-1.43 | the same drill                                          | the same                                                                                                     | `restore/full` (nine old credentials refused)                   |
| AC-1.44 | the same drill                                          | the same; audit-archive keys hold the incarnation                                                            | `restore/full`, `fault/restore/interrupted`, the cloud files    |
| PO-22   | the same drill                                          | the same                                                                                                     | `restore/full`, `fault/restore/interrupted`                     |
| KMS-L1  | the same drill                                          | `host.ts` gives production its KMS and OpenBao                                                               | `key-loss.staging`, the `host.ts` unit tests                    |
| DB-G1   | the same drill                                          | no new migration; queries of Session 7's read routes only                                                    | `restore/full`, `database/privileges`                           |
| PO-9    | R2 lock ageing under D-04, Run 6.6 (17 Nov)             | the retention code has no commit; `pair.ts` changed 2 lines                                                  | `fixture.cloud`, `cleanup.cloud`                                |
| R2-L1   | the same                                                | the same                                                                                                     | `fixture.cloud`, `cleanup.cloud` (refusal, expiry, bulk errors) |
| COST-B1 | the cost sheet, Run 6.6                                 | the pair format and its operations are unchanged; there is no invoice figure yet                             | `backup.staging`, `cleanup.cloud`                               |

## 4. NOT PROVEN on the candidate

| Item                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1.18, AC-1.40, AC-1.57, PO-18 | **The staging drill of an issuance left unknown was red on `host-v0.8.1`.** 20 attempts in two runs caught no issuance after its marker. The pause of OpenBao reaches the host over SSH 2.5 to 3.4 s after it is sent, and the window it must hit is one OpenBao call. The same fault, placed exactly, is proven on CI (`tests/fault/credentials/issuance.test.ts`). All their other files are green on the candidate. Re-aiming the drill is Session 9's work. |
| AC-1.25                          | The stopped checker (`probe-watch`) is proven by a unit test and by a hand run in Run 6.4. No file runs the real watcher against a stopped probe.                                                                                                                                                                                                                                                                                                               |
| AC-1.26                          | "A revoked certificate prevents unseal" ran once, in Run 2.7. The expired certificate is checkpoint `kms-cert-expiry`, due from 12 Dec 2026.                                                                                                                                                                                                                                                                                                                    |
| AC-1.36                          | "Destruction of the referenced KMS key is refused" has no test. Only "the seal certificate cannot create a key" is proven.                                                                                                                                                                                                                                                                                                                                      |
| AC-1.52                          | The owner's hour started from an operator reset of the existing staging owner. Install, deploy and bootstrap are proven by the agent's files, not done by the owner.                                                                                                                                                                                                                                                                                            |
| AC-1.55                          | "Delayed events" (a row committed late into a day already counted) are not simulated for the summary.                                                                                                                                                                                                                                                                                                                                                           |

So **FR-1.101** (the release proof, through AC-1.57), **FR-1.97** (through AC-1.52) and **FR-1.102** (through AC-1.55) are not PASS. Section 11 states what signing means with these open.

## 5. The amendments

- **D-03:** AC-1.42 is the synthetic consumer rehearsal. It is PASS (`test:consumers` 7/7, `cli.staging`, the credentials journey, `token-sweep`).
- **D-04:** R2 lock ageing is proven with a short-lock fixture (PO-9, R2-L1, earlier). The real 30-day rule on staging is checkpoint `pair-30-day`, due from 17 Dec 2026.
- **D-05:** the stage exit (Gate F) is decided on Day 14. The 28-day field observation continues as watch item W-2.
- **D-06:** the independent reviewer is a fresh-context agent plus the owner's signature. There were six reviews (`review-1` to `review-6`) and one re-read of the fixes (`review-fixes.md`).

## 6. Accepted findings

- **M1, the resting root token (D-65).** Reviewer 3 rated it **Medium** (R3-1) and said it does not block real, non-critical secrets. The init answer, holding a root token that never expires and the one recovery share, rests in custody on the host, on the workstation and in the password manager. The reviewer's smallest change (a dated root token, and the recovery share out of the workstation's file) is carried to Stage 2.
- **The carried findings (D-66).** Each accepted item has a line in `known-limits.md`:
  - Session 6's C, D, E and I;
  - `reconcile-credentials --all`;
  - `credential_expiring` under 7 days;
  - the probabilistic staging drill;
  - Session 7's 1–4, 7, 9 and 12.

## 7. Every open Medium of the reviews, in its reviewer's words

Each is accepted, with a line in `known-limits.md`. The restore items are carried to Session 9 because the restore code stays as it was proven (P-150).

- **R2-1.** "The intent fingerprint stored in `app.operation.fingerprint` is an HMAC over the whole validated body. For `secrets.create`, `secrets.update` and every import child, that body includes the secret value. So PostgreSQL holds a keyed digest of every written value for the 30-day replay window, and in every database dump and pair taken in that window."
- **R3-1.** "The init answer holds the init root token, which never expires, together with the single recovery share (threshold 1). … It is used routinely by deploy, gate open, `ops` and reconcile, not only for break-glass."
- **R3-2.** "The issuer identity lives in the API process. It can mint 30-day orphan tokens from any `machine-env-*` role, including those of archived, in-review or pending environments … The runbook's line 'archived is a promise that no token of the scope works' therefore holds only for tokens that are recorded."
- **R4-2.** "After a completed restore no root token exists for the restored OpenBao. … No runbook says to run `generate-root` with the source's recovery key or to update the custody copy."
- **R4-3.** "A host restore that stops after step 4 cannot be run again, although `restore.md` says it can." (`restore.md` is corrected.)
- **R4-4.** "The step-1 refusal ('gate is open', 'holds organizations') is skipped whenever `restore-state.json` names the same pair, whatever step it records."
- **R4-5.** "Nothing measures whether the seal key is usable while OpenBao runs. `kmsReachable` is only a TLS handshake. Pair verification never checks the key's state."
- **R4-10.** "Restoring a host onto its own reinstalled server (production onto production, the main disaster case) does not work by the runbook. The two init answers share one custody path."
- **R6-1.** "Every ops job container runs on the host network, so it gets all of the host's egress." (The three statements that said otherwise are corrected.)

No Critical or High finding is open.

## 8. Exceptions, and what the sweep cannot see

- **`.trivyignore.images`:** 53 reviewed upstream CVEs, with no fix possible in this repository. All of them **expire on 14 Dec 2026**, and the image scan turns red then.
- **The canary sweep** passed on the candidate: 18 surfaces, 0 needles found, every control found. It cannot see:
  - TOTP codes on the host;
  - the page's memory and its query cache;
  - the inside of the encrypted snapshot;
  - the text of a delivered alert;
  - an agent's transcript.

## 9. Not yet due (Gate F, Session 9)

| Item                               | Owner                  | Closing condition                                                                                   |
| ---------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| AC-1.53, AC-1.54, FR-1.98, FR-1.99 | the agent, Run 9.3–9.4 | the external test agent's instruction request, and its denial and leakage tests on staging canaries |
| AC-1.58, FR-1.100                  | the owner              | the first consumer in real use after this signature; 28-day observation W-2 (D-05)                  |
| AC-1.59                            | the owner              | the final evidence report reviewed at Gate F (Day 14)                                               |

## 10. Production, and the dated items

- **Production now:**
  - `host-v0.8.1`, **closed**;
  - its own OpenBao, unsealed by `mykey-prod-seal-1` in its own KMS domain (the seal policy refuses create);
  - backup timers installed, and its first pair eligible;
  - in the probe with nothing open;
  - **no account, no organization, no data.**

  Valve 1 (production without OpenBao) was not taken. It opens only by the path in `production.md` (Run 9.1): bootstrap in the owner's terminal, enrolment, `provision-organization`, the owner's journey, then `deploy --owner-confirmed`.

- **The dated items:**
  - **12 Dec 2026:** staging's KMS certificates expire (`kms-and-unseal.md`).
  - **14 Dec 2026:** `.trivyignore.images` expires.
  - **17 Dec 2026, 19:00 UTC:** checkpoint `pair-30-day` is due, before the retention run of 18 Dec, 05:00.
  - **21 Dec 2026, 07:48 UTC:** production's seal certificate `prod-seal-1` expires. Replace it before then, by `production.md`.

## 11. The authorization

I authorize controlled use of MyKey Private `host-v0.8.1` with `cli-v0.1.2`: real, non-critical secrets, on production, for one declared first consumer, from Run 9.1. I sign knowing the four limits it carries:

- the items of section 4 are not proven on this candidate, among them the staging drill of an unknown issuance, whose fault is proven on CI only;
- the accepted findings of sections 6 and 7;
- the exceptions of section 8, which expire on 14 Dec 2026;
- the dated items of section 10.

---

Signature: the owner writes **"approved"** (recorded with its date in `owner-requests.md` and D-67), or signs by a commit of their own.
