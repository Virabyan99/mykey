// Run 11.4 (Session 11, P-187, D-81; spec §2.4): the CLI with a runtime
// credential. A client secret (`mkrc.<id>.<secret>`) is exchanged once, after
// the version check, and the read is made with the exchanged token. A 30-day
// token makes no exchange. The secrets here are synthetic and made at run
// time; the server keeps only the SHA-256 of a bearer.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenv } from "@mykey/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliResult } from "../harness/cli.ts";
import {
  ENV_NAME,
  NAMES,
  PROJECT,
  errorReply,
  goodExchange,
  goodResolve,
  startCliServer,
  type CliServer,
  type Reply,
  type ServerScript,
} from "./server.ts";

const CHILD = join(process.cwd(), "tests", "cli", "child.mjs");
const EXCHANGE = "/v1/machine/exchange";
const machine = (route: "keys" | "resolve"): string =>
  `/v1/machine/projects/${PROJECT}/environments/${ENV_NAME}/${route}`;
const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const thirtyDayToken = (): string => `s.${randomBytes(18).toString("base64url")}`;

/** A runtime credential's client secret in its presented shape, with its parts. */
function runtimeCredential(): { presented: string; id: string; secret: string } {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return { presented: `mkrc.${id}.${secret}`, id, secret };
}

interface Marker {
  starts: number;
  env: Record<string, string>;
}

let base: string;
let cwd: string;
let home: string;
let out: string;
let marker: string;
const servers: CliServer[] = [];
const listeners: Server[] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mykey-exchange-")));
  cwd = join(base, "cwd");
  home = join(base, "home");
  out = join(base, "out");
  for (const dir of [cwd, home, out]) {
    mkdirSync(dir);
    chmodSync(dir, 0o700);
  }
  marker = join(base, "child.json");
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const listener of listeners.splice(0)) listener.close();
  rmSync(base, { recursive: true, force: true });
});

async function serve(script: ServerScript = {}): Promise<CliServer> {
  const server = await startCliServer(script);
  servers.push(server);
  return server;
}

function envOf(server: CliServer, token: string | null): Record<string, string> {
  return {
    SECRETS_API_URL: server.url,
    SECRETS_CA_FILE: server.caPath,
    ...(token === null ? {} : { SECRETS_MACHINE_TOKEN: token }),
    HOME: home,
    TMPDIR: base,
  };
}

const selector = ["--project", PROJECT, "--env", ENV_NAME];
/** Built when a test runs: the marker's path is made in beforeEach. */
const runArgs = (): string[] => ["run", ...selector, "--", process.execPath, CHILD, marker];
const run = (server: CliServer, token: string): Promise<CliResult> =>
  runCli(runArgs(), { env: envOf(server, token), cwd });
const readMarker = (): Marker => JSON.parse(readFileSync(marker, "utf8")) as Marker;
/** What the server saw, as [method, path, digest of the bearer]. */
const calls = (server: CliServer): [string, string, string | null][] =>
  server.seen.map((request) => [request.method, request.path, request.bearerSha]);

