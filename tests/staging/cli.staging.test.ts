// Run 5.6 Task C (FR-1.47–1.50, AC-1.20, AC-1.21, P-97 layer 3): the CLI as a
// process against the API Run 5.4 deployed, through the public name. On this
// Windows workstation the CLI runs in the pinned glibc Node image
// (runCliInLinux); the token reaches it by environment name only. The staging
// owner seeds ten synthetic values in a project of its own and issues a token
// (300 s): keys prints the ten names; run starts a child whose value digests
// equal the owner's export; export writes a 0600 file there whose digests are
// the same; after the revocation run and keys exit 77 and start nothing.
//
// Session 11 (Run 11.8, spec §6 item 12; Review focus 7): with MYKEY_CLI_DIST
// the CLI is a published release's bundle, not this tree's build, and the
// evidence goes to Session 11's file. A second test gives the CLI a runtime
// credential's client secret: from 0.2.0 it starts with it; an older CLI
// presents it as a token, is refused, exits 77 and starts nothing.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { releasedCliDist, runCliInLinux, runShellInLinux } from "../harness/cli-linux.ts";
import { registerSecret } from "../harness/staging.ts";
import { exportedDigests } from "../harness/staging-machine.ts";
import {
  STAGING_ORIGIN,
  publicRequest,
  stagingOwnerSession,
  type PublicAnswer,
} from "../harness/staging-owner.ts";

/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const ENVIRONMENT = "development";

let cookie: string;
let projectId: string;
let environmentPath: string;
const issued = new Set<string>();
const evidence: Record<string, unknown> = {};
const RELEASED = releasedCliDist() !== undefined;
// The second review of Run 11.8 (M1): the run names the version it means to
// prove. For a published bundle the operator names it (MYKEY_CLI_EXPECT);
// without one it is this tree's. What the CLI under test says about itself is
// compared with it and never decides an expectation.
const EXPECTED_VERSION = RELEASED
  ? (process.env.MYKEY_CLI_EXPECT ?? "")
  : (JSON.parse(readFileSync("apps/cli/package.json", "utf8")) as { version: string }).version;
const expectedParts = EXPECTED_VERSION.split(".");
if (
  expectedParts.length !== 3 ||
  !expectedParts.every((part) => part !== "" && Number.isInteger(Number(part)))
) {
  throw new Error("with MYKEY_CLI_DIST, MYKEY_CLI_EXPECT names the bundle's version (x.y.z)");
}
/** From 0.2.0 the CLI exchanges a client secret by itself (D-81). */
const EXCHANGES = Number(expectedParts[0]) > 0 || Number(expectedParts[1]) >= 2;
const EVIDENCE = RELEASED
  ? `docs/evidence/session-11/staging-cli-released-${EXPECTED_VERSION}.json`
  : "docs/evidence/session-5/run-5.6-staging-cli.json";
/** The CLI under test, as it says itself (`secrets --version`). */
let cliVersion = "";
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const codeOf = (answer: PublicAnswer): string | undefined =>
  (json(answer).error as { code?: string } | undefined)?.code;

