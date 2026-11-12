// Review focus 2: a secret must not reach the transcript through a remote command.
// Every canary is assembled at run time; none is written literally in this file.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../../scripts/host.ts";
import {
  SshError,
  expectSuccess,
  redact,
  registerSecret,
  setSshRunner,
  sshExec,
  type HostEntry,
  type SshRunner,
} from "../../harness/staging.ts";

const canary = (): string => `MYKEY_CANARY_${randomBytes(16).toString("hex")}`;

const staging: HostEntry = {
  name: "staging",
  publicIp: "192.0.2.50",
  vpnIp: "10.77.2.1",
  hostname: "staging.example.test",
  sshUser: "ubuntu",
};

/** A runner that records every call and answers with a fixed result. */
function recordingRunner(answer: { code: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  const runner: SshRunner = (args) => {
    calls.push(args);
    return Promise.resolve(answer);
  };
  return { calls, runner };
}

afterEach(() => {
  setSshRunner(undefined);
});

describe("redact", () => {
  it("replaces every registered secret, wherever it appears", () => {
    const secret = canary();
    registerSecret(secret);
    const text = `before ${secret} middle ${secret}after`;
    expect(redact(text)).toBe("before [redacted] middle [redacted]after");
    expect(redact(text)).not.toContain(secret);
  });

  it("leaves text without a registered secret unchanged", () => {
    expect(redact("nothing to hide here")).toBe("nothing to hide here");
  });
});

describe("the host.ts logger", () => {
  it("writes registered secrets as [redacted], on stdout and on stderr", () => {
    const secret = canary();
    registerSecret(secret);
    const out: string[] = [];
    const err: string[] = [];
    const log = createLogger({
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    log.info(`token=${secret}`);
    log.error(`failed with ${secret}`);
    expect(out.join("")).toContain("token=[redacted]");
    expect(err.join("")).toContain("failed with [redacted]");
    expect(out.join("") + err.join("")).not.toContain(secret);
  });

  it("redacts the output of a secretOutput command it is given, without a manual registration", async () => {
    const secret = canary();
    const { runner } = recordingRunner({ code: 0, stdout: `${secret}\n`, stderr: "" });
    setSshRunner(runner);
    const result = await sshExec(staging, "cat /etc/mykey/secrets/postgres/superuser-password", {
      sudo: true,
      secretOutput: true,
    });
    expect(result.stdout.trim()).toBe(secret);
    const out: string[] = [];
    const log = createLogger({ out: (text) => out.push(text), err: (text) => out.push(text) });
    log.info(`read: ${result.stdout}`);
    expect(out.join("")).not.toContain(secret);
    expect(out.join("")).toContain("[redacted]");
  });
});

describe("errors built from sshExec", () => {
  it("a failed command yields an Error whose message has the secret redacted", async () => {
    const secret = canary();
    registerSecret(secret);
    const { runner } = recordingRunner({
      code: 3,
      stdout: secret,
      stderr: `bad value ${secret}\n`,
    });
    setSshRunner(runner);
    const result = await sshExec(staging, "false");
    expect(result.code).toBe(3);
    let thrown: unknown;
    try {
      expectSuccess(result, "the check");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SshError);
    const error = thrown as SshError;
    expect(error.kind).toBe("exit");
    expect(error.message).toContain("the check");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(secret);
  });

  it("the stderr of a failed secretOutput command never reaches the message", async () => {
    const secret = canary();
    const { runner } = recordingRunner({ code: 1, stdout: "", stderr: secret });
    setSshRunner(runner);
    const result = await sshExec(staging, "cat /root/mykey-custody/init.json", {
      sudo: true,
      secretOutput: true,
    });
    expect(() => expectSuccess(result, "reading custody")).toThrow(SshError);
    try {
      expectSuccess(result, "reading custody");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("a timeout rejects with kind 'timeout' (outcome unknown), distinct from a non-zero exit", async () => {
    let aborted = false;
    const hanging: SshRunner = (_args, io) =>
      new Promise((resolve) => {
        io.signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ code: -1, stdout: "", stderr: "late output" });
        });
      });
    setSshRunner(hanging);
    const outcome = sshExec(staging, "sleep 100", { timeoutMs: 50 });
    await expect(outcome).rejects.toBeInstanceOf(SshError);
    await expect(outcome).rejects.toMatchObject({ kind: "timeout" });
    await expect(outcome).rejects.toThrow(/outcome unknown/);
    expect(aborted).toBe(true);
  });
});

describe("sshExec refuses secret paths", () => {
  it.each([
    "cat /etc/mykey/secrets/x",
    "ls -l /etc/mykey/secrets",
    "cat /etc//mykey/./secrets/x",
    "cd /etc/mykey && cat secrets/x",
    "cat /root/mykey-custody/init.json",
  ])("rejects %j without secretOutput, before connecting", async (command) => {
    const { calls, runner } = recordingRunner({ code: 0, stdout: "", stderr: "" });
    setSshRunner(runner);
    const outcome = sshExec(staging, command, { sudo: true });
    await expect(outcome).rejects.toBeInstanceOf(SshError);
    await expect(outcome).rejects.toMatchObject({ kind: "refused" });
    expect(calls).toHaveLength(0);
  });

  it("also rejects a script on stdin that mentions a secret path", async () => {
    const { calls, runner } = recordingRunner({ code: 0, stdout: "", stderr: "" });
    setSshRunner(runner);
    const outcome = sshExec(staging, "sh -s", { stdin: "cat /etc/mykey/secrets/x\n" });
    await expect(outcome).rejects.toMatchObject({ kind: "refused" });
    expect(calls).toHaveLength(0);
  });

  it("connects when secretOutput is true", async () => {
    const { calls, runner } = recordingRunner({ code: 0, stdout: "", stderr: "" });
    setSshRunner(runner);
    await sshExec(staging, "test -d /etc/mykey/secrets", { sudo: true, secretOutput: true });
    expect(calls).toHaveLength(1);
  });
});
