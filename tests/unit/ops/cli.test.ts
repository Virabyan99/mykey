// Run 3.2 Task A: the operator tool's frame. Commands take no secret as an
// argument; an unknown command is a usage error (exit 64).
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { OPS_COMMANDS, runOps, type OpsIo } from "@mykey/ops";

function io(): { io: OpsIo; out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
  stdout.on("data", (chunk: Buffer) => chunks.out.push(chunk));
  stderr.on("data", (chunk: Buffer) => chunks.err.push(chunk));
  const stdin = new PassThrough();
  stdin.end();
  return {
    io: { stdin, stdout, stderr, env: {} },
    out: () => Buffer.concat(chunks.out).toString("utf8"),
    err: () => Buffer.concat(chunks.err).toString("utf8"),
  };
}

describe("runOps", () => {
  it("answers an unknown command with exit 64 and the usage", async () => {
    const run = io();
    expect(await runOps(["no-such-command"], run.io)).toBe(64);
    expect(run.err()).toMatch(/usage/i);
    for (const command of OPS_COMMANDS) expect(run.err()).toContain(command);
  });

  it("answers no command at all with exit 64", async () => {
    const run = io();
    expect(await runOps([], run.io)).toBe(64);
  });

  it.each(OPS_COMMANDS.map((command) => [command]))(
    "%s refuses a flag named --password (a secret is never an argument)",
    async (command) => {
      const run = io();
      expect(await runOps([command, "--password", "x"], run.io)).toBe(64);
      expect(run.err()).toMatch(/--password/);
      expect(run.err().includes(" x")).toBe(false);
    },
  );

  it("refuses an unknown flag and a flag without a value", async () => {
    const run = io();
    expect(await runOps(["bootstrap-owner", "--colour", "red"], run.io)).toBe(64);
    expect(await runOps(["bootstrap-owner", "--email"], run.io)).toBe(64);
  });
});