function send(method: string, path: string, body: unknown): Promise<PublicAnswer> {
  return publicRequest(method, path, {
    body,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
}

async function revokeAll(): Promise<void> {
  ({ cookie } = await stagingOwnerSession());
  for (const credentialId of issued) {
    const answer = await send("POST", `${environmentPath}/credentials/${credentialId}/revoke`, {
      confirmed: true,
    });
    if (answer.status === 200 || codeOf(answer) === "state_conflict") issued.delete(credentialId);
  }
  expect(issued.size, "a credential of this file was not revoked").toBe(0);
}

// Prints {name: sha256(value)} for the seeded names: what the child was given.
const CHILD = [
  'const { createHash } = require("node:crypto");',
  "const out = {};",
  "for (const [name, value] of Object.entries(process.env)) {",
  '  if (name.startsWith("S5_CLI_")) out[name] = createHash("sha256").update(value, "utf8").digest("hex");',
  "}",
  'out.__secrets = Object.keys(process.env).filter((name) => name.startsWith("SECRETS_")).length;',
  "console.log(JSON.stringify(out));",
].join("\n");

// Reads a canonical dotenv file whose values need no unescaping (the seeded
// values are [a-z0-9-] only) and prints {name: sha256(value)}.
const FILE_DIGESTS = [
  'const { createHash } = require("node:crypto");',
  'const { readFileSync } = require("node:fs");',
  "const out = {};",
  'for (const line of readFileSync(process.argv[1], "utf8").split(String.fromCharCode(10))) {',
  '  if (line === "") continue;',
  '  const at = line.indexOf("=");',
  '  out[line.slice(0, at)] = createHash("sha256").update(line.slice(at + 2, -1), "utf8").digest("hex");',
  "}",
  "console.log(JSON.stringify(out));",
].join("\n");

beforeAll(async () => {
  if (!RELEASED) {
    const built = spawnSync(process.execPath, ["apps/cli/build.ts"], { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
  }
  const said = await runCliInLinux(["--version"]);
  expect(said.code, said.stderr).toBe(0);
  cliVersion = /^secrets (\d+\.\d+\.\d+) /.exec(said.stdout)?.[1] ?? "";
  expect(cliVersion).not.toBe("");
  expect(cliVersion, "the CLI under test is not the version this run names").toBe(EXPECTED_VERSION);
  record("cli", { version: cliVersion, released: RELEASED });
  ({ cookie } = await stagingOwnerSession());
  const name = `s5-cli-${randomBytes(3).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
  expect(created.status).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  projectId = result.projectId;
  const projectPath = `/v1/organizations/${ORGANIZATION}/projects/${projectId}`;
  environmentPath = `${projectPath}/environments/${result.developmentEnvironmentId}`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
    const all = (json(listed).environments ?? []) as { id: string; state: string; name: string }[];
    const own = all.find((environment) => environment.id === result.developmentEnvironmentId);
    expect(own?.name).toBe(ENVIRONMENT);
    if (own?.state === "active") break;
    if (Date.now() > deadline) throw new Error(`environment stayed ${String(own?.state)}`);
    await sleep(3000);
  }
  record("project", { name, id: projectId, environment: result.developmentEnvironmentId });
}, 300_000);

describe("the CLI against staging", () => {
  it("keys → run (digests equal the owner's export) → export (0600, same digests) → revoke → run and keys exit 77 and start nothing", async () => {
    try {
      const names: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const name = `S5_CLI_${String(index)}`;
        const made = await send("POST", `${environmentPath}/secrets`, {
          name,
          value: `synthetic-${randomUUID()}`,
        });
        expect(made.status, name).toBe(201);
        names.push(name);
      }
      ({ cookie } = await stagingOwnerSession());
      const issuedAnswer = await send("POST", `${environmentPath}/credentials`, {
        name: "s5-cli",
        ttlSeconds: 300,
      });
      expect(issuedAnswer.status, issuedAnswer.body.slice(0, 200)).toBe(201);
      const body = json(issuedAnswer) as { credential: { credentialId: string }; token: string };
      registerSecret(body.token);
      issued.add(body.credential.credentialId);
      const env = {
        SECRETS_API_URL: STAGING_ORIGIN,
        SECRETS_MACHINE_TOKEN: body.token,
        SECRETS_PROJECT: projectId,
        SECRETS_ENVIRONMENT: ENVIRONMENT,
      };
      const exported = await publicRequest("POST", `${environmentPath}/export`, {
        body: { confirmed: true },
        cookie,
      });
      expect(exported.status).toBe(200);
      const expected = Object.fromEntries(exportedDigests(exported));

      const keys = await runCliInLinux(["keys"], { env });
      expect(keys.code, keys.stderr).toBe(0);
      expect(keys.stdout).toBe(`${[...names].sort().join("\n")}\n`);

      const run = await runCliInLinux(["run", "--", "node", "-e", CHILD], { env });
      expect(run.code, run.stderr).toBe(0);
      const seen = JSON.parse(run.stdout) as Record<string, string | number>;
      expect(seen.__secrets).toBe(0);
      delete seen.__secrets;
      expect(seen).toEqual(expected);

      const exportRun = await runShellInLinux(
        [
          "set -e",
          "mkdir -m 700 /tmp/out",
          "$MYKEY_CLI_COMMAND export --output /tmp/out/app.env",
          "stat -c %a /tmp/out/app.env",
          'node -e "$FILE_DIGESTS" /tmp/out/app.env',
        ].join("\n"),
        { env: { ...env, FILE_DIGESTS } },
      );
      expect(exportRun.code, exportRun.stderr).toBe(0);
      const [mode, digests] = exportRun.stdout.trim().split("\n");
      expect(mode).toBe("600");
      expect(JSON.parse(digests ?? "{}")).toEqual(expected);
      expect(exportRun.stderr).toContain("holds plaintext secrets");

      const revoked = await send(
        "POST",
        `${environmentPath}/credentials/${body.credential.credentialId}/revoke`,
        { confirmed: true },
      );
      expect(revoked.status, revoked.body.slice(0, 200)).toBe(200);
      issued.delete(body.credential.credentialId);

      const runAfter = await runCliInLinux(["run", "--", "node", "-e", 'console.log("started")'], {
        env,
      });
      expect(runAfter.code).toBe(77);
      expect(runAfter.stdout).toBe("");
      expect(runAfter.stderr).toMatch(
        /^secrets: denied: .*\(code: unauthenticated, requestId: [0-9a-f-]{36}\)\n$/,
      );
      const keysAfter = await runCliInLinux(["keys"], { env });
      expect(keysAfter.code).toBe(77);
      expect(keysAfter.stdout).toBe("");
      record("journey", {
        credentialId: body.credential.credentialId,
        keys: keys.code,
        run: run.code,
        names: Object.keys(seen).length,
        exportMode: mode,
        afterRevoke: { run: runAfter.code, keys: keysAfter.code },
        where: process.platform === "win32" ? "node-glibc container" : process.platform,
      });
    } finally {
      await revokeAll();
    }
  }, 600_000);

  it("a runtime credential's client secret: from 0.2.0 the CLI starts with it; an older CLI exits 77 and starts nothing", async () => {
    try {
      ({ cookie } = await stagingOwnerSession());
      const issuedAnswer = await send("POST", `${environmentPath}/runtime-credentials`, {
        name: "s11-cli-runtime",
        ttlSeconds: 3600,
      });
      expect(issuedAnswer.status).toBe(201);
      const body = json(issuedAnswer) as {
        credential: { credentialId: string };
        clientSecret: string;
      };
      registerSecret(body.clientSecret);
      issued.add(body.credential.credentialId);
      const env = {
        SECRETS_API_URL: STAGING_ORIGIN,
        SECRETS_MACHINE_TOKEN: body.clientSecret,
        SECRETS_PROJECT: projectId,
        SECRETS_ENVIRONMENT: ENVIRONMENT,
      };
      const exchanges = EXCHANGES;
      const run = await runCliInLinux(["run", "--", "node", "-e", 'console.log("started")'], {
        env,
      });
      if (exchanges) {
        expect(run.code, run.stderr).toBe(0);
        expect(run.stdout).toBe("started\n");
      } else {
        expect(run.code).toBe(77);
        expect(run.stdout).toBe("");
        expect(run.stderr).toMatch(
          /^secrets: denied: .*\(code: unauthenticated, requestId: [0-9a-f-]{36}\)\n$/,
        );
      }
      // Session 11's own record of this test, one file per CLI version: the
      // journey's file is Session 5's when the CLI is this tree's build.
      writeFileSync(
        `docs/evidence/session-11/staging-cli-runtime-credential-${cliVersion}.json`,
        `${JSON.stringify(
          {
            cli: cliVersion,
            published: RELEASED,
            exchanges,
            exit: run.code,
            startedTheChild: run.stdout.length > 0,
          },
          null,
          2,
        )}\n`,
      );
      record("runtimeCredential", {
        cli: cliVersion,
        exchanges,
        run: run.code,
        started: run.stdout === "started\n",
      });
    } finally {
      await revokeAll();
    }
  }, 600_000);
});
