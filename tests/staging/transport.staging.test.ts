// Run 2.5 Task D: transport security of a MyKey host, proven from outside it.
//
// The public checks (certificate chain, HSTS, TLS versions, SNI, forwarded
// headers) run against staging and production; they only send requests and
// read the API log. The PostgreSQL checks and the certificate drill run on
// staging only.
import { rootCertificates } from "node:tls";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionConfig } from "@mykey/db";
import {
  httpsGet,
  parseWireguardEndpoints,
  tlsHandshake,
  waitForHealth,
} from "../harness/outside.ts";
import {
  connectStaging,
  expectSuccess,
  loadHosts,
  sshExec,
  type HostEntry,
  type StagingStack,
} from "../harness/staging.ts";

const hosts = loadHosts();
const run = async (host: HostEntry, command: string): Promise<string> =>
  expectSuccess(await sshExec(host, command, { sudo: true, timeoutMs: 120_000 }), command).stdout;

/** GET /health of the API container from the host, by the name in its certificate. */
async function apiCurl(host: HostEntry, tls: string): Promise<{ code: number; status: string }> {
  const result = await sshExec(
    host,
    `curl -s -o /dev/null -m 10 -w '%{http_code}' ${tls} --resolve api:8443:10.78.1.3 https://api:8443/health`,
    { timeoutMs: 60_000 },
  );
  return { code: result.code, status: result.stdout.trim() };
}

