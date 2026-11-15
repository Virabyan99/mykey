// Verifies that every version, image and Action used by the repository is an
// exact, stable pin recorded in infra/dependencies.lock.json.
// Run: node scripts/pins-verify.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TARGETS as CLI_TARGETS, renderInstaller } from "../infra/release/cli/build-release.ts";

export interface ImagePin {
  image: string;
  tag: string;
  /** The flavour the digest belongs to when the tag alone does not say it (`alpine` → `<tag>-alpine`). */
  variant?: string;
  digest: string;
  releaseUrl: string;
  advisoriesChecked: string;
}
export interface NpmPin {
  version: string;
  advisoriesChecked: string;
  note: string;
}
export interface DependenciesLock {
  reviewedAt: string;
  node: { version: string; line: string };
  pnpm: { version: string };
  images: Record<string, ImagePin>;
  npm: Record<string, NpmPin>;
  python: Record<string, { version: string; sha256: string }>;
  actions: Record<string, { sha: string; tag: string }>;
  /** Release archives run on a host (Run 2.7): exact version, SHA-256 of the archive. */
  binaries?: Record<string, { version: string; asset: string; sha256: string }>;
}

/** Binaries every checkout must pin (Run 2.10). */
export const REQUIRED_BINARIES = [
  "okms-cli",
  // The CLI installer's runtime (Run 5.7, D-44).
  "node-linux-x64",
  "node-linux-arm64",
  "node-darwin-x64",
  "node-darwin-arm64",
];

export const REQUIRED_IMAGES = [
  "postgres",
  "openbao",
  "traefik",
  "restic",
  "gitleaks",
  "trivy",
  "node",
  "nmap",
];
/**
 * Images built from this repository. A Compose file names one as the required
 * variable `${<NAME>_IMAGE:?…}`, which `host.ts image` sets to an image ID.
 */
export const OWN_IMAGES = ["api", "provisioner"];
export const REQUIRED_NPM = [
  "typescript",
  "vitest",
  "fast-check",
  "eslint",
  "typescript-eslint",
  "prettier",
  "zod",
  "hono",
  "drizzle-orm",
  "drizzle-kit",
  "pg",
  "pg-boss",
  "better-auth",
  "jose",
  "otpauth",
  "react",
  "react-dom",
  "@tanstack/react-query",
  "@scalar/api-reference",
  "@scalar/openapi-parser",
  "@aws-sdk/client-s3",
  "@next/env",
];
export const REQUIRED_ACTIONS = [
  "actions/checkout",
  "actions/setup-node",
  "pnpm/action-setup",
  "actions/setup-python",
];
export const FORBIDDEN_COMPONENTS = [
  "redis",
  "ioredis",
  "bullmq",
  "temporalio",
  "@modelcontextprotocol/",
];

const WORKSPACE_GROUPS = ["apps", "packages", "workers"];
const PRERELEASE = /-(alpha|beta|rc|next|canary|pre|dev)/i;
const EXACT_NPM = /^\d+\.\d+\.\d+$/;
const EXACT_IMAGE_TAG = /^v?\d+\.\d+(\.\d+)?$/;
const EXACT_ACTION_TAG = /^v\d+\.\d+\.\d+$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;

export function loadLock(root: string): DependenciesLock {
  return JSON.parse(
    readFileSync(join(root, "infra/dependencies.lock.json"), "utf8"),
  ) as DependenciesLock;
}

export function listFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...listFiles(path, pattern));
    else if (pattern.test(entry)) found.push(path);
  }
  return found;
}

export function missingRequiredKeys(lock: DependenciesLock): string[] {
  return [
    ...REQUIRED_IMAGES.filter((key) => !(key in lock.images)).map((key) => `images.${key}`),
    ...REQUIRED_NPM.filter((key) => !(key in lock.npm)).map((key) => `npm.${key}`),
    ...REQUIRED_ACTIONS.filter((key) => !(key in lock.actions)).map((key) => `actions.${key}`),
    ...REQUIRED_BINARIES.filter((key) => !(key in (lock.binaries ?? {}))).map(
      (key) => `binaries.${key}`,
    ),
  ];
}

export interface PinnedVersion {
  where: string;
  kind: "npm" | "image" | "action" | "workspace";
  version: string;
}

