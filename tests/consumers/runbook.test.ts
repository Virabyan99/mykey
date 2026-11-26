// Run 5.8 Task B (PO-20, FR-1.85, AC-1.42 as D-03's synthetic rehearsal):
// both consumer runbooks followed from a clean machine against staging over
// its public name. The test supplies what the owner would: the release files
// (the published cli-v<version>, checked against SHA256SUMS), the variables,
// and each token on stdin. It is a staging test in all but its project: its
// own project and environment, every token revoked and the project archived
// in `finally`.
//   consumer-local.md: a fresh container of each fixture's application image
//     (the pinned Node or Python image with the application and nothing of
//     MyKey; curl added, as the runbook needs it) is the developer's machine;
//     every rehearsed block in order; rotation; after a restore.
//   consumer-deploy.md: the host's Linux shell (WSL's Ubuntu on Windows) with
//     the workstation's Docker; each fixture built, run with the token file
//     mounted, rotated.
// Then the token is searched where it must not be, each search with a control.
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLI_VERSION,
  FIXTURES,
  LAUNCH_WRAPPER,
  cleanContext,
  docker,
  releaseFiles,
  removeContainer,
  type Fixture,
} from "../harness/consumers.ts";
import {
  argumentCount,
  historyCount,
  historyOfImageCount,
  imageCount,
  textCount,
  treeCount,
} from "../harness/leak-search.ts";
import {
  freshHostHome,
  placeFile,
  provideVariables,
  rehearsedBlocks,
  removeHostHome,
  runBlock,
  runScript,
  stopBackground,
  type BlockResult,
  type RunbookBlock,
  type Target,
} from "../harness/runbook.ts";
import { registerSecret } from "../harness/staging.ts";
import { digestOf, exportedDigests } from "../harness/staging-machine.ts";
import {
  STAGING_ORIGIN,
  publicRequest,
  stagingOwnerSession,
  type PublicAnswer,
} from "../harness/staging-owner.ts";

/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const ENVIRONMENT = "development";
const LOCAL = "docs/runbooks/consumer-local.md";
const DEPLOY = "docs/runbooks/consumer-deploy.md";
const EVIDENCE = "docs/evidence/session-5/run-5.8-consumers.json";

let cookie: string;
let projectPath: string;
let environmentPath: string;
let projectId: string;
let expected: Record<string, string>;
let names: string[];
let releaseWithWrapper: string;
const issued = new Map<string, string>(); // credentialId → token, while not revoked
const tokens: string[] = []; // every token of the test
const captured: string[] = []; // every output the test saw
const containers: string[] = [];
const images: string[] = [];
const hosts: Target[] = [];
const evidence: Record<string, unknown> = {};
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};
const marker = (): string => `mykey-control-${randomBytes(12).toString("hex")}`;

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;

