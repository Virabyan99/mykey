// Runs the pinned scanners (gitleaks, Trivy) as containers, by the digests in
// infra/dependencies.lock.json. The same commands run locally and in CI.
// Run: node scripts/ci-scan.ts <secrets|dependencies|images|selftest>
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadLock, type DependenciesLock } from "./pins-verify.ts";

/** Exit code the scanners use for "finding reported", so a crash (1) is never mistaken for one. */
export const FOUND_EXIT_CODE = 3;
export const SCANNED_IMAGES = ["postgres", "openbao", "traefik", "restic", "node"];

const TRIVY_CACHE_VOLUME = "mykey-trivy-cache:/root/.cache/trivy";
const TRIVY_FLAGS = [
  "--scanners",
  "vuln",
  "--severity",
  "HIGH,CRITICAL",
  "--ignore-unfixed",
  "--exit-code",
  String(FOUND_EXIT_CODE),
];
const SELFTEST_SECRET_MARKER = "mykey-canary";
const SELFTEST_VULNERABILITY_MARKER = "lodash";

function imageReference(lock: DependenciesLock, key: string): string {
  const pin = lock.images[key];
  if (pin === undefined) throw new Error(`image ${key} is not in the lock`);
  return `${pin.image}@${pin.digest}`;
}

function gitleaks(lock: DependenciesLock, repository: string, args: string[]): string[] {
  return [
    "run",
    "--rm",
    "-v",
    `${repository}:/repo:ro`,
    imageReference(lock, "gitleaks"),
    ...args,
    "--redact",
    "--no-banner",
    "--exit-code",
    String(FOUND_EXIT_CODE),
  ];
}

function trivy(lock: DependenciesLock, mounts: string[], args: string[]): string[] {
  const volumes = [...mounts, TRIVY_CACHE_VOLUME].flatMap((mount) => ["-v", mount]);
  return ["run", "--rm", ...volumes, imageReference(lock, "trivy"), ...args];
}

/** gitleaks over the full Git history with the repository configuration. */
export function secretHistoryScanArgs(lock: DependenciesLock, repository: string): string[] {
  return gitleaks(lock, repository, [
    "git",
    "/repo",
    "--config",
    "/repo/.gitleaks.toml",
    "--gitleaks-ignore-path",
    "/repo",
  ]);
}

/** Trivy over the repository's lock files; the seeded CI fixtures are excluded here only. */
export function dependencyScanArgs(lock: DependenciesLock, repository: string): string[] {
  return trivy(
    lock,
    [`${repository}:/repo:ro`],
    [
      "fs",
      ...TRIVY_FLAGS,
      "--include-dev-deps",
      "--skip-dirs",
      "tests/fixtures/ci",
      "--skip-dirs",
      "**/node_modules",
      "--skip-dirs",
      ".stack",
      "--ignorefile",
      "/repo/.trivyignore",
      "/repo",
    ],
  );
}

/**
 * Trivy excludes development dependencies unless told otherwise and reports
 * "nothing to scan" as success. A run that did not read pnpm-lock.yaml is a
 * failure, not a pass.
 */
export function dependencyScanCoverageProblem(output: string): string | undefined {
  // The summary row must carry a count: "pnpm-lock.yaml │ pnpm │ 0 │". A dash means "not scanned".
  return /pnpm-lock\.yaml\s*│\s*pnpm\s*│\s*\d+\s*│/.test(output)
    ? undefined
    : "dependency scan did not cover pnpm-lock.yaml";
}

/**
 * gitleaks exits 0 with "0 commits scanned" when it is pointed at something that
 * is not a Git repository, and a shallow checkout hides the history from it. A
 * scan that read no commit, printed an error, or saw a shallow history is a
 * failure, not a pass.
 */
