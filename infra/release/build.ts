// Run 6.9 Task A (P-127, D-57): a host release, built once.
//
//   pnpm run host:release -- --version 0.6.0 [--out <dir>]
//
// Refuses a dirty tree and a commit origin does not hold. Builds the api,
// provisioner and ops images with MYKEY_BUILD = the commit's first 12 hex,
// proves each final image holds no npm, npx or corepack, saves each as
// <name>.tar, runs the three scanners (images over these archives), and only
// then writes release.json and SHA256SUMS. Run it on a clean clone outside
// OneDrive; one heavy job at a time.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RELEASE_IMAGES, releaseSchema, type Release } from "./release-schema.ts";

export interface BuildIo {
  root: string;
  now(): Date;
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
}

const TOOLS = ["/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/corepack"];

/** The node images every one of ours starts from, by the digest in the lock. */
const BASE_IMAGES = ["node"] as const;

export function defaultIo(root: string = resolve(import.meta.dirname, "..", "..")): BuildIo {
  return {
    root,
    now: () => new Date(),
    run: (cmd, args) =>
      new Promise((done, fail) => {
        const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.on("error", fail);
        child.on("close", (code) => {
          done({ code: code ?? 1, stdout });
        });
      }),
  };
}

const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function lastMigration(root: string): string {
  const names = readdirSync(join(root, "packages", "db", "migrations"))
    .filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n))
    .sort();
  const last = names.at(-1);
  if (last === undefined) throw new Error("release: no migration found");
  return last.slice(0, -".sql".length);
}

export async function buildRelease(
  opts: { version: string; outDir: string },
  io: BuildIo = defaultIo(),
): Promise<Release> {
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(opts.version)) {
    throw new Error("release: --version is three numbers, such as 0.6.0");
  }
  const must = async (cmd: string, args: string[], what: string): Promise<string> => {
    const answer = await io.run(cmd, args);
    if (answer.code !== 0) throw new Error(`release: ${what} failed (exit ${String(answer.code)})`);
    return answer.stdout;
  };
  if ((await must("git", ["status", "--porcelain"], "git status")).trim() !== "") {
    throw new Error("release: the working tree is not clean");
  }
  const commit = (await must("git", ["rev-parse", "HEAD"], "git rev-parse")).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("release: HEAD is not a commit");
  const remote = await must("git", ["branch", "-r", "--contains", commit], "git branch -r");
  if (remote.trim() === "") throw new Error(`release: commit ${commit} is not on origin`);
  const build = commit.slice(0, 12);

  mkdirSync(opts.outDir, { recursive: true });
  const images: Release["images"] = [];
  for (const name of RELEASE_IMAGES) {
    const tag = `mykey-${name}:${opts.version}`;
    await must(
      "docker",
      [
        "build",
        "--platform",
        "linux/amd64",
        "-q",
        "-f",
        `apps/${name}/Dockerfile`,
        "--build-arg",
        `MYKEY_BUILD=${build}`,
        "-t",
        tag,
        ".",
      ],
      `docker build ${name}`,
    );
    const left = (
      await io.run("docker", ["run", "--rm", "--entrypoint", "ls", tag, ...TOOLS])
    ).stdout.trim();
    if (left !== "")
      throw new Error(`release: the ${name} image holds ${left.split(/\s+/).join(", ")}`);
    const imageId = (
      await must("docker", ["image", "inspect", "--format", "{{.Id}}", tag], `inspect ${name}`)
    ).trim();
    const archive = `${name}.tar`;
    await must("docker", ["save", tag, "-o", join(opts.outDir, archive)], `docker save ${name}`);
    images.push({ name, imageId, archive, archiveSha256: sha256File(join(opts.outDir, archive)) });
  }

  for (const scan of [["secrets"], ["dependencies"], ["images", "--archives", opts.outDir]]) {
    const answer = await io.run("node", ["scripts/ci-scan.ts", ...scan]);
    if (answer.code !== 0) throw new Error(`release: scan ${scan[0] ?? ""} failed`);
  }

  const lock = JSON.parse(
    readFileSync(join(io.root, "infra", "dependencies.lock.json"), "utf8"),
  ) as {
    images: Record<string, { digest: string }>;
  };
  const baseDigests = Object.fromEntries(
    BASE_IMAGES.map((key) => {
      const digest = lock.images[key]?.digest;
      if (digest === undefined) throw new Error(`release: the lock has no image ${key}`);
      return [key, digest];
    }),
  );
  const release = releaseSchema.parse({
    format: "mykey-host-release/1",
    version: opts.version,
    commit,
    builtAt: io.now().toISOString(),
    images,
    baseDigests,
    migrations: { last: lastMigration(io.root) },
    scans: { secrets: "pass", dependencies: "pass", images: "pass" },
  });
  const releaseFile = join(opts.outDir, "release.json");
  writeFileSync(releaseFile, `${JSON.stringify(release, null, 2)}\n`);
  const sums = [...images.map((i) => i.archive), "release.json"]
    .map((file) => `${sha256File(join(opts.outDir, file))}  ${file}`)
    .join("\n");
  writeFileSync(join(opts.outDir, "SHA256SUMS"), `${sums}\n`);
  return release;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const version = value("--version");
  if (version === undefined) {
    console.error("usage: pnpm run host:release -- --version <x.y.z> [--out <dir>]");
    process.exit(2);
  }
  const outDir = resolve(value("--out") ?? join("dist", "host-release", version));
  buildRelease({ version, outDir })
    .then((release) => {
      console.log(`host release ${release.version} (${release.commit.slice(0, 12)}) in ${outDir}`);
      for (const image of release.images) console.log(`  ${image.name}: ${image.imageId}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