interface Manifest {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface ManifestDependency {
  where: string;
  name: string;
  version: string;
}

function manifestPaths(root: string): string[] {
  const paths = [join(root, "package.json"), join(root, "tests/package.json")];
  for (const group of WORKSPACE_GROUPS) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      paths.push(join(dir, entry, "package.json"));
    }
  }
  return paths.filter((path) => existsSync(path));
}

function manifestDependencies(root: string): ManifestDependency[] {
  const found: ManifestDependency[] = [];
  for (const path of manifestPaths(root)) {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    const file = relative(root, path).replaceAll("\\", "/");
    for (const field of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [name, version] of Object.entries(field ?? {})) {
        found.push({ where: `${file} ${name}`, name, version });
      }
    }
  }
  return found;
}

export function readCatalog(root: string): Record<string, string> {
  const catalog: Record<string, string> = {};
  let inside = false;
  for (const line of readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/)) {
    if (/^catalog:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside || line.trim() === "") continue;
    if (/^\S/.test(line)) break;
    const match = /^\s+["']?([^"':\s]+)["']?:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) catalog[match[1]] = match[2];
  }
  return catalog;
}

export function collectPinnedVersions(root: string, lock: DependenciesLock): PinnedVersion[] {
  const entries: PinnedVersion[] = [
    { where: "lock node", kind: "npm", version: lock.node.version },
    { where: "lock pnpm", kind: "npm", version: lock.pnpm.version },
  ];
  for (const [key, pin] of Object.entries(lock.images)) {
    entries.push({ where: `lock images.${key}`, kind: "image", version: pin.tag });
  }
  for (const [key, pin] of Object.entries(lock.npm)) {
    entries.push({ where: `lock npm.${key}`, kind: "npm", version: pin.version });
  }
  for (const [key, pin] of Object.entries(lock.python)) {
    entries.push({ where: `lock python.${key}`, kind: "npm", version: pin.version });
  }
  for (const [key, pin] of Object.entries(lock.actions)) {
    entries.push({ where: `lock actions.${key}`, kind: "action", version: pin.tag });
  }
  for (const [key, pin] of Object.entries(lock.binaries ?? {})) {
    entries.push({ where: `lock binaries.${key}`, kind: "npm", version: pin.version });
  }
  for (const [name, version] of Object.entries(readCatalog(root))) {
    entries.push({ where: `catalog ${name}`, kind: "npm", version });
  }
  for (const dependency of manifestDependencies(root)) {
    entries.push({ where: dependency.where, kind: "workspace", version: dependency.version });
  }
  return entries;
}

function isExact(kind: PinnedVersion["kind"], version: string): boolean {
  switch (kind) {
    case "npm":
      return EXACT_NPM.test(version);
    case "image":
      return EXACT_IMAGE_TAG.test(version);
    case "action":
      return EXACT_ACTION_TAG.test(version);
    case "workspace":
      return EXACT_NPM.test(version) || version === "catalog:" || version === "workspace:*";
  }
}

export function unpinnedVersions(entries: readonly PinnedVersion[]): string[] {
  const problems: string[] = [];
  for (const { where, kind, version } of entries) {
    if (PRERELEASE.test(version)) problems.push(`${where}: pre-release version ${version}`);
    else if (!isExact(kind, version)) problems.push(`${where}: not an exact version (${version})`);
  }
  return problems;
}

export function versionLineProblems(lock: DependenciesLock): string[] {
  const problems: string[] = [];
  const expectLine = (label: string, actual: string | undefined, pattern: RegExp) => {
    if (actual === undefined || !pattern.test(actual)) {
      problems.push(`${label} is ${actual ?? "missing"}, expected ${pattern.source}`);
    }
  };
  expectLine("images.postgres.tag", lock.images.postgres?.tag, /^18\.\d+$/);
  expectLine("images.openbao.tag", lock.images.openbao?.tag, /^2\.7\.\d+$/);
  expectLine("images.traefik.tag", lock.images.traefik?.tag, /^3\.7\.\d+$/);
  expectLine("npm.better-auth.version", lock.npm["better-auth"]?.version, /^1\.7\.\d+$/);
  return problems;
}

