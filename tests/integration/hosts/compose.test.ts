// Run 2.5 Task C: the host Compose file, as Docker Compose itself resolves it.
// The file holds no secret, so it can be rendered on any machine.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@mykey/contracts";

const root = resolve(import.meta.dirname, "../../..");
const composeFile = join(root, "infra/compose/host.compose.yml");

interface Service {
  image: string;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  pids_limit?: number;
  mem_limit?: string;
  restart?: string;
  network_mode?: string;
  environment?: Record<string, string | null>;
  ports?: { target: number; published: string; host_ip?: string; protocol: string }[];
  networks?: Record<string, { ipv4_address?: string } | null>;
  volumes?: { type: string; source?: string; target: string; read_only?: boolean }[];
}
interface Rendered {
  name: string;
  services: Record<string, Service>;
  networks: Record<
    string,
    {
      internal?: boolean;
      enable_ipv6?: boolean;
      driver_opts?: Record<string, string>;
      ipam: { config: { subnet: string }[] };
    }
  >;
}

const API_IMAGE = `sha256:${"a".repeat(64)}`;

function render(): Rendered {
  const output = execFileSync(
    "docker",
    // Every profile: the file must hold its rules for OpenBao too (Run 2.7).
    ["compose", "-f", composeFile, "--profile", "openbao", "config", "--format", "json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        API_IMAGE,
        // Run 3.8: the provisioner service (profile openbao).
        PROVISIONER_IMAGE: API_IMAGE,
        MYKEY_BAO_URL: "https://openbao:8200",
        MYKEY_HOSTNAME: "mykey-staging.example.test",
        MYKEY_HOST_INSTANCE_ID: "6f1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f",
        MYKEY_BASE_URL: "https://mykey-staging.example.test",
        MYKEY_ACME_DIRECTORY: "https://acme-staging-v02.api.letsencrypt.org/directory",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(output) as Rendered;
}

describe("host compose file", () => {
  const rendered = render();
  const services = Object.entries(rendered.services);
  const longRunning = services.filter(([name]) => name !== "pki-init");

  it("has exactly the services of the skeleton, under the project name host.ts uses", () => {
    expect(rendered.name).toBe("mykey");
    expect(Object.keys(rendered.services).sort()).toEqual([
      "api",
      "edge",
      "openbao",
      "pki-init",
      "postgres",
      "provisioner",
    ]);
    expect(rendered.services.api?.image).toBe(API_IMAGE);
  });

  it("runs every service read-only, without capabilities, non-root and bounded", () => {
    for (const [name, service] of services) {
      expect(service.read_only, name).toBe(true);
      expect(service.cap_drop, name).toEqual(["ALL"]);
      expect(service.security_opt, name).toContain("no-new-privileges:true");
      expect(service.pids_limit, name).toBeGreaterThan(0);
      expect(Number(service.mem_limit), name).toBeGreaterThan(0);
    }
    for (const [name, service] of longRunning) {
      expect(service.user, name).toMatch(/^[1-9]\d*:[1-9]\d*$/);
      expect(service.cap_add ?? [], name).toEqual([]);
      expect(service.restart, name).toBe("unless-stopped");
    }
    // The one-shot certificate job is the only root process: it must give files to other users.
    const pki = rendered.services["pki-init"];
    expect(pki?.user).toBe("0:0");
    expect(pki?.network_mode).toBe("none");
    expect([...(pki?.cap_add ?? [])].sort()).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER"]);
  });

  it("publishes port 443 of the edge and nothing else", () => {
    const published = services.flatMap(([name, service]) =>
      (service.ports ?? []).map((port) => ({ name, ...port })),
    );
    expect(published).toEqual([
      expect.objectContaining({
        name: "edge",
        target: 8443,
        published: "443",
        host_ip: "0.0.0.0",
        protocol: "tcp",
      }),
    ]);
  });

  it("uses the fixed bridges and addresses of the firewall; only mk-pub and mk-kms lead out", () => {
    const networks = Object.values(rendered.networks).map((network) => ({
      bridge: network.driver_opts?.["com.docker.network.bridge.name"],
      subnet: network.ipam.config[0]?.subnet,
      internal: network.internal === true,
      ipv6: network.enable_ipv6 === true,
    }));
    expect(networks.sort((a, b) => String(a.bridge).localeCompare(String(b.bridge)))).toEqual([
      { bridge: "mk-bao", subnet: "10.78.3.0/28", internal: true, ipv6: false },
      { bridge: "mk-db", subnet: "10.78.2.0/28", internal: true, ipv6: false },
      { bridge: "mk-edge", subnet: "10.78.1.0/28", internal: true, ipv6: false },
      { bridge: "mk-kms", subnet: "10.78.4.0/28", internal: false, ipv6: false },
      { bridge: "mk-pub", subnet: "10.78.0.0/28", internal: false, ipv6: false },
    ]);
    const address = (service: string, network: string): string | undefined =>
      rendered.services[service]?.networks?.[network]?.ipv4_address;
    expect(Object.keys(rendered.services.edge?.networks ?? {}).sort()).toEqual(["edge", "pub"]);
    expect(Object.keys(rendered.services.api?.networks ?? {}).sort()).toEqual([
      "bao",
      "db",
      "edge",
    ]);
    expect(Object.keys(rendered.services.openbao?.networks ?? {}).sort()).toEqual(["bao", "kms"]);
    expect(Object.keys(rendered.services.postgres?.networks ?? {})).toEqual(["db"]);
    // The addresses the operator tunnels and the proxy use.
    expect(address("postgres", "db")).toBe("10.78.2.2");
    expect(address("api", "edge")).toBe("10.78.1.3");
    // The addresses REMOTE.openbao (tests/harness/staging.ts) and the firewall use.
    expect(address("openbao", "bao")).toBe("10.78.3.2");
    expect(address("openbao", "kms")).toBe("10.78.4.2");
  });

  it("mounts no Docker socket and writes only to named volumes and tmpfs", () => {
    for (const [name, service] of longRunning) {
      for (const volume of service.volumes ?? []) {
        expect(volume.source ?? "", name).not.toContain("docker.sock");
        if (volume.type === "bind") expect(volume.read_only, `${name}:${volume.target}`).toBe(true);
      }
    }
  });

  it("passes no secret through the environment, only paths to files", () => {
    for (const [name, service] of services) {
      for (const [key, value] of Object.entries(service.environment ?? {})) {
        // "MYKEY_" is the product prefix, not a key.
        if (/PASSWORD|TOKEN|SECRET|KEY/.test(key.replace(/^MYKEY_/, ""))) {
          expect(key, `${name}.${key}`).toMatch(/_FILE$|_OWNER$/);
          if (key.endsWith("_FILE")) expect(value, `${name}.${key}`).toMatch(/^\/run\/mykey\//);
        }
      }
    }
  });

  it("gives Traefik a file provider only, strict TLS and the directory from host.env", () => {
    const edge = rendered.services.edge as unknown as { command: string[] };
    const flags = edge.command.join(" ");
    expect(flags).toContain("--providers.file.filename=");
    expect(flags).not.toMatch(/providers\.docker|--api|dashboard/);
    expect(flags).toContain(
      "--certificatesresolvers.le.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory",
    );
    expect(flags).toContain("--certificatesresolvers.le.acme.tlschallenge=true");
    const dynamic = readFileSync(join(root, "infra/compose/host/traefik-dynamic.yml"), "utf8");
    expect(dynamic).toMatch(/minVersion:\s*VersionTLS12/);
    expect(dynamic).toMatch(/sniStrict:\s*true/);
    expect(dynamic).toMatch(/stsSeconds:\s*63072000/);
    expect(dynamic).toMatch(/serverName:\s*api/);
    expect(dynamic).toMatch(/rootCAs:/);
    expect(dynamic).toContain("https://10.78.1.3:8443");
    expect(dynamic).not.toMatch(/insecureSkipVerify:\s*true/);
  });
});

describe("host PostgreSQL configuration", () => {
  const settings = new Map(
    readFileSync(join(root, "infra/compose/host/postgresql.conf"), "utf8")
      .split("\n")
      .map((line) => /^([a-z_]+)\s*=\s*'?([^'#]*?)'?\s*(?:#.*)?$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]] as const),
  );

  it("requires TLS 1.3 and SCRAM, logs no parameter value, and takes max_connections from the limits", () => {
    expect(settings.get("ssl")).toBe("on");
    expect(settings.get("ssl_min_protocol_version")).toBe("TLSv1.3");
    expect(settings.get("password_encryption")).toBe("scram-sha-256");
    expect(settings.get("log_parameter_max_length")).toBe("0");
    expect(settings.get("log_parameter_max_length_on_error")).toBe("0");
    expect(settings.get("max_connections")).toBe(String(LIMITS.db.maxConnections));
  });

  it("accepts TLS with SCRAM from the database network only and rejects everything else", () => {
    const rules = readFileSync(join(root, "infra/compose/host/pg_hba.conf"), "utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/).join(" "))
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(rules).toEqual([
      "local all all scram-sha-256",
      "hostssl all all 10.78.2.0/28 scram-sha-256",
      "host all all all reject",
    ]);
  });
});

describe("OpenBao on a host (Run 2.7)", () => {
  const rendered = JSON.parse(
    execFileSync(
      "docker",
      ["compose", "-f", composeFile, "--profile", "openbao", "config", "--format", "json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          API_IMAGE,
          PROVISIONER_IMAGE: API_IMAGE,
          MYKEY_HOSTNAME: "mykey-staging.example.test",
          MYKEY_HOST_INSTANCE_ID: "6f1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f",
          MYKEY_BASE_URL: "https://mykey-staging.example.test",
          MYKEY_ACME_DIRECTORY: "https://acme-staging-v02.api.letsencrypt.org/directory",
          MYKEY_BAO_URL: "https://openbao:8200",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  ) as Rendered & { services: Record<string, Service & { profiles?: string[] }> };

  it("starts only with the openbao profile, which production does not use", () => {
    expect(rendered.services.openbao?.profiles).toEqual(["openbao"]);
    expect(rendered.services.openbao?.user).toBe("100:1000");
  });

  it("reads its configuration, server certificate and KMS certificate from read-only files", () => {
    const mounts = Object.fromEntries(
      (rendered.services.openbao?.volumes ?? []).map((volume) => [volume.target, volume]),
    );
    expect(mounts["/openbao/config/openbao.hcl"]?.source).toBe("/etc/mykey/openbao/openbao.hcl");
    expect(mounts["/openbao/kms"]?.source).toBe("/etc/mykey/secrets/kms");
    for (const target of [
      "/openbao/config/openbao.hcl",
      "/openbao/kms",
      "/openbao/tls/server.key",
    ]) {
      expect(mounts[target]?.read_only, target).toBe(true);
    }
  });

  it("gives the API OpenBao's address only from host.env", () => {
    expect(rendered.services.api?.environment?.MYKEY_BAO_URL).toBe("https://openbao:8200");
    expect(rendered.services.api?.environment?.MYKEY_BAO_CA_FILE).toBe("/run/mykey/tls/ca.crt");
  });
});
