// Reproducible-build check: clone the current commit into a fresh directory
// outside the working tree, install from the lock file, build, and print one
// hash over everything the build produced.
// Run: node scripts/repro-build.ts          (one clean build, prints BUILD_HASH)
//      node scripts/repro-build.ts --twice  (two clean builds, fails if they differ)
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".stack", ".superpowers"]);
const LOCK_FILES = ["pnpm-lock.yaml", "infra/dependencies.lock.json"];

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

function distFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    if (entry === "dist") found.push(...filesUnder(path));
    else found.push(...distFiles(path));
  }
  return found;
}

/** One hash over every file under every `dist/` plus the two lock files. */
export function hashBuild(root: string): string {
  const lines = distFiles(root)
    .map((path) => `${relative(root, path).replaceAll("\\", "/")} ${sha256(readFileSync(path))}`)
    .sort();
  for (const lock of LOCK_FILES) {
    lines.push(`${lock} ${sha256(readFileSync(join(root, lock)))}`);
  }
  return sha256(lines.join("\n"));
}

function run(command: string, cwd: string): void {
  // A fixed command string through the shell: pnpm is a .cmd shim on Windows.
  const result = spawnSync(command, { cwd, shell: true, stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`"${command}" failed with exit code ${result.status ?? "unknown"}`);
  }
}

export function cleanBuildHash(repository: string): string {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository }).toString().trim();
  const checkout = mkdtempSync(join(tmpdir(), "mykey-repro-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", repository, checkout]);
    execFileSync("git", ["checkout", "--quiet", "--detach", commit], { cwd: checkout });
    run("pnpm install --frozen-lockfile", checkout);
    run("pnpm run build", checkout);
    return hashBuild(checkout);
  } finally {
    rmSync(checkout, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (import.meta.main) {
  const repository = resolve(import.meta.dirname, "..");
  const first = cleanBuildHash(repository);
  console.log(`BUILD_HASH=${first}`);
  if (process.argv.includes("--twice")) {
    const second = cleanBuildHash(repository);
    console.log(`BUILD_HASH=${second}`);
    if (first !== second) {
      console.error("repro-build: the two clean builds differ");
      process.exit(1);
    }
  }
}
