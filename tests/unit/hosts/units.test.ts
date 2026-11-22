// Run 6.2 Task C (P-110, P-112): the systemd units of host jobs. Every
// service that calls ops-run.sh is the unit of its job in the table; every job
// timer catches up after a boot; the rotation runs before the archive; the
// install command names only these units. And the two host commands that put
// a job's secrets on a host parse and write where the table mounts them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKUP_FILES,
  backupKeysCommand,
  jobTimers,
  parseHostArgs,
  r2InstallFiles,
  timersCommand,
} from "../../../scripts/host.ts";
import { readOpsJobs } from "../../../scripts/ops-jobs.ts";

const SYSTEMD = join(import.meta.dirname, "..", "..", "..", "infra", "hosts", "systemd");
const read = (name: string) => readFileSync(join(SYSTEMD, name), "utf8");
const field = (text: string, key: string) =>
  new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] ?? null;
const table = readOpsJobs();

describe("the units of host jobs (P-112)", () => {
  it("every service that calls ops-run.sh is the unit of the job it names", () => {
    for (const file of readdirSync(SYSTEMD).filter((name) => name.endsWith(".service"))) {
      const exec = field(read(file), "ExecStart") ?? "";
      const match = /^\/opt\/mykey\/hosts\/ops-run\.sh ([a-z0-9-]+) -- ([a-z0-9-]+)/.exec(exec);
      if (match === null) continue;
      const job = table.jobs[match[1] ?? ""];
      expect(job, file).toBeDefined();
      expect(`${job?.unit ?? ""}.service`, file).toBe(file);
      expect(match[2], file).toBe(job?.command);
    }
  });

  // Run 6.9 (P-129): the hourly and five-minute timers do not catch up; every daily one does.
  const FREQUENT: Record<string, RegExp> = {
    "mykey-auth-cleanup": /^\*-\*-\* \*:15:00 UTC$/,
    "mykey-sweep": /^\*-\*-\* \*:0\/5:00 UTC$/,
  };

  it("every daily job timer and the rotation catch up after a boot; the rotation runs before the archive", () => {
    for (const unit of jobTimers()) {
      const timer = read(`${unit}.timer`);
      const frequent = FREQUENT[unit];
      if (frequent === undefined) {
        expect(field(timer, "Persistent"), unit).toBe("true");
        expect(field(timer, "OnCalendar"), unit).toMatch(/^\*-\*-\* \d\d:\d\d:00 UTC$/);
      } else {
        expect(field(timer, "Persistent"), unit).toBe("false");
        expect(field(timer, "OnCalendar"), unit).toMatch(frequent);
      }
      expect(field(read(`${unit}.service`), "Type"), unit).toBe("oneshot");
    }
    const at = (unit: string) => field(read(`${unit}.timer`), "OnCalendar") ?? "";
    expect(at("mykey-bao-audit-rotate") < at("mykey-audit-archive")).toBe(true);
    expect(field(read("mykey-bao-audit-rotate.service"), "ExecStart")).toBe(
      "/opt/mykey/hosts/checks/bao-audit-rotate.sh",
    );
  });

  it("timers installs and starts exactly the job timers", () => {
    const command = timersCommand(jobTimers());
    expect(command).toContain(
      "systemctl enable --now mykey-bao-audit-rotate.timer mykey-audit-archive.timer",
    );
    expect(command).toContain("/opt/mykey/hosts/systemd/mykey-audit-archive.service");
    expect(() => timersCommand(["mykey-x; rm -rf /"])).toThrow(/unusable/);
    // Run 6.8: status.sh measures this directory for the capacity record; until
    // the first rotation (01:15 UTC) a new host had none and refused every
    // expanding mutation with 503.
    expect(command).toContain(
      "install -d -m 0700 -o 1000 -g 1000 /var/lib/mykey/bao-audit/rotated",
    );
    // Run 6.5: the daily pair's timer, the boot recovery and the heartbeat's expectation.
    expect(jobTimers()).toContain("mykey-backup");
    // Run 6.6: retention runs after the night's pair, with the cleanup token, without the signer.
    expect(jobTimers()).toContain("mykey-pair-retention");
    const at = (unit: string) => field(read(`${unit}.timer`), "OnCalendar") ?? "";
    expect(at("mykey-backup") < at("mykey-pair-retention")).toBe(true);
    const retention = table.jobs["pair-retention"];
    expect(retention?.env).toEqual({
      MYKEY_R2_DIR: "/run/mykey/secrets/r2",
      MYKEY_PAIR_RETENTION: "yes",
    });
    expect(Object.keys(retention?.secrets ?? {})).not.toContain(
      "/run/mykey/secrets/backup/signing-key",
    );
    expect(command).toContain("systemctl enable mykey-capture-recover.service");
    expect(command).toContain("/opt/mykey/hosts/systemd/mykey-capture-recover.service");
    expect(command).toContain("MYKEY_BACKUP_EXPECTED=yes");
  });

  // Run 9.6 (P-166, D-72): one field record per day at 00:10 UTC, from the host's own facts.
  it("the field day has a daily timer at 00:10 UTC that runs field-day.sh, and timers installs it", () => {
    expect(jobTimers()).toContain("mykey-field-day");
    expect(field(read("mykey-field-day.timer"), "OnCalendar")).toBe("*-*-* 00:10:00 UTC");
    expect(field(read("mykey-field-day.service"), "ExecStart")).toBe(
      "/opt/mykey/hosts/field/field-day.sh",
    );
    expect(timersCommand(jobTimers())).toContain("mykey-field-day.timer");
  });

  // Run 6.9 (P-129): expiry at 02:00, auth clean-up hourly, the PostgreSQL sweeps every 5 minutes.
  it("operations-expire, auth-cleanup and sweep each have a timer that runs their command through ops-run.sh", () => {
    const want = {
      "operations-expire": ["mykey-operations-expire", "operations-expire", "*-*-* 02:00:00 UTC"],
      "auth-cleanup": ["mykey-auth-cleanup", "auth-cleanup", "*-*-* *:15:00 UTC"],
      sweep: ["mykey-sweep", "sweep", "*-*-* *:0/5:00 UTC"],
    } as const;
    for (const [job, [unit, command, schedule]] of Object.entries(want)) {
      expect(table.jobs[job], job).toMatchObject({ command, role: "maintenance", unit, schedule });
      expect(jobTimers()).toContain(unit);
      expect(field(read(`${unit}.service`), "ExecStart")).toBe(
        `/opt/mykey/hosts/ops-run.sh ${job} -- ${command}`,
      );
      expect(field(read(`${unit}.timer`), "OnCalendar")).toBe(schedule);
    }
  });
});

