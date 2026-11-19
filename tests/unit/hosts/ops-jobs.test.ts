// Run 6.2 Task A (P-111, D-47): the table of operator jobs on a host and the
// wrapper rendered from it. Every job names an existing command and a role,
// mounts only secret files under /etc/mykey/secrets/, and a scheduled job has
// a unit that calls the wrapper. The wrapper, run dry, mounts exactly the job's
// files and carries no value.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLE_NAMES } from "@mykey/db";
import { OPS_COMMANDS } from "@mykey/ops";
import { OWN_SCANNED_IMAGES } from "../../../scripts/ci-scan.ts";
import {
  OPS_RUN_FILE,
  readOpsJobs,
  renderOpsRun,
  validateOpsJobs,
  type OpsJobs,
} from "../../../scripts/ops-jobs.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const table = readOpsJobs();

/** The wrapper run with MYKEY_OPS_DRY_RUN: the docker argv, one word per line. */
function dryRun(
  job: string,
  argv: string[],
  hostEnv?: string,
): { code: number; lines: string[]; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "mykey-ops-run-"));
  const env = join(dir, "host.env");
  writeFileSync(
    env,
    hostEnv ?? `OPS_IMAGE=sha256:${"a".repeat(64)}\nMYKEY_HOST_NAME=staging\nMYKEY_SECRET_LIKE=x\n`,
  );
  const result = spawnSync("sh", [OPS_RUN_FILE, job, "--", ...argv], {
    env: { ...process.env, MYKEY_OPS_DRY_RUN: "1", MYKEY_HOST_ENV: env },
    encoding: "utf8",
  });
  return {
    code: result.status ?? -1,
    lines: result.stdout.split("\n").filter((line) => line !== ""),
    err: result.stderr,
  };
}

describe("the job table (P-111)", () => {
  it("is valid: commands, roles, secret files, units", () => {
    expect(
      validateOpsJobs(table, { commands: OPS_COMMANDS, roles: ROLE_NAMES, root: ROOT }),
    ).toEqual([]);
    expect(Object.keys(table.jobs)).toContain("status-check");
  });

  it("refuses a job with an unknown command, a role outside ROLE_NAMES, a secret outside /etc/mykey/secrets or a missing unit", () => {
    const bad: OpsJobs = {
      jobs: {
        a: {
          command: "nope",
          role: "postgres",
          secrets: { "/run/mykey/secrets/x": "/root/x" },
          writable: {},
          env: {},
          unit: null,
          schedule: null,
        },
        b: {
          command: "operations",
          role: "maintenance",
          secrets: {},
          writable: {},
          env: {},
          unit: "mykey-missing",
          schedule: "*-*-* 01:30:00 UTC",
        },
      },
    };
    const problems = validateOpsJobs(bad, {
      commands: OPS_COMMANDS,
      roles: ROLE_NAMES,
      root: ROOT,
    });
    expect(problems.join("\n")).toMatch(/a: unknown command nope/);
    expect(problems.join("\n")).toMatch(/a: role postgres/);
    expect(problems.join("\n")).toMatch(/a: secret \/root\/x/);
    expect(problems.join("\n")).toMatch(/b: unit mykey-missing/);
  });

  it("the committed wrapper is the one rendered from the table (node scripts/ops-jobs.ts)", () => {
    expect(readFileSync(OPS_RUN_FILE, "utf8")).toBe(renderOpsRun(table));
  });

  it("the ops image is scanned", () => {
    expect(OWN_SCANNED_IMAGES).toContain("ops");
    expect(existsSync(join(ROOT, "apps/ops/Dockerfile"))).toBe(true);
  });
});

describe("the wrapper (P-111)", () => {
  it("for each job mounts that job's files and no other, and carries no value", () => {
    for (const [name, job] of Object.entries(table.jobs)) {
      const run = dryRun(name, [job.command]);
      expect(run.code, `${name}: ${run.err}`).toBe(0);
      const mounts = run.lines.filter((line) => line.startsWith("type=bind,"));
      const expected = [
        ...Object.entries(job.secrets).map(
          ([target, source]) => `type=bind,source=${source},target=${target},readonly`,
        ),
        ...Object.entries(job.writable).map(
          ([target, source]) => `type=bind,source=${source},target=${target}`,
        ),
        "type=bind,source=/etc/mykey/pki/ca.crt,target=/run/mykey/tls/ca.crt,readonly",
      ].sort();
      expect(mounts.sort(), name).toEqual(expected);
      for (const other of Object.values(table.jobs)) {
        for (const source of Object.values(other.secrets)) {
          if (!Object.values(job.secrets).includes(source)) {
            expect(run.lines.join("\n"), `${name} mounts ${source}`).not.toContain(source);
          }
        }
      }
      expect(run.lines).toContain(`MYKEY_DB_USER=${job.role}`);
      expect(run.lines).toContain("MYKEY_OPS_HOST=staging");
      expect(run.lines.join("\n")).not.toContain("MYKEY_SECRET_LIKE");
      expect(run.lines.slice(0, 3)).toEqual(["docker", "run", "--rm"]);
      for (const flag of ["--read-only", "--network", "--cap-drop", "--add-host"]) {
        expect(run.lines, `${name} ${flag}`).toContain(flag);
      }
      expect(run.lines.at(-1)).toBe(job.command);
      expect(run.lines.at(-2)).toBe(`sha256:${"a".repeat(64)}`);
    }
  });

  it("refuses another command than the job's, an unknown job and a host without OPS_IMAGE", () => {
    expect(dryRun("status-check", ["bootstrap-owner"]).code).toBe(64);
    expect(dryRun("no-such-job", ["operations"]).code).toBe(64);
    const missing = dryRun("status-check", ["operations"], "MYKEY_HOST_NAME=staging\n");
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/OPS_IMAGE/);
  });

  it("passes the operator's arguments through, after the image, one word each", () => {
    const run = dryRun("status-check", [
      "operations",
      "--organization",
      "e2350312-0000-4000-8000-000000000000",
    ]);
    expect(run.code, run.err).toBe(0);
    expect(run.lines.slice(-3)).toEqual([
      "operations",
      "--organization",
      "e2350312-0000-4000-8000-000000000000",
    ]);
  });
});

describe("ops-secrets (P-111)", () => {
  it("parses without arguments for both hosts", async () => {
    const { parseHostArgs } = await import("../../../scripts/host.ts");
    expect(parseHostArgs(["staging", "ops-secrets"])).toMatchObject({ command: "ops-secrets" });
    expect(parseHostArgs(["prod", "ops-secrets"])).toMatchObject({ command: "ops-secrets" });
    expect(() => parseHostArgs(["staging", "ops-secrets", "now"])).toThrow();
  });

  it("installs exactly the role passwords the table mounts, each for its own role", async () => {
    const { OPS_ROLE_SECRETS } = await import("../../../scripts/host.ts");
    for (const [name, job] of Object.entries(table.jobs)) {
      const password = job.secrets["/run/mykey/secrets/db-password"];
      expect(password, name).toBe(OPS_ROLE_SECRETS[job.role as keyof typeof OPS_ROLE_SECRETS]);
    }
  });
});
