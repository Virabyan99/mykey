# Known limits — what the service does not do

FR-1.75 (P-130). This is an honest list: each line names what the service does not do, and where that was measured or decided. A limit leaves this list only when a later session changes the behaviour and its run note says so. The lines marked "Gate R" are the open Medium findings of Session 8's review, which the owner signs.

## Requests and errors

- **A response made by the proxy carries no request id.** A 502 or a TLS refusal from the edge has no id the API logged (P-109, Run 6.1).
- **Refusals that cannot be attributed are log lines, not audit rows.** An unauthenticated or unparseable request has no actor and no organization (Run 6.1, `audit.md`).
- **One source with 30 unknown machine tokens a minute blocks itself.** Valid tokens from that source are refused too, for the rest of that minute (Run 6.3, `limits.md`).
- **A complete read holds a per-credential read lock**, and a write in the same environment can answer `busy` meanwhile. Locally, the worst write needed all three attempts (6.4 s); staging reads 7 MB in up to 23.5 s, which can outlast a writer's attempts. That `busy` is not stored and is safe to repeat (Run 6.3, `run-6.3-starvation.json`).
- **Some refusals are kept under the request's key.** A change refused at its dispatch step (`quarantined`, `audit_unavailable`, `dependency_unavailable`) is stored as `rejected`: the same request sent again with the same idempotency key gets the same answer for 30 days. The workspace keeps the key until the form changes; a new action gets a new key (Run 8.5, R2-5).
- **A written value leaves a keyed digest in the database.** The replay fingerprint of a create, an update or an import entry is an HMAC over the request body, value included. It is kept for 30 days, and an `uncertain` operation keeps it until it is resolved. Its key ring is never in the database or in a pair; whoever holds both can test guesses of a short value without asking OpenBao (Run 8.5, R2-1; Gate R).
- **Two values that differ only in Unicode normal form count as one request.** Sent again under the same idempotency key, the second gets the first's answer instead of `409` (Run 8.5, R2-6).
- **A 503 from OpenBao after a change was sent counts as a refusal.** OpenBao answers 503 when it is sealed. If it sealed after applying the change, the operation says `rejected`; the next writer's check then finds the version moved and sends the key to review (Run 8.5, R2-3).
- **A review mark can be written without its audit row.** When OpenBao refuses a read and the audit table fails at the same moment, the key or environment is marked for review and the caller is told `audit_unavailable` (Run 8.5, R2-4).
- **Two answers say less than happened.** An archive that fails midway answers `503 dependency_unavailable` with its operation id, although revocations may have gone out; the archive tick finishes it. An answer that fails its own schema check answers 503 without an operation id, although the change was made (Run 8.5, R2-10, R3-7).
- **Import is limited to 1 MiB, an environment to 8 MiB.** A large export cannot be imported again in one piece. The `@next/env` reader can lose a key in one case, and the export warns about it (Session 4).
- **Better Auth writes `expires_at` with the API's clock.** A session's expiry depends on the API host's time (Session 3; chrony is checked in `status`).
- **The verification listener has limits of its own.** Its in-flight and large-body slots are separate from the public listener's, so while it serves (a deploy or a restore) the per-process limits are doubled (Session 6 finding E, accepted in D-66).

## Sign-in and accounts

- **Anyone who knows an address can keep its owner from signing in.** Five wrong passwords every 15 minutes, from any sources, keep the account locked; an operator reset clears the lock only until the next five (Run 8.5, R1-5).
- **Sign-in time is not made equal.** A wrong password for a known address does 1–3 ms more work than for an unknown one. The answers are identical; the timing was not measured (Run 8.5, R1-4).
- **"Revoke all" can miss a second factor completed at that moment.** Someone who holds the password and a current code, and completes the second factor while the owner revokes, keeps the session that step made. A password change ends it (Run 8.5, R1-3).

## The workspace

