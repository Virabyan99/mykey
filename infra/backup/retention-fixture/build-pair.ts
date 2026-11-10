// Builds one synthetic recovery pair for the retention fixture: a new Restic
// repository with three synthetic files, checked, packed into one tar bundle and
// described by a manifest. Everything runs in the pinned Restic image.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const LOCK_FILE = resolve(import.meta.dirname, "../../dependencies.lock.json");
const PASSWORD_IN_CONTAINER = "/run/secrets/restic-password";
const PAIR_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MIB = 1024 * 1024;

export interface PairManifest {
  pairId: string;
  captureTime: string;
  bundleSha256: string;
  bundleBytes: number;
  resticVersion: string;
  synthetic: true;
}

export interface PairFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface BuiltPair {
  pairId: string;
  directory: string;
  bundlePath: string;
  manifestPath: string;
  manifest: PairManifest;
  /** The synthetic files inside the bundle, by name. */
  files: PairFile[];
}

export interface BuildPairOptions {
  pairId: string;
  /** When the pair claims to have been captured; whole seconds are kept. */
  captureTime: Date;
  /** The pair is written to `<outDir>/<pairId>/`. */
  outDir: string;
  passwordFile: string;
}

/** The default place of the fixture's Restic password, outside the repository. */
export function resticPasswordFile(home: string = homedir()): string {
  return join(home, ".mykey", "secrets", "retention-fixture", "restic-password");
}

/** Creates the password file once, with a random value; later calls leave it alone. */
export function ensureResticPassword(file: string = resticPasswordFile()): string {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  }
  return file;
}

function resticImage(): string {
  const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as {
    images: { restic: { image: string; digest: string } };
  };
  return `${lock.images.restic.image}@${lock.images.restic.digest}`;
}

/** Runs one program of the pinned Restic image; throws with `<label> failed` on a non-zero exit. */
function inContainer(
  label: string,
  entrypoint: string,
  mounts: [host: string, container: string, mode: "ro" | "rw"][],
  args: string[],
): string {
  // On Linux the container writes into bind mounts; run as the caller so the files can be removed.
  const user = process.getuid && process.getgid ? [`${process.getuid()}:${process.getgid()}`] : [];
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      ...user.flatMap((id) => ["--user", id]),
      ...mounts.flatMap(([host, container, mode]) => ["-v", `${host}:${container}:${mode}`]),
      "--entrypoint",
      entrypoint,
      resticImage(),
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * MIB },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const reason = result.stderr.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${label} failed (exit ${String(result.status)}): ${reason}`);
  }
  return result.stdout;
}

/** Runs restic on the repository in `work/repo`. The password reaches it only as a mounted file. */
function restic(
  work: string,
  passwordFile: string,
  args: string[],
  extraMounts: [string, string, "ro" | "rw"][] = [],
): string {
  return inContainer(
    `restic ${args[0] ?? ""}`,
    "restic",
    [[work, "/work", "rw"], [passwordFile, PASSWORD_IN_CONTAINER, "ro"], ...extraMounts],
    ["--repo", "/work/repo", "--password-file", PASSWORD_IN_CONTAINER, "--no-cache", ...args],
  );
}

/**
 * Unpacks a bundle into a temporary directory and runs one restic command on the
 * repository inside it. `mounts.out` is a host directory offered to restic as `/out`.
 */
export function resticInBundle(
  bundlePath: string,
  passwordFile: string,
  args: string[],
  mounts: { out?: string } = {},
): string {
  const work = mkdtempSync(join(tmpdir(), "mykey-bundle-"));
  try {
    inContainer(
      "tar extract",
      "tar",
      [
        [dirname(bundlePath), "/in", "ro"],
        [work, "/work", "rw"],
      ],
      ["-xf", "/in/bundle.tar", "-C", "/work"],
    );
    return restic(
      work,
      passwordFile,
      args,
      mounts.out === undefined ? [] : [[mounts.out, "/out", "rw"]],
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const GLOBALS_SQL = [
  "-- Synthetic fixture. No real role, password or data.",
  "CREATE ROLE fixture_reader NOLOGIN;",
  "CREATE ROLE fixture_writer NOLOGIN;",
  "",
].join("\n");

/** `2026-11-10T09:30:00Z` → `2026-11-10 09:30:00`, the form restic reads (the container runs in UTC). */
function resticTime(time: Date): string {
  return time.toISOString().slice(0, 19).replace("T", " ");
}

export function buildPair(options: BuildPairOptions): BuiltPair {
  const { pairId, passwordFile } = options;
  if (!PAIR_ID.test(pairId)) throw new Error("build-pair: the pair id is not a plain name");
  const directory = join(options.outDir, pairId);
  if (existsSync(directory)) throw new Error(`build-pair: pair ${pairId} already exists`);
  const captureTime = new Date(Math.floor(options.captureTime.getTime() / 1000) * 1000);

  mkdirSync(options.outDir, { recursive: true });
  const staging = mkdtempSync(join(options.outDir, `.build-${pairId}-`));
  try {
    const source = join(staging, "source");
    mkdirSync(source);
    const contents: [string, Buffer][] = [
      ["globals.sql", Buffer.from(GLOBALS_SQL, "utf8")],
      ["pg.dump", randomBytes(MIB)],
      ["raft.snap", randomBytes(MIB)],
    ];
    const files = contents.map(([name, bytes]) => {
      writeFileSync(join(source, name), bytes);
      return {
        name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });

    const version = /^restic (\S+)/.exec(inContainer("restic version", "restic", [], ["version"]));
    if (version === null) throw new Error("build-pair: restic did not report its version");

    restic(staging, passwordFile, ["init"]);
    restic(
      staging,
      passwordFile,
      ["backup", "/source", "--time", resticTime(captureTime), "--host", "mykey-fixture"],
      [[source, "/source", "ro"]],
    );
    restic(staging, passwordFile, ["check", "--read-data"]);

    mkdirSync(directory);
    inContainer(
      "tar create",
      "tar",
      [
        [staging, "/work", "ro"],
        [directory, "/out", "rw"],
      ],
      ["-cf", "/out/bundle.tar", "-C", "/work", "repo"],
    );

    const bundlePath = join(directory, "bundle.tar");
    const manifest: PairManifest = {
      pairId,
      captureTime: captureTime.toISOString(),
      bundleSha256: createHash("sha256").update(readFileSync(bundlePath)).digest("hex"),
      bundleBytes: statSync(bundlePath).size,
      resticVersion: version[1] ?? "",
      synthetic: true,
    };
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { pairId, directory, bundlePath, manifestPath, manifest, files };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
