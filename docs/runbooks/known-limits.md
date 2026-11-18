# Known limits — what the service does not do

FR-1.75 (P-130). This is an honest list: each line names what the service does not do, and where that was measured or decided. A limit leaves this list only when a later session changes the behaviour and its run note says so.

## Requests and errors

- **A response made by the proxy carries no request id.** A 502 or a TLS refusal from the edge has no id the API logged (P-109, Run 6.1).
- **Refusals that cannot be attributed are log lines, not audit rows.** An unauthenticated or unparseable request has no actor and no organization (Run 6.1, `audit.md`).
- **One source with 30 unknown machine tokens a minute blocks itself.** Valid tokens from that source are refused too, for the rest of that minute (Run 6.3, `limits.md`).
- **A complete read holds a per-credential read lock**, and a write in the same environment can answer `busy` meanwhile. Locally, the worst write needed all three attempts (6.4 s); staging reads 7 MB in up to 23.5 s, which can outlast a writer's attempts. `busy` is safe to repeat (Run 6.3, `run-6.3-starvation.json`).
- **Import is limited to 1 MiB, an environment to 8 MiB.** A large export cannot be imported again in one piece. The `@next/env` reader can lose a key in one case, and the export warns about it (Session 4).
- **Better Auth writes `expires_at` with the API's clock.** A session's expiry depends on the API host's time (Session 3; chrony is checked in `status`).

## Alerts and the probe

- **A certificate that lives 60 days or less alerts at a third of its life.** A 30-day KMS certificate alerts 10 days before it ends, not 30 (D-50).
- **The watcher of the probe can be late, and it can stop.** `probe-watch.yml` is a scheduled GitHub workflow: GitHub may delay it, and it disables scheduled workflows after 60 days without repository activity (Run 6.4).
- **A host that is not in the probe is not watched.** The drill host was never in it (Run 6.8).

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
- **The OpenBao user lockout.** About 15 minutes of failed AppRole logins lock the role id out, even for the right secret id. A credential mistake therefore becomes a 15-minute outage of every secret read (Run 6.9). Tuning `user_lockout` is a question for Session 8.

## Operations

- **The drill borrowed production's empty server.** From the day production holds data, a drill needs a temporary server (OWN-5) (D-56).
- **The ops image knows two host names**, `staging` and `prod`. On a third host every job fails closed (Run 6.8).
- **The deploy reads OpenBao with the custody root token.** Once that token is revoked (M1), a deploy cannot fill `openbao_readable` or `incarnation_three_places` until another namespace-listing identity exists (Run 6.9).
- **An issuance left `needs_review` has no stored accessor.** Settling it needs the token sweep or `--executors-excluded` (Session 5).
- **One operator, one workstation.** Custody copies, release builds and every host command live on the owner's workstation. Its loss is covered only by the owner's offline copies (OWN-4).