- **There is no QR code at enrolment.** The setup key is shown as text and as an `otpauth://` address (P-135; the owner is asked in Run 8.8).
- **A closed host answers JSON, not a page.** With the gate closed, the workspace's own address answers `quarantined` like every other path (D-59).
- **The clipboard and a saved export are outside the product.** A copied value and an exported file stay where the owner put them; the page says so at the copy (D-60).
- **Clearing the page's state is not erasing memory.** The browser may keep freed text until it reuses the space (FR-1.22).
- **No scan sees what the page holds in memory or in its query cache.** The rule that no secret goes through the query cache is kept by a search of the source, which a wrapper function could pass (Session 7 finding 12, accepted in D-66).
- **After a reset of the authenticator, a reload loses the hand-over to enrolment.** A new reset link is needed (Run 7.2).
- **The script is about 875 kB, 216 kB compressed.** It is one file with no splitting (Run 7.9).
- **The history does not say which version a restore copied.** The server keeps the source with the operation, not in `secrets.history` (Run 7.5).
- **An import that waits for its file shows no progress per entry**, and only the member who started it can resume it (Run 7.6).
- **An exported file is held for 30 seconds before it must be saved.** Waiting longer means a second export and a second audit row (Run 7.6).
- **The page names runbooks by their path.** It serves no document but this list, which the Help screen shows: the owner reads the other runbooks in the repository (Run 7.6, Run 8.0).
- **The summary counts the audit rows the database still holds.** After the purge, older days read "not measured"; the archive is not read (D-61).
- **The analytics are tables.** There is no chart (D-62).
- **On a narrow screen a wide table moves inside its own frame.** Rows are not stacked (Run 7.9).
- **Contrast was not measured, and no accessibility standard is claimed.** Keyboard use, labels, focus and a 360-pixel screen were tested in Chromium only (Run 7.9).
- **The CLI's error line has no next step and no operation id.** The page's text for the same code is the fuller one (Run 7.9).
- **The script is downloaded again at every page load.** The page and its files are sent with `no-store` (Session 7 gate; accepted in D-66).
- **A `HEAD` request for the page answers 404.** Only `GET` is served; a checker that uses `HEAD` sees the page as missing (Session 7 gate; accepted in D-66).
- **The browser's own history may keep a pasted reset link.** The page removes the token from the address at once, but what the browser recorded at the paste is the browser's. The token works once, for 15 minutes (Session 7 gate).
- **Some things the page holds are not on the 30-second rule.** The bytes of a previewed import file stay until the import ends or the page is left; a value typed into an open form stays while the form is open; an export that arrives while the tab is hidden is held for its 30 seconds, and its download address lives 10 seconds after Save; a captured reset token has no time limit when the session read fails (review of the Session 7 gate; accepted in D-66).

## Machine tokens and the CLI

