// Run 6.7 Task C (P-124): the host target's parts that need no host. The
// whole host restore is the drill's (Run 6.8); here, with a fake shell: where
// credentials go, that only this host's organization is delivered, that the
// state line round-trips, and that a host with an open gate is refused.
import { describe, expect, it } from "vitest";
import {
  deliveryFiles,
  ensureSourceBackupPassword,
  hostRestoreTarget,
  pairPrefixFor,
  restoreStateCommand,
  type HostIo,
} from "../../../scripts/host-restore.ts";

const ORG = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

function fakeIo(gate: string | null): { io: HostIo; ran: { command: string; stdin?: string }[] } {
  const ran: { command: string; stdin?: string }[] = [];
  let state = "";
  const io: HostIo = {
    exec: (command, opts = {}) => {
      const stdin = typeof opts.stdin === "string" ? opts.stdin : undefined;
      ran.push({ command, ...(stdin === undefined ? {} : { stdin }) });
      if (command.startsWith("cat /etc/mykey/gate/")) {
        return Promise.resolve(gate === null ? { code: 1, stdout: "" } : { code: 0, stdout: gate });
      }
      if (command === restoreStateCommand().write) state = stdin ?? "";
      if (command === restoreStateCommand().read)
        return Promise.resolve({ code: 0, stdout: state });
      return Promise.resolve({ code: 0, stdout: "" });
    },
    tunnel: () => Promise.resolve({ localPort: 1, close: () => Promise.resolve() }),
    caCertPath: "ca.crt",
    superuserPassword: "unused",
    pairRootToken: "unused",
    rootTokens: () => [],
    keepRootToken: () => Promise.resolve(),
    sourceBackupPassword: "unused",
    kmsKeyUsable: () => Promise.resolve(true),
    keepPassword: () => Promise.resolve(),
    setHostEnv: () => Promise.resolve(),
    startExecutors: () => Promise.resolve("abcdef012345"),
    organizationId: ORG,
    log: () => undefined,
  };
  return { io, ran };
}

const store = {
  list: () => Promise.resolve([]),
  head: () => Promise.resolve(null),
  get: () => Promise.reject(new Error("unused")),
} as unknown as Parameters<typeof hostRestoreTarget>[1]["store"];
const pair = { store, prefix: "pairs/staging/x/", trust: new Map() };

