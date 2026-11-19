// Operator jobs on a host (Run 6.2, P-111, D-47). The table
// infra/hosts/ops-jobs.json names, for each job, the one ops command it runs,
// the database role, the secret files it mounts (container path → host path),
// the host directories it may write, its plain settings, and its systemd unit
// and schedule. infra/hosts/ops-run.sh is rendered from the table, so the host
// needs no JSON tool and every mount is visible in the committed script.
// Run: node scripts/ops-jobs.ts   (--check: exit 1 when ops-run.sh is stale)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
export const OPS_JOBS_FILE = join(ROOT, "infra/hosts/ops-jobs.json");
export const OPS_RUN_FILE = join(ROOT, "infra/hosts/ops-run.sh");

export interface OpsJob {
  /** The one ops command this job runs. */
  command: string;
  /** The database role the job logs in as. */
  role: string;
  /** Container path → host path of a secret file, mounted read-only. */
  secrets: Record<string, string>;
  /** Container path → host directory the job may write. */
  writable: Record<string, string>;
  /** Plain settings (no secret): name → value. */
  env: Record<string, string>;
  /** The systemd unit (without suffix) that runs the job, or null for a job run by hand. */
  unit: string | null;
  /** The timer's OnCalendar, or null. */
  schedule: string | null;
}

export interface OpsJobs {
  jobs: Record<string, OpsJob>;
}

export function readOpsJobs(file: string = OPS_JOBS_FILE): OpsJobs {
  return JSON.parse(readFileSync(file, "utf8")) as OpsJobs;
}

const JOB = /^[a-z][a-z0-9-]{0,40}$/;
const SAFE = /^[A-Za-z0-9/._:@-]+$/;
const SECRET_SOURCE = /^\/etc\/mykey\/secrets\/[a-z0-9-]+\/[a-z0-9_-]+$/;
const SECRET_TARGET = /^\/run\/mykey\/secrets\/[a-z0-9/_-]+$/;
const WRITABLE_SOURCE = /^\/var\/lib\/mykey\/[a-z0-9/_-]+$/;
const WRITABLE_TARGET = /^\/run\/mykey\/[a-z0-9/_-]+$/;
const ENV_NAME = /^MYKEY_[A-Z0-9_]+$/;
const ENV_FORBIDDEN = /KEY|SECRET|PASS|TOKEN/;

/** Every problem of the table; empty when it is valid. */
export function validateOpsJobs(
  table: OpsJobs,
  known: { commands: readonly string[]; roles: readonly string[]; root?: string },
): string[] {
  const problems: string[] = [];
  const root = known.root ?? ROOT;
  for (const [name, job] of Object.entries(table.jobs)) {
    const say = (problem: string) => problems.push(`${name}: ${problem}`);
    if (!JOB.test(name)) say("the job name is not lower-case letters, digits and hyphens");
    if (!known.commands.includes(job.command)) say(`unknown command ${job.command}`);
    if (!known.roles.includes(job.role)) say(`role ${job.role} is not one of ROLE_NAMES`);
    for (const [target, source] of Object.entries(job.secrets)) {
      if (!SECRET_SOURCE.test(source))
        say(`secret ${source} is not a file under /etc/mykey/secrets/<dir>/`);
      if (!SECRET_TARGET.test(target))
        say(`secret target ${target} is not under /run/mykey/secrets/`);
    }
    for (const [target, source] of Object.entries(job.writable)) {
      if (!WRITABLE_SOURCE.test(source)) say(`writable ${source} is not under /var/lib/mykey/`);
      if (!WRITABLE_TARGET.test(target)) say(`writable target ${target} is not under /run/mykey/`);
    }
    for (const [key, value] of Object.entries(job.env)) {
      if (!ENV_NAME.test(key) || ENV_FORBIDDEN.test(key.slice("MYKEY_".length))) {
        say(`setting ${key} is not a plain MYKEY_ name`);
      }
      if (!SAFE.test(value)) say(`setting ${key} has characters outside [A-Za-z0-9/._:@-]`);
    }
    if ((job.unit === null) !== (job.schedule === null)) say("unit and schedule go together");
    if (job.unit !== null) {
      const service = join(root, "infra/hosts/systemd", `${job.unit}.service`);
      const timer = join(root, "infra/hosts/systemd", `${job.unit}.timer`);
      if (!existsSync(service) || !existsSync(timer)) {
        say(`unit ${job.unit} has no .service and .timer in infra/hosts/systemd`);
      } else {
        const exec = /^ExecStart=(.*)$/m.exec(readFileSync(service, "utf8"))?.[1] ?? "";
        if (!exec.startsWith(`/opt/mykey/hosts/ops-run.sh ${name} -- ${job.command}`)) {
          say(`unit ${job.unit} does not call ops-run.sh ${name} -- ${job.command}`);
        }
        const calendar = /^OnCalendar=(.*)$/m.exec(readFileSync(timer, "utf8"))?.[1];
        if (calendar !== job.schedule)
          say(`unit ${job.unit}: OnCalendar is not ${job.schedule ?? ""}`);
      }
    }
  }
  return problems;
}