- **A taken-over API process can make tokens that outlive an archive.** The issuer identity can create 30-day tokens for any environment of its organization, archived ones included, and nothing alerts. Only `reconcile-credentials`, one environment at a time, finds them (Run 8.5, R3-2; Gate R).
- **An issuance whose outcome is unknown can leave a live token that nobody holds.** When the finalize fails after the token was made, or a late executor makes it after the sweep, the credential is `needs_review` without its accessor. The token lives until `reconcile-credentials` finds it by its operation id (Session 5; Run 8.5, R2-7, R3-3).
- **A revocation that OpenBao refused is not sent again by itself.** The credential stays `revoking`: the product refuses the token, OpenBao still accepts it, and no alert opens. Revoke again once OpenBao answers, or run `reconcile-credentials` (Run 8.5, R3-6).
- **"Revoked" rests on any 400 from OpenBao's lookup.** The answer's text is not checked (Run 8.5, R2-9).
- **A machine token can ask OpenBao for wrapped reads.** A wrapped copy of a value it may read outlives the token's revocation, up to OpenBao's maximum (Run 8.5, R3-4).
- **Older versions stay readable in OpenBao.** A machine token used against OpenBao directly can read its environment's older versions, also of a secret the product shows as deleted: a delete marks only the current version (FR-1.45; Run 8.5, R3-5).
- **The application can read the token from the CLI.** `secrets run` keeps the token out of the child's environment, but the CLI's own environment holds it while the child runs, and any process of the same user, the application included, can read it there (Run 8.5, R5-6).
- **`secrets run` does not pass SIGUSR1 on.** The launcher turns off Node's SIGUSR1 debugger, and Node then keeps that signal blocked: signal the application itself. SIGUSR2 is passed on (Run 8.6, R5-3).
- **A signal can reach the child twice, or not at all.** Without a terminal, a signal to the whole process group (systemd's stop, `timeout`) reaches the child from the sender and again from the CLI. With a terminal on stdin, `kill -INT` of the CLI alone is not passed on (Run 8.5, R5-5).
- **The installer checks the download against sums from the same release.** The sums are also written in the repository's reports, which the runbooks name; the launch wrapper is fetched by its tag and has no sum (Run 8.5, R5-7).
- **An export trusts the directories above its own.** One that another user can write, without the sticky bit, can be swapped while the export runs (Run 8.5, R5-8).
- **`secrets run` checks values less than `export` does.** A value that `export` refuses as ill-formed text can still start a child (Run 8.5, R5-9).
- **A secret can be named like a loader setting.** `LD_PRELOAD`, `NODE_OPTIONS` or `PYTHONPATH` as a secret's name reach the child, so whoever may write secrets can steer how it starts (Run 8.5, R5-10).

## Alerts and the probe

- **A certificate that lives 60 days or less alerts at a third of its life.** A 30-day KMS certificate alerts 10 days before it ends, not 30 (D-50).
- **The watcher of the probe can be late, and it can stop.** `probe-watch.yml` is a scheduled GitHub workflow: GitHub may delay it, and it disables scheduled workflows after 60 days without repository activity (Run 6.4).
- **A host that is not in the probe is not watched.** The drill host was never in it (Run 6.8).
- **An edge outage of more than three minutes raises two alerts.** The host reads its public certificate as the edge serves it; with the edge down that check is unknown, so `checks_unknown` opens beside `health_failing` (Session 7 gate).
- **A host without OpenBao has `checks_unknown` open.** Production reports it until its OpenBao exists: the seal, the KMS and the capacity record cannot be read there (Session 7 gate).
- **A machine credential issued for less than 7 days counts as expiring from its first minute.** `credential_expiring` warns early for it, which is the safe side (Session 6, accepted in D-66).
- **A lost seal key is not measured while OpenBao runs.** The KMS check is a TLS handshake. A deactivated or destroyed key is first seen at the next unseal or restore, while each night's pair keeps becoming eligible (Run 8.5, R4-5; Gate R).
- **The backup check reads the newest eligible pair in the database, whatever its host.** On a restored host the source's pairs count until the host has its own (Run 8.5, R4-15).
- **No image scan runs between pull requests.** A new vulnerability in a deployed image is seen at the next ready pull request or gate (Run 8.5, R6-9).

## Backups

- **A pair has a size limit.** The frozen artifacts must fit the 1 GiB tmpfs, and the bundle is read back whole. A database or OpenBao store larger than that fails the capture (`backup.md`).
- **A capture refuses writes for its frozen seconds every night.** Measured on staging: 2.8 s median, 3.7 s worst, 9.0 s once with writes in flight. Writes answer `503 busy`; reads continue (Run 6.5).
- **The 120-second freeze is the backup script's own limit.** A slow `pg_dump` or an OpenBao that hangs can keep writes refused for up to about 5 minutes; the alert opens at 10 (Run 8.5, R4-6).
- **An access-reducing action during a capture costs that night's pair.** A sign-out, the revocation of a session or a credential, or an archive while capturing makes the pair `ineligible` (`access_reduction`); the next night takes a new one (Run 6.5).
- **The audit archive is locked.** Staging's for 30 days, production's for 365. A segment cannot be deleted before then, even by the owner (Run 6.2).
- **Pairs need a bucket of their own host.** `mykey-<host>-pairs`: a temporary host (the drill) takes no pair (Run 6.8).
- **A pair can miss an access reduction that began just before its capture.** The capture records the reducing transaction's start time, so one that started before `capturing` committed can go unseen and the pair stays eligible. A restore resets every account and revokes every token anyway (D-55), and members are confirmed by count (Session 6 finding C, accepted in D-66).
- **During a capture's drain one long writer stalls the API's writes.** The coordinator's mode change has no lock timeout, so it waits for that writer and every write behind it waits too, for as long as that one writer runs. The capture runs once a night, at 03:00 UTC (Session 6 finding I, accepted in D-66).
- **The backup job passes the database superuser's password in a process environment.** Root can read it there while the job runs; it reaches no journal and no file (Run 8.5, R4-9).

## Restore

- **A restore needs the custody set and the same KMS key:**
  - the source's backup password and OpenBao init answer;
  - the trust anchor;
  - a KMS certificate under the source's domain.

  Without the seal key there is no restore at all (Run 2.7, D-56, `custody-map.md`).

- **A restore resets everyone.** Every account returns to `recovery_pending` and every machine token is revoked: every person needs an operator reset of kind `mfa`, and every consumer needs a new token (D-55, Run 8.6).
- **After a restore no root token is left.** The restore revokes the source's, and `--open` revokes its own. Until one is made with the source's recovery key, `host.ts <host> ops`, a deploy and a restore of the host's own later pairs cannot use OpenBao (Run 8.5, R4-2; Gate R; carried to Session 9).
- **A deploy could open a restored host with the deploy's checks alone.** Only the standalone `gate open` refuses a restore's record; today the dead root token stops such a deploy first (Run 8.5, R4-7; carried with R4-2).
- **An interrupted restore can be run again only before its OpenBao step.** After that step the target's root token is gone, and a rerun needs OpenBao wiped and initialised again (Run 8.5, R4-3; Gate R; carried to Session 9).
- **A finished restore's state file can stay behind.** If `--open` stops after opening the gate, `restore-state.json` stays, and a later restore of the same pair skips its refusal of a serving host: check that the file is gone after `--open` (Run 8.5, R4-4; Gate R; carried to Session 9).
- **A host cannot be restored onto its own reinstalled server by the runbook.** The new server's init answer and the lost host's share one custody path, and `bao-init` refuses to overwrite it (Run 8.5, R4-10; Gate R; carried to Session 9).
- **A restore onto another name installs the source's backup password.** The target's later pairs use it while its custody copy keeps the old one, so those pairs cannot be restored from custody (Run 8.5, R4-13; carried with R4-2).
- **The target's timers run during a restore.** The nightly backup and the five-minute sweep can act on the restored data before `--open` (Run 8.5, R4-14; carried with R4-2).
- **`restore-verify --journey` is not refused on production.** It would write the owner's new password and authenticator seed to the workstation; `restore.md` forbids it in words only (Run 8.5, R4-8).
- **A report can open the gate again within its 30 minutes.** It is not bound to the gate's epoch: after a close, the same report reopens without a new journey (Run 8.5, R4-11).
- **A restore takes about 42 minutes of work on staging's data**, of which `reconcile-credentials` is 27 minutes. It runs once per environment, about 19 s each (84 environments). There is no `--all` form: the restore code stays as Run 6.8's drill proved it (Run 6.8, `drill.json`; accepted in D-66, measured again by Run 9.7's drill).
- **The restored data is P's, faults included.** Staging's pairs hold 16 member-less spike organizations of Session 2 with no OpenBao namespace. A restore's catalog check refuses them until they are marked for review (Run 6.8).
- **A restore accepts any signed pair.** One past its `eligibleUntil`, or one published before a commit that then failed, is restored if its signature holds. With `--pair` the operator chooses it; with `--newest` the bucket's newest signed pair is taken, whatever the database says (Session 6 finding D, accepted in D-66).
- **A rollback is a redeploy on the same schema, or a restore.** It is never a downgrade of the schema (D-57).

## Operations

- **The drill borrowed production's empty server.** From the day production holds data, a drill needs a temporary server (OWN-5) (D-56).
- **The ops image knows two host names**, `staging` and `prod`. On a third host every job fails closed (Run 6.8).
- **The deploy reads OpenBao with the custody root token.** Once that token is revoked (M1) or made useless by a restore (R4-2), a deploy cannot fill `openbao_readable` or `incarnation_three_places` until another namespace-listing identity exists (Run 6.9).
- **The custody root token never expires.** It rests in `openbao-init.json` beside the single recovery share; whoever reads that file and reaches OpenBao is root in every namespace (D-65; Run 8.5, R3-1; Gate R).
- **One operator, one workstation.** Custody copies, release builds and every host command live on the owner's workstation. Its loss is covered only by the owner's offline copies (OWN-4).
- **Two workers may repeat a change, by design.** The provisioner retries an unclear OpenBao answer and takes over an operation whose heartbeat is 60 s old, and the archive tick drives an archive again; each compares before it acts (D-32, D-35, D-41; Run 8.5, R2-2).
- **A provisioner that lost its claim can still close the operation.** Its end step does not check the claim, so with two provisioners at once (a host runs one) a stale one could mark a finished environment for review (Run 8.5, R2-8).
- **"No effect" after `--executors-excluded yes` is the operator's word.** The command does not check that `quiesce` or an OpenBao restart happened after the dispatch (Run 8.5, R2-11; `reconciliation.md`).
- **The staging credential drill places its fault by chance.** It catches an issuance in flight only sometimes and tries up to ten times; `tests/fault/credentials/issuance.test.ts` places the same fault exactly (Session 6, accepted in D-66).

## The hosts and the network

- **Ops jobs run on the host's network.** Each job's container reaches what the host reaches: the metadata service, the resolver, OpenBao, the API's verification port and the R2, probe and KMS addresses. The `pair` job holds the backup signing key and the R2 credentials (Run 8.5, R6-1; Gate R).
- **Egress is allowed by address, not by name.** The R2, probe, ACME and KMS sets are lists of addresses; anything served from those addresses is reachable (D-21).
- **The edge and OpenBao may ask the provider's resolver for any name.** That is an outbound channel through DNS (Run 8.5, R6-3).
- **The edge's access log holds page paths, so secret names.** It is kept by journald, outside the audit's retention and archive (Run 8.5, reviewer 6).
- **The verification listener answers on every network of the API**, not only at the tunnel's address (Run 8.5, R6-2).
- **The firewall fails open at boot.** Docker does not wait for the firewall's table; if the table fails to load, the stack starts without it until `firewall_unloaded` opens after three minutes (Run 8.5, R6-4).
- **The DHCP rule admits any source that uses port 67** (Run 8.5, R6-5).
- **Every container on the database network may try any role over TCP**, the superuser included. The passwords are random and live only on the host (Run 8.5, R6-7).
- **OpenBao sees the whole KMS directory**, not only the current seal key (Run 8.5, R6-8).
- **The backup AppRole is bound to no address**, and its secret id never expires (Run 8.5, R6-11).
- **Host packages are not pinned and update themselves**, Docker and nftables among them. The firewall's design was measured on Docker 29.1.3 (D-21; Run 8.5, R6-10).
