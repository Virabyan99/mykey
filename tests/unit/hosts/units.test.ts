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

  it("every job timer and the rotation catch up after a boot; the rotation runs before the archive", () => {
    for (const unit of jobTimers()) {
      const timer = read(`${unit}.timer`);
      expect(field(timer, "Persistent"), unit).toBe("true");
      expect(field(timer, "OnCalendar"), unit).toMatch(/^\*-\*-\* \d\d:\d\d:00 UTC$/);
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
  });
});

describe("r2-install and timers (P-112)", () => {
  it("parse", () => {
    expect(parseHostArgs(["staging", "r2-install", "audit-archive"])).toMatchObject({
      command: "r2-install",
      name: "audit-archive",
    });
    expect(parseHostArgs(["staging", "r2-install", "pairs"])).toMatchObject({ name: "pairs" });
    expect(() => parseHostArgs(["staging", "r2-install", "other"])).toThrow(/audit-archive, pairs/);
    expect(parseHostArgs(["prod", "backup-init"])).toMatchObject({ command: "backup-init" });
    expect(parseHostArgs(["staging", "backup-custody"])).toMatchObject({
      command: "backup-custody",
    });
    expect(parseHostArgs(["staging", "timers"])).toMatchObject({ command: "timers" });
  });

  it("installs the three files exactly where the job mounts them", () => {
    for (const name of ["audit-archive", "pairs"] as const) {
      const files = Object.values(r2InstallFiles(name)).sort();
      const job = table.jobs[name === "pairs" ? "pair" : name];
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