function send(method: string, path: string, body: unknown): Promise<PublicAnswer> {
  return publicRequest(method, path, {
    body,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
}

/**
 * A machine credential for the rehearsal. Session 11 (Run 11.8): with `runtime`
 * it is a runtime credential, and what the runbook stores as "the token" is its
 * client secret, which the CLI exchanges by itself. Everything the test does
 * with a token (storing, searching, refusing after a revocation) is the same.
 */
async function issue(
  label: string,
  kind: "token" | "runtime" = "token",
): Promise<{ credentialId: string; token: string }> {
  ({ cookie } = await stagingOwnerSession());
  const answer = await send(
    "POST",
    `${environmentPath}/${kind === "runtime" ? "runtime-credentials" : "credentials"}`,
    { name: `s5-consumer-${label}`, ttlSeconds: 3600 },
  );
  expect(answer.status).toBe(201);
  const body = json(answer) as {
    credential: { credentialId: string; kind: string };
    token?: string;
    clientSecret?: string;
  };
  expect(body.credential.kind).toBe(kind);
  const token = (kind === "runtime" ? body.clientSecret : body.token) ?? "";
  expect(token.length).toBeGreaterThan(8);
  registerSecret(token);
  tokens.push(token);
  issued.set(body.credential.credentialId, token);
  return { credentialId: body.credential.credentialId, token };
}

async function revoke(credentialId: string): Promise<void> {
  ({ cookie } = await stagingOwnerSession());
  const answer = await send("POST", `${environmentPath}/credentials/${credentialId}/revoke`, {
    confirmed: true,
  });
  const code = (json(answer).error as { code?: string } | undefined)?.code;
  expect(answer.status === 200 || code === "state_conflict", answer.body.slice(0, 200)).toBe(true);
  issued.delete(credentialId);
}

const keep = (result: BlockResult): BlockResult => {
  captured.push(result.stdout, result.stderr);
  return result;
};

async function run(target: Target, block: RunbookBlock, stdin?: string): Promise<BlockResult> {
  const result = keep(await runBlock(target, block, stdin === undefined ? {} : { stdin }));
  expect(
    result.code,
    `${block.file} "${block.heading}": stderr ${result.stderr.slice(-800)} stdout ${result.stdout.slice(-400)}`,
  ).toBe(0);
  return result;
}

/** The JSON a check block printed. */
function checkOf(result: BlockResult): { names: string[]; digests: Record<string, string> } {
  const line = result.stdout.split("\n").find((text) => text.trim().startsWith("{"));
  if (line === undefined) throw new Error(`no /check answer in: ${result.stdout.slice(0, 300)}`);
  return JSON.parse(line) as { names: string[]; digests: Record<string, string> };
}

function expectTheSet(result: BlockResult): void {
  const answer = checkOf(result);
  expect([...answer.names].sort()).toEqual([...names].sort());
  expect(answer.digests).toEqual(expected);
}

/** Waits until the application of a clean machine answers on 3000. */
async function waitReady(target: Target): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const probe = keep(
      await runScript(target, 'curl -fs -o /dev/null "http://127.0.0.1:3000/check"'),
    );
    if (probe.code === 0) return;
    if (Date.now() > deadline) {
      const log = keep(await runScript(target, 'tail -n 30 "$HOME/.rehearsal-background.log"'));
      throw new Error(`the application did not answer: ${log.stdout}`);
    }
    await sleep(1500);
  }
}

/** `secrets keys` with a token on stdin, in the target's session. */
function keysWith(target: Target, token: string): Promise<BlockResult> {
  return runScript(target, '. "$HOME/.rehearsal-session"\nsecrets keys --token-stdin\n', {
    stdin: token,
  }).then(keep);
}

const byHeading = (blocks: RunbookBlock[], prefix: string): RunbookBlock[] =>
  blocks.filter((block) => block.heading.startsWith(prefix));