async function waitForApi(host: HostEntry, tls: string, status: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const answer = await apiCurl(host, tls);
    if (answer.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`the API did not answer ${status} (${tls}): ${JSON.stringify(answer)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
}

describe.each([hosts.staging, hosts.prod])("$name, public HTTPS", (host) => {
  // Production runs without a gate file since Session 3 (the owner opens it): its /health
  // answers down by design. The chain, HSTS and forwarded headers are checked the same.
  const health =
    host.name === "prod"
      ? { status: 503, body: '{"status":"down"}' }
      : { status: 200, body: '{"status":"up"}' };

  it("serves /health with a valid chain for the host name and HSTS", async () => {
    const answer = await httpsGet(host.hostname, "/health");
    expect(answer.status).toBe(health.status);
    expect(answer.body).toBe(health.body);
    expect(answer.authorized).toBe(true);
    expect(answer.certificate.subjectAltName.split(", ")).toContain(`DNS:${host.hostname}`);
    expect(answer.certificate.issuer).toMatch(/^Let's Encrypt /);
    expect(answer.certificate.issuer).not.toContain("STAGING");
    // Two years, and nothing about other names under the domain.
    expect(answer.headers["strict-transport-security"]).toBe("max-age=63072000");
  });

  it("refuses TLS 1.1 and accepts TLS 1.2 and 1.3", async () => {
    const old = await tlsHandshake({
      address: host.publicIp,
      servername: host.hostname,
      minVersion: "TLSv1.1",
      maxVersion: "TLSv1.1",
      // Lets this client offer TLS 1.1 at all, so the refusal is the server's.
      ciphers: "DEFAULT@SECLEVEL=0",
    });
    expect(old.ok).toBe(false);
    expect(old.code).toMatch(/ALERT_PROTOCOL_VERSION/);
    for (const version of ["TLSv1.2", "TLSv1.3"] as const) {
      const result = await tlsHandshake({
        address: host.publicIp,
        servername: host.hostname,
        minVersion: version,
        maxVersion: version,
      });
      expect(result, version).toEqual({ ok: true, protocol: version, code: null });
    }
  });

  it("gives no application answer to another server name or to the bare address", async () => {
    for (const servername of [`other.${host.hostname}`, null]) {
      const result = await tlsHandshake({ address: host.publicIp, servername });
      expect(result.ok, String(servername)).toBe(false);
    }
  });

  it("ignores forwarded headers sent by the client", async () => {
    const answer = await httpsGet(host.hostname, "/health", {
      "X-Forwarded-For": "203.0.113.9",
      "X-Forwarded-Proto": "http",
    });
    expect(answer.status).toBe(health.status);
    const requestId = answer.headers["x-request-id"];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    // The workstation's public address as the host sees it: its WireGuard endpoint.
    const workstation = parseWireguardEndpoints(await run(host, "wg show wg0 endpoints"));
    expect(workstation).toHaveLength(1);
    const lines = (
      await run(host, `docker logs --since 10m mykey-api-1 2>&1 | grep -F ${String(requestId)}`)
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event?: string })
      // A down /health also writes its cause (`health_down`) under the same request id.
      .filter((line) => line.event === "request");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "request",
      requestId,
      path: "/health",
      status: health.status,
      // The proxy is the only peer; the forwarded values are the proxy's own.
      peer: "10.78.1.2",
      forwardedFor: workstation[0],
      forwardedProto: "https",
    });
  });
});

describe("staging, private hops", () => {
  const host = hosts.staging;
  let stack: StagingStack;

  beforeAll(async () => {
    stack = await connectStaging();
  });
  afterAll(async () => {
    await stack.close();
  });

  const target = (): Parameters<typeof connectionConfig>[0] => ({
    host: stack.pg.host,
    port: stack.pg.port,
    database: stack.pg.database,
    user: stack.pg.superuser.user,
    password: stack.pg.superuser.password,
    caCertPath: stack.pg.caCertPath,
  });

  const connectError = async (config: pg.ClientConfig): Promise<NodeJS.ErrnoException> => {
    const client = new pg.Client(config);
    client.on("error", () => undefined);
    try {
      await client.connect();
    } catch (error) {
      return error as NodeJS.ErrnoException;
    } finally {
      await client.end().catch(() => undefined);
    }
    throw new Error("the connection was accepted");
  };

  it("PostgreSQL refuses plaintext and an unverified server, and accepts the host CA", async () => {
    const plain = await connectError({ ...connectionConfig(target()), ssl: false });
    expect(plain.code).toBe("28000");
    // PostgreSQL 18 names the explicit `reject` line that matched.
    expect(plain.message).toMatch(/^pg_hba\.conf rejects connection for host .*, no encryption$/);

    const otherCa = await connectError({
      ...connectionConfig(target()),
      ssl: { ca: rootCertificates[0], rejectUnauthorized: true },
    });
    expect(otherCa.code).toMatch(/SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE/);

    const client = new pg.Client(connectionConfig(target()));
    await client.connect();
    try {
      const result = await client.query<{ ssl: boolean }>(
        "select ssl from pg_stat_ssl where pid = pg_backend_pid()",
      );
      expect(result.rows[0]?.ssl).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("the proxy refuses an API certificate from another CA", async () => {
    const pki = "/etc/mykey/pki";
    const keep = "/root/mykey-drill";
    const since = new Date().toISOString();
    // The API's certificate and key are kept, then replaced in place (same
    // inode, owner and mode) by ones from a CA the proxy does not trust.
    await run(
      host,
      [
        "set -eu",
        `install -d -m 0700 ${keep}`,
        `cp -p ${pki}/api.crt ${pki}/api.key ${keep}/`,
        "d=$(mktemp -d)",
        'cd "$d"',
        "openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.crt -days 1 -subj '/CN=MyKey drill CA' -addext basicConstraints=critical,CA:TRUE >/dev/null 2>&1",
        "printf 'subjectAltName=DNS:api\\n' > ext",
        "openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout api.key -out api.csr -subj /CN=api >/dev/null 2>&1",
        "openssl x509 -req -in api.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out api.crt -days 1 -extfile ext >/dev/null 2>&1",
        `cat api.crt > ${pki}/api.crt`,
        `cat api.key > ${pki}/api.key`,
        'cd / && rm -rf "$d"',
        "docker restart mykey-api-1 >/dev/null",
      ].join("\n"),
    );
    try {
      // The API itself is up with the drill certificate: it answers on its
      // bridge address when the client does not verify.
      await waitForApi(host, "-k", "200");
      // Verified against the host CA, as the proxy does, the certificate fails (curl 60).
      expect(await apiCurl(host, `--cacert ${pki}/ca.crt`)).toEqual({ code: 60, status: "000" });
      // So the proxy refuses to forward. Traefik 3.7 answers 500 to a failed
      // backend verification (502 only while the API is down) and logs the TLS
      // cause at debug level only; its access log records the answers.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect((await httpsGet(host.hostname, "/health")).status).toBe(500);
      }
      const edgeLog = await run(host, `docker logs --since ${since} mykey-edge-1 2>&1`);
      expect(edgeLog.match(/"GET \/health HTTP\/1\.1" 500 /g)?.length).toBeGreaterThanOrEqual(3);
    } finally {
      await run(
        host,
        [
          "set -eu",
          `cat ${keep}/api.crt > ${pki}/api.crt`,
          `cat ${keep}/api.key > ${pki}/api.key`,
          `rm -rf ${keep}`,
          "docker restart mykey-api-1 >/dev/null",
        ].join("\n"),
      );
    }
    await waitForHealth(host.hostname, 200, 120_000);
    // Control: the restored certificate verifies against the host CA.
    await waitForApi(host, "--cacert /etc/mykey/pki/ca.crt", "200");
  }, 600_000);
});