export function digestProblems(lock: DependenciesLock): string[] {
  const problems: string[] = [];
  for (const [key, pin] of Object.entries(lock.images)) {
    if (!SHA256_DIGEST.test(pin.digest))
      problems.push(`images.${key}.digest is not sha256:<64 hex>`);
  }
  for (const [key, pin] of Object.entries(lock.actions)) {
    if (!HEX_40.test(pin.sha)) problems.push(`actions.${key}.sha is not 40 hex characters`);
  }
  for (const [key, pin] of Object.entries(lock.python)) {
    if (!HEX_64.test(pin.sha256)) problems.push(`python.${key}.sha256 is not 64 hex characters`);
  }
  for (const [key, pin] of Object.entries(lock.binaries ?? {})) {
    if (!HEX_64.test(pin.sha256)) problems.push(`binaries.${key}.sha256 is not 64 hex characters`);
  }
  return problems;
}

/** Checks every `image:` line: it must be `name@sha256:…` with a digest recorded for that name. */
export function composeImageProblems(text: string, lock: DependenciesLock, file: string): string[] {
  const problems: string[] = [];
  const known = new Map(Object.values(lock.images).map((pin) => [pin.digest, pin.image]));
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^\s*(?:-\s*)?image:\s*["']?([^"'\s#]+)/.exec(line);
    if (match?.[1] === undefined) return;
    const at = `${file}:${index + 1}`;
    const own = /^\$\{([A-Z][A-Z0-9_]*)_IMAGE:\?/.exec(match[1]);
    if (own?.[1] !== undefined && OWN_IMAGES.includes(own[1].toLowerCase())) return;
    const parsed = /^([^@:\s]+)(?::[\w.-]+)?@(sha256:[0-9a-f]{64})$/.exec(match[1]);
    if (parsed?.[1] === undefined || parsed[2] === undefined) {
      problems.push(`${at}: image is not pinned by digest`);
    } else if (known.get(parsed[2]) !== parsed[1]) {
      problems.push(`${at}: image digest is not in infra/dependencies.lock.json for ${parsed[1]}`);
    }
  });
  return problems;
}

/** `<group>/<workspace>/Dockerfile` of every app, package and worker that has one. */
export function ownDockerfiles(root: string): string[] {
  return WORKSPACE_GROUPS.flatMap((group) => {
    const directory = join(root, group);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .sort()
      .map((workspace) => join(directory, workspace, "Dockerfile"))
      .filter((file) => existsSync(file));
  });
}

/** Checks every `FROM`: `name@sha256:…` with a digest recorded for that name, or an earlier stage. */
export function dockerfileProblems(text: string, lock: DependenciesLock, file: string): string[] {
  const problems: string[] = [];
  const known = new Map(Object.values(lock.images).map((pin) => [pin.digest, pin.image]));
  const stages = new Set<string>();
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (match?.[1] === undefined) return;
    const at = `${file}:${index + 1}`;
    const parsed = /^([^@:\s]+)(?::[\w.-]+)?@(sha256:[0-9a-f]{64})$/.exec(match[1]);
    if (stages.has(match[1].toLowerCase())) {
      // A stage defined above.
    } else if (parsed?.[1] === undefined || parsed[2] === undefined) {
      problems.push(`${at}: FROM is not pinned by digest`);
    } else if (known.get(parsed[2]) !== parsed[1]) {
      problems.push(`${at}: FROM digest is not in infra/dependencies.lock.json for ${parsed[1]}`);
    }
    if (match[2] !== undefined) stages.add(match[2].toLowerCase());
  });
  return problems;
}

/** Checks every `uses:` line: it must be `owner/repo@<40 hex>` with that SHA recorded in the lock. */
export function workflowActionProblems(
  text: string,
  lock: DependenciesLock,
  file: string,
): string[] {
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^\s*(?:-\s*)?uses:\s*["']?([^"'\s#]+)/.exec(line);
    if (match?.[1] === undefined) return;
    const at = `${file}:${index + 1}`;
    const parsed = /^([\w.-]+\/[\w.-]+)(?:\/[^@]+)?@([0-9a-f]{40})$/.exec(match[1]);
    if (parsed?.[1] === undefined || parsed[2] === undefined) {
      problems.push(`${at}: uses is not pinned by a 40-hex commit SHA`);
    } else if (lock.actions[parsed[1]]?.sha !== parsed[2]) {
      problems.push(`${at}: ${parsed[1]} SHA is not in infra/dependencies.lock.json`);
    }
  });
  problems.push(...composeImageProblems(text, lock, file));
  return problems;
}

