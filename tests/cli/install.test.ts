// Run 5.7 Task B (P-98, D-44, FR-1.51): install.sh, as the user runs it. A
// fresh HOME each case; the release built from this checkout (or the files of
// MYKEY_RELEASE_DIR: the downloaded release); the official Node archive of
// this machine's target, downloaded once into the suite's cache and verified
// against the lock file. The shell is dash on Linux and /bin/sh on macOS.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelease } from "../../infra/release/cli/build-release.ts";

const lock = JSON.parse(readFileSync("infra/dependencies.lock.json", "utf8")) as {
  node: { version: string };
  binaries: Record<string, { asset: string; sha256: string }>;
};
const version = (JSON.parse(readFileSync("apps/cli/package.json", "utf8")) as { version: string })
  .version;
const TARGET = `${process.platform}-${process.arch}`;
const SHELL = process.platform === "linux" ? "dash" : "/bin/sh";
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

let base: string;
let release: string;
let nodeArchive: string;

async function nodeArchiveCached(): Promise<string> {
  const pin = lock.binaries[`node-${TARGET}`];
  if (pin === undefined) throw new Error(`no pinned Node archive for ${TARGET}`);
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

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mykey-install-")));
  const given = process.env.MYKEY_RELEASE_DIR;
  if (given !== undefined && given !== "") {
    release = given;
  } else {
    release = join(base, "release");
    buildRelease({ version, out: release });
  }
  nodeArchive = await nodeArchiveCached();
}, 300_000);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A directory as the user downloaded it: the three release files and the Node archive. */
function downloadDir(label: string, damage?: "cli" | "node"): string {
  const dir = join(base, `dl-${label}`);
  mkdirSync(dir);
  for (const name of [`mykey-cli-${version}.tgz`, "install.sh", "SHA256SUMS"]) {
    copyFileSync(join(release, name), join(dir, name));
  }
  copyFileSync(nodeArchive, join(dir, lock.binaries[`node-${TARGET}`]?.asset ?? "node.tgz"));
  const flip = (path: string): void => {
    const bytes = readFileSync(path);
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff;
    writeFileSync(path, bytes);
  };
  if (damage === "cli") flip(join(dir, `mykey-cli-${version}.tgz`));
  if (damage === "node") flip(join(dir, lock.binaries[`node-${TARGET}`]?.asset ?? ""));
  return dir;
}

function freshHome(label: string): string {
  const home = join(base, `home-${label}`);
  mkdirSync(home);
  chmodSync(home, 0o700);
  return home;
}

function install(dir: string, home: string, args: string[] = [], path?: string) {
  return spawnSync(SHELL, [join(dir, "install.sh"), ...args], {
    encoding: "utf8",
    env: { HOME: home, PATH: path ?? process.env.PATH ?? "/usr/bin:/bin" },
    cwd: base,
  });
}

/** Every path under a directory with the SHA-256 of each file (links by target). */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = `${prefix}${name}`;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(path, `${rel}/`);
      } else if (stat.isSymbolicLink()) out[rel] = "link";
      else out[rel] = `${sha(readFileSync(path))} ${(stat.mode & 0o777).toString(8)}`;
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

describe("install.sh", () => {
  it("installs from the download directory: the launcher runs the installed CLI; the tree is exactly the version directory and the launcher", () => {
    const home = freshHome("ok");
    const result = install(downloadDir("ok"), home);
    expect(result.status, result.stderr).toBe(0);
    const launcher = join(home, ".local", "bin", "secrets");
    const shown = spawnSync(launcher, ["--version"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`secrets ${version} `);
    expect(shown.stdout).toContain(`node ${lock.node.version}`);
    // R5-3 (Run 8.6): SIGUSR1 never opens Node's inspector in the CLI.
    expect(readFileSync(launcher, "utf8")).toMatch(/\/node\/bin\/node' --disable-sigusr1 '/);
    const top = Object.keys(tree(home)).filter((path) => !path.slice(0, -1).includes("/"));
    expect(top).toEqual([".local/"]);
    expect(readdirSync(join(home, ".local"))).toEqual(["bin", "share"]);
    expect(readdirSync(join(home, ".local", "bin"))).toEqual(["secrets"]);
    expect(readdirSync(join(home, ".local", "share", "mykey", "cli"))).toEqual([version]);
    expect(readdirSync(join(home, ".local", "share", "mykey"))).toEqual(["cli"]);
  });

  it("one changed byte in the CLI archive, or in the Node archive → refused, nothing written", () => {
    for (const damage of ["cli", "node"] as const) {
      const home = freshHome(`bad-${damage}`);
      const result = install(downloadDir(`bad-${damage}`, damage), home);
      expect(result.status, damage).not.toBe(0);
      expect(result.stderr, damage).toMatch(/checksum/);
      expect(readdirSync(home), damage).toEqual([]);
    }
  });

  it("an unsupported system → 78 naming what it saw, nothing written", () => {
    for (const [label, system, machine, seen] of [
      ["freebsd", "FreeBSD", "amd64", "FreeBSD"],
      ["riscv", "Linux", "riscv64", "riscv64"],
      ["mingw", "MINGW64_NT-10.0", "x86_64", "MINGW64_NT-10.0"],
    ] as const) {
      const fake = join(base, `uname-${label}`);
      mkdirSync(fake);
      writeFileSync(
        join(fake, "uname"),
        `#!/bin/sh\ncase "$1" in -s) echo '${system}' ;; -m) echo '${machine}' ;; *) echo '${system}' ;; esac\n`,
      );
      chmodSync(join(fake, "uname"), 0o755);
      const home = freshHome(label);
      const result = install(downloadDir(label), home, [], `${fake}:${process.env.PATH ?? ""}`);
      expect(result.status, label).toBe(78);
      expect(result.stderr.trim().split("\n"), label).toHaveLength(1);
      expect(result.stderr, label).toContain(seen);
      expect(readdirSync(home), label).toEqual([]);
    }
  });

  it("a second install changes nothing; --uninstall leaves HOME as it was", () => {
    const home = freshHome("again");
    writeFileSync(join(home, ".profile"), "# the user's own\n");
    const before = tree(home);
    const dir = downloadDir("again");
    expect(install(dir, home).status).toBe(0);
    const installed = tree(home);
    const again = install(dir, home);
    expect(again.status, again.stderr).toBe(0);
    expect(tree(home)).toEqual(installed);
    const removed = install(dir, home, ["--uninstall"]);
    expect(removed.status, removed.stderr).toBe(0);
    expect(tree(home)).toEqual(before);
  });
});
