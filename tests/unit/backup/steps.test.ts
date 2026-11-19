// Run 6.5 Task C (P-119, Session 2 M2): the host steps of a pair are pure
// builders of shell text. Each container mounts at most the one artifact it
// reads or writes, no text names a secret value (only files), and the pair id
// is quoted wherever it appears.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAIR_ROOT,
  pairSteps,
  renderBackupScript,
  resticArgv,
} from "../../../infra/hosts/backup/steps.ts";

const pairId = randomUUID();
const steps = pairSteps(pairId);
const ARTIFACTS = ["postgres.dump", "globals.sql", "openbao.snap"];

/** The `-v`/`--mount` sources of every docker command in a text. */
function mounts(text: string): string[] {
  return [...text.matchAll(/(?:^| )-v '?([^:' ]+)/g)].map((match) => match[1] ?? "");
}

describe("the host steps of a pair", () => {
  it("refuses a pair id that is not a UUID", () => {
    expect(() => pairSteps("x'; rm -rf /")).toThrow();
    expect(() => pairSteps("../etc")).toThrow();
  });

  it("each step that takes an artifact mounts at most that one artifact", () => {
    for (const [name, text] of Object.entries(steps.capture)) {
      const touched = ARTIFACTS.filter((artifact) =>
        mounts(text).some((source) => source.endsWith(`/artifacts/${artifact}`)),
      );
      expect(touched.length, name).toBeLessThanOrEqual(1);
      expect(
        mounts(text).filter((source) => source.endsWith("/artifacts")),
        `${name} mounts no whole artifact directory`,
      ).toEqual([]);
    }
  });

  it("restic runs without a network and reads the password from a read-only file", () => {
    for (const text of Object.values(steps.restic)) {
      expect(text).toContain("--network none");
      expect(text).toMatch(/:\/run\/mykey\/restic-password:ro/);
      expect(text).toContain("RESTIC_PASSWORD_FILE=/run/mykey/restic-password");
    }
    expect(steps.restic.backup).toMatch(/\/artifacts:\/artifacts:ro/);
  });

  it("no step names a secret value: secrets are files, and no environment value is secret", () => {
    const all = [
      ...Object.values(steps.capture),
      ...Object.values(steps.restic),
      ...Object.values(steps.tmpfs),
    ].join("\n");
    for (const match of all.matchAll(/(?:-e|--env)[ =]([A-Z_]+)=(\S+)/g)) {
      const [, name = "", value = ""] = match;
      if (/PASS|SECRET|TOKEN|KEY/.test(name)) {
        expect(name, `${name} carries a file, not a value`).toMatch(/FILE$/);
        expect(value).toMatch(/^\/run\//);
      }
    }
    expect(all).not.toMatch(/secret_id=|client_token=|PGPASSWORD=[^"$]/);
  });

  it("the pair id appears only inside single quotes", () => {
    const all = [
      ...Object.values(steps.capture),
      ...Object.values(steps.restic),
      ...Object.values(steps.tmpfs),
    ];
    for (const text of all) {
      const unquoted = text.replace(/'[^']*'/g, "");
      expect(unquoted, text).not.toContain(pairId);
    }
    expect(steps.root).toBe(`${PAIR_ROOT}/${pairId}`);
  });

  it("resticArgv builds the same restic invocation for a local directory", () => {
    const argv = resticArgv(
      { repo: "/tmp/r", password: "/tmp/p", artifacts: "/tmp/a", out: null },
      ["backup", "/artifacts"],
    );
    expect(argv.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
    expect(argv).toContain("/tmp/a:/artifacts:ro");
    expect(argv.at(-2)).toBe("backup");
  });

  it("backup.sh is rendered from the steps and current", () => {
    const committed = readFileSync(
      join(import.meta.dirname, "../../../infra/hosts/backup/backup.sh"),
      "utf8",
    );
    expect(committed).toBe(renderBackupScript());
  });
});