// Run 8.0 (P-149, Session 6 findings G and H): two units that alerted falsely.
describe("units that must not stay failed", () => {
  const section = (text: string, name: string) =>
    new RegExp(`^\\[${name}\\]\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m").exec(text)?.[1] ?? "";

  it("mykey-backup: exit 75 (a busy drain) is not a failed unit", () => {
    const service = section(read("mykey-backup.service"), "Service");
    expect(field(service, "SuccessExitStatus")?.split(/\s+/)).toContain("75");
  });

  it("mykey-capture-recover waits for PostgreSQL: it starts after the stack and tries again, a bounded number of times, when the database does not answer yet", () => {
    const text = read("mykey-capture-recover.service");
    const unit = section(text, "Unit");
    const service = section(text, "Service");
    expect(field(unit, "After")?.split(/\s+/)).toContain("docker.service");
    expect(field(service, "Restart")).toBe("on-failure");
    const pause = Number(/^(\d+)s$/.exec(field(service, "RestartSec") ?? "")?.[1]);
    const burst = Number(field(unit, "StartLimitBurst"));
    const interval = Number(/^(\d+)s$/.exec(field(unit, "StartLimitIntervalSec") ?? "")?.[1]);
    expect(pause).toBeGreaterThanOrEqual(10);
    expect(burst).toBeGreaterThanOrEqual(3);
    expect(burst).toBeLessThanOrEqual(20);
    // Every retry falls inside the window, so the limit really bounds them.
    expect(interval).toBeGreaterThan(pause * burst);
  });
});

describe("r2-install and timers (P-112)", () => {
  it("parse", () => {
    expect(parseHostArgs(["staging", "r2-install", "audit-archive"])).toMatchObject({
      command: "r2-install",
      name: "audit-archive",
    });
    expect(parseHostArgs(["staging", "r2-install", "pairs"])).toMatchObject({ name: "pairs" });
    expect(parseHostArgs(["staging", "r2-install", "pairs-cleanup"])).toMatchObject({
      name: "pairs-cleanup",
    });
    expect(() => parseHostArgs(["staging", "r2-install", "other"])).toThrow(
      /audit-archive, pairs, pairs-cleanup/,
    );
    expect(parseHostArgs(["prod", "backup-init"])).toMatchObject({ command: "backup-init" });
    expect(parseHostArgs(["staging", "backup-custody"])).toMatchObject({
      command: "backup-custody",
    });
    expect(parseHostArgs(["staging", "timers"])).toMatchObject({ command: "timers" });
  });

  it("installs the three files exactly where the job mounts them", () => {
    const jobOf = {
      "audit-archive": "audit-archive",
      pairs: "pair",
      "pairs-cleanup": "pair-retention",
    };
    for (const name of ["audit-archive", "pairs", "pairs-cleanup"] as const) {
      const files = Object.values(r2InstallFiles(name)).sort();
      const job = table.jobs[jobOf[name]];
      const mounted = Object.values(job?.secrets ?? {}).filter((source) => source.includes("/r2-"));
      expect(files, name).toEqual(mounted.sort());
    }
  });

  it("the pair job mounts the signing key where host-env reads it, and the pair scratch", () => {
    const job = table.jobs.pair;
    expect(job?.secrets["/run/mykey/secrets/backup/signing-key"]).toBe(BACKUP_FILES.signingKey);
    expect(job?.writable).toEqual({ "/run/mykey/pairs": "/var/lib/mykey/pairs" });
    expect(table.jobs.capture?.writable).toEqual(job?.writable);
  });

  it("backup-init makes the keys on the host once and never prints them", () => {
    const command = backupKeysCommand();
    expect(command).toContain(`test -s ${BACKUP_FILES.password} ||`);
    expect(command).toContain("openssl genpkey -algorithm ed25519");
    expect(command).not.toMatch(/\bcat\b|\becho\b|\btee\b|\bprintf\b/);
    expect(command).toContain("chown 1000:1000");
  });
});
