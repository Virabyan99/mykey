// Run 8.1 Task B Step 4 (P-145): the release candidate, written, never typed.
//
//   node scripts/release-candidate.ts --release <host release dir> --cli cli-vX.Y.Z
//       writes docs/evidence/session-8/candidate.json
//   node scripts/release-candidate.ts --deploy <staging|prod> --at <ISO time> --epoch <gate epoch>
//       adds one host's deploy to it (Step 7)
//
// Everything but the CLI tag comes from the release's release.json and the
// repository at the release's commit, which must be an ancestor of HEAD.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseSchema } from "../infra/release/release-schema.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const CANDIDATE_PATH = "docs/evidence/session-8/candidate.json";
const HOSTS = ["staging", "prod"] as const;
type Host = (typeof HOSTS)[number];

export interface CandidateFile {
  hostRelease: string;
  cliRelease: string;
  sourceCommit: string;
  builtAt: string;
  releaseJsonSha256: string;
  images: { name: string; imageId: string }[];
  baseDigests: Record<string, string>;
  lockfiles: { "pnpm-lock.yaml": string; "infra/dependencies.lock.json": string };
  upstreamImages: Record<string, string>;
  lastMigration: string;
  /** The last commit at or before the source commit that changed infra/hosts. */
  hostFilesCommit: string;
  /** P-145: operator-tool and host-file changes after the freeze; they build nothing. */
  tooling: { path: string; note: string }[];
  deploys: Partial<Record<Host, { at: string; gateEpoch: number }>>;
}

function git(args: string[]): Buffer {
  return execFileSync("git", args, { cwd: ROOT });
}
const text = (args: string[]): string => git(args).toString("utf8").trim();
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function isAncestor(commit: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

interface LockImage {
  image: string;
  tag: string;
  variant?: string;
  digest: string;
}

export function buildCandidate(input: { releaseDir: string; cli: string }): CandidateFile {
  if (!/^cli-v\d+\.\d+\.\d+$/.test(input.cli)) {
    throw new Error(`the CLI release must be a cli-vX.Y.Z tag, not ${input.cli}`);
  }
  const raw = readFileSync(join(input.releaseDir, "release.json"));
  const release = releaseSchema.parse(JSON.parse(raw.toString("utf8")));
  if (!/^[0-9a-f]{40}$/.test(release.commit) || !isAncestor(release.commit)) {
    throw new Error(`the release's commit ${release.commit} is not an ancestor of HEAD`);
  }
  const at = (path: string): Buffer => git(["show", `${release.commit}:${path}`]);
  const lock = JSON.parse(at("infra/dependencies.lock.json").toString("utf8")) as {
    images: Record<string, LockImage>;
  };
  const upstreamImages: Record<string, string> = {};
  for (const [name, entry] of Object.entries(lock.images)) {
    const tag = entry.variant === undefined ? entry.tag : `${entry.tag}-${entry.variant}`;
    upstreamImages[name] = `${entry.image}:${tag}@${entry.digest}`;
  }
  return {
    hostRelease: `host-v${release.version}`,
    cliRelease: input.cli,
    sourceCommit: release.commit,
    builtAt: release.builtAt,
    releaseJsonSha256: sha256(raw),
    images: release.images.map((image) => ({ name: image.name, imageId: image.imageId })),
    baseDigests: release.baseDigests,
    lockfiles: {
      "pnpm-lock.yaml": sha256(at("pnpm-lock.yaml")),
      "infra/dependencies.lock.json": sha256(at("infra/dependencies.lock.json")),
    },
    upstreamImages,
    lastMigration: release.migrations.last,
    hostFilesCommit: text(["log", "-1", "--format=%H", release.commit, "--", "infra/hosts"]),
    tooling: [],
    deploys: {},
  };
}

export function recordDeploy(
  candidate: CandidateFile,
  host: string,
  at: string,
  gateEpoch: number,
): CandidateFile {
  if (!(HOSTS as readonly string[]).includes(host)) throw new Error(`unknown host ${host}`);
  const key = host as Host;
  if (candidate.deploys[key] !== undefined) throw new Error(`${host}'s deploy is already recorded`);
  if (Number.isNaN(Date.parse(at)) || !Number.isInteger(gateEpoch) || gateEpoch < 0) {
    throw new Error("a deploy needs an ISO time and a whole gate epoch");
  }
  return { ...candidate, deploys: { ...candidate.deploys, [key]: { at, gateEpoch } } };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv: string[]): void {
  const path = join(ROOT, CANDIDATE_PATH);
  const releaseDir = flag(argv, "--release");
  const deploy = flag(argv, "--deploy");
  let candidate: CandidateFile;
  if (releaseDir !== undefined) {
    candidate = buildCandidate({ releaseDir, cli: flag(argv, "--cli") ?? "" });
  } else if (deploy !== undefined) {
    const current = JSON.parse(readFileSync(path, "utf8")) as CandidateFile;
    candidate = recordDeploy(
      current,
      deploy,
      flag(argv, "--at") ?? "",
      Number(flag(argv, "--epoch") ?? "NaN"),
    );
  } else {
    process.stderr.write(
      "usage: release-candidate.ts --release <dir> --cli cli-vX.Y.Z | --deploy <host> --at <ISO> --epoch <n>\n",
    );
    process.exit(64);
  }
  writeFileSync(path, `${JSON.stringify(candidate, null, 2)}\n`);
  process.stdout.write(`${CANDIDATE_PATH}: ${candidate.hostRelease}, ${candidate.cliRelease}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