export function secretScanCoverageProblem(output: string, shallow: boolean): string | undefined {
  if (shallow) return "secret scan ran on a shallow checkout; the whole history is required";
  // gitleaks colours its log lines; the colour codes would hide the level from \b.
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  if (/^fatal:|\b(ERR|FTL)\b/m.test(plain)) return "secret scan printed a git or gitleaks error";
  const commits = /\b(\d+) commits scanned/.exec(plain);
  if (commits === null || Number(commits[1]) === 0) return "secret scan read no commit";
  return undefined;
}

/**
 * Trivy over one runtime image, by the digest in the lock. Upstream image
 * findings are reviewed in .trivyignore.images, never in .trivyignore, so an
 * exception for an image can not hide a finding in our own dependencies.
 */
export function imageScanArgs(lock: DependenciesLock, key: string, repository?: string): string[] {
  const mounts = repository === undefined ? [] : [`${repository}:/repo:ro`];
  const ignore = repository === undefined ? [] : ["--ignorefile", "/repo/.trivyignore.images"];
  return trivy(lock, mounts, ["image", ...TRIVY_FLAGS, ...ignore, imageReference(lock, key)]);
}

/** Images built from this repository (Run 2.10): built, saved and scanned from the archive. */
export const OWN_SCANNED_IMAGES = ["api", "provisioner", "ops"];

/** Run 6.9 (P-127): `images --archives <dir>` scans a release's archives instead of building. */
export function parseScanArgs(argv: string[]): { mode: string; archives: string | null } {
  const [mode = "", ...rest] = argv;
  if (rest.length === 0) return { mode, archives: null };
  if (mode !== "images" || rest[0] !== "--archives" || rest.length !== 2 || rest[1] === undefined) {
    throw new Error("--archives <dir> belongs to images only, with one directory");
  }
  return { mode, archives: rest[1] };
}

/**
 * Trivy over our own image's archive (`<archiveDir>/<name>.tar`). Only the
 * language packages — our dependencies — under the repository's .trivyignore:
 * the base image's OS packages are the pinned node image, scanned above with
 * its own reviewed exceptions, which must never cover our dependencies.
 */
export function ownImageScanArgs(
  lock: DependenciesLock,
  archiveDir: string,
  repository: string,
  name = "api",
): string[] {
  return trivy(
    lock,
    [`${archiveDir}:/archive:ro`, `${repository}:/repo:ro`],
    [
      "image",
      ...TRIVY_FLAGS,
      "--pkg-types",
      "library",
      // npm and corepack bundled by the base image belong to the node image's scan.
      "--skip-dirs",
      "/usr/local/lib/node_modules",
      "--ignorefile",
      "/repo/.trivyignore",
      "--input",
      `/archive/${name}.tar`,
    ],
  );
}

