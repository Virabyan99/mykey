// Run 3.2 Task B (Review focus 3): an operator command prints no secret. The
// bootstrap reads the password from stdin; neither the password nor its hash
// reaches stdout, stderr or the audit row.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyFiles } from "@mykey/auth";
import { runOps, type OpsEnv } from "@mykey/ops";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

let db: TestDatabase;
let keysDirectory: string;
let home: string;

beforeAll(async () => {
  db = await prepareDatabase();
  keysDirectory = mkdtempSync(join(tmpdir(), "mykey-ops-keys-"));
  generateKeyFiles(keysDirectory);
  home = mkdtempSync(join(tmpdir(), "mykey-ops-home-"));
});

afterAll(async () => {
  await db.drop();
  rmSync(keysDirectory, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function ops(
  argv: string[],
  stdinText: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => out.push(chunk));
  stderr.on("data", (chunk: Buffer) => err.push(chunk));
  stdin.end(stdinText);
  const env: OpsEnv = {
    database: db.targets.maintenance,
    keysDirectory,
    baseUrl: "https://mykey.test",
    home,
  };
  const code = await runOps(argv, { stdin, stdout, stderr, env });
  return {
    code,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
  };
}

describe("ops bootstrap-owner output", () => {
  it("prints the outcome and the two ids, and neither the password nor its hash", async () => {
    // A canary assembled at run time (never a literal in the repository).
    const canary = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
    const address = `owner-${randomBytes(4).toString("hex")}@mykey.invalid`;
    const result = await ops(["bootstrap-owner", "--email", address], `${canary}\n`);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^created user [0-9a-f-]{36} organization [0-9a-f-]{36}\n$/);
    const [account] = await run<{ password: string }>(
      db.pool("superuser"),
      "SELECT password FROM auth.account",
    );
    const hash = account?.password ?? "";
    expect(hash.length).toBeGreaterThan(20);
    for (const text of [result.stdout, result.stderr]) {
      expect(text.includes(canary)).toBe(false);
      expect(text.includes(hash)).toBe(false);
    }
    const audit = await run<{ details: unknown }>(
      db.pool("superuser"),
      "SELECT details FROM audit.event",
    );
    const auditText = JSON.stringify(audit);
    expect(auditText.includes(canary)).toBe(false);
    expect(auditText.includes(hash)).toBe(false);

    // Repeated: already_present, exit 0; another e-mail: refused, exit 2.
    const again = await ops(["bootstrap-owner", "--email", address], `${canary}\n`);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/^already_present user /);
    const other = await ops(
      ["bootstrap-owner", "--email", `x-${address}`],
      `${randomBytes(18).toString("base64url")}\n`,
    );
    expect(other.code).toBe(2);
    expect(other.stdout).toBe("refused: another_owner_exists\n");
  });

  it("refuses an empty stdin and a missing --email", async () => {
    expect((await ops(["bootstrap-owner", "--email", "a@mykey.invalid"], "")).code).toBe(2);
    expect((await ops(["bootstrap-owner"], "x\n")).code).toBe(64);
  });
});
