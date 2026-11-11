// The pure parts of scripts/host.ts: argument parsing, remote command
// construction and the rule that a pending revert is cancelled only from a
// connection opened after the apply. No network: ssh is an injected runner.
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIRM_PROBE,
  applyCommand,
  bootstrapCommands,
  confirmPlan,
  hostEnvSetCommand,
  imageEnvKey,
  imageIdFromLoadOutput,
  maintCommands,
  parseConfirmProbe,
  parseHostArgs,
  runConfirm,
  runMaint,
} from "../../../scripts/host.ts";
import {
  setSshRunner,
  sshArgs,
  type HostEntry,
  type SshResult,
  type SshRunner,
} from "../../harness/staging.ts";

const hosts: { region: string; prod: HostEntry; staging: HostEntry } = {
  region: "test-region",
  prod: {
    name: "prod",
    publicIp: "192.0.2.48",
    vpnIp: "10.77.1.1",
    hostname: "prod.example.test",
    sshUser: "ubuntu",
  },
  staging: {
    name: "staging",
    publicIp: "192.0.2.50",
    vpnIp: "10.77.2.1",
    hostname: "staging.example.test",
    sshUser: "ubuntu",
  },
};

const ok = (stdout = ""): SshResult => ({ code: 0, stdout, stderr: "" });

/** A runner answering each call in turn and recording the arguments. */
function scripted(answers: SshResult[]) {
  const calls: string[][] = [];
  const runner: SshRunner = (args) => {
    calls.push(args);
    return Promise.resolve(answers[calls.length - 1] ?? ok());
  };
  return { calls, runner };
}

afterEach(() => {
  setSshRunner(undefined);
});

describe("parseHostArgs", () => {
  it.each([
    [["staging", "bootstrap"], { host: "staging", command: "bootstrap", via: "public" }],
    [["prod", "push"], { host: "prod", command: "push", via: "vpn" }],
    [["prod", "push", "--public"], { host: "prod", command: "push", via: "public" }],
    [["staging", "apply", "ssh"], { host: "staging", command: "apply", target: "ssh", via: "vpn" }],
    [
      ["staging", "apply", "firewall", "--public"],
      { host: "staging", command: "apply", target: "firewall", via: "public" },
    ],
    [["staging", "confirm"], { host: "staging", command: "confirm", via: "vpn" }],
    [
      ["staging", "image", "api", "C:/some dir/api.tar"],
      { host: "staging", command: "image", name: "api", tar: "C:/some dir/api.tar", via: "vpn" },
    ],
    [
      ["staging", "maint", "15", "--", "docker", "pull", "traefik@sha256:abc"],
      {
        host: "staging",
        command: "maint",
        minutes: 15,
        argv: ["docker", "pull", "traefik@sha256:abc"],
        via: "vpn",
      },
    ],
    [["staging", "up"], { host: "staging", command: "up", via: "vpn" }],
    [["staging", "db-init"], { host: "staging", command: "db-init", via: "vpn" }],
    [["prod", "status"], { host: "prod", command: "status", via: "vpn" }],
  ])("parses %j", (argv, expected) => {
    expect(parseHostArgs(argv)).toEqual(expected);
  });

  it.each([
    [[], /usage/],
    [["dev", "push"], /host/],
    [["staging"], /usage/],
    [["staging", "reboot"], /unknown command/],
    [["staging", "apply"], /firewall\|ssh/],
    [["staging", "apply", "docker"], /firewall\|ssh/],
    [["staging", "image", "API", "x.tar"], /image name/],
    [["staging", "image", "api"], /usage/],
    [["staging", "maint", "15", "docker", "pull"], /--/],
    [["staging", "maint", "0", "--", "true"], /minutes/],
    [["staging", "maint", "61", "--", "true"], /minutes/],
    [["staging", "maint", "15", "--"], /command/],
    [["staging", "push", "--force"], /unknown option/],
    [["staging", "status", "extra"], /usage/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseHostArgs(argv)).toThrow(message);
  });
});

