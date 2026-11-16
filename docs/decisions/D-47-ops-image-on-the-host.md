# D-47 — Operator jobs run on the host, in an ops image

**Date:** 2026-11-16

**Status:** DECIDED in Run 6.2 (P-111). Evidence:

- `docs/evidence/session-6/run-6.2.md`;
- `tests/unit/hosts/ops-jobs.test.ts`;
- the `status-check` job on staging, whose answer matched the tunnel's.

## Decision

A daily job (the audit archive, later the backup pair) runs **on the host**, not from the workstation. It needs PostgreSQL, OpenBao and R2 in one process, and the workstation must not be part of a daily backup.

- **The image.** `apps/ops/Dockerfile` contains:
  - the pinned Node base;
  - the production dependencies of `@mykey/ops` only;
  - user 1000;
  - Node's permission model: read `/app` and `/run/mykey`, write only under `/run/mykey/*` and `/tmp/*`.

  Its entry point `apps/ops/src/main.ts` runs one operator command and exits with its code. A missing setting is exit 1 and names the setting only. `scripts/ci-scan.ts` scans the image like the API and the provisioner.

- **The table.** `infra/hosts/ops-jobs.json` gives each job:
  - the one command it runs;
  - its database role (one of `ROLE_NAMES`);
  - its secret files, each a container path mapped to a host file under `/etc/mykey/secrets/<dir>/`;
  - the host directories it may write (under `/var/lib/mykey/`);
  - its plain settings;
  - its systemd unit and schedule.

  A unit test validates the table. It refuses an unknown command or role, a secret outside `/etc/mykey/secrets/`, and a unit that is missing, does not call the wrapper for that job, or has another schedule.

- **The wrapper.** `infra/hosts/ops-run.sh` is rendered from the table by `node scripts/ops-jobs.ts`, so the host needs no JSON tool and every mount is visible in the committed script. A unit test runs it dry: each job mounts its own files and no other job's, and carries no value. `ops-run.sh <job> -- <command> [flags]` refuses another command than the job's. It runs the image with:
  - `docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --ulimit core=0`;
  - `--add-host postgres:10.78.2.2 --add-host openbao:10.78.3.2`, so the names in the certificates resolve;
  - the CA certificate and exactly the job's files.

  The container reaches PostgreSQL from the bridge's gateway address, which `pg_hba.conf` already admits (`10.78.2.0/28`).

- **Secrets on the host.** `host.ts <host> ops-secrets` installs the workstation's custody copies of the `maintenance` and `backup_reader` passwords. They go to `/etc/mykey/secrets/ops/`, owner 1000, mode 0400, on stdin. The command also records `MYKEY_HOST_NAME` in `host.env`. The host is root over both stores already, so a role password there adds no authority it lacks.
- **The image on a host.** `host.ts <host> image ops <tar>` writes `OPS_IMAGE`, as for the other two images.

## Alternatives rejected

- **The workstation runs the daily jobs through the tunnel.** A backup would then depend on a laptop being on and on the VPN.
- **A long-running ops service in compose.** A job runs once a day; a resident process with database and R2 credentials is a target for 23 hours and 59 minutes.
- **`jq` reading the table at run time.** The host has it, but the workstation and CI do not. The rendered script can be tested anywhere, and a review sees every mount.

## Consequences

- A new job is a table entry, a unit pair and a re-render, and the unit test checks all three.
- The image is rebuilt and loaded on each host whenever `apps/ops` or a package it uses changes, like the other two images.
