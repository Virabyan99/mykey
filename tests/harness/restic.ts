// Run 6.5 Task C: the pinned Restic image over local directories, with the
// same invocation backup.sh uses on a host (resticArgv), and tar from the same
// image for packing and unpacking a bundle.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resticArgv } from "../../infra/hosts/backup/steps.ts";

const run = promisify(execFile);
const LOCK_FILE = resolve(import.meta.dirname, "../../infra/dependencies.lock.json");

function resticImage(): string {
  const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as {
    images: Record<string, { image: string; digest: string }>;
  };
  const pin = lock.images.restic;
  if (pin === undefined) throw new Error("no restic pin");
  return `${pin.image}@${pin.digest}`;
}

/** Runs restic; resolves with its exit code and output (never throws on a non-zero exit). */
export async function restic(
  paths: { repo: string; password: string; artifacts?: string; out?: string },
  args: readonly string[],
): Promise<{ code: number; output: string }> {
  const argv = resticArgv(
    {
      repo: paths.repo,
      password: paths.password,
      artifacts: paths.artifacts ?? null,
      out: paths.out ?? null,
    },
    args,
  );
  try {
    const { stdout, stderr } = await run("docker", argv, { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
    };
  }
}

/** tar inside the Restic image, over one mounted directory (`/d`). */
export async function tarIn(directory: string, args: readonly string[]): Promise<void> {
  await run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${directory}:/d`,
    "--entrypoint",
    "tar",
    resticImage(),
    ...args,
  ]);
}
