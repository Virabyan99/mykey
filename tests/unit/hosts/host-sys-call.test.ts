// Run 10.2 Task A (D-73, R4-2): generate-root's host path. `hostSysCall` sends
// one sys/ call to a host's OpenBao by curl on the host, with the restore's root
// token. Its exec is injected here, so the test sees exactly what would cross
// SSH: the token and the body on stdin only, the header file removed whatever
// curl does, the status read from the last line. Its run on staging is
// tests/staging/host-sys-call.staging.test.ts.
import { describe, expect, it } from "vitest";
import { hostSysCall, type HostExec } from "../../../scripts/host.ts";
import type { HostEntry } from "@mykey/ops/remote";

const HOST = { name: "staging" } as unknown as HostEntry;
const TOKEN = `s.${"T".repeat(24)}`;
const KEY = "recovery-key-of-the-test";

interface Call {
  command: string;
  options: Parameters<HostExec>[2];
}

function fakeExec(answer: { code: number; stdout: string }): { exec: HostExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec = ((_host: HostEntry, command: string, options: Parameters<HostExec>[2]) => {
    calls.push({ command, options });
    return Promise.resolve({ code: answer.code, stdout: answer.stdout, stderr: "" });
  }) as unknown as HostExec;
  return { exec, calls };
}

describe("hostSysCall (generate-root's host path)", () => {
  it("the token and the body travel on stdin only: the command text holds neither, stdin's first line is the token header, and the call asks for sudo and secretOutput", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: '{"data":{}}\n200' });
    const call = hostSysCall(HOST, "vpn", TOKEN, exec);
    await call("POST", "sys/generate-root-token/update", { key: KEY, nonce: "n-1" });
    expect(calls).toHaveLength(1);
    const { command, options } = calls[0]!;
    expect(command).not.toContain(TOKEN);
    expect(command).not.toContain(KEY);
    const stdin = String(options?.stdin ?? "");
    const [first, ...rest] = stdin.split("\n");
    expect(first).toBe(`X-Vault-Token: ${TOKEN}`);
    expect(JSON.parse(rest.join("\n"))).toEqual({ key: KEY, nonce: "n-1" });
    expect(options?.sudo).toBe(true);
    expect(options?.secretOutput).toBe(true);
    expect(options?.address).toBe("vpn");
    expect(command).toContain("--data-binary @-");
    expect(command).toContain("https://openbao:8200/v1/sys/generate-root-token/update");
  });

  it("a call without a body sends the header only and no data", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: "\n204" });
    await hostSysCall(HOST, "vpn", TOKEN, exec)("DELETE", "sys/generate-root-token/attempt");
    expect(String(calls[0]?.options?.stdin)).toBe(`X-Vault-Token: ${TOKEN}\n`);
    expect(calls[0]?.command).not.toContain("--data-binary");
    expect(calls[0]?.command).toContain("-X DELETE");
  });

  it("the command removes its header file whatever curl answers", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: "\n204" });
    await hostSysCall(HOST, "vpn", TOKEN, exec)("DELETE", "sys/generate-root-token/attempt");
    const command = calls[0]?.command ?? "";
    expect(command).toMatch(/^umask 077 && h=\$\(mktemp\)/);
    // curl's status is kept, the file removed, then that status is the exit.
    expect(command).toMatch(/; rc=\$\?; rm -f "\$h"; exit \$rc$/);
  });

  it("the last line of the answer is the HTTP status, what precedes it is the parsed body, and an empty body is null", async () => {
    const withBody = fakeExec({ code: 0, stdout: '{"data":{"nonce":"n","otp":"o"}}\n200\n' });
    expect(await hostSysCall(HOST, "vpn", TOKEN, withBody.exec)("POST", "sys/x", {})).toEqual({
      status: 200,
      body: { data: { nonce: "n", otp: "o" } },
    });
    const empty = fakeExec({ code: 0, stdout: "\n204" });
    expect(await hostSysCall(HOST, "vpn", TOKEN, empty.exec)("DELETE", "sys/x")).toEqual({
      status: 204,
      body: null,
    });
  });

  it("a curl failure throws an error that names the path and holds no token", async () => {
    const { exec } = fakeExec({ code: 7, stdout: "" });
    const failed = hostSysCall(
      HOST,
      "vpn",
      TOKEN,
      exec,
    )("POST", "sys/generate-root-token/attempt", {});
    await expect(failed).rejects.toThrow(/sys\/generate-root-token\/attempt: curl exit 7/);
    await failed.catch((error: unknown) => {
      expect(String(error)).not.toContain(TOKEN);
    });
  });
});