/** The wrapper: one `case` branch per job with its fixed docker arguments. */
export function renderOpsRun(table: OpsJobs): string {
  const branches = Object.entries(table.jobs).map(([name, job]) => {
    const words = [
      `--env=MYKEY_DB_USER=${job.role}`,
      ...Object.entries(job.env).map(([key, value]) => `--env=${key}=${value}`),
      ...Object.entries(job.secrets).map(
        ([target, source]) => `--mount=type=bind,source=${source},target=${target},readonly`,
      ),
      ...Object.entries(job.writable).map(
        ([target, source]) => `--mount=type=bind,source=${source},target=${target}`,
      ),
    ];
    for (const word of words) {
      if (!/^[A-Za-z0-9/._:@=,-]+$/.test(word)) throw new Error(`${name}: unsafe word ${word}`);
    }
    const sources = Object.values(job.secrets);
    return [
      `  ${name})`,
      `    command=${job.command}`,
      `    files="${sources.join(" ")}"`,
      `    fixed="${words.join(" ")}"`,
      "    ;;",
    ].join("\n");
  });
  return `#!/bin/sh
# GENERATED by scripts/ops-jobs.ts from infra/hosts/ops-jobs.json: do not edit.
# Runs one operator job in the ops image (Run 6.2, P-111, D-47):
#
#   /opt/mykey/hosts/ops-run.sh <job> -- <command> [args...]
#
# The job fixes the command, the database role and exactly the files mounted.
# The container reaches PostgreSQL and OpenBao by the names in their
# certificates, on the host network; it cannot write outside the job's
# directories. Secret values never appear here: only file names.
# MYKEY_OPS_DRY_RUN=1 prints the docker command, one word per line, and checks
# no file.
set -euf

host_env=\${MYKEY_HOST_ENV:-/etc/mykey/host.env}
usage() {
	echo "usage: ops-run.sh <job> -- <command> [args...]" >&2
	exit 64
}

[ "$#" -ge 3 ] || usage
job=$1
[ "$2" = "--" ] || usage
shift 2

case "$job" in
${branches.join("\n")}
  *)
    echo "ops-run.sh: unknown job $job" >&2
    exit 64
    ;;
esac

if [ "$1" != "$command" ]; then
	echo "ops-run.sh: job $job runs only ops $command" >&2
	exit 64
fi

setting() {
	sed -n "s/^$1=//p" "$host_env" | tail -n 1
}
image=$(setting OPS_IMAGE)
if [ -z "$image" ]; then
	echo "ops-run.sh: OPS_IMAGE is not set in host.env (node scripts/host.ts <host> image ops <tar>)" >&2
	exit 1
fi
host_name=$(setting MYKEY_HOST_NAME)
if [ -z "$host_name" ]; then
	echo "ops-run.sh: MYKEY_HOST_NAME is not set in host.env (node scripts/host.ts <host> ops-secrets)" >&2
	exit 1
fi

if [ -z "\${MYKEY_OPS_DRY_RUN:-}" ]; then
	for file in $files; do
		if [ ! -r "$file" ]; then
			echo "ops-run.sh: $file is missing (node scripts/host.ts <host> ops-secrets)" >&2
			exit 1
		fi
	done
fi

# The fixed words hold no space and no wildcard (rendered and checked).
# shellcheck disable=SC2086
set -- docker run --rm -i --network host --read-only --cap-drop ALL \\
	--security-opt no-new-privileges --user 1000:1000 --ulimit core=0 \\
	--add-host postgres:10.78.2.2 --add-host openbao:10.78.3.2 \\
	--tmpfs /tmp \\
	--env=MYKEY_DB_HOST=postgres --env=MYKEY_DB_PORT=5432 --env=MYKEY_DB_NAME=postgres \\
	--env=MYKEY_DB_PASSWORD_FILE=/run/mykey/secrets/db-password \\
	--env=MYKEY_DB_CA_FILE=/run/mykey/tls/ca.crt \\
	"--env=MYKEY_OPS_HOST=$host_name" \\
	--mount=type=bind,source=/etc/mykey/pki/ca.crt,target=/run/mykey/tls/ca.crt,readonly \\
	$fixed "$image" "$@"

if [ -n "\${MYKEY_OPS_DRY_RUN:-}" ]; then
	for word in "$@"; do
		case "$word" in
		--env=* | --mount=*) printf '%s\\n' "\${word%%=*}" "\${word#*=}" ;;
		*) printf '%s\\n' "$word" ;;
		esac
	done
	exit 0
fi
exec "$@"
`;
}

if (import.meta.main) {
  const table = readOpsJobs();
  const next = renderOpsRun(table);
  if (process.argv.includes("--check")) {
    if (!existsSync(OPS_RUN_FILE) || readFileSync(OPS_RUN_FILE, "utf8") !== next) {
      process.stderr.write("ops-run.sh is stale: node scripts/ops-jobs.ts\n");
      process.exit(1);
    }
    process.stdout.write("ops-run.sh: current\n");
  } else {
    writeFileSync(OPS_RUN_FILE, next);
    process.stdout.write("ops-run.sh: written\n");
  }
}