describe("remote command construction", () => {
  it("applies a network change through apply-with-revert.sh with a 300 s revert", () => {
    for (const target of ["firewall", "ssh"] as const) {
      const command = applyCommand(target);
      expect(command).toMatch(/^\/opt\/mykey\/hosts\/firewall\/apply-with-revert\.sh /);
      expect(command).toContain(` ${target} `);
      expect(command).toMatch(/ 300$/);
    }
  });

  it("names the image variable after the image and accepts only an image id", () => {
    expect(imageEnvKey("api")).toBe("API_IMAGE");
    expect(imageEnvKey("probe-agent")).toBe("PROBE_AGENT_IMAGE");
    const id = `sha256:${"a1".repeat(32)}`;
    expect(imageIdFromLoadOutput(`Loaded image ID: ${id}\n`)).toBe(id);
    expect(imageIdFromLoadOutput("Loaded image: mykey/api:dev\n")).toBeUndefined();
  });

  it("sets one key of host.env in place", () => {
    const id = `sha256:${"b2".repeat(32)}`;
    const command = hostEnvSetCommand("API_IMAGE", id);
    expect(command).toContain("/etc/mykey/host.env");
    expect(command).toContain("API_IMAGE");
    expect(command).toContain(id);
    expect(() => hostEnvSetCommand("api image", id)).toThrow();
    expect(() => hostEnvSetCommand("API_IMAGE", "x'; rm -rf /")).toThrow();
  });

  it("quotes every word of a maintenance command and closes the window with the egress script", () => {
    const commands = maintCommands(15, ["docker", "pull", "it's"]);
    expect(commands.open).toBe("/opt/mykey/hosts/firewall/mykey-egress.sh maint 15");
    expect(commands.run).toBe(`'docker' 'pull' 'it'\\''s'`);
    expect(commands.close).toBe("/opt/mykey/hosts/firewall/mykey-egress.sh maint-end");
  });

  it("closes the maintenance window even when the command fails", async () => {
    const { calls, runner } = scripted([
      ok(),
      { code: 7, stdout: "", stderr: "pull failed" },
      ok(),
    ]);
    setSshRunner(runner);
    const code = await runMaint(hosts.staging, 5, ["docker", "pull", "x"], {
      address: "vpn",
      log: { info: () => undefined, error: () => undefined },
    });
    expect(code).toBe(7);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.at(-1)).toContain("maint-end");
  });

  it("bootstraps with the WireGuard values of the host and leaves sshd to `apply ssh`", () => {
    const commands = bootstrapCommands("staging", hosts, "WORKSTATIONPUBLICKEY=");
    const joined = commands.join("\n");
    expect(joined).toContain("10-packages.sh");
    expect(joined).toContain("20-wireguard.sh");
    expect(joined).toContain("40-sysctl.sh");
    expect(joined).toContain("50-docker.sh");
    expect(joined).not.toContain("30-ssh.sh");
    expect(joined).toContain("WG_ADDRESS=10.77.2.1/24");
    expect(joined).toContain("WG_PEER_ADDRESS=10.77.2.10/32");
    expect(joined).toContain("WG_PEER_PUBLIC_KEY='WORKSTATIONPUBLICKEY='");
  });
});

describe("confirm", () => {
  it("never reuses a connection: every ssh call disables multiplexing", () => {
    const args = sshArgs(hosts.staging, "true", { address: "vpn" });
    expect(args).toContain("ControlMaster=no");
    expect(args).toContain("ControlPath=none");
  });

  it("cancels the reverts that were started before this connection was opened", () => {
    const probe = parseConfirmProbe(
      "connection 5000000\npending mykey-revert-ssh.timer 4000000\npending mykey-revert-firewall.timer 4500000\n",
    );
    expect(confirmPlan(probe)).toEqual({
      cancel: ["mykey-revert-ssh.timer", "mykey-revert-firewall.timer"],
    });
  });

  it("refuses when the connection is not newer than the apply", () => {
    const probe = parseConfirmProbe("connection 4000000\npending mykey-revert-ssh.timer 4000000\n");
    const plan = confirmPlan(probe);
    expect("refuse" in plan && plan.refuse).toMatch(/mykey-revert-ssh/);
  });

  it("refuses when a pending revert has no recorded start time", () => {
    const plan = confirmPlan(
      parseConfirmProbe("connection 5000000\npending mykey-revert-ssh.timer 0\n"),
    );
    expect("refuse" in plan).toBe(true);
  });

  it("refuses when nothing is pending", () => {
    const plan = confirmPlan(parseConfirmProbe("connection 5000000\n"));
    expect("refuse" in plan && plan.refuse).toMatch(/no pending revert/);
  });

  it("rejects a malformed probe answer and an unexpected unit name", () => {
    expect(() => parseConfirmProbe("")).toThrow();
    expect(() => parseConfirmProbe("connection x\n")).toThrow();
    expect(() => parseConfirmProbe("connection 5\npending ssh.service 1\n")).toThrow();
  });

  it("probes without sudo, then stops the timers in a second, new connection", async () => {
    const { calls, runner } = scripted([
      ok("connection 9000000\npending mykey-revert-ssh.timer 1000000\n"),
      ok(),
    ]);
    setSshRunner(runner);
    const log = { info: () => undefined, error: () => undefined };
    await expect(runConfirm(hosts.staging, { address: "vpn", log })).resolves.toEqual([
      "mykey-revert-ssh.timer",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.at(-1)).toBe(CONFIRM_PROBE);
    expect(calls[1]!.at(-1)).toContain("systemctl stop");
    expect(calls[1]!.at(-1)).toContain("mykey-revert-ssh.timer");
    expect(calls[1]!.at(-1)).toMatch(/^sudo -n /);
  });

  it("stops nothing when the probe refuses", async () => {
    const { calls, runner } = scripted([ok("connection 1\npending mykey-revert-ssh.timer 2\n")]);
    setSshRunner(runner);
    const log = { info: () => undefined, error: () => undefined };
    await expect(runConfirm(hosts.staging, { address: "vpn", log })).rejects.toThrow(
      /mykey-revert-ssh/,
    );
    expect(calls).toHaveLength(1);
  });
});
