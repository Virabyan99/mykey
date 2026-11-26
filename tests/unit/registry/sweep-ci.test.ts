// Run 8.4 Step 3 (P-152): scripts/sweep-ci.ts counts canary-shaped strings and
// OpenBao service tokens in the files it is given (CI logs, CLI reports) and
// exits 1 on any; it prints counts per file, never what it found.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { countFindings } from "../../../scripts/sweep-ci.ts";

const work = mkdtempSync(join(tmpdir(), "mykey-sweep-ci-"));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

// Assembled at run time: no literal canary or token in this file.
const canary = () => ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const serviceToken = () => ["hvs", randomBytes(24).toString("base64url")].join(".");
const legacyToken = () =>
  [
    "s",
    randomBytes(18)
      .toString("base64")
      .replace(/[^A-Za-z0-9]/g, "a")
      .slice(0, 24),
  ].join(".");

function run(files: string[]) {
  return spawnSync(process.execPath, ["scripts/sweep-ci.ts", ...files], { encoding: "utf8" });
}

describe("sweep-ci", () => {
  it("counts a canary, a service token and a legacy token, and nothing in plain text", () => {
    expect(countFindings(`log line ${canary()} more`)).toEqual({ canaries: 1, tokens: 0 });
    expect(countFindings(`X-Vault-Token: ${serviceToken()}`)).toEqual({ canaries: 0, tokens: 1 });
    expect(countFindings(`token=${legacyToken()};`)).toEqual({ canaries: 0, tokens: 1 });
    expect(countFindings("2026-11-20 ok s.short run hvs. done")).toEqual({
      canaries: 0,
      tokens: 0,
    });
  });

  // Session 11 (Run 11.8): the two new secrets are token shapes too.
  it("counts a runtime credential's client secret and an automation secret, and neither their prefix nor a placeholder", () => {
    const presented = (prefix: string) =>
      [prefix, randomUUID(), randomBytes(32).toString("base64url")].join(".");
    expect(countFindings(`authorization: Bearer ${presented("mkrc")}`)).toEqual({
      canaries: 0,
      tokens: 1,
    });
    expect(countFindings(`secret=${presented("mkac")};`)).toEqual({ canaries: 0, tokens: 1 });
    const placeholder = ["mkrc", "<credentialId>", "<43 characters>"].join(".");
    expect(countFindings(`not.toContain("mkrc.") and "mkac." and ${placeholder}`)).toEqual({
      canaries: 0,
      tokens: 0,
    });
  });

  it("exits 1 on a planted canary and a planted token, printing counts but never the strings", () => {
    const planted = [canary(), serviceToken()];
    const file = join(work, "planted.log");
    writeFileSync(file, `step 1\n${planted[0]!}\nstep 2 token ${planted[1]!}\n`);
    const clean = join(work, "clean.log");
    writeFileSync(clean, "step 1\nstep 2\n");
    const result = run([file, clean]);
    expect(result.status).toBe(1);
    for (const value of planted) expect(`${result.stdout}${result.stderr}`).not.toContain(value);
    expect(result.stdout).toMatch(/planted\.log: 1 canary-shaped, 1 token-shaped/);
    expect(result.stdout).toMatch(/clean\.log: 0 canary-shaped, 0 token-shaped/);
  });

  it("exits 0 on clean files and 2 without any file or with a missing one", () => {
    const clean = join(work, "clean2.log");
    writeFileSync(clean, "nothing here\n");
    expect(run([clean]).status).toBe(0);
    expect(run([]).status).toBe(2);
    expect(run([join(work, "absent.log")]).status).toBe(2);
  });
});
