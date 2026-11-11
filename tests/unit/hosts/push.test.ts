// Review focus 5: files written on Windows must not break on Linux.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPushFiles,
  pushFiles,
  pushScript,
  readbackScript,
  verifyReadback,
  type PushFile,
} from "../../../scripts/host.ts";
import { setSshRunner, sshArgs, type HostEntry, type SshRunner } from "../../harness/staging.ts";

const roots: string[] = [];

/** A temporary repository root holding the given files (relative path → content). */
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mykey-push-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

const staging: HostEntry = {
  name: "staging",
  publicIp: "192.0.2.50",
  vpnIp: "10.77.2.1",
  hostname: "staging.example.test",
  sshUser: "ubuntu",
};

const LAYOUT = {
  "infra/hosts/bootstrap/10-packages.sh": "#!/bin/sh\nset -eu\n",
  "infra/hosts/firewall/mykey.nft": "table inet mykey {\n}\n",
  "infra/hosts/checks/with space.conf": "a = 1\n",
  "infra/hosts/.gitkeep": "",
  "infra/compose/host.compose.yml": "services: {}\n",
  "infra/compose/host/pki-init.sh": "#!/bin/sh\n",
  "infra/compose/host/postgresql.conf": "ssl = on\n",
  "infra/compose/dev.compose.yml": "services: {}\n",
  "infra/compose/dev/pki-init.sh": "#!/bin/sh\n",
};

afterEach(() => {
  setSshRunner(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collectPushFiles", () => {
  it("maps infra/hosts/** and infra/compose/host* to /opt/mykey and nothing else", () => {
    const files = collectPushFiles(repoWith(LAYOUT));
    expect(files.map((file) => file.remotePath).sort()).toEqual([
      "/opt/mykey/compose/host.compose.yml",
      "/opt/mykey/compose/host/pki-init.sh",
      "/opt/mykey/compose/host/postgresql.conf",
      "/opt/mykey/hosts/bootstrap/10-packages.sh",
      "/opt/mykey/hosts/checks/with space.conf",
      "/opt/mykey/hosts/firewall/mykey.nft",
    ]);
  });

  it("gives every file an explicit owner and mode: scripts 0755, everything else 0644", () => {
    const files = collectPushFiles(repoWith(LAYOUT));
    for (const file of files) {
      expect(file.owner).toBe("root");
      expect(file.group).toBe("root");
      expect(file.mode).toBe(file.remotePath.endsWith(".sh") ? 0o755 : 0o644);
    }
  });

  it("rejects a file containing a carriage return and names every such file", () => {
    const root = repoWith({
      ...LAYOUT,
      "infra/hosts/bootstrap/20-wireguard.sh": "#!/bin/sh\r\nset -eu\r\n",
      "infra/compose/host/pg_hba.conf": "hostssl all all 0.0.0.0/0 scram-sha-256\r",
    });
    let message = "";
    try {
      collectPushFiles(root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("carriage return");
    expect(message).toContain("infra/hosts/bootstrap/20-wireguard.sh");
    expect(message).toContain("infra/compose/host/pg_hba.conf");
  });

  it("rejects a malformed egress-names.conf before anything is pushed", () => {
    const root = repoWith({
      ...LAYOUT,
      "infra/hosts/firewall/egress-names.conf": "acme *.example\n",
    });
    expect(() => collectPushFiles(root)).toThrow(/egress-names\.conf/);
  });
});

describe("the push over ssh", () => {
  it("passes a key path with a space and the whole remote command as single arguments", () => {
    const args = sshArgs(staging, "sh -s", {
      address: "vpn",
      paths: { key: "C:/Users/some one/.mykey/ssh/key", knownHosts: "C:/Users/some one/kh" },
    });
    expect(args).toContain("C:/Users/some one/.mykey/ssh/key");
    expect(args).toContain('UserKnownHostsFile="C:/Users/some one/kh"');
    expect(args).toContain(`HostKeyAlias=${staging.publicIp}`);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args.at(-2)).toBe(staging.vpnIp);
    expect(args.at(-1)).toBe("sh -s");
  });

  it("quotes a remote path with a space as one shell word and sets owner and mode explicitly", () => {
    const files = collectPushFiles(repoWith(LAYOUT));
    const script = pushScript(files);
    expect(script).toContain("'/opt/mykey/hosts/checks/with space.conf'");
    expect(script).toMatch(
      /install -D -o root -g root -m 0644 [^\n]*'\/opt\/mykey\/hosts\/checks\/with space\.conf'/,
    );
    expect(script).toMatch(
      /install -D -o root -g root -m 0755 [^\n]*'\/opt\/mykey\/hosts\/bootstrap\/10-packages\.sh'/,
    );
    expect(script).not.toContain("\r");
  });

  it("reads owner, mode and content back and reports every mismatch by name", () => {
    const files = collectPushFiles(repoWith(LAYOUT));
    const good = files.map((file) => `root:root:${file.mode.toString(8)} ${file.sha256}`);
    expect(verifyReadback(files, `${good.join("\n")}\n`)).toEqual([]);

    const bad = [...good];
    const index = files.findIndex((file) => file.remotePath.endsWith("mykey.nft"));
    bad[index] = `root:root:666 ${files[index]!.sha256}`;
    const problems = verifyReadback(files, bad.join("\n"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/opt/mykey/hosts/firewall/mykey.nft");

    expect(verifyReadback(files, good.slice(1).join("\n")).length).toBeGreaterThan(0);
  });

  it("pushFiles installs over stdin, then reads back in a second call and fails on a mismatch", async () => {
    const files = collectPushFiles(repoWith(LAYOUT));
    const calls: { args: string[]; stdin: string }[] = [];
    const answers =
      (wrongMode: boolean): SshRunner =>
      (args, io) => {
        const stdin = typeof io.stdin === "string" ? io.stdin : "";
        calls.push({ args, stdin });
        if (stdin === readbackScript(files)) {
          const lines = files.map(
            (file: PushFile, i) =>
              `root:root:${wrongMode && i === 0 ? "600" : file.mode.toString(8)} ${file.sha256}`,
          );
          return Promise.resolve({ code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      };

    setSshRunner(answers(false));
    await pushFiles(staging, files, { address: "vpn" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.stdin).toBe(pushScript(files));
    expect(calls[1]!.stdin).toBe(readbackScript(files));

    calls.length = 0;
    setSshRunner(answers(true));
    await expect(pushFiles(staging, files, { address: "vpn" })).rejects.toThrow(
      files[0]!.remotePath,
    );
  });

  it("records the SHA-256 of the exact bytes pushed", () => {
    const files = collectPushFiles(repoWith(LAYOUT));
    for (const file of files) {
      expect(file.sha256).toBe(createHash("sha256").update(file.content).digest("hex"));
    }
  });
});
