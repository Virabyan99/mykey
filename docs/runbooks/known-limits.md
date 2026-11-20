# Known limits — what the service does not do

FR-1.75 (P-130). This is an honest list: each line names what the service does not do, and where that was measured or decided. A limit leaves this list only when a later session changes the behaviour and its run note says so.

## Requests and errors

- **A response made by the proxy carries no request id.** A 502 or a TLS refusal from the edge has no id the API logged (P-109, Run 6.1).
- **Refusals that cannot be attributed are log lines, not audit rows.** An unauthenticated or unparseable request has no actor and no organization (Run 6.1, `audit.md`).
- **One source with 30 unknown machine tokens a minute blocks itself.** Valid tokens from that source are refused too, for the rest of that minute (Run 6.3, `limits.md`).
- **A complete read holds a per-credential read lock**, and a write in the same environment can answer `busy` meanwhile. Locally, the worst write needed all three attempts (6.4 s); staging reads 7 MB in up to 23.5 s, which can outlast a writer's attempts. `busy` is safe to repeat (Run 6.3, `run-6.3-starvation.json`).
- **Import is limited to 1 MiB, an environment to 8 MiB.** A large export cannot be imported again in one piece. The `@next/env` reader can lose a key in one case, and the export warns about it (Session 4).
- **Better Auth writes `expires_at` with the API's clock.** A session's expiry depends on the API host's time (Session 3; chrony is checked in `status`).

## The workspace

- **There is no QR code at enrolment.** The setup key is shown as text and as an `otpauth://` address (P-135; the owner is asked in Run 8.8).
- **A closed host answers JSON, not a page.** With the gate closed, the workspace's own address answers `quarantined` like every other path (D-59).
- **The clipboard and a saved export are outside the product.** A copied value and an exported file stay where the owner put them; the page says so at the copy (D-60).
- **Clearing the page's state is not erasing memory.** The browser may keep freed text until it reuses the space (FR-1.22).
- **After a reset of the authenticator, a reload loses the hand-over to enrolment.** A new reset link is needed (Run 7.2).
- **The script is about 875 kB, 216 kB compressed.** It is one file with no splitting (Run 7.9).
- **The history does not say which version a restore copied.** The server keeps the source with the operation, not in `secrets.history` (Run 7.5).
- **An import that waits for its file shows no progress per entry**, and only the member who started it can resume it (Run 7.6).
- **An exported file is held for 30 seconds before it must be saved.** Waiting longer means a second export and a second audit row (Run 7.6).
- **The page names runbooks by their path.** It serves no document: the owner reads them in the repository (Run 7.6).
- **The summary counts the audit rows the database still holds.** After the purge, older days read "not measured"; the archive is not read (D-61).
- **The analytics are tables.** There is no chart (D-62).
- **On a narrow screen a wide table moves inside its own frame.** Rows are not stacked (Run 7.9).
- **Contrast was not measured, and no accessibility standard is claimed.** Keyboard use, labels, focus and a 360-pixel screen were tested in Chromium only (Run 7.9).
- **The CLI's error line has no next step and no operation id.** The page's text for the same code is the fuller one (Run 7.9).
- **The script is downloaded again at every page load.** The page and its files are sent with `no-store` (Session 7 gate).
- **A `HEAD` request for the page answers 404.** Only `GET` is served; a checker that uses `HEAD` sees the page as missing (Session 7 gate).
- **The browser's own history may keep a pasted reset link.** The page removes the token from the address at once, but what the browser recorded at the paste is the browser's. The token works once, for 15 minutes (Session 7 gate).
- **Some things the page holds are not on the 30-second rule.** The bytes of a previewed import file stay until the import ends or the page is left; a value typed into an open form stays while the form is open; an export that arrives while the tab is hidden is held for its 30 seconds (review of the Session 7 gate, for Session 8).
- **After "the outcome is not known" the form's button is still there.** The page says not to enter the change a second time; the server answers a repeated request and does not do it twice (Session 7 gate, for Session 8).

## Alerts and the probe

- **A certificate that lives 60 days or less alerts at a third of its life.** A 30-day KMS certificate alerts 10 days before it ends, not 30 (D-50).
- **The watcher of the probe can be late, and it can stop.** `probe-watch.yml` is a scheduled GitHub workflow: GitHub may delay it, and it disables scheduled workflows after 60 days without repository activity (Run 6.4).
- **A host that is not in the probe is not watched.** The drill host was never in it (Run 6.8).
- **An edge outage of more than three minutes raises two alerts.** The host reads its public certificate as the edge serves it; with the edge down that check is unknown, so `checks_unknown` opens beside `health_failing` (Session 7 gate).
- **A host without OpenBao has `checks_unknown` open.** Production reports it until its OpenBao exists: the seal, the KMS and the capacity record cannot be read there (Session 7 gate).

## Backups

- **A pair has a size limit.** The frozen artifacts must fit the 1 GiB tmpfs, and the bundle is read back whole. A database or OpenBao store larger than that fails the capture (`backup.md`).
- **A capture refuses writes for its frozen seconds every night.** Measured on staging: 2.8 s median, 3.7 s worst, 9.0 s once with writes in flight. Writes answer `503 busy`; reads continue (Run 6.5).
- **An access-reducing action during a capture costs that night's pair.** A revocation or removal while capturing makes the pair `ineligible` (`access_reduction`); the next night takes a new one (Run 6.5).
- **The audit archive is locked.** Staging's for 30 days, production's for 365. A segment cannot be deleted before then, even by the owner (Run 6.2).
- **Pairs need a bucket of their own host.** `mykey-<host>-pairs`: a temporary host (the drill) takes no pair (Run 6.8).

## Restore

- **A restore needs the custody set and the same KMS key:**
  - the source's backup password and OpenBao init answer;
  - the trust anchor;
  - a KMS certificate under the source's domain.

  Without the seal key there is no restore at all (Run 2.7, D-56, `custody-map.md`).

- **A restore resets everyone.** Every account returns to `recovery_pending` and every machine token is revoked: every person needs an operator reset, and every consumer needs a new token (D-55).
- **A restore takes about 42 minutes of work on staging's data**, of which `reconcile-credentials` is 27 minutes. It runs once per environment, about 19 s each (84 environments). An `--all` form is for Session 8 (Run 6.8, `drill.json`).
- **The restored data is P's, faults included.** Staging's pairs hold 16 member-less spike organizations of Session 2 with no OpenBao namespace. A restore's catalog check refuses them until they are marked for review (Run 6.8).
- **A rollback is a redeploy on the same schema, or a restore.** It is never a downgrade of the schema (D-57).

## Operations

- **The drill borrowed production's empty server.** From the day production holds data, a drill needs a temporary server (OWN-5) (D-56).
- **The ops image knows two host names**, `staging` and `prod`. On a third host every job fails closed (Run 6.8).
- **The deploy reads OpenBao with the custody root token.** Once that token is revoked (M1), a deploy cannot fill `openbao_readable` or `incarnation_three_places` until another namespace-listing identity exists (Run 6.9).
- **An issuance left `needs_review` has no stored accessor.** Settling it needs the token sweep or `--executors-excluded` (Session 5).
- **One operator, one workstation.** Custody copies, release builds and every host command live on the owner's workstation. Its loss is covered only by the owner's offline copies (OWN-4).
