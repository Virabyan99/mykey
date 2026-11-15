// The consumer fixtures (Run 5.8, P-100): building their images from a clean
// context, and asking a running one for GET /check. The release files are the
// published release of this CLI version (`gh release download`, checked
// against its SHA256SUMS); the Node archive for the Docker host's architecture
// comes from nodejs.org once into the suite's cache, checked against the lock.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface Fixture {
  key: "next" | "fastapi";
  label: string;
  dir: string;
  image: string;
  /** The server command, as the image's CMD runs it (working directory /app). */
  start: string[];
}

export const FIXTURES: Fixture[] = [
  {
    key: "next",
    label: "Next.js",
    dir: "tests/fixtures/consumers/next-app",
    image: "mykey-fixture-next:test",
    start: ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"],
  },
  {
    key: "fastapi",
    label: "FastAPI",
    dir: "tests/fixtures/consumers/fastapi-app",
    image: "mykey-fixture-fastapi:test",
    start: ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"],
  },
];

export const LAUNCH_WRAPPER = "tests/fixtures/consumers/secrets-launch.sh";

const lock = JSON.parse(readFileSync("infra/dependencies.lock.json", "utf8")) as {
  node: { version: string };
  binaries: Record<string, { asset: string; sha256: string }>;
};
export const CLI_VERSION = (
  JSON.parse(readFileSync("apps/cli/package.json", "utf8")) as { version: string }
).version;
export const CLI_RELEASE = `cli-v${CLI_VERSION}`;
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** docker <args>; values reach it through `env` (names on the command line only). */
export function docker(
  args: string[],
  opts: { env?: Record<string, string>; input?: string } = {},
): Run {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1", ...opts.env },
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export function removeContainer(name: string): void {
  docker(["rm", "-f", "-v", name]);
}

let release: string | undefined;

/** The three files of the published release, downloaded once and checked against SHA256SUMS. */
export function releaseFiles(): string {
  if (release !== undefined) return release;
  const dir = mkdtempSync(join(tmpdir(), "mykey-consumer-release-"));
  const got = spawnSync("gh", ["release", "download", CLI_RELEASE, "--dir", dir], {
    encoding: "utf8",
  });
  if (got.status !== 0) throw new Error(`gh release download ${CLI_RELEASE}: ${got.stderr}`);
  for (const line of readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n")) {
    const [sum, name] = line.split(/\s+/);
    if (name === undefined || sha(readFileSync(join(dir, name))) !== sum) {
      throw new Error(`${CLI_RELEASE}: ${String(name)} does not match SHA256SUMS`);
    }
  }
  release = dir;
  return dir;
}

/** The Docker host's architecture as a Node target (linux-x64 or linux-arm64). */
export function dockerTarget(): string {
  const arch = docker(["info", "--format", "{{.Architecture}}"]).stdout.trim();
  return arch === "aarch64" || arch === "arm64" ? "linux-arm64" : "linux-x64";
}

/** The official Node archive of `target`, cached and checked against the lock file. */
export async function nodeArchive(target: string): Promise<string> {
  const pin = lock.binaries[`node-${target}`];
  if (pin === undefined) throw new Error(`no pinned Node archive for ${target}`);
  const cache = process.env.MYKEY_TEST_CACHE ?? join(homedir(), ".cache", "mykey-tests");
  mkdirSync(cache, { recursive: true });
  const path = join(cache, pin.asset);
  if (!existsSync(path) || sha(readFileSync(path)) !== pin.sha256) {
    const response = await fetch(`https://nodejs.org/dist/v${lock.node.version}/${pin.asset}`);
    if (!response.ok) throw new Error(`the Node archive answered ${String(response.status)}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== pin.sha256) throw new Error("the downloaded Node archive has another sum");
    writeFileSync(path, bytes);
  }
  return path;
}

/** Fills `<dir>/mykey-release/` as consumer-deploy.md does. */
export async function fillReleaseDir(dir: string): Promise<void> {
  const out = join(dir, "mykey-release");
  mkdirSync(out, { recursive: true });
  const files = releaseFiles();
  for (const name of [`mykey-cli-${CLI_VERSION}.tgz`, "install.sh", "SHA256SUMS"]) {
    copyFileSync(join(files, name), join(out, name));
  }
  const archive = await nodeArchive(dockerTarget());
  copyFileSync(archive, join(out, archive.split(/[\\/]/).pop() ?? "node.tar.gz"));
  copyFileSync(LAUNCH_WRAPPER, join(out, "secrets-launch.sh"));
}

/** The fixture directory as Git would commit it (nothing ignored), copied into a new directory. */
export function cleanContext(fixture: Fixture): string {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "-co", "--exclude-standard", "--", fixture.dir],
    { encoding: "utf8" },
  );
  if (listed.status !== 0) throw new Error(`git ls-files ${fixture.dir} failed`);
  const files = listed.stdout.split("\0").filter((file) => file !== "" && existsSync(file));
  if (files.length === 0) throw new Error(`${fixture.dir} has no files`);
  const context = mkdtempSync(join(tmpdir(), `mykey-fixture-${fixture.key}-`));
  for (const file of files) {
    const target = join(context, file.slice(fixture.dir.length + 1));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  return context;
}

/** Builds the fixture's image from a clean context with the release files in it. */
export async function buildFixtureImage(
  fixture: Fixture,
  tag: string = fixture.image,
): Promise<void> {
  const context = cleanContext(fixture);
  await fillReleaseDir(context);
  const built = docker(["build", "--quiet", "-t", tag, context]);
  if (built.status !== 0)
    throw new Error(`docker build ${fixture.key}: ${built.stderr.slice(-2000)}`);
}

export interface CheckAnswer {
  names: string[];
  digests: Record<string, string>;
}

/** GET /check of a container that publishes 3000 on 127.0.0.1, waiting for it to answer. */
export async function waitForCheck(container: string, timeoutMs = 120_000): Promise<CheckAnswer> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const port = docker(["port", container, "3000/tcp"]).stdout.trim().split("\n")[0] ?? "";
    const at = port.lastIndexOf(":");
    if (at !== -1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port.slice(at + 1)}/check`);
        if (response.ok) return (await response.json()) as CheckAnswer;
        last = `status ${String(response.status)}`;
      } catch (error) {
        last = String(error);
      }
    }
    const state = docker(["inspect", "-f", "{{.State.Status}}", container]).stdout.trim();
    if (state === "exited" || state === "dead") {
      const logs = docker(["logs", "--tail", "20", container]);
      throw new Error(
        `${container} ${state}: ${logs.stderr.slice(-800)}${logs.stdout.slice(-800)}`,
      );
    }
    if (Date.now() > deadline) throw new Error(`${container}: /check did not answer (${last})`);
    await sleep(1000);
  }
}
