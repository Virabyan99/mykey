// Run 5.5 Task B (P-96, FR-1.79, AC-1.37): the CLI's connection. HTTP URLs,
// untrusted certificates, unsafe runtime settings, redirects and an
// incompatible API each fail with their exit code, and — unless a case says
// otherwise — no request carried a credential.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { createClient } from "@mykey/cli";
import type { AddressInfo } from "node:net";
import { LIMITS, type ErrorCode } from "@mykey/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliResult } from "../harness/cli.ts";
import {
  ENV_NAME,
  PROJECT,
  errorReply,
  goodVersion,
  startCliServer,
  type CliServer,
  type ServerScript,
} from "./server.ts";

const token = (): string => `s.${randomBytes(18).toString("base64url")}`;
const servers: CliServer[] = [];
const listeners: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const listener of listeners.splice(0)) listener.close();
});

async function serve(script: ServerScript = {}): Promise<CliServer> {
  const server = await startCliServer(script);
  servers.push(server);
  return server;
}

function keys(server: { url: string; caPath?: string }, env: Record<string, string> = {}) {
  return runCli(["keys", "--project", PROJECT, "--env", ENV_NAME], {
    env: {
      SECRETS_API_URL: server.url,
      SECRETS_MACHINE_TOKEN: token(),
      ...(server.caPath === undefined ? {} : { SECRETS_CA_FILE: server.caPath }),
      ...env,
    },
  });
}

const noCredential = (server: CliServer): boolean =>
  server.requests.every((request) => !request.hadAuthorization);
const oneLine = (result: CliResult): string[] => result.stderr.trim().split("\n");