/** Builds our own image from the repository and saves it as `<archiveDir>/<name>.tar`. */
function buildOwnImage(repository: string, archiveDir: string, name: string): boolean {
  const tag = `mykey-${name}:scan`;
  const build = spawnSync(
    "docker",
    ["build", "--platform", "linux/amd64", "-q", "-f", `apps/${name}/Dockerfile`, "-t", tag, "."],
    { cwd: repository, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (build.status !== 0) return false;
  const save = spawnSync("docker", ["save", tag, "-o", resolve(archiveDir, `${name}.tar`)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  return save.status === 0;
}

export function selftestSecretArgs(lock: DependenciesLock, repository: string): string[] {
  return gitleaks(lock, repository, [
    "dir",
    "/repo/tests/fixtures/ci/seeded-secret",
    "--config",
    "/repo/tests/fixtures/ci/gitleaks-selftest.toml",
    "--verbose",
  ]);
}

export function selftestVulnerabilityArgs(lock: DependenciesLock, repository: string): string[] {
  return trivy(
    lock,
    [`${repository}:/repo:ro`],
    ["fs", ...TRIVY_FLAGS, "/repo/tests/fixtures/ci/vulnerable-dep"],
  );
}

export interface Verdict {
  ok: boolean;
  message: string;
}

/**
 * The self-test passes only when the scanner exited with the "finding" code
 * and its output names the seeded item. Exit 0, a crash, or a different
 * finding all fail.
 */
export function selftestVerdict(
  kind: "secret" | "vulnerability",
  exitCode: number | null,
  output: string,
  marker: string,
): Verdict {
  if (exitCode === FOUND_EXIT_CODE && output.includes(marker)) {
    return { ok: true, message: `scanner detected the seeded ${kind}` };
  }
  return { ok: false, message: `scanner did not detect the seeded ${kind}` };
}

function runDocker(args: string[], capture: boolean): { status: number | null; output: string } {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: capture ? `${result.stdout}\n${result.stderr}` : "" };
}

function scan(label: string, args: string[]): boolean {
  console.log(`scan: ${label}`);
  const { status } = runDocker(args, false);
  if (status === 0) return true;
  console.error(
    status === FOUND_EXIT_CODE
      ? `scan: ${label} reported findings`
      : `scan: ${label} failed to run (exit ${status ?? "unknown"})`,
  );
  return false;
}

function selftest(lock: DependenciesLock, repository: string): boolean {
  const cases = [
    ["secret", selftestSecretArgs(lock, repository), SELFTEST_SECRET_MARKER],
    ["vulnerability", selftestVulnerabilityArgs(lock, repository), SELFTEST_VULNERABILITY_MARKER],
  ] as const;
  let ok = true;
  for (const [kind, args, marker] of cases) {
    const { status, output } = runDocker([...args], true);
    const verdict = selftestVerdict(kind, status, output, marker);
    console.log(`selftest: ${verdict.message} (scanner exit ${status ?? "unknown"})`);
    if (!verdict.ok) {
      console.error(output.split("\n").slice(-15).join("\n"));
      ok = false;
    }
  }
  return ok;
}

if (import.meta.main) {
  const repository = resolve(import.meta.dirname, "..");
  const lock = loadLock(repository);
  let parsed: { mode: string; archives: string | null };
  try {
    parsed = parseScanArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
  const mode = parsed.mode;
  let ok: boolean;
  switch (mode) {
    case "secrets": {
      console.log("scan: secrets in Git history");
      const shallow =
        spawnSync("git", ["-C", repository, "rev-parse", "--is-shallow-repository"], {
          encoding: "utf8",
        }).stdout.trim() !== "false";
      const { status, output } = runDocker(secretHistoryScanArgs(lock, repository), true);
      console.log(output);
      const problem = secretScanCoverageProblem(output, shallow);
      if (problem !== undefined) console.error(`scan: ${problem}`);
      if (status === FOUND_EXIT_CODE)
        console.error("scan: secrets in Git history reported findings");
      ok = status === 0 && problem === undefined;
      break;
    }
    case "dependencies": {
      console.log("scan: dependency vulnerabilities");
      const { status, output } = runDocker(dependencyScanArgs(lock, repository), true);
      console.log(output);
      const problem = dependencyScanCoverageProblem(output);
      if (problem !== undefined) console.error(`scan: ${problem}`);
      ok = status === 0 && problem === undefined;
      break;
    }
    case "images": {
      const upstream = SCANNED_IMAGES.map((key) =>
        scan(`image ${key}`, imageScanArgs(lock, key, repository)),
      ).every(Boolean);
      const given = parsed.archives === null ? null : resolve(parsed.archives);
      const archiveDir = given ?? mkdtempSync(join(tmpdir(), "mykey-own-images-"));
      try {
        const own = OWN_SCANNED_IMAGES.map(
          (name) =>
            (given !== null || buildOwnImage(repository, archiveDir, name)) &&
            scan(`own image ${name}`, ownImageScanArgs(lock, archiveDir, repository, name)),
        ).every(Boolean);
        ok = upstream && own;
      } finally {
        if (given === null) rmSync(archiveDir, { recursive: true, force: true });
      }
      break;
    }
    case "selftest":
      ok = selftest(lock, repository);
      break;
    default:
      console.error(
        "usage: node scripts/ci-scan.ts <secrets|dependencies|images [--archives <dir>]|selftest>",
      );
      ok = false;
  }
  process.exit(ok ? 0 : 1);
}