/** Starts the clean machine for a fixture: its application image, curl, a user. */
function cleanMachine(fixture: Fixture): Target & { kind: "container" } {
  const appImage = `mykey-fixture-${fixture.key}:app`;
  const built = docker([
    "build",
    "--quiet",
    "--target",
    "app",
    "-t",
    appImage,
    cleanContext(fixture),
  ]);
  expect(built.status, built.stderr.slice(-1000)).toBe(0);
  images.push(appImage);
  const name = `mykey-clean-${fixture.key}-${randomBytes(3).toString("hex")}`;
  containers.push(name);
  const started = docker([
    "run",
    "-d",
    "--name",
    name,
    "--entrypoint",
    "sleep",
    appImage,
    "infinity",
  ]);
  expect(started.status, started.stderr).toBe(0);
  const user = fixture.key === "next" ? "node" : "dev";
  const prepared = docker([
    "exec",
    "-u",
    "0",
    name,
    "sh",
    "-ec",
    [
      "apt-get update -qq >/dev/null",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null",
      `id -u ${user} >/dev/null 2>&1 || useradd -m -s /bin/sh ${user}`,
      `chown -R ${user}:${user} /app`,
    ].join("\n"),
  ]);
  expect(prepared.status, prepared.stderr.slice(-1000)).toBe(0);
  return { kind: "container", name, user, home: `/home/${user}` };
}

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  const name = `s5-consumers-${randomBytes(3).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
  expect(created.status).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  projectId = result.projectId;
  projectPath = `/v1/organizations/${ORGANIZATION}/projects/${projectId}`;
  environmentPath = `${projectPath}/environments/${result.developmentEnvironmentId}`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
    const all = (json(listed).environments ?? []) as { id: string; state: string }[];
    if (
      all.find((environment) => environment.id === result.developmentEnvironmentId)?.state ===
      "active"
    ) {
      break;
    }
    if (Date.now() > deadline) throw new Error("the environment did not become active");
    await sleep(3000);
  }
  names = Array.from({ length: 10 }, (_, index) => `S5_CONSUMER_${String(index)}`);
  for (const secret of names) {
    const made = await send("POST", `${environmentPath}/secrets`, {
      name: secret,
      value: `synthetic-${randomUUID()}`,
    });
    expect(made.status, secret).toBe(201);
  }
  ({ cookie } = await stagingOwnerSession());
  const exported = await publicRequest("POST", `${environmentPath}/export`, {
    body: { confirmed: true },
    cookie,
  });
  expect(exported.status).toBe(200);
  expected = Object.fromEntries(exportedDigests(exported));
  expect(Object.keys(expected).sort()).toEqual([...names].sort());
  releaseWithWrapper = mkdtempSync(join(tmpdir(), "mykey-release-wrapper-"));
  const release = join(releaseWithWrapper, "mykey-release");
  mkdirSync(release);
  for (const file of [`mykey-cli-${CLI_VERSION}.tgz`, "install.sh", "SHA256SUMS"]) {
    copyFileSync(join(releaseFiles(), file), join(release, file));
  }
  copyFileSync(LAUNCH_WRAPPER, join(release, "secrets-launch.sh"));
  record("project", { name, id: projectId, environment: result.developmentEnvironmentId });
}, 900_000);

afterAll(async () => {
  for (const name of containers) removeContainer(name);
  for (const host of hosts) removeHostHome(host);
  for (const image of images) docker(["rmi", "-f", image]);
  rmSync(releaseWithWrapper, { recursive: true, force: true });
  try {
    for (const credentialId of [...issued.keys()]) await revoke(credentialId);
  } finally {
    ({ cookie } = await stagingOwnerSession());
    const archived = await send("POST", `${projectPath}/archive`, { confirmed: true });
    record("archived", archived.status);
  }
}, 600_000);

const variables = (extra: Record<string, string>): Record<string, string> => ({
  SECRETS_API_URL: STAGING_ORIGIN,
  SECRETS_PROJECT: projectId,
  SECRETS_ENVIRONMENT: ENVIRONMENT,
  FIXTURE_NAMES: names.join(","),
  ...extra,
});

describe.each(FIXTURES)("consumer-local.md with the $label fixture", (fixture) => {
  it("every rehearsed block in order exits 0; rotation; after a restore; the wrapper's refusals; the token in no history or argument list", async () => {
    const machine = cleanMachine(fixture);
    const root: Target = { ...machine, user: "0" };
    const blocks = rehearsedBlocks(LOCAL);
    expect(blocks.map((block) => block.mode)).toEqual([
      "provided",
      "run",
      "run",
      "run",
      "provided",
      "run",
      "stdin",
      "background",
      "run",
      "stdin",
      "background",
    ]);
    const first = await issue(`${fixture.key}-local-1`);
    let second: { credentialId: string; token: string } | undefined;
    const started = Date.now();
    for (const block of blocks) {
      if (block.mode === "provided" && block.heading.startsWith("1.")) {
        placeFile(
          machine,
          join(releaseWithWrapper, "mykey-release"),
          `${machine.home}/mykey-release`,
        );
      } else if (block.mode === "provided") {
        await provideVariables(
          machine,
          variables({ APP_DIR: "/app", APP_START: fixture.start.join(" ") }),
        );
      } else if (block.mode === "stdin") {
        if (block.heading === "Rotate the token") second = await issue(`${fixture.key}-local-2`);
        await run(machine, block, (second ?? first).token);
      } else if (block.mode === "background") {
        await stopBackground(machine);
        await run(machine, block);
        await waitReady(machine);
      } else {
        const result = await run(machine, block);
        if (block.heading.startsWith("10.")) expectTheSet(result);
      }
    }
    const check = byHeading(blocks, "10.")[0];
    if (check === undefined || second === undefined)
      throw new Error("the runbook has no check or no rotation");
    // Rotation: the application runs with the second token; the first is revoked and refused.
    expectTheSet(await run(machine, check));
    await revoke(first.credentialId);
    const refused = await keysWith(machine, first.token);
    expect(refused.code).toBe(77);
    expect(refused.stdout).toBe("");
    // After a restore (synthetic): every token of the environment revoked, a new one, replace and restart.
    for (const credentialId of [...issued.keys()]) await revoke(credentialId);
    const third = await issue(`${fixture.key}-local-3`);
    const [replace, restart] = byHeading(blocks, "Rotate the token");
    if (replace === undefined || restart === undefined) throw new Error("no rotation blocks");
    await run(machine, replace, third.token);
    await stopBackground(machine);
    await run(machine, restart);
    await waitReady(machine);
    expectTheSet(await run(machine, check));
    const elapsedMs = Date.now() - started;

    // The token is in no argument list while the application runs, and in no history file.
    const own = [first.token, second.token, third.token];
    const planted = marker();
    expect(
      keep(await runScript(machine, `exec sh -c 'sleep 120' ${planted} >/dev/null 2>&1 &`)).code,
    ).toBe(0);
    expect(await argumentCount(root, [planted])).toBeGreaterThan(0);
    expect(await argumentCount(root, own)).toBe(0);
    const historyMarker = marker();
    expect(
      keep(
        await runScript(machine, 'cat >> "$HOME/.bash_history"', { stdin: `${historyMarker}\n` }),
      ).code,
    ).toBe(0);
    expect(await historyCount(root, [historyMarker])).toBe(1);
    expect(await historyCount(root, own)).toBe(0);

    // The wrapper refuses a token file readable by group, a symbolic link and a missing file.
    const refusals = keep(
      await runScript(
        machine,
        [
          '. "$HOME/.rehearsal-session"',
          'd="$HOME/refusals"; mkdir -p "$d"; printf not-a-token > "$d/group"; chmod 640 "$d/group"',
          'printf not-a-token > "$d/real"; chmod 600 "$d/real"; ln -s "$d/real" "$d/link"',
          "for f in group link missing; do",
          '  set +e; SECRETS_TOKEN_FILE="$d/$f" secrets-launch.sh -- sh -c \'touch "$HOME/started"\' 2>/dev/null; code=$?; set -e',
          '  echo "$f=$code"',
          "done",
          'if [ -e "$HOME/started" ]; then echo started=yes; else echo started=no; fi',
        ].join("\n"),
      ),
    );
    expect(refusals.code, refusals.stderr).toBe(0);
    for (const line of ["group=78", "link=78", "missing=78", "started=no"]) {
      expect(refusals.stdout.split("\n")).toContain(line);
    }
    await stopBackground(machine);
    record(`local-${fixture.key}`, {
      credentials: [first.credentialId, second.credentialId, third.credentialId],
      blocks: blocks.length,
      elapsedMs,
      argumentControl: "found",
      historyControl: "found",
      refusals: "78 each, nothing started",
    });
  });
});

describe.each(FIXTURES)("consumer-deploy.md with the $label fixture", (fixture) => {
  it("built, run with the token file mounted, rotated; docker inspect, the argument lists, the image and its history hold no token", async () => {
    const host = freshHostHome();
    hosts.push(host);
    const appName = `mykey-deploy-${fixture.key}-${randomBytes(3).toString("hex")}`;
    const appImage = `mykey-deploy-${fixture.key}:rehearsal`;
    containers.push(appName);
    images.push(appImage);
    const blocks = rehearsedBlocks(DEPLOY);
    expect(blocks.map((block) => block.mode)).toEqual([
      "provided",
      "provided",
      "run",
      "run",
      "stdin",
      "run",
      "run",
      "stdin",
      "run",
    ]);
    // Session 11: a deployed server takes a runtime credential (machine-credentials.md, "Two kinds").
    const first = await issue(`${fixture.key}-deploy-1`, "runtime");
    let second: { credentialId: string; token: string } | undefined;
    const port = String(18_100 + Math.floor(Math.random() * 800));
    for (const block of blocks) {
      if (block.mode === "provided" && block.heading.startsWith("1.")) {
        placeFile(host, join(releaseWithWrapper, "mykey-release"), `${host.home}/mykey-release`);
      } else if (block.mode === "provided") {
        placeFile(host, cleanContext(fixture), `${host.home}/app`);
        await provideVariables(
          host,
          variables({
            APP_DIR: `${host.home}/app`,
            APP_IMAGE: appImage,
            APP_NAME: appName,
            APP_PORT: port,
          }),
        );
      } else if (block.mode === "stdin") {
        if (block.heading === "Rotate the token")
          second = await issue(`${fixture.key}-deploy-2`, "runtime");
        await run(host, block, (second ?? first).token);
      } else {
        const result = await run(host, block);
        if (block.heading.startsWith("7.")) expectTheSet(result);
      }
    }
    const check = byHeading(blocks, "7.")[0];
    if (check === undefined || second === undefined)
      throw new Error("the runbook has no check or no rotation");
    expectTheSet(await run(host, check));
    await revoke(first.credentialId);
    const user = docker(["inspect", "-f", "{{.Config.User}}", appName]).stdout.trim();
    const container: Target = {
      kind: "container",
      name: appName,
      user: user === "" ? "0" : user,
      home: "/tmp",
    };
    const refused = keep(
      await runScript(container, "secrets keys --token-stdin", { stdin: first.token }),
    );
    expect(refused.code).toBe(77);
    expect(refused.stdout).toBe("");
    const own = [first.token, second.token];

    // docker inspect: the path of the token file, never the token (control: a variable set with -e).
    const controlName = `mykey-control-${randomBytes(3).toString("hex")}`;
    containers.push(controlName);
    const planted = marker();
    expect(
      docker(
        [
          "run",
          "-d",
          "--name",
          controlName,
          "-e",
          "CONTROL",
          "--entrypoint",
          "sleep",
          appImage,
          "120",
        ],
        {
          env: { CONTROL: planted },
        },
      ).status,
    ).toBe(0);
    expect(textCount(docker(["inspect", controlName]).stdout, [planted])).toBeGreaterThan(0);
    const inspected = docker(["inspect", appName]).stdout;
    captured.push(inspected);
    expect(inspected).toContain("SECRETS_TOKEN_FILE=/run/secrets/mykey-token");
    expect(textCount(inspected, own)).toBe(0);

    // The argument lists inside the running container (control: a process started with the marker).
    expect(
      keep(await runScript(container, `exec sh -c 'sleep 120' ${planted} >/dev/null 2>&1 &`)).code,
    ).toBe(0);
    expect(await argumentCount(container, [planted])).toBeGreaterThan(0);
    expect(await argumentCount(container, own)).toBe(0);

    // The host shell's history files (control: a marker appended to one).
    const historyMarker = marker();
    expect(
      keep(await runScript(host, 'cat >> "$HOME/.bash_history"', { stdin: `${historyMarker}\n` }))
        .code,
    ).toBe(0);
    expect(await historyCount(host, [historyMarker])).toBe(1);
    expect(await historyCount(host, own)).toBe(0);

    // The image, every layer, and its history (control: an image built on it with the marker in a layer).
    const controlImage = `mykey-control-${fixture.key}:rehearsal`;
    images.push(controlImage);
    const builtControl = docker(["build", "--quiet", "-t", controlImage, "-"], {
      input: `FROM ${appImage}\nRUN printf '%s' ${planted} > /tmp/control\n`,
    });
    expect(builtControl.status, builtControl.stderr.slice(-500)).toBe(0);
    expect(await imageCount(controlImage, [planted])).toBeGreaterThan(0);
    expect(historyOfImageCount(controlImage, [planted])).toBeGreaterThan(0);
    expect(await imageCount(appImage, own)).toBe(0);
    expect(historyOfImageCount(appImage, own)).toBe(0);

    record(`deploy-${fixture.key}`, {
      credentials: [first.credentialId, second.credentialId],
      blocks: blocks.length,
      inspect: "token file path only",
      controls: "inspect, arguments, history, image, image history: found",
    });
  });
});

describe("the tokens of this test", () => {
  it("are in no file of the working tree and in none of the test's captured output", () => {
    expect(tokens.length).toBe(10);
    const planted = marker();
    const control = join(
      "tests",
      "consumers",
      `.rehearsal-control-${randomBytes(3).toString("hex")}`,
    );
    writeFileSync(control, `${planted}\n`);
    try {
      expect(treeCount([planted])).toBe(1);
    } finally {
      unlinkSync(control);
    }
    expect(treeCount(tokens)).toBe(0);
    const echoed = marker();
    captured.push(`some output ${echoed}\n`);
    expect(textCount(captured.join("\n"), [echoed])).toBe(1);
    expect(textCount(captured.join("\n"), tokens)).toBe(0);
    expect(tokens.map((token) => digestOf(token)).length).toBe(10);
    record("searches", { tree: 0, captured: 0, tokens: tokens.length, controls: "found" });
  });
});
