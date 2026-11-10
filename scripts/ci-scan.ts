// Runs the pinned scanners (gitleaks, Trivy) as containers, by the digests in
// infra/dependencies.lock.json. The same commands run locally and in CI.
// Run: node scripts/ci-scan.ts <secrets|dependencies|images|selftest>
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadLock, type DependenciesLock } from "./pins-verify.ts";

/** Exit code the scanners use for "finding reported", so a crash (1) is never mistaken for one. */
export const FOUND_EXIT_CODE = 3;
export const SCANNED_IMAGES = ["postgres", "openbao", "traefik", "restic"];

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
  return output.includes("pnpm-lock.yaml")
    ? undefined
    : "dependency scan did not cover pnpm-lock.yaml";
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
  const mode = process.argv[2];
  let ok: boolean;
  switch (mode) {
    case "secrets":
      ok = scan("secrets in Git history", secretHistoryScanArgs(lock, repository));
      break;
    case "dependencies": {
      console.log("scan: dependency vulnerabilities");
      const { status, output } = runDocker(dependencyScanArgs(lock, repository), true);
      console.log(output);
      const problem = dependencyScanCoverageProblem(output);
      if (problem !== undefined) console.error(`scan: ${problem}`);
      ok = status === 0 && problem === undefined;
      break;
    }
    case "images":
      ok = SCANNED_IMAGES.map((key) =>
        scan(`image ${key}`, imageScanArgs(lock, key, repository)),
      ).every(Boolean);
      break;
    case "selftest":
      ok = selftest(lock, repository);
      break;
    default:
      console.error("usage: node scripts/ci-scan.ts <secrets|dependencies|images|selftest>");
      ok = false;
  }
  process.exit(ok ? 0 : 1);
}