describe("the connection is verified before a credential is sent", () => {
  it("an http:// URL → 78, and a plain listener on that port saw no connection", async () => {
    let connections = 0;
    const listener = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    listeners.push(listener);
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;
    const result = await keys({ url: `http://127.0.0.1:${String(port)}` });
    expect(result.code).toBe(78);
    expect(connections).toBe(0);
    expect(oneLine(result)).toHaveLength(1);
    expect(result.stderr).toMatch(/^secrets: unsupported: .+ \(code: none, requestId: none\)\n$/);
  });

  it("an authority the CLI does not trust, another host name, an expired certificate → 69 each, no request", async () => {
    const untrusted = await serve();
    const other = await serve({ cert: "other-host" });
    const expired = await serve({ cert: "expired" });
    for (const [label, result, server] of [
      ["untrusted", await keys({ url: untrusted.url }), untrusted],
      ["other host", await keys({ url: other.url, caPath: other.caPath }), other],
      ["expired", await keys({ url: expired.url, caPath: expired.caPath }), expired],
    ] as const) {
      expect(result.code, label).toBe(69);
      expect(server.requests, label).toEqual([]);
      expect(result.stdout, label).toBe("");
    }
    // The control: the same CLI and certificate authority with a good certificate.
    const good = await serve();
    expect((await keys(good)).code).toBe(0);
  });

  it("NODE_TLS_REJECT_UNAUTHORIZED=0 and NODE_OPTIONS (any value) → 78, no request", async () => {
    const server = await serve();
    expect((await keys(server, { NODE_TLS_REJECT_UNAUTHORIZED: "0" })).code).toBe(78);
    expect((await keys(server, { NODE_OPTIONS: "--max-old-space-size=64" })).code).toBe(78);
    expect(server.requests).toEqual([]);
  });

  it("/v1/version answering 307 to a second server → 69; the second server saw nothing", async () => {
    const second = await serve();
    const first = await serve({
      version: { status: 307, headers: { location: `${second.url}/v1/version` } },
    });
    const result = await keys(first);
    expect(result.code).toBe(69);
    expect(second.requests).toEqual([]);
    expect(first.requests).toEqual([
      { method: "GET", path: "/v1/version", hadAuthorization: false },
    ]);
  });

  it("keys answering 302 to a second server → 69; the second server saw nothing", async () => {
    const second = await serve();
    const first = await serve({
      keys: { status: 302, headers: { location: `${second.url}/v1/version` } },
    });
    const result = await keys(first);
    expect(result.code).toBe(69);
    expect(second.requests).toEqual([]);
    // The first server saw exactly one credentialed request: the keys call it redirected.
    expect(first.requests.map((request) => request.hadAuthorization)).toEqual([false, true]);
    expect(result.stdout).toBe("");
  });

  it("apiMajor one higher → 76; a version body that is HTML → 65; neither sends the token", async () => {
    const newer = await serve({
      version: { status: 200, body: { ...goodVersion(), apiMajor: 2 } },
    });
    expect((await keys(newer)).code).toBe(76);
    expect(noCredential(newer)).toBe(true);
    const html = await serve({
      version: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body>a login page</body></html>",
      },
    });
    expect((await keys(html)).code).toBe(65);
    expect(noCredential(html)).toBe(true);
    expect(newer.requests).toHaveLength(1);
    expect(html.requests).toHaveLength(1);
  });

  it("the client itself checks the version before its first credentialed call", async () => {
    const newer = await serve({
      version: { status: 200, body: { ...goodVersion(), apiMajor: 2 } },
    });
    const client = createClient(new URL(newer.url), {
      extraCa: readFileSync(newer.caPath, "utf8"),
    });
    const selector = { project: PROJECT, env: ENV_NAME };
    await expect(client.keys(selector, token())).rejects.toMatchObject({
      category: "incompatible",
    });
    await expect(client.resolve(selector, token())).rejects.toMatchObject({
      category: "incompatible",
    });
    expect(newer.requests.map((request) => request.path)).toEqual(["/v1/version", "/v1/version"]);
    expect(noCredential(newer)).toBe(true);
  });

  it("a server that accepts and never answers → 69 within the deadline plus two seconds", async () => {
    const server = await serve({ version: "hang" });
    const started = Date.now();
    const result = await runCli(["keys", "--project", PROJECT, "--env", ENV_NAME], {
      env: {
        SECRETS_API_URL: server.url,
        SECRETS_MACHINE_TOKEN: token(),
        SECRETS_CA_FILE: server.caPath,
      },
      timeoutMs: 60_000,
    });
    const took = Date.now() - started;
    expect(result.code).toBe(69);
    expect(took).toBeGreaterThanOrEqual(30_000);
    expect(took).toBeLessThan(32_000);
    expect(noCredential(server)).toBe(true);
  }, 60_000);

  it("each error status with the contract's envelope → its exit code, with the server's code and request id", async () => {
    const cases: [number, ErrorCode, number][] = [
      [401, "unauthenticated", 77],
      [403, "action_denied", 77],
      [404, "not_found", 77],
      [409, "environment_changed", 69],
      [409, "key_under_review", 69],
      [429, "rate_limited", 75],
      [503, "busy", 75],
      [503, "dependency_unavailable", 69],
      [503, "backend_sealed", 69],
      [503, "backend_inconsistent", 69],
      [503, "quarantined", 69],
      [507, "capacity_exceeded", 75],
    ];
    for (const [status, code, exit] of cases) {
      const { reply, requestId } = errorReply(status, code);
      const server = await serve({ keys: reply });
      const result = await keys(server);
      expect(result.code, code).toBe(exit);
      expect(result.stdout, code).toBe("");
      expect(oneLine(result), code).toHaveLength(1);
      expect(result.stderr, code).toContain(`(code: ${code}, requestId: ${requestId})`);
      expect(result.stderr.includes("test refusal"), code).toBe(false);
    }
    // A status without the envelope: the category of the status alone.
    const bare = await serve({ keys: { status: 502, body: "bad gateway" } });
    const result = await keys(bare);
    expect(result.code).toBe(69);
    expect(result.stderr).toContain("(code: none, requestId: none)");
  });

  it("no token → 64; the variable and --token-stdin together → 64; a token of 4,097 bytes → 64; no request", async () => {
    const server = await serve();
    const base = {
      SECRETS_API_URL: server.url,
      SECRETS_CA_FILE: server.caPath,
    };
    const args = ["keys", "--project", PROJECT, "--env", ENV_NAME];
    expect((await runCli(args, { env: base })).code).toBe(64);
    expect(
      (
        await runCli([...args, "--token-stdin"], {
          env: { ...base, SECRETS_MACHINE_TOKEN: token() },
          stdin: `${token()}\n`,
        })
      ).code,
    ).toBe(64);
    const long = "a".repeat(LIMITS.body.bearerMaxBytes + 1);
    expect((await runCli(args, { env: { ...base, SECRETS_MACHINE_TOKEN: long } })).code).toBe(64);
    expect(server.requests).toEqual([]);
  });
});
