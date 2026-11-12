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
  baoInitCommand,
  custodyCopyPath,
  bootstrapCommands,
  composeUpCommand,
  openBaoValuesFrom,
  hostEnvDefaultCommand,
  imageLoadCommand,
  kmsCertCommand,
  kmsCsrCommands,
  kmsImportKeyCommand,
  kmsRemoveCommand,
  kmsUseCommand,
  okmsCommand,
  okmsInstallCommand,
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
    // OpenBao (uid 100) reads the directory through its bind mount; nobody else.
    expect(create).toContain("install -d -m 0700 -o 100 -g 1000 /etc/mykey/secrets/kms");
    expect(create).toContain("chown 100:1000 /etc/mykey/secrets/kms/staging-seal-1.key");
    expect(read).toBe("cat /etc/mykey/kms-csr/staging-seal-1.csr");
    expect(read).not.toContain("secrets");
  });
});

// Run 2.7 Step 2: certificates, the okms tool and the KMS settings, staging only.
describe("kms", () => {
  it("parses kms-install, kms-cert, kms-use, kms and env, and refuses them for production", () => {
    const base = { host: "staging", via: "vpn" };
    expect(parseHostArgs(["staging", "kms-install", "C:/t/okms.tar.gz"])).toEqual({
      ...base,
      command: "kms-install",
      tar: "C:/t/okms.tar.gz",
    });
    expect(parseHostArgs(["staging", "kms-cert", "staging-seal-1", "C:/k/s.crt"])).toEqual({
      ...base,
      command: "kms-cert",
      name: "staging-seal-1",
      crt: "C:/k/s.crt",
    });
    expect(parseHostArgs(["staging", "kms-use", "staging-seal-2"])).toEqual({
      ...base,
      command: "kms-use",
      name: "staging-seal-2",
    });
    expect(
      parseHostArgs(["staging", "kms", "staging-seal-1", "--", "kmip", "locate", "--details"]),
    ).toEqual({
      ...base,
      command: "kms",
      name: "staging-seal-1",
      argv: ["kmip", "locate", "--details"],
    });
    expect(parseHostArgs(["staging", "env", "MYKEY_KMS_HOST", "us-east-vin.okms.ovh.us"])).toEqual({
      ...base,
      command: "env",
      key: "MYKEY_KMS_HOST",
      value: "us-east-vin.okms.ovh.us",
    });
    expect(() => parseHostArgs(["staging", "env", "API_IMAGE", "x"])).toThrow(/env/);
    expect(() => parseHostArgs(["staging", "kms", "staging-seal-1"])).toThrow(/--/);
    for (const argv of [
      ["prod", "kms-cert", "a", "b"],
      ["prod", "kms-use", "a"],
      ["prod", "kms", "a", "--", "kmip", "locate"],
      ["prod", "kms-install", "t"],
      ["prod", "env", "MYKEY_OPENBAO", "1"],
    ]) {
      expect(() => parseHostArgs(argv), argv.join(" ")).toThrow(/production/);
    }
  });

  it("installs okms only from an archive with the pinned checksum", () => {
    const lock = JSON.parse(readFileSync("infra/dependencies.lock.json", "utf8")) as {
      binaries: { "okms-cli": { sha256: string } };
    };
    const command = okmsInstallCommand("/var/tmp/mykey-okms.0123abcd.tar.gz");
    expect(command).toContain(
      `echo '${lock.binaries["okms-cli"].sha256}  /var/tmp/mykey-okms.0123abcd.tar.gz' | sha256sum -c`,
    );
    expect(command).toContain("install -m 0755 -o root -g root");
    expect(command).toMatch(/\/opt\/mykey\/bin\/okms$/);
    expect(() => okmsInstallCommand("/tmp/x;rm")).toThrow();
  });

  it("installs a certificate next to its key only when the two match, for OpenBao's uid", () => {
    const command = kmsCertCommand("staging-seal-1");
    const dir = "/etc/mykey/secrets/kms";
    expect(command).toContain(`test -e ${dir}/staging-seal-1.key`);
    expect(command).toContain(`install -d -m 0700 -o 100 -g 1000 ${dir}`);
    expect(command).toContain(
      `install -m 0444 -o 100 -g 1000 /dev/stdin ${dir}/staging-seal-1.crt.new`,
    );
    expect(command).toContain(`openssl x509 -in ${dir}/staging-seal-1.crt.new -noout -pubkey`);
    expect(command).toContain(`openssl pkey -in ${dir}/staging-seal-1.key -pubout`);
    expect(command).toContain(`mv ${dir}/staging-seal-1.crt.new ${dir}/staging-seal-1.crt`);
    expect(command).toContain(`chown 100:1000 ${dir}/staging-seal-1.key`);
  });

  it("points seal.crt and seal.key at one certificate with relative links", () => {
    const command = kmsUseCommand("staging-seal-2");
    expect(command).toContain("test -e /etc/mykey/secrets/kms/staging-seal-2.crt");
    expect(command).toContain("ln -sfn staging-seal-2.crt /etc/mykey/secrets/kms/seal.crt");
    expect(command).toContain("ln -sfn staging-seal-2.key /etc/mykey/secrets/kms/seal.key");
  });

  it("runs okms through the host script, so the command never names the secrets directory", () => {
    expect(okmsCommand("staging-seal-1", ["kmip", "locate", "--details"])).toBe(
      "/opt/mykey/hosts/kms/okms.sh staging-seal-1 kmip locate --details",
    );
    expect(okmsCommand("staging-seal-1", ["kmip", "locate"])).not.toContain("secrets");
    expect(() => okmsCommand("staging-seal-1", ["kmip", "$(id)"])).toThrow(/argument/);
  });
});