describe("the host restore target (P-124)", () => {
  it("each AppRole's credential goes where its service reads it", () => {
    expect(deliveryFiles("runtime")).toEqual({
      roleId: "/etc/mykey/secrets/api/runtime-role-id",
      secretId: "/etc/mykey/secrets/api/runtime-secret-id",
      owner: "1000:1000",
    });
    expect(deliveryFiles("provisioner").secretId).toBe(
      "/etc/mykey/secrets/provisioner/provisioner-secret-id",
    );
    expect(deliveryFiles("backup").roleId).toBe("/etc/mykey/secrets/backup-approle/role-id");
  });

  it("delivers this host's organization and the root's backup role, on stdin with output redacted; nothing else", async () => {
    const { io, ran } = fakeIo(null);
    const target = await hostRestoreTarget(io, pair);
    const credential = { roleId: "role-x", secretId: "secret-y" };
    await target.deliver(`org-${ORG}`, "runtime", credential);
    await target.deliver("", "backup", credential);
    await target.deliver("org-7a7a7a7a-0000-4000-8000-000000000000", "runtime", credential);
    await target.deliver("", "runtime", credential);
    const installs = ran.filter((r) => r.command.includes("/dev/stdin"));
    expect(installs[0]?.stdin).toBe(ORG);
    // Run 6.8: with the runtime credential, the organization it belongs to (a
    // clean host has no such file; the API reads it first).
    expect(installs.map((r) => r.command.split(" ").at(-1))).toEqual([
      "/etc/mykey/secrets/api/organization-id",
      "/etc/mykey/secrets/api/runtime-role-id",
      "/etc/mykey/secrets/api/runtime-secret-id",
      "/etc/mykey/secrets/backup-approle/role-id",
      "/etc/mykey/secrets/backup-approle/secret-id",
    ]);
    expect(installs.map((r) => r.stdin)).toEqual([ORG, "role-x", "secret-y", "role-x", "secret-y"]);
    for (const r of installs) expect(r.command).not.toContain("secret-y");
    await target.close();
  });

  it("the provisioner's credential goes beside the organization id too (Run 10.6: a clean host's provisioner deferred every job)", async () => {
    const { io, ran } = fakeIo(null);
    const target = await hostRestoreTarget(io, pair);
    await target.deliver(`org-${ORG}`, "provisioner", { roleId: "role-p", secretId: "secret-p" });
    const installs = ran.filter((r) => r.command.includes("/dev/stdin"));
    expect(installs.map((r) => r.command.split(" ").at(-1))).toEqual([
      "/etc/mykey/secrets/provisioner/organization-id",
      "/etc/mykey/secrets/provisioner/provisioner-role-id",
      "/etc/mykey/secrets/provisioner/provisioner-secret-id",
    ]);
    expect(installs.map((r) => r.stdin)).toEqual([ORG, "role-p", "secret-p"]);
    await target.close();
  });

  it("the state line round-trips on the host", async () => {
    const { io } = fakeIo(null);
    const target = await hostRestoreTarget(io, pair);
    expect(await target.state.read()).toBeNull();
    await target.state.write({ pairId: "p", step: "postgres" });
    expect(await target.state.read()).toEqual({ pairId: "p", step: "postgres" });
    await target.close();
  });

  it("a host whose gate is open is refused before anything else is asked", async () => {
    const { io } = fakeIo(JSON.stringify({ version: 2, state: "open" }));
    const target = await hostRestoreTarget(io, pair);
    expect(await target.holding()).toEqual({ why: "the gate is open", serving: true });
    await target.close();
  });

  it("--pair finds its prefix among the eligible pairs of the source; an unknown id is null", async () => {
    const id = "0b0e7a52-6b51-4d43-9a1e-61f4a0e3c0d2";
    const listing = {
      list: () =>
        Promise.resolve([
          { key: `pairs/staging/20261117T033000Z-${id}/eligible.json` },
          { key: `pairs/staging/20261117T033000Z-${id}/manifest.json` },
          {
            key: "pairs/staging/20261116T033000Z-1b1e7a52-6b51-4d43-9a1e-61f4a0e3c0d2/eligible.json",
          },
        ]),
    } as unknown as Parameters<typeof pairPrefixFor>[0];
    expect(await pairPrefixFor(listing, "staging", id)).toBe(
      `pairs/staging/20261117T033000Z-${id}/`,
    );
    expect(
      await pairPrefixFor(listing, "staging", "2b1e7a52-6b51-4d43-9a1e-61f4a0e3c0d2"),
    ).toBeNull();
  });
});

// Run 6.8: restic opens the pair with the source host's backup password; a
// clean host has none. It comes from the workstation custody, on stdin only.
describe("the source's backup password on the target", () => {
  const run = (code: number) => {
    const ran: { command: string; stdin?: string; secretOutput?: boolean }[] = [];
    const exec: HostIo["exec"] = (command, opts = {}) => {
      ran.push({
        command,
        ...(typeof opts.stdin === "string" ? { stdin: opts.stdin } : {}),
        ...(opts.secretOutput === undefined ? {} : { secretOutput: opts.secretOutput }),
      });
      return Promise.resolve({ code, stdout: "" });
    };
    return { exec, ran };
  };

  it("installs it where none is, accepts the same one, keeps a different one aside once and replaces it", async () => {
    const absent = run(10);
    await expect(ensureSourceBackupPassword(absent.exec, "pw-staging-1")).resolves.toBe(
      "installed",
    );
    expect(absent.ran).toHaveLength(1);
    expect(absent.ran[0]?.stdin).toBe("pw-staging-1");
    expect(absent.ran[0]?.secretOutput).toBe(true);
    expect(absent.ran[0]?.command).not.toContain("pw-staging-1");
    expect(absent.ran[0]?.command).toContain("/etc/mykey/secrets/backup/password");
    expect(absent.ran[0]?.command).toContain("/dev/shm");
    await expect(ensureSourceBackupPassword(run(0).exec, "pw")).resolves.toBe("present");
    await expect(ensureSourceBackupPassword(run(12).exec, "pw")).resolves.toBe(
      "replaced (the target's own kept at /etc/mykey/secrets/backup/password.before-restore)",
    );
    await expect(ensureSourceBackupPassword(run(11).exec, "pw")).rejects.toThrow(/before-restore/);
    await expect(ensureSourceBackupPassword(run(1).exec, "pw")).rejects.toThrow(/exit 1/);
  });
});
