// Run 2.5 Task C Step 3: where each secret of a host lives, and the ACME switch.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROLE_NAMES } from "@mykey/db";
import {
  ACME_DIRECTORIES,
  HOST_SECRETS,
  ROLE_PASSWORD_PLACE,
  acmeCommands,
  bootstrapCommands,
  hostEnvDefaultCommand,
  imageLoadCommand,
  kmsCsrCommands,
  imageParts,
  inParallel,
  localSecret,
  parseHostArgs,
  secretInstallCommand,
} from "../../../scripts/host.ts";
import { redact, type Hosts } from "../../harness/staging.ts";

const hosts: Hosts = {
  region: "us-east-vin",
  staging: {
    name: "staging",
    publicIp: "203.0.113.50",
    vpnIp: "10.77.2.1",
    hostname: "mykey-staging.example.test",
    sshUser: "ubuntu",
  },
  prod: {
    name: "prod",
    publicIp: "203.0.113.48",
    vpnIp: "10.77.1.1",
    hostname: "mykey.example.test",
    sshUser: "ubuntu",
  },
};

describe("where a host's secrets live", () => {
  it("keeps on the host only what a service on it reads: the superuser and api_runtime", () => {
    expect(Object.keys(ROLE_PASSWORD_PLACE).sort()).toEqual([...ROLE_NAMES].sort());
    const onHost = ROLE_NAMES.filter((role) => ROLE_PASSWORD_PLACE[role] === "host");
    expect(onHost).toEqual(["api_runtime"]);
    expect(HOST_SECRETS).toEqual({
      postgresSuperuser: {
        path: "/etc/mykey/secrets/postgres/superuser-password",
        owner: "999:999",
      },
      apiRuntime: { path: "/etc/mykey/secrets/api/db-password", owner: "1000:1000" },
    });
  });

  it("installs a host secret from stdin, readable by the service's user only", () => {
    expect(secretInstallCommand("/etc/mykey/secrets/api/db-password", "1000:1000")).toBe(
      "install -d -m 0755 -o root -g root /etc/mykey/secrets && " +
        "install -d -m 0700 -o 1000 -g 1000 /etc/mykey/secrets/api && " +
        "install -m 0400 -o 1000 -g 1000 /dev/stdin /etc/mykey/secrets/api/db-password",
    );
    expect(() => secretInstallCommand("/etc/passwd", "0:0")).toThrow(/secrets/);
    expect(() => secretInstallCommand("/etc/mykey/secrets/../passwd", "0:0")).toThrow();
    expect(() => secretInstallCommand("/etc/mykey/secrets/api/x", "root")).toThrow(/uid:gid/);
  });

  describe("on the workstation", () => {
    const directories: string[] = [];
    afterEach(() => {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("creates a secret once, keeps it, and never lets it reach a log line", () => {
      const directory = mkdtempSync(join(tmpdir(), "mykey-secrets-"));
      directories.push(directory);
      const file = join(directory, "hosts", "staging", "migration_owner");
      const first = localSecret(file);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(localSecret(file)).toBe(first);
      expect(readFileSync(file, "utf8")).toBe(first);
      expect(redact(`password=${first}`)).toBe("password=[redacted]");
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
    });
  });
});

describe("ACME directory", () => {
  it("starts every host on the Let's Encrypt staging directory and never resets a choice", () => {
    expect(ACME_DIRECTORIES).toEqual({
      staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
      production: "https://acme-v02.api.letsencrypt.org/directory",
    });
    const commands = bootstrapCommands("staging", hosts, "WORKSTATIONPUBLICKEY=");
    const acme = commands.filter((command) => command.includes("MYKEY_ACME_DIRECTORY"));
    expect(acme).toEqual([hostEnvDefaultCommand("MYKEY_ACME_DIRECTORY", ACME_DIRECTORIES.staging)]);
    // "default" writes the key only when it is absent.
    expect(acme[0]).toContain("grep -q '^MYKEY_ACME_DIRECTORY='");
    expect(acme[0]).not.toContain("sed -i");
  });

  it("switches the directory, then drops the edge and its certificate store", () => {
    expect(parseHostArgs(["staging", "acme", "production"])).toEqual({
      host: "staging",
      via: "vpn",
      command: "acme",
      directory: "production",
    });
    expect(() => parseHostArgs(["staging", "acme"])).toThrow(/staging\|production/);
    expect(() => parseHostArgs(["staging", "acme", "letsencrypt"])).toThrow(/staging\|production/);

    const commands = acmeCommands("production");
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain(
      "MYKEY_ACME_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory",
    );
    // A certificate of the other directory must not be served or renewed.
    // Not through Compose: this must work before an image is recorded in host.env.
    // The finished one-shot job still holds the volume, so it goes too (seen on staging).
    expect(commands[1]).toBe("docker rm --force mykey-edge-1 mykey-pki-init-1");
    expect(commands[2]).toBe("docker volume rm --force mykey_acme");
  });
});

// The path from the workstation to the hosts loses packets, so one stream is
// slow. An image travels as parts over several connections (run-2.5.md).
describe("image upload", () => {
  const MIB = 1024 * 1024;

  it("cuts an archive into parts that a shell glob puts back in order", () => {
    const parts = imageParts(10 * MIB + 5, 4 * MIB);
    expect(parts).toEqual([
      { name: "part-0000", start: 0, end: 4 * MIB },
      { name: "part-0001", start: 4 * MIB, end: 8 * MIB },
      { name: "part-0002", start: 8 * MIB, end: 10 * MIB + 5 },
    ]);
    expect(imageParts(4 * MIB, 4 * MIB)).toHaveLength(1);
    expect(() => imageParts(0, 4 * MIB)).toThrow(/empty/);
    // More parts than the name has digits would break the order.
    expect(() => imageParts(10_001, 1)).toThrow(/parts/);
  });

  it("loads the parts only when together they are the archive that was sent", () => {
    const sha = "a".repeat(64);
    const command = imageLoadCommand("/var/tmp/mykey-image.0123abcd", sha);
    expect(command).toBe(
      `test "$(cat /var/tmp/mykey-image.0123abcd/part-* | sha256sum | cut -d ' ' -f 1)" = ${sha} && ` +
        "cat /var/tmp/mykey-image.0123abcd/part-* | docker load",
    );
    expect(() => imageLoadCommand("/etc/mykey", sha)).toThrow(/directory/);
    expect(() => imageLoadCommand("/var/tmp/mykey-image.0123abcd", "abc")).toThrow(/sha256/);
  });

  it("runs at most the given number of uploads at once and fails when one fails", async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    const work = async (item: number): Promise<void> => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      done.push(item);
    };
    await inParallel([1, 2, 3, 4, 5, 6, 7], 3, work);
    expect(most).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const started: number[] = [];
    const failing = inParallel([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (item === 2) throw new Error("part 2 failed");
    });
    await expect(failing).rejects.toThrow("part 2 failed");
    // Nothing new starts after a failure.
    expect(started.length).toBeLessThan(6);
  });
});

