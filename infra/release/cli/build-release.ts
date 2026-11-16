// Builds a CLI release (P-98, D-44): apps/cli/release/<version>/ with
//   mykey-cli-<version>.tgz  secrets.mjs, package.json, LICENSE; the same bytes
//                            on every builder (sorted entries, mode 0644/0755,
//                            uid/gid 0, mtime 0, gzip without a timestamp)
//   install.sh               the template with the version, the archive's sum
//                            and the four pinned Node sums
//   SHA256SUMS               over the two files
// Run: node infra/release/cli/build-release.ts --version <v> [--out <dir>]
// (or `pnpm run cli:release -- --version <v>`). The version must be the one in
// apps/cli/package.json, which the bundle compiles in.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
export const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

interface Lock {
  node: { version: string };
  binaries: Record<string, { version: string; asset: string; sha256: string }>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** One ustar header block for a regular file. */
function header(name: string, size: number, mode: number): Buffer {
  const block = Buffer.alloc(512, 0);
  const put = (text: string, at: number, length: number): void => {
    block.write(text.slice(0, length), at, length, "latin1");
  };
  const octal = (value: number, length: number): string =>
    `${value.toString(8).padStart(length - 1, "0")}\0`;
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put("root", 265, 32);
  put("root", 297, 32);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

/** A deterministic .tgz of regular files at the archive's root. */
export function deterministicTgz(files: { name: string; mode: number; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    parts.push(header(file.name, file.data.length, file.mode), file.data);
    const pad = (512 - (file.data.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  // gzip's header: mtime (bytes 4–7) is 0 already; the OS byte names the
  // builder's system, so it is set to Unix (3) on every builder.
  gz[9] = 3;
  return gz;
}

export function renderInstaller(
  template: string,
  values: { version: string; cliSha256: string; lock: Lock },
): string {
  const replace: Record<string, string> = {
    VERSION: values.version,
    NODE_VERSION: values.lock.node.version,
    CLI_SHA256: values.cliSha256,
  };
  for (const target of TARGETS) {
    const pin = values.lock.binaries[`node-${target}`];
    if (pin === undefined)
      throw new Error(`infra/dependencies.lock.json has no binaries.node-${target}`);
    if (pin.version !== values.lock.node.version) {
      throw new Error(
        `binaries.node-${target} is ${pin.version}, the pinned Node is ${values.lock.node.version}`,
      );
    }
    if (pin.asset !== `node-v${pin.version}-${target}.tar.gz`) {
      throw new Error(`binaries.node-${target}.asset is not node-v${pin.version}-${target}.tar.gz`);
    }
    replace[`NODE_SHA256_${target.toUpperCase().replace("-", "_")}`] = pin.sha256;
  }
  const rendered = template.replace(/@([A-Z0-9_]+)@/g, (whole, key: string) => {
    const value = replace[key];
    if (value === undefined) throw new Error(`install.sh.template names an unknown value ${whole}`);
    return value;
  });
  return rendered;
}

export function buildRelease(opts: { version: string; out?: string }): string {
  const cli = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")) as {
    version: string;
  };
  if (opts.version !== cli.version) {
    throw new Error(`--version ${opts.version} is not apps/cli/package.json's ${cli.version}`);
  }
  const built = spawnSync(process.execPath, [join(root, "apps/cli/build.ts")], {
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(`the bundle did not build: ${built.stderr.slice(-400)}`);
  const lock = JSON.parse(readFileSync(join(root, "infra/dependencies.lock.json"), "utf8")) as Lock;
  const manifest = {
    name: "mykey-cli",
    version: opts.version,
    private: true,
    license: "UNLICENSED",
    type: "module",
    bin: { secrets: "secrets.mjs" },
    engines: { node: lock.node.version },
  };
  const archive = deterministicTgz([
    {
      name: "secrets.mjs",
      mode: 0o755,
      data: readFileSync(join(root, "apps/cli/dist/secrets.mjs")),
    },
    {
      name: "package.json",
      mode: 0o644,
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    },
    { name: "LICENSE", mode: 0o644, data: readFileSync(join(here, "LICENSE")) },
  ]);
  const archiveName = `mykey-cli-${opts.version}.tgz`;
  const installer = renderInstaller(readFileSync(join(here, "install.sh.template"), "utf8"), {
    version: opts.version,
    cliSha256: sha256(archive),
    lock,
  });
  const out = opts.out ?? join(root, "apps/cli/release", opts.version);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, archiveName), archive);
  writeFileSync(join(out, "install.sh"), installer, { mode: 0o755 });
  writeFileSync(
    join(out, "SHA256SUMS"),
    `${sha256(archive)}  ${archiveName}\n${sha256(Buffer.from(installer, "utf8"))}  install.sh\n`,
  );
  return out;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--version");
  const version = at === -1 ? undefined : process.argv[at + 1];
  const outAt = process.argv.indexOf("--out");
  const out = outAt === -1 ? undefined : process.argv[outAt + 1];
  if (version === undefined) {
    console.error("usage: node infra/release/cli/build-release.ts --version <v> [--out <dir>]");
    process.exit(64);
  }
  const dir = buildRelease({ version, ...(out === undefined ? {} : { out }) });
  console.log(readFileSync(join(dir, "SHA256SUMS"), "utf8").trimEnd());
  console.log(`release files in ${dir}`);
}
