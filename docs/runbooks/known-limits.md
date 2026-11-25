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
- **A success near a window's edge can shorten a counted failure's life.** A successful attempt gives its count back to the newest window, which may not be the one it was counted in; a failure then expires up to 15 minutes early (fixes review F-2, Run 8.6).
- **After a restore, a password reset is refused only while the restore's audit row is kept.** The refusal compares the authenticator's age with the restore's `operator.restore_begin` row, which the audit purge removes after 365 days, and the two times come from two hosts' clocks (fixes review F-7, Run 8.6).
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
- **The token step needs `bash`, and a paste before its prompt goes to the shell.** The one command (`consumer-local.md` §8) runs in `bash` whatever the shell is. A token pasted before `Paste the token, then press Enter:` is on the screen, or a command that failed to start, reaches the shell, its history and the screen (Run 10.1, which replaced Run 9.2's three blocks, F-9.2-1).
- **The token step waits one second after the token for more lines.** A paste of several lines is swallowed and refused, but a line that arrives later than a second after the one before is not swallowed: it reaches the shell (Run 10.1).
- **Until `host-v0.9.2`, the names-only command printed the later lines of a multi-line value.** Cutting `env`'s lines at `=` prints a line that holds no `=` whole; the command now asks `awk` for the names (Run 10.1, F-10.0-1). A terminal of an earlier start may hold such lines.
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
- **A revoked runtime credential's last token still reads in OpenBao for up to 15 minutes.** The product refuses the credential and every token it was exchanged for at once. OpenBao keeps accepting such a token until it expires: no accessor is stored, so none is revoked. Measured with 899 of 900 seconds left; OpenBao is reachable only from the host's private network (Run 11.3, D-81).
- **Whoever can write the database can bring a revoked or expired runtime credential back.** A runtime credential's state and times are columns of PostgreSQL alone. With its client secret in hand, a writer of the database can exchange it again, for its own environment and from its own networks only: the verifier covers both, and a moved row is refused. A revoked 30-day token cannot come back this way, because OpenBao has revoked it (Run 11.3, D-81).
- **The API sees every client secret that is presented to it.** After a suspected takeover of the API process, issue every runtime credential again: one that was kept works until it is revoked, for up to a year (Run 11.3, D-81).
- **Instances of one environment that start in the same second are admitted about two every 1.6 s.** Complete reads of one environment wait out a read cool-down (D-49), and while they wait they hold the API process's two large-request slots, so reads of other environments are answered `busy` too. Measured locally with ten instances (Run 11.3, D-83): the CLI from `0.2.0` asks ten times over 13.75 s and all ten start, the slowest after 10 s; `cli-v0.1.2` asks five times over 3.75 s, and two of the ten exited 75 for their supervisor to start again. A larger fleet needs a supervisor that restarts, or staggered starts.
- **Give each server its own runtime credential.** One credential allows 10 exchanges a minute, and the CLI asks for an exchange once. Of replicas that share a credential and start in the same minute, the eleventh exits 75 for its supervisor to start it again. They would also share one revocation and one line of the inventory (Runs 11.3 and 11.4, D-83).
- **A lost answer of an exchange leaves a token nobody holds, for at most 15 minutes.** When OpenBao's answer to the request that makes the token is lost, the exchange answers `503` and the caller exchanges again. Nothing is blocked and nothing goes to review. The token that may have been made ends by itself (Run 11.3, D-81).
- **A bound network is compared with the address the edge reports.** A credential bound to an IPv4 network refuses the same caller over IPv6, and a caller behind a NAT is its NAT's address. A runtime credential with no network works from anywhere (D-81, D-82).
- **A dead credential is refused as a miss of its source.** A runtime credential, a token of an exchange, a 30-day token or an automation credential that is revoked, expired or presented from outside its networks counts against the 30 misses a minute of its source address, as a secret nobody can attribute does. From the 31st, that source is answered `429` before the database is read and no audit row is written. Valid credentials of the same source are refused too, until the window ends. The rule bounds one source: a dead secret sent from many addresses still writes up to 30 `access.denied` rows a minute for each of them (review M1, Run 11.8).
- **`machine.metadata` writes no audit row.** It answers every live name of the environment with its version and its two times, never a value, from PostgreSQL alone, as a person's list of names does. `machine.keys` writes a row for the same names. So the holder of a token can read the names without a record. A refusal is audited on both routes (Run 11.3; review L4).
- **An IPv4-mapped IPv6 network is accepted at issue and was never tried.** A network such as `::ffff:10.0.0.0/104` is stored as an IPv6 network, while a caller's mapped address is compared in its IPv4 form. At worst such a credential never works. Write an IPv4 network in IPv4 form (review L6).
- **A request that reaches the API with more than one forwarded address is read as the edge's own address.** The API takes a caller's address from the edge only when the header holds exactly one. That is safe while the edge replaces a client's own header, which is Traefik's default and which no test here shows. If an edge ever added to the header instead, such a caller would read as the edge and match a credential bound to a network that holds the edge's address. Never bind a credential to a host's own container network (review L6).
- **`cli-v0.1.2` given a runtime credential exits 77.** It presents the client secret as a token, and the service refuses a token nobody can attribute (`401`). A runtime credential needs the CLI from `cli-v0.2.0`. This follows from those two rules: the released `0.1.2` itself was not run against one (D-81).
- **`secrets run` does not pass SIGUSR1 on.** The launcher turns off Node's SIGUSR1 debugger, and Node then keeps that signal blocked: signal the application itself. SIGUSR2 is passed on (Run 8.6, R5-3).
- **Only the launcher turns the debugger off.** Starting `secrets.mjs` with Node directly, not through `~/.local/bin/secrets`, leaves SIGUSR1 able to open Node's inspector while the CLI holds the token (fixes review F-9, Run 8.6).
- **A signal can reach the child twice, or not at all.** A signal to the whole process group (systemd's stop, `timeout`) reaches the child from the sender and again from the CLI: always for SIGTERM and SIGUSR2, and without a terminal for the others. With a terminal on stdin, `kill -INT` of the CLI alone is not passed on (Run 8.5, R5-5; fixes review F-11).
- **`secrets run` cannot give an application `NODE_EXTRA_CA_CERTS` or `OPENSSL_CONF`.** The CLI refuses them in its own environment, which is the child's: set them inside the command, `secrets run -- env NODE_EXTRA_CA_CERTS=… app` (D-68).
- **An export killed midway can leave a hidden file with every value.** The export writes `.<name>.<random>.part` beside the target and links it into place; a kill before the link, or between the link and the removal, leaves that file (mode 0600). If the removal fails after the link, the command exits 73 although the target is whole. A target name longer than about 236 bytes is refused (fixes review F-4, F-5, Run 8.6).
- **The size check needs `/usr/bin/getconf`.** Where it is missing (NixOS, Guix), the CLI assumes a 256 KiB limit and refuses a larger environment as `capacity` (fixes review F-6, Run 8.6).
- **The installer checks the download against sums from the same release.** The sums are also written in the repository's reports, which the runbooks name; the launch wrapper is fetched by its tag and has no sum (Run 8.5, R5-7).
- **An export trusts the directories above its own.** One that another user can write, without the sticky bit, can be swapped while the export runs (Run 8.5, R5-8).
- **`secrets run` checks values less than `export` does.** A value that `export` refuses as ill-formed text can still start a child (Run 8.5, R5-9).
- **A secret can be named like a loader setting.** `LD_PRELOAD`, `NODE_OPTIONS` or `PYTHONPATH` as a secret's name reach the child, so whoever may write secrets can steer how it starts (Run 8.5, R5-10).

## Automation credentials

- **An automation credential cannot change, delete or read a secret, and it manages only the projects its chain created.** It writes new names only: an existing name is `409 already_exists`. No route moves a project into a chain or out of one (D-80, D-82).
- **With the right to manage runtime credentials, the holder of an automation secret can read its chain's values in two steps.** It issues a runtime credential, exchanges it and reads the environment. The issuance is audited with the automation credential as its actor, the exchange is audited too, and the credential shows in the owner's inventory. The right is the owner's choice at issue (D-82).
- **Revoking an automation credential stops nothing it made.** Its projects, their secrets and every runtime credential it issued keep working. A server is stopped by revoking its runtime credential (D-82).
- **Whoever can write the database alone can move a project into a chain, and can undo a revocation or an expiry.** `managed_by`, the state and the times are columns that no key covers. A credential of that chain could then add environments, new names and runtime credentials to the moved project. The same writer cannot make a credential or widen one: the keyed digest covers the rights, the networks and the chain (D-82).
- **The API sees every automation secret that is presented to it.** After a suspected takeover of the API process, issue every automation credential again, with `replaces`, and revoke the old ones (D-82).
- **The workspace names a project's chain only to an owner or an admin,** and only among the first 100 automation credentials. Others see "Managed by automation" without a name (Run 11.6).
- **Nothing bounds what one automation credential makes except its 120 requests a minute.** A leaked secret with `projects.create`, or a script in a loop, can make up to 120 projects a minute, and a project cannot be deleted. With `runtime_credentials.manage` it can issue 120 runtime credentials a minute, where a person may issue 5. The controls are the credential's networks, its lifetime (7 days by default) and its revocation. When the disk is low these routes answer `507`, as every route that stores something does (review L3).
- **A project name that exists outside a chain answers `409 already_exists` to that chain's credential.** Project names are unique in the organization, so a credential with `projects.create` can learn that the owner or another chain has a project of that name. Every guess that is free makes a project. It learns nothing else: every other route answers `404` for a project its chain does not manage (the specification's row A1; review L5).
- **A script's own revocation of a runtime credential counts against its 120 requests a minute.** A script that used its requests of the minute revokes when the window ends; `retry-after` says when. An owner's or an admin's revocation of either kind is not held by the session limit (review L2).
- **Production has none of this yet.** Runtime credentials, automation credentials and the Automation page come with `host-v0.10.0`. Production gets that release only on the owner's word, after the 28-day report (W-2, 20 Dec 2026). Until then it issues 30-day tokens only.

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
- **The audit archive is locked.** Staging's for 30 days, production's for 365. No token a host or CI holds can delete a segment or change the lock. The owner's workstation token `mykey-r2-admin`, which sets the lock rules, could remove the rule (Run 6.2, D-16).
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
- **A restore with the two new kinds is proven in the integration suite, not yet on a host.** It revokes every runtime credential and every automation credential with the tokens, in the same transaction and with no added time. One automation credential issued with `replaces` then gives a chain its runtime credentials back (Run 11.5). Staging's re-drill (D-77) was made before these kinds existed.
- **A restore has two hours from its step 4 to `restore-verify --open`.** The restore's own root token lasts two hours from step 4, and step 5 revokes the pair's. A rerun after step 5, the owner's part, both `restore-verify` runs and the making of the next root token at `--open` all use that token. Later than that, no root token the target's OpenBao accepts is left, and OpenBao must be initialised anew and the restore run from the start (Run 9.7, which fixed R4-3; review RR-2). Making the next root token at the end of step 7 would lift this; it is not done in Stage 1.
- **A restore onto another name installs the source's backup password.** The target's later pairs use it while its custody copy keeps the old one, so those pairs cannot be restored from custody (Run 8.5, R4-13; not closed by Run 9.7).
- **The target's timers run during a restore.** The nightly backup and the five-minute sweep can act on the restored data before `--open` (Run 8.5, R4-14; not closed by Run 9.7).
- **`restore-verify --journey` is not refused on production.** It would write the owner's new password and authenticator seed to the workstation; `restore.md` forbids it in words only (Run 8.5, R4-8).
- **A report can open the gate again within its 30 minutes.** It is not bound to the gate's epoch: after a close, the same report reopens without a new journey (Run 8.5, R4-11).
- **A restore takes about 76 minutes from step 4 to the opening on staging's data**, of which `reconcile-credentials` is 45 minutes. It runs once per environment, about 16 s each (163 environments in Run 10.6; Run 6.8 had 84 at 19 s). Steps 1–7 took 184 s. That leaves 44 of the two hours (the line above): at this rate, about 330 active environments fill the window. There is no `--all` form (Run 6.8, `drill.json`; accepted in D-66; Run 10.6, `session-10/redrill.json`).
- **The restored data is P's, faults included.** Staging's pairs hold 16 member-less spike organizations of Session 2 with no OpenBao namespace. A restore's catalog check refuses them until they are marked for review (Run 6.8).
- **A restore accepts any signed pair.** One past its `eligibleUntil`, or one published before a commit that then failed, is restored if its signature holds. With `--pair` the operator chooses it; with `--newest` the bucket's newest signed pair is taken, whatever the database says (Session 6 finding D, accepted in D-66).
- **A rollback is a redeploy on the same schema, or a restore.** It is never a downgrade of the schema (D-57).

## Operations

- **The drill borrowed production's empty server.** From the day production holds data, a drill needs a temporary server (OWN-5) (D-56).
- **The ops image knows two host names**, `staging` and `prod`. On a third host every job fails closed (Run 6.8).
- **The deploy reads OpenBao with the custody root token.** Once that token is revoked (M1), a deploy cannot fill `openbao_readable` or `incarnation_three_places` until another namespace-listing identity exists (Run 6.9).
- **The custody root token never expires.** It rests in `openbao-init.json` beside the single recovery share; whoever reads that file and reaches OpenBao is root in every namespace (D-65; Run 8.5, R3-1; Gate R).
- **One operator, one workstation.** Custody copies, release builds and every host command live on the owner's workstation. Its loss is covered only by the owner's offline copies (OWN-4).
- **Two workers may repeat a change, by design.** The provisioner retries an unclear OpenBao answer and takes over an operation whose heartbeat is 60 s old, and the archive tick drives an archive again; each compares before it acts (D-32, D-35, D-41; Run 8.5, R2-2).
- **A provisioner that lost its claim can still close the operation.** Its end step does not check the claim, so with two provisioners at once (a host runs one) a stale one could mark a finished environment for review (Run 8.5, R2-8).
- **"No effect" after `--executors-excluded yes` is the operator's word.** The command does not check that `quiesce` or an OpenBao restart happened after the dispatch (Run 8.5, R2-11; `reconciliation.md`).
- **The staging credential drill depends on a trigger on the host.** A transient unit freezes OpenBao at the token create's audit record (D-78), and Run 10.6 caught the issuance on its first attempt. The trigger needs cgroup v2 with Docker's systemd driver and OpenBao's audit file; without them the drill stops at its first step. `tests/fault/credentials/issuance.test.ts` still places the same fault exactly on CI (Session 6; Run 10.6).

## The hosts and the network

- **Ops jobs and `okms.sh` run on the host's network.** Each such container reaches what the host reaches: the metadata service, the resolver (so any name, an outbound channel), NTP, every address set (R2, probe, KMS, apt, the registry during a window), every `mk-*` bridge on every port (OpenBao, the API's verification port among them) and the host's loopback. Every job holds the `maintenance` password, and the `pair` job also the backup signing key and the R2 credentials (Run 8.5, R6-1; fixes review F-10; Gate R).
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
