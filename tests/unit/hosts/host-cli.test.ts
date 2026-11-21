// The pure parts of scripts/host.ts: argument parsing, remote command
// construction and the rule that a pending revert is cancelled only from a
// connection opened after the apply. No network: ssh is an injected runner.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIRM_PROBE,
  REMOTE_API_VERIFY,
  apiBuildCommand,
  applyCommand,
  bootstrapCommands,
  confirmPlan,
  gateOriginOf,
  gateRecordText,
  gateWriteCommand,
  hostEnvSetCommand,
  keyInstallCommand,
  imageEnvKey,
  imageIdFromLoadOutput,
  loadedImageReference,
  maintCommands,
  parseConfirmProbe,
  parseHostArgs,
  usableHost,
  planIncarnation,
  quiesceCommands,
  resumeCommand,
  runConfirm,
  runMaint,
  opsRootToken,
  restoreOrganization,
  restorePasswordPlaces,
  restoreStartCommand,
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
    [["prod", "status"], { host: "prod", command: "status", via: "vpn", json: false }],
    [
      ["staging", "status", "--json"],
      { host: "staging", command: "status", via: "vpn", json: true },
    ],
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

  // Run 2.7 finding: `docker save mykey-api` (no tag) saved two tags; the
  // first one loaded was an older image, and that one was recorded.
  it("takes the one image an archive loads, and refuses an archive with more than one", () => {
    expect(loadedImageReference("Loaded image: mykey-api:latest\n")).toBe("mykey-api:latest");
    const id = `sha256:${"c3".repeat(32)}`;
    expect(loadedImageReference(`Loaded image ID: ${id}\n`)).toBe(id);
    expect(() =>
      loadedImageReference("Loaded image: mykey-api:dev\nLoaded image: mykey-api:latest\n"),
    ).toThrow(/2 images/);
    expect(() => loadedImageReference("nothing\n")).toThrow(/no image/);
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

// Run 6.8: after a restore's snapshot, the host's custody root token is gone
// with the token store it lived in; until restore-verify --open revokes it,
// the restore's own root token is the operator's one valid token.
// Run 6.8: `compose start` reuses containers made before the restore wrote
// the new incarnation and host instance id into host.env; they refused to start.
describe("the restore's start of the executors", () => {
  it("recreates api and provisioner from host.env, never starts the old containers", () => {
    const command = restoreStartCommand();
    expect(command).toContain("--env-file /etc/mykey/host.env");
    expect(command).toMatch(/ up -d --force-recreate --no-deps api provisioner$/);
    expect(command).not.toContain(" start ");
  });
});

// Run 6.8: a restore gives every role a new password; the host jobs read
// maintenance and backup_reader from /etc/mykey/secrets/ops, which kept the old ones.
describe("where a restore keeps each role's new password", () => {
  it("a host service's on the host; the workstation's in custody, and the ops copy on the host too", () => {
    expect(restorePasswordPlaces("api_runtime")).toEqual({
      workstation: false,
      host: ["/etc/mykey/secrets/api/db-password"],
    });
    expect(restorePasswordPlaces("maintenance")).toEqual({
      workstation: true,
      host: ["/etc/mykey/secrets/ops/maintenance"],
    });
    expect(restorePasswordPlaces("backup_reader")).toEqual({
      workstation: true,
      host: ["/etc/mykey/secrets/ops/backup_reader"],
    });
    expect(restorePasswordPlaces("migration_owner")).toEqual({ workstation: true, host: [] });
  });
});

describe("the operator's OpenBao token for ops on a host", () => {
  it("is the restore's root token while a restore waits for its report, else the custody copy", () => {
    const home = mkdtempSync(join(tmpdir(), "mykey-ops-token-"));
    try {
      expect(opsRootToken("drill", home)).toBeNull();
      mkdirSync(join(home, ".mykey", "custody", "drill"), { recursive: true });
      writeFileSync(
        join(home, ".mykey", "custody", "drill", "openbao-init.json"),
        JSON.stringify({ root_token: "custody-token" }),
      );
      expect(opsRootToken("drill", home)).toEqual({ token: "custody-token", from: "custody" });
      mkdirSync(join(home, ".mykey", "secrets", "hosts", "drill"), { recursive: true });
      writeFileSync(
        join(home, ".mykey", "secrets", "hosts", "drill", "restore-root-token"),
        "restore-token\n",
      );
      expect(opsRootToken("drill", home)).toEqual({ token: "restore-token", from: "restore" });
      expect(opsRootToken("staging", home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Run 6.8 (P-125): from "declared lost" until the drill host opens, staging is
// unreachable on purpose: MYKEY_FENCED_HOSTS reaches host.ts's child processes too.
describe("a fenced host", () => {
  it("refuses every connection, command or tunnel, to a host MYKEY_FENCED_HOSTS names", () => {
    const before = process.env.MYKEY_FENCED_HOSTS;
    process.env.MYKEY_FENCED_HOSTS = "staging";
    try {
      expect(() => sshArgs(hosts.staging, "true", { address: "vpn" })).toThrow(/fenced/);
      expect(() =>
        sshArgs(hosts.staging, undefined, {
          address: "vpn",
          forward: "127.0.0.1:1:10.78.2.2:5432",
        }),
      ).toThrow(/fenced/);
      expect(sshArgs(hosts.prod, "true", { address: "vpn" })).toContain("ControlMaster=no");
    } finally {
      if (before === undefined) delete process.env.MYKEY_FENCED_HOSTS;
      else process.env.MYKEY_FENCED_HOSTS = before;
    }
    expect(sshArgs(hosts.staging, "true", { address: "vpn" })).toContain("ControlMaster=no");
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

// Run 6.8 (P-125, D-56): the drill host, and production lent to it.
describe("the drill host and a lent host", () => {
  it("accepts drill as a host, KMS and OpenBao commands included; production's rule stays production's", () => {
    expect(parseHostArgs(["drill", "status"])).toMatchObject({ host: "drill", command: "status" });
    expect(parseHostArgs(["drill", "quiesce"])).toMatchObject({ host: "drill" });
    expect(parseHostArgs(["drill", "kms-use", "drill-1"])).toMatchObject({ host: "drill" });
    expect(parseHostArgs(["drill", "kms-import", "d", "a", "b"])).toMatchObject({ host: "drill" });
    expect(() => parseHostArgs(["prod", "kms-import", "d", "a", "b"])).toThrow(/production/);
    expect(() => parseHostArgs(["other", "status"])).toThrow(/unknown host/);
  });

  it("a host marked lent in hosts.json refuses every command", () => {
    const entry = {
      name: "prod",
      publicIp: "192.0.2.48",
      vpnIp: "10.77.1.1",
      hostname: "prod.example.test",
      sshUser: "ubuntu",
    } as const;
    expect(() => usableHost({ ...entry, lent: true })).toThrow(/lent/);
    expect(usableHost(entry)).toEqual(entry);
    expect(() => usableHost(undefined, "drill")).toThrow(/no drill entry/);
  });
});

describe("quiesce and resume (Run 4.5, P-75)", () => {
  it("parse without arguments (production too since Run 8.0)", () => {
    expect(parseHostArgs(["staging", "quiesce"])).toMatchObject({ command: "quiesce" });
    expect(parseHostArgs(["staging", "resume"])).toMatchObject({ command: "resume" });
    expect(() => parseHostArgs(["staging", "quiesce", "now"])).toThrow();
  });

  it("stop both executors, restart OpenBao; resume starts both and leaves the gate alone", () => {
    const steps = quiesceCommands();
    expect(steps.stop).toMatch(/docker compose .* stop api provisioner$/);
    expect(steps.restartOpenBao).toMatch(/docker compose .* restart openbao$/);
    expect(resumeCommand()).toMatch(/docker compose .* start api provisioner$/);
    expect(resumeCommand()).not.toMatch(/gate/);
  });
});

describe("gate (Run 3.1, P-43)", () => {
  const hostId = "6f1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f";

  it("parses gate open, close and status, and nothing else", () => {
    expect(parseHostArgs(["staging", "gate", "open"])).toMatchObject({
      command: "gate",
      action: "open",
    });
    expect(parseHostArgs(["prod", "gate", "close"])).toMatchObject({
      command: "gate",
      action: "close",
    });
    expect(parseHostArgs(["staging", "gate", "status"])).toMatchObject({
      command: "gate",
      action: "status",
    });
    expect(() => parseHostArgs(["staging", "gate"])).toThrow(/gate/);
    expect(() => parseHostArgs(["staging", "gate", "ajar"])).toThrow(/gate/);
  });

  // Run 6.7 (P-122): v2 needs a verification report to open; close may say verifying.
  it("parses gate open --report <file>, gate close --verifying, and refuses other words", () => {
    expect(parseHostArgs(["staging", "gate", "open", "--report", "r.json"])).toEqual({
      host: "staging",
      via: "vpn",
      command: "gate",
      action: "open",
      report: "r.json",
    });
    expect(parseHostArgs(["staging", "gate", "close", "--verifying"])).toEqual({
      host: "staging",
      via: "vpn",
      command: "gate",
      action: "close",
      verifying: true,
    });
    expect(() => parseHostArgs(["staging", "gate", "open", "--report"])).toThrow(/report/);
    expect(() => parseHostArgs(["staging", "gate", "close", "--report", "r.json"])).toThrow(/gate/);
    expect(() => parseHostArgs(["staging", "gate", "status", "--verifying"])).toThrow(/gate/);
    expect(() => parseHostArgs(["staging", "gate", "open", "--wide"])).toThrow(/gate/);
  });

  // Run 6.7 (P-124): steps 1–7 by `restore`, the report and step 9 by `restore-verify`.
  it("parses restore --source <host> --pair <id> | --newest, and refuses anything else", () => {
    const pair = "0b0e7a52-6b51-4d43-9a1e-61f4a0e3c0d2";
    expect(parseHostArgs(["staging", "restore", "--source", "staging", "--newest"])).toEqual({
      host: "staging",
      via: "vpn",
      command: "restore",
      source: "staging",
      pair: "newest",
    });
    expect(parseHostArgs(["prod", "restore", "--source", "staging", "--pair", pair])).toEqual({
      host: "prod",
      via: "vpn",
      command: "restore",
      source: "staging",
      pair,
    });
    expect(() => parseHostArgs(["staging", "restore", "--newest"])).toThrow(/--source/);
    expect(() => parseHostArgs(["staging", "restore", "--source", "staging"])).toThrow(/--pair/);
    expect(() =>
      parseHostArgs(["staging", "restore", "--source", "staging", "--newest", "--pair", pair]),
    ).toThrow(/--pair/);
    expect(() =>
      parseHostArgs(["staging", "restore", "--source", "staging", "--pair", "latest"]),
    ).toThrow(/pair id/);
    expect(() =>
      parseHostArgs(["staging", "restore", "--source", "elsewhere", "--newest"]),
    ).toThrow(/--source/);
  });

  // Run 6.8: a clean host has no organization file; the API serves the source's.
  it("parses restore --organization <id>, and refuses one that is not an id", () => {
    const org = "e2350312-420b-4fde-84c5-d582a008080b";
    expect(
      parseHostArgs(["drill", "restore", "--source", "staging", "--newest", "--organization", org]),
    ).toEqual({
      host: "drill",
      via: "vpn",
      command: "restore",
      source: "staging",
      pair: "newest",
      organization: org,
    });
    expect(() =>
      parseHostArgs(["drill", "restore", "--source", "staging", "--newest", "--organization", "x"]),
    ).toThrow(/--organization/);
  });

  it("the organization the restored API serves: the host's file, or --organization on a clean host; never two", () => {
    const a = "e2350312-420b-4fde-84c5-d582a008080b";
    const b = "d0a3e52c-7e04-4b5e-94b3-c5693f5bc4eb";
    expect(restoreOrganization(a, null)).toBe(a);
    expect(restoreOrganization(a, a)).toBe(a);
    expect(restoreOrganization(null, b)).toBe(b);
    expect(() => restoreOrganization(a, b)).toThrow(/serves/);
    expect(() => restoreOrganization(null, null)).toThrow(/--organization/);
  });

  it("parses restore-verify --confirm-members <n> with --journey or --owner-confirmed, and --open", () => {
    expect(
      parseHostArgs(["staging", "restore-verify", "--confirm-members", "2", "--journey", "--open"]),
    ).toEqual({
      host: "staging",
      via: "vpn",
      command: "restore-verify",
      confirmMembers: 2,
      journey: "run",
      open: true,
    });
    expect(
      parseHostArgs(["prod", "restore-verify", "--confirm-members", "1", "--owner-confirmed"]),
    ).toEqual({
      host: "prod",
      via: "vpn",
      command: "restore-verify",
      confirmMembers: 1,
      journey: "owner-confirmed",
      open: false,
    });
    expect(() => parseHostArgs(["staging", "restore-verify", "--journey"])).toThrow(
      /--confirm-members/,
    );
    expect(() =>
      parseHostArgs(["staging", "restore-verify", "--confirm-members", "two", "--journey"]),
    ).toThrow(/--confirm-members/);
    expect(() => parseHostArgs(["staging", "restore-verify", "--confirm-members", "2"])).toThrow(
      /--journey or --owner-confirmed/,
    );
    expect(() =>
      parseHostArgs([
        "staging",
        "restore-verify",
        "--confirm-members",
        "2",
        "--journey",
        "--owner-confirmed",
      ]),
    ).toThrow(/--journey or --owner-confirmed/);
  });

  // Run 6.9 (P-128): a release through the closed gate.
  it("parses deploy --release <dir> with --resume, --install-only, --stay-closed and --image", () => {
    const image = `sha256:${"a".repeat(64)}`;
    expect(parseHostArgs(["staging", "deploy", "--release", "r/0.6.0"])).toEqual({
      host: "staging",
      via: "vpn",
      command: "deploy",
      release: "r/0.6.0",
      images: [],
      resume: false,
      installOnly: false,
      stayClosed: false,
      ownerConfirmed: false,
    });
    expect(
      parseHostArgs(["prod", "deploy", "--release", "r", "--stay-closed", "--image", image]),
    ).toMatchObject({ stayClosed: true, images: [image] });
    expect(parseHostArgs(["staging", "deploy", "--release", "r", "--resume"])).toMatchObject({
      resume: true,
    });
    expect(() => parseHostArgs(["staging", "deploy"])).toThrow(/--release/);
    expect(() =>
      parseHostArgs(["staging", "deploy", "--release", "r", "--install-only", "--stay-closed"]),
    ).toThrow(/exclude/);
    expect(() =>
      parseHostArgs(["staging", "deploy", "--release", "r", "--image", "api:1"]),
    ).toThrow(/unexpected/);
  });

  // Run 8.0 Task B (P-147): a host with a real owner is opened by the owner's own journey.
  it("deploy --owner-confirmed parses, and not together with --install-only or --stay-closed", () => {
    expect(
      parseHostArgs(["staging", "deploy", "--release", "r", "--owner-confirmed"]),
    ).toMatchObject({ command: "deploy", ownerConfirmed: true, stayClosed: false });
    expect(parseHostArgs(["staging", "deploy", "--release", "r"])).toMatchObject({
      ownerConfirmed: false,
    });
    expect(
      parseHostArgs(["prod", "deploy", "--release", "r", "--resume", "--owner-confirmed"]),
    ).toMatchObject({ resume: true, ownerConfirmed: true });
    for (const other of ["--install-only", "--stay-closed"]) {
      expect(
        () => parseHostArgs(["staging", "deploy", "--release", "r", "--owner-confirmed", other]),
        other,
      ).toThrow(/exclude/);
    }
  });

  it("prod with the scripted journey is refused before anything is touched", () => {
    for (const argv of [
      ["prod", "deploy", "--release", "r"],
      ["prod", "deploy", "--release", "r", "--resume"],
    ]) {
      expect(() => parseHostArgs(argv), argv.join(" ")).toThrow(/--owner-confirmed/);
    }
    // No journey at all: these touch the host without one.
    expect(parseHostArgs(["prod", "deploy", "--release", "r", "--stay-closed"])).toMatchObject({
      stayClosed: true,
    });
    expect(parseHostArgs(["prod", "deploy", "--release", "r", "--install-only"])).toMatchObject({
      installOnly: true,
    });
  });

  it("a close keeps the origin of a v2 record, and names a fresh install otherwise", () => {
    const origin = { kind: "restore", pairId: "0b0e7a52-6b51-4d43-9a1e-61f4a0e3c0d2" };
    expect(gateOriginOf(JSON.stringify({ version: 2, origin }), hostId)).toEqual(origin);
    expect(gateOriginOf(JSON.stringify({ version: 1, state: "open" }), hostId)).toEqual({
      kind: "fresh_install",
      id: hostId,
    });
    expect(gateOriginOf(null, hostId)).toEqual({ kind: "fresh_install", id: hostId });
    expect(gateOriginOf("garbage", hostId)).toEqual({ kind: "fresh_install", id: hostId });
  });

  it("db-init's incarnation: new when nowhere, copied to where it is missing, refused when they differ", () => {
    const a = "1d3c6f4e-9a1b-4c2d-8e3f-5a6b7c8d9e0f";
    const b = "2e4d7a5f-0b2c-4d3e-9f4a-6b7c8d9e0f1a";
    expect(planIncarnation(null, undefined, () => a)).toEqual({
      incarnation: a,
      writeDatabase: true,
      writeHostEnv: true,
    });
    expect(planIncarnation(null, b, () => a)).toEqual({
      incarnation: b,
      writeDatabase: true,
      writeHostEnv: false,
    });
    expect(planIncarnation(b, undefined, () => a)).toEqual({
      incarnation: b,
      writeDatabase: false,
      writeHostEnv: true,
    });
    expect(planIncarnation(b, b, () => a)).toEqual({
      incarnation: b,
      writeDatabase: false,
      writeHostEnv: false,
    });
    expect(() => planIncarnation(a, b, () => a)).toThrow(/different incarnations/);
    expect(() => planIncarnation(null, "not-a-uuid", () => a)).toThrow(/uuid/);
  });

  it("reads the running API's build from its container, printing nothing else", () => {
    expect(apiBuildCommand()).toBe(
      "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' mykey-api-1 | sed -n 's/^MYKEY_BUILD=//p'",
    );
    expect(REMOTE_API_VERIFY).toEqual({ address: "10.78.2.3", port: 8444 });
  });

  it("writes a v1 record whose epoch follows the previous one", () => {
    const first: unknown = JSON.parse(
      gateRecordText("open", null, hostId, "2026-11-12T10:00:00.000Z"),
    );
    expect(first).toEqual({
      version: 1,
      state: "open",
      gateEpoch: 1,
      hostInstanceId: hostId,
      writtenAt: "2026-11-12T10:00:00.000Z",
    });
    const second: unknown = JSON.parse(
      gateRecordText("closed", JSON.stringify(first), hostId, "2026-11-12T10:01:00.000Z"),
    );
    expect(second).toMatchObject({ state: "closed", gateEpoch: 2 });
    // An unreadable previous record restarts nothing silently: the epoch still rises above 0.
    expect(
      JSON.parse(gateRecordText("open", "garbage", hostId, "2026-11-12T10:02:00.000Z")),
    ).toMatchObject({ gateEpoch: 1 });
  });

  it("refuses a host instance id that is not a uuid", () => {
    expect(() => gateRecordText("open", null, "not-a-uuid", "2026-11-12T10:00:00.000Z")).toThrow();
  });

  it("replaces the record atomically: a temporary file, fsync, rename, fsync of the directory", () => {
    const command = gateWriteCommand();
    const steps = ["cat >", "sync /etc/mykey/gate/gate.json.tmp", "mv -f", "sync /etc/mykey/gate"];
    let at = -1;
    for (const step of steps) {
      const next = command.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    expect(command).toContain("chmod 0644");
  });
});

describe("auth keys and operator commands (Run 3.2)", () => {
  it("installs a key file of a known ring under api-keys, 0600 for the API's uid", () => {
    const command = keyInstallCommand("cookie.k1.key");
    expect(command).toContain("/etc/mykey/secrets/api-keys/cookie.k1.key");
    expect(command).toContain("install -m 0600 -o 1000 -g 1000 /dev/stdin");
    // An existing key on the host is never replaced.
    expect(command.indexOf("test -e")).toBeLessThan(command.indexOf("install -m 0600"));
  });

  it.each([["evil.k1.key"], ["cookie.k01.key"], ["cookie.k1.key/../x"], ["../cookie.k1.key"]])(
    "refuses the key file name %s",
    (name) => {
      expect(() => keyInstallCommand(name)).toThrow();
    },
  );

  it("passes everything after `ops` to the operator tool, flags included", () => {
    expect(parseHostArgs(["staging", "ops", "bootstrap-owner", "--email", "a@b.invalid"])).toEqual({
      host: "staging",
      via: "vpn",
      command: "ops",
      argv: ["bootstrap-owner", "--email", "a@b.invalid"],
    });
    expect(() => parseHostArgs(["staging", "ops"])).toThrow(/ops/);
  });

  it("parses keys init", () => {
    expect(parseHostArgs(["staging", "keys", "init"])).toMatchObject({ command: "keys" });
    expect(() => parseHostArgs(["staging", "keys", "rotate"])).toThrow(/keys/);
  });
});