// Run 2.7: the seal certificate's key is made on the host and never leaves it.
describe("kms-csr", () => {
  it("parses the certificate name", () => {
    expect(parseHostArgs(["staging", "kms-csr", "staging-seal-1"])).toEqual({
      host: "staging",
      via: "vpn",
      command: "kms-csr",
      name: "staging-seal-1",
    });
    expect(() => parseHostArgs(["staging", "kms-csr"])).toThrow(/name/);
    expect(() => parseHostArgs(["staging", "kms-csr", "../x"])).toThrow(/name/);
  });

  it("keeps the key in the secrets directory, refuses to replace it, and leaves only the CSR outside", () => {
    const { create, read } = kmsCsrCommands("staging-seal-1");
    expect(create).toContain("test ! -e /etc/mykey/secrets/kms/staging-seal-1.key");
    expect(create).toContain("-keyout /etc/mykey/secrets/kms/staging-seal-1.key");
    expect(create).toContain("ec_paramgen_curve:prime256v1");
    expect(create).toContain("-subj /CN=staging-seal-1");
    expect(create).toContain("-out /etc/mykey/kms-csr/staging-seal-1.csr");
    expect(create).toContain("chmod 0400 /etc/mykey/secrets/kms/staging-seal-1.key");
    expect(read).toBe("cat /etc/mykey/kms-csr/staging-seal-1.csr");
    expect(read).not.toContain("secrets");
  });
});