describe("the CLI exchanges a runtime credential before the read", () => {
  it("run with SECRETS_MACHINE_TOKEN holding a runtime credential: the child starts with every entry, and the server saw one exchange, then one resolve with the exchanged token", async () => {
    const entries = NAMES.map((name) => ({ name, value: `synthetic-${name}-${randomUUID()}` }));
    const server = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const credential = runtimeCredential();
    const result = await run(server, credential.presented);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const seen = readMarker();
    expect(seen.starts).toBe(1);
    for (const entry of entries) expect(seen.env[entry.name], entry.name).toBe(sha(entry.value));
    expect(calls(server)).toEqual([
      ["GET", "/v1/version", null],
      ["POST", EXCHANGE, sha(credential.presented)],
      ["POST", machine("resolve"), sha(server.exchangedToken)],
    ]);
  });

  it("keys and export with --token-stdin holding a runtime credential work the same way", async () => {
    const entries = NAMES.map((name) => ({ name, value: `synthetic-${name}-${randomUUID()}` }));
    const forKeys = await serve();
    const first = runtimeCredential();
    const keys = await runCli(["keys", ...selector, "--token-stdin"], {
      env: envOf(forKeys, null),
      stdin: `${first.presented}\n`,
    });
    expect(keys.code, keys.stderr).toBe(0);
    expect(keys.stdout).toBe(`${NAMES.join("\n")}\n`);
    expect(calls(forKeys)).toEqual([
      ["GET", "/v1/version", null],
      ["POST", EXCHANGE, sha(first.presented)],
      ["GET", machine("keys"), sha(forKeys.exchangedToken)],
    ]);

    const forExport = await serve({ resolve: { status: 200, body: goodResolve(entries) } });
    const second = runtimeCredential();
    const target = join(out, "app.env");
    const exported = await runCli(["export", ...selector, "--output", target, "--token-stdin"], {
      env: envOf(forExport, null),
      stdin: `${second.presented}\n`,
    });
    expect(exported.code, exported.stderr).toBe(0);
    const parsed = parseDotenv(readFileSync(target));
    if (!parsed.ok) throw new Error("the exported file does not parse");
    expect(new Map(parsed.entries.map((entry) => [entry.name, sha(entry.value)]))).toEqual(
      new Map(entries.map((entry) => [entry.name, sha(entry.value)])),
    );
    expect(calls(forExport)).toEqual([
      ["GET", "/v1/version", null],
      ["POST", EXCHANGE, sha(second.presented)],
      ["POST", machine("resolve"), sha(forExport.exchangedToken)],
    ]);
  });

  it("the exchange refused with 401: nothing starts, exit 77, one line on stderr with the code and the request id, and the line holds no part of the secret", async () => {
    const { reply, requestId } = errorReply(401, "unauthenticated");
    const server = await serve({ exchange: reply });
    const credential = runtimeCredential();
    const result = await run(server, credential.presented);
    expect(result.code).toBe(77);
    expect(existsSync(marker)).toBe(false);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain(`(code: unauthenticated, requestId: ${requestId})`);
    for (const part of [credential.presented, credential.secret, credential.id, "mkrc."]) {
      expect(result.stderr.includes(part)).toBe(false);
    }
    // Nothing was asked after the refusal.
    expect(calls(server).map(([, path]) => path)).toEqual(["/v1/version", EXCHANGE]);
  });

  it("the exchange answering 429 is exit 75, and 503 is exit 69", async () => {
    for (const [status, code, exit] of [
      [429, "rate_limited", 75],
      [503, "dependency_unavailable", 69],
    ] as const) {
      const { reply, requestId } = errorReply(status, code);
      const server = await serve({ exchange: reply });
      const result = await run(server, runtimeCredential().presented);
      expect(result.code, code).toBe(exit);
      expect(existsSync(marker), code).toBe(false);
      expect(result.stderr, code).toContain(`(code: ${code}, requestId: ${requestId})`);
      // One exchange: a refusal is not asked again.
      expect(calls(server).map(([, path]) => path)).toEqual(["/v1/version", EXCHANGE]);
    }
  });

  it("an exchange answer that is not the contract's body is exit 65, and nothing starts", async () => {
    const good = goodExchange(thirtyDayToken());
    const without = (key: string): Record<string, unknown> =>
      Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
    const cases: [string, Reply][] = [
      ["no token", { status: 200, body: without("token") }],
      ["an empty token", { status: 200, body: { ...good, token: "" } }],
      ["a token with a space", { status: 200, body: { ...good, token: "s.abc def" } }],
      ["a token with a line break", { status: 200, body: { ...good, token: "s.abc\r\nx: y" } }],
      ["no expiry", { status: 200, body: without("expiresAt") }],
      ["a key the contract does not have", { status: 200, body: { ...good, extra: true } }],
      ["another API version", { status: 200, body: { ...good, apiMajor: 2 } }],
      [
        "a page",
        { status: 200, headers: { "content-type": "text/html" }, body: "<html>sign in</html>" },
      ],
    ];
    for (const [label, reply] of cases) {
      const server = await serve({ exchange: reply });
      const result = await run(server, runtimeCredential().presented);
      expect(result.code, label).toBe(65);
      expect(existsSync(marker), label).toBe(false);
      expect(result.stderr, label).toMatch(/^secrets: malformed: /);
      expect(
        calls(server).map(([, path]) => path),
        label,
      ).toEqual(["/v1/version", EXCHANGE]);
    }
  });

  it("a 30-day token: the server sees no exchange", async () => {
    const server = await serve();
    const token = thirtyDayToken();
    const result = await run(server, token);
    expect(result.code, result.stderr).toBe(0);
    expect(readMarker().starts).toBe(1);
    expect(calls(server)).toEqual([
      ["GET", "/v1/version", null],
      ["POST", machine("resolve"), sha(token)],
    ]);
  });

  it("the child's environment holds neither the client secret nor the exchanged token", async () => {
    const server = await serve();
    const credential = runtimeCredential();
    const result = await run(server, credential.presented);
    expect(result.code, result.stderr).toBe(0);
    const seen = readMarker();
    const digests = Object.values(seen.env);
    for (const hidden of [credential.presented, credential.secret, server.exchangedToken]) {
      expect(digests).not.toContain(sha(hidden));
    }
    expect(Object.keys(seen.env).filter((name) => name.startsWith("SECRETS_"))).toEqual([]);
  });

  it("the exchange goes to SECRETS_API_URL only, over https, with the bearer header and no body", async () => {
    const other = await serve();
    const server = await serve();
    const credential = runtimeCredential();
    const result = await run(server, credential.presented);
    expect(result.code, result.stderr).toBe(0);
    expect(other.requests).toEqual([]);
    const exchange = server.seen.filter((request) => request.path === EXCHANGE);
    expect(exchange).toEqual([
      {
        method: "POST",
        path: EXCHANGE,
        bearerSha: sha(credential.presented),
        contentLength: "0",
        bodyBytes: 0,
      },
    ]);
    // The client secret went to the exchange and nowhere else.
    expect(
      server.seen.filter((request) => request.bearerSha === sha(credential.presented)),
    ).toHaveLength(1);

    // An http:// address is refused before any connection, with a runtime credential too.
    let connections = 0;
    const listener = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    listeners.push(listener);
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;
    rmSync(marker, { force: true });
    const plain = await runCli(runArgs(), {
      env: {
        ...envOf(server, runtimeCredential().presented),
        SECRETS_API_URL: `http://127.0.0.1:${String(port)}`,
      },
      cwd,
    });
    expect(plain.code).toBe(78);
    expect(connections).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