/**
 * Forbidden components among the packages the lockfile installs. An installed
 * package is a two-space key `name@version:` of pnpm-lock.yaml. A name that
 * appears only deeper, as another package's optional peer, is not installed.
 */
export function forbiddenComponents(lockfileText: string): string[] {
  const installed = new Set<string>();
  for (const line of lockfileText.split("\n")) {
    const match = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s']+)@/.exec(line);
    if (match?.[1] !== undefined) installed.add(match[1].toLowerCase());
  }
  return FORBIDDEN_COMPONENTS.filter((name) =>
    [...installed].some((packageName) => packageName.includes(name)),
  );
}

export function consistencyProblems(root: string, lock: DependenciesLock): string[] {
  const problems: string[] = [];
  const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim();
  if (nodeVersion !== lock.node.version) {
    problems.push(`.node-version is ${nodeVersion}, lock says ${lock.node.version}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
  const packageManager = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.[0-9a-f]{128}$/.exec(
    manifest.packageManager ?? "",
  );
  if (packageManager?.[1] !== lock.pnpm.version) {
    problems.push(`packageManager is not pnpm@${lock.pnpm.version} with a sha512 hash`);
  }
  const catalog = readCatalog(root);
  for (const [name, version] of Object.entries(catalog)) {
    const pinned = lock.npm[name]?.version;
    if (pinned !== version) {
      problems.push(`catalog ${name} is ${version}, lock says ${pinned ?? "nothing"}`);
    }
  }
  for (const dependency of manifestDependencies(root)) {
    if (dependency.version === "workspace:*") continue;
    if (dependency.version === "catalog:") {
      if (!(dependency.name in catalog)) problems.push(`${dependency.where}: not in the catalog`);
      continue;
    }
    const pinned = lock.npm[dependency.name]?.version;
    if (pinned !== dependency.version) {
      problems.push(
        `${dependency.where} is ${dependency.version}, lock says ${pinned ?? "nothing"}`,
      );
    }
  }
  return problems;
}

/**
 * The CLI installer (Run 5.7): rendering infra/release/cli/install.sh.template
 * with the lock must work (each Node archive at the pinned Node version, named
 * as nodejs.org names it) and must carry every pinned sum.
 */
export function cliReleaseProblems(root: string, lock: DependenciesLock): string[] {
  const template = readFileSync(join(root, "infra/release/cli/install.sh.template"), "utf8");
  try {
    const rendered = renderInstaller(template, {
      version: "0.0.0",
      cliSha256: "0".repeat(64),
      lock: { node: lock.node, binaries: lock.binaries ?? {} },
    });
    return CLI_TARGETS.filter(
      (target) => !rendered.includes(lock.binaries?.[`node-${target}`]?.sha256 ?? "missing"),
    ).map((target) => `install.sh.template does not carry binaries.node-${target}.sha256`);
  } catch (error) {
    return [`CLI installer: ${(error as Error).message}`];
  }
}

export function verifyPins(root: string): string[] {
  const lock = loadLock(root);
  const problems = [
    ...missingRequiredKeys(lock).map((key) => `lock is missing ${key}`),
    ...unpinnedVersions(collectPinnedVersions(root, lock)),
    ...versionLineProblems(lock),
    ...digestProblems(lock),
    ...consistencyProblems(root, lock),
    ...cliReleaseProblems(root, lock),
  ];
  for (const file of listFiles(join(root, "infra/compose"), /\.ya?ml$/)) {
    problems.push(...composeImageProblems(readFileSync(file, "utf8"), lock, relative(root, file)));
  }
  for (const file of ownDockerfiles(root)) {
    problems.push(...dockerfileProblems(readFileSync(file, "utf8"), lock, relative(root, file)));
  }
  for (const file of listFiles(join(root, ".github/workflows"), /\.ya?ml$/)) {
    problems.push(
      ...workflowActionProblems(readFileSync(file, "utf8"), lock, relative(root, file)),
    );
  }
  for (const name of forbiddenComponents(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"))) {
    problems.push(`pnpm-lock.yaml contains forbidden component ${name}`);
  }
  return problems;
}

if (import.meta.main) {
  const problems = verifyPins(resolve(import.meta.dirname, ".."));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`pins: ${problem}`);
    process.exit(1);
  }
  console.log("pins: ok");
}