// Run 2.7: OpenBao starts only where host.env asks for it.
describe("up", () => {
  it("adds the openbao profile only when asked", () => {
    expect(composeUpCommand(false)).toMatch(/ -p mykey up -d$/);
    expect(composeUpCommand(false)).not.toContain("--profile");
    expect(composeUpCommand(true)).toMatch(/ -p mykey --profile openbao up -d$/);
  });

  it("renders OpenBao's configuration from host.env, and refuses an incomplete one", () => {
    const env = {
      MYKEY_OPENBAO: "1",
      MYKEY_KMS_HOST: "us-east-vin.okms.ovh.us",
      MYKEY_KMS_SEAL_KEY_ID: "00000000-1111-4222-8333-444444444444",
    };
    expect(openBaoValuesFrom("staging", env)).toEqual({
      host: "staging",
      kmsHost: "us-east-vin.okms.ovh.us",
      sealKeyId: "00000000-1111-4222-8333-444444444444",
      maxRequestDuration: "15s",
    });
    expect(openBaoValuesFrom("prod", {})).toBeNull();
    expect(() => openBaoValuesFrom("staging", { MYKEY_OPENBAO: "1" })).toThrow(/MYKEY_KMS_HOST/);
  });
});

// Run 2.7 Step 4: initialisation on the host; its answer never crosses the terminal.
describe("bao-init", () => {
  it("parses for staging only", () => {
    expect(parseHostArgs(["staging", "bao-init"])).toEqual({
      host: "staging",
      via: "vpn",
      command: "bao-init",
    });
    expect(() => parseHostArgs(["prod", "bao-init"])).toThrow(/production/);
  });

  it("initialises once, with one recovery share, into root's custody file, and prints only a count", () => {
    const command = baoInitCommand();
    expect(command).toContain("install -d -m 0700 -o root -g root /root/mykey-custody");
    expect(command).toContain("test ! -e /root/mykey-custody/openbao-init.json");
    // Review finding I3: a retry after an uncertain first attempt must never truncate
    // the only copy of the answer, nor init an OpenBao that already is.
    expect(command).toContain("test ! -e /root/mykey-custody/openbao-init.json.new");
    expect(command).toMatch(
      /curl [^&]*https:\/\/openbao:8200\/v1\/sys\/init \| jq -e '\.initialized == false'/,
    );
    expect(command.indexOf("jq -e '.initialized == false'")).toBeLessThan(
      command.indexOf("-X PUT"),
    );
    expect(command).toContain('{"recovery_shares":1,"recovery_threshold":1}');
    expect(command).toContain("--cacert /etc/mykey/pki/ca.crt --resolve openbao:8200:10.78.3.2");
    expect(command).toContain("https://openbao:8200/v1/sys/init");
    expect(command).toContain("chmod 0400 /root/mykey-custody/openbao-init.json");
    expect(command).toMatch(
      // OpenBao's field is recovery_keys_base64; jq would count a missing one as 0.
      /jq -er '\.recovery_keys_base64 \| length' \/root\/mykey-custody\/openbao-init\.json$/,
    );
  });

  it("keeps the workstation copy beside the other custody files, never overwritten", () => {
    expect(custodyCopyPath("staging", "/home/u")).toBe(
      join("/home/u", ".mykey", "custody", "staging", "openbao-init.json"),
    );
  });
});

// Run 2.7 Step 7: the losstest certificate and key go to staging for the test only.
describe("kms-import and kms-remove", () => {
  it("parse for staging only", () => {
    expect(parseHostArgs(["staging", "kms-import", "losstest-ops", "a.crt", "a.key"])).toEqual({
      host: "staging",
      via: "vpn",
      command: "kms-import",
      name: "losstest-ops",
      crt: "a.crt",
      key: "a.key",
    });
    expect(parseHostArgs(["staging", "kms-remove", "losstest-ops"])).toMatchObject({
      command: "kms-remove",
      name: "losstest-ops",
    });
    expect(() => parseHostArgs(["prod", "kms-import", "a", "b", "c"])).toThrow(/production/);
    expect(() => parseHostArgs(["staging", "kms-remove", "seal"])).toThrow(/seal/);
  });

  it("imports a key only where none exists, then installs its certificate the checked way", () => {
    const command = kmsImportKeyCommand("losstest-ops");
    expect(command).toContain("test ! -e /etc/mykey/secrets/kms/losstest-ops.key");
    expect(command).toContain(
      "install -m 0400 -o 100 -g 1000 /dev/stdin /etc/mykey/secrets/kms/losstest-ops.key",
    );
  });

  it("removes a certificate and key that seal.* does not point at", () => {
    const command = kmsRemoveCommand("losstest-ops");
    expect(command).toContain(
      '[ "$(readlink /etc/mykey/secrets/kms/seal.key)" != losstest-ops.key ]',
    );
    expect(command).toContain("shred -u /etc/mykey/secrets/kms/losstest-ops.key");
    expect(command).toContain("rm -f /etc/mykey/secrets/kms/losstest-ops.crt");
  });
});
