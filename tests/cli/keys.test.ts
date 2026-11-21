// Run 5.5 Task B (FR-1.47, FR-1.49): `secrets keys` prints the live names one
// a line, and nothing at all unless the whole answer passed the validator.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../harness/cli.ts";
import {
  ENV_NAME,
  NAMES,
  PROJECT,
  errorReply,
  goodKeys,
  startCliServer,
  type CliServer,
  type ServerScript,
} from "./server.ts";

const token = (): string => `s.${randomBytes(18).toString("base64url")}`;
const servers: CliServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function serve(script: ServerScript = {}): Promise<CliServer> {
  const server = await startCliServer(script);
  servers.push(server);
  return server;
}

const args = ["keys", "--project", PROJECT, "--env", ENV_NAME];
const envOf = (server: CliServer, extra: Record<string, string> = {}) => ({
  SECRETS_API_URL: server.url,
  SECRETS_CA_FILE: server.caPath,
  ...extra,
});

describe("secrets keys", () => {
  it("prints the names one a line in the server's order, with a final newline; exit 0", async () => {
    const order = ["ZETA", "ALPHA", "MIDDLE_1"];
    const server = await serve({ keys: { status: 200, body: goodKeys(order) } });
    const result = await runCli(args, { env: envOf(server, { SECRETS_MACHINE_TOKEN: token() }) });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ZETA\nALPHA\nMIDDLE_1\n");
    expect(result.stderr).toBe("");
    expect(server.requests.map((request) => [request.path, request.hadAuthorization])).toEqual([
      ["/v1/version", false],
      [`/v1/machine/projects/${PROJECT}/environments/${ENV_NAME}/keys`, true],
    ]);
  });

  it("reads the token from stdin with --token-stdin", async () => {
    const server = await serve();
    const result = await runCli([...args, "--token-stdin"], {
      env: envOf(server),
      stdin: `${token()}\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${NAMES.join("\n")}\n`);
  });

  it("takes the selector from SECRETS_PROJECT and SECRETS_ENVIRONMENT", async () => {
    const server = await serve();
    const result = await runCli(["keys"], {
      env: envOf(server, {
        SECRETS_MACHINE_TOKEN: token(),
        SECRETS_PROJECT: PROJECT,
        SECRETS_ENVIRONMENT: ENV_NAME,
      }),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${NAMES.join("\n")}\n`);
  });

  it("a wrong count → 65 and stdout is empty", async () => {
    const server = await serve({ keys: { status: 200, body: { ...goodKeys(), count: 4 } } });
    const result = await runCli(args, { env: envOf(server, { SECRETS_MACHINE_TOKEN: token() }) });
    expect(result.code).toBe(65);
    expect(result.stdout).toBe("");
  });

  it("a name that breaks the name rule → 65 and stdout is empty", async () => {
    const server = await serve({
      keys: { status: 200, body: { ...goodKeys(), names: ["ALPHA", "not-a-name", "GAMMA"] } },
    });
    const result = await runCli(args, { env: envOf(server, { SECRETS_MACHINE_TOKEN: token() }) });
    expect(result.code).toBe(65);
    expect(result.stdout).toBe("");
    expect(result.stderr.includes("not-a-name")).toBe(false);
  });

  it("a body cut short of its length → 65 or 69, stdout empty", async () => {
    const whole = Buffer.from(JSON.stringify(goodKeys()), "utf8");
    const server = await serve({
      keys: {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(whole.length + 10),
        },
        body: whole,
      },
    });
    const result = await runCli(args, { env: envOf(server, { SECRETS_MACHINE_TOKEN: token() }) });
    expect([65, 69]).toContain(result.code);
    expect(result.stdout).toBe("");
  });

  it("401 → 77", async () => {
    const { reply, requestId } = errorReply(401, "unauthenticated");
    const server = await serve({ keys: reply });
    const result = await runCli(args, { env: envOf(server, { SECRETS_MACHINE_TOKEN: token() }) });
    expect(result.code).toBe(77);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(requestId);
  });
});
