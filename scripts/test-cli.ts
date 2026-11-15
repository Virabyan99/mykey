// `pnpm run test:cli` (P-97): builds the CLI bundle and runs project `cli`.
// On Linux and macOS it runs natively. On Windows the CLI refuses to run (that
// is checked first: exit 78 and a line that names Windows), and the project
// runs in the pinned glibc Node image instead: the working tree
// (`git ls-files -co --exclude-standard`) and the test certificates, made here
// because the image has no openssl, are copied into a Docker volume; pnpm
// installs there with a cached store volume; then the project runs.
// Arguments are passed to vitest (file filters): node scripts/test-cli.ts tests/cli/keys.test.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CERT_DIR, makeCertificates } from "../tests/cli/certs.ts";

const root = join(import.meta.dirname, "..");
const extra = process.argv.slice(2);
if (!extra.every((arg) => /^[A-Za-z0-9._/=-]+$/.test(arg))) {
  console.error("test:cli: arguments may hold only letters, digits and . _ / = -");
  process.exit(64);
}

function must(command: string, args: string[], what: string): void {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`test:cli: ${what} failed`);
    process.exit(result.status ?? 1);
  }
}

must(process.execPath, ["apps/cli/build.ts"], "the bundle");

if (process.platform !== "win32") {
  const vitest = spawnSync("pnpm", ["exec", "vitest", "run", "--project", "cli", ...extra], {
    cwd: root,
    stdio: "inherit",
  });
  process.exit(vitest.status ?? 1);
}

// 1. Natively, the CLI refuses Windows before anything else.
const native = spawnSync(process.execPath, ["apps/cli/dist/secrets.mjs", "keys"], {
  cwd: root,
  encoding: "utf8",
  env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
});
if (native.status !== 78 || !native.stderr.includes("Windows")) {
  console.error(
    `test:cli: on Windows the CLI must exit 78 naming Windows; it exited ${String(native.status)}`,
  );
  process.exit(1);
}
console.log("test:cli: native Windows refused with 78, as it must be");

// 2. The image, the tree and the certificates.
const lock = JSON.parse(readFileSync(join(root, "infra/dependencies.lock.json"), "utf8")) as {
  images: Record<string, { image: string; tag: string; variant?: string; digest: string }>;
};
const pin = lock.images["node-glibc"];
if (pin === undefined) throw new Error("infra/dependencies.lock.json has no images.node-glibc");
const image = `${pin.image}:${pin.tag}${pin.variant === undefined ? "" : `-${pin.variant}`}@${pin.digest}`;

makeCertificates({ force: true });
const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (listed.status !== 0) throw new Error("git ls-files failed");
const files = listed.stdout
  .split("\0")
  .filter((file) => file !== "" && existsSync(join(root, file)));
for (const name of readdirSync(CERT_DIR)) {
  files.push(relative(root, join(CERT_DIR, name)).replaceAll("\\", "/"));
}
const scratch = mkdtempSync(join(tmpdir(), "mykey-test-cli-"));
const listFile = join(scratch, "files.txt");
writeFileSync(listFile, `${files.join("\n")}\n`);

const TREE = "mykey-cli-tree";
const STORE = "mykey-cli-store";
for (const volume of [TREE, STORE])
  must("docker", ["volume", "create", volume], `volume ${volume}`);

function copyTree(): Promise<number> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-cf", "-", "-T", listFile], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const docker = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--platform",
        "linux/amd64",
        "-v",
        `${TREE}:/work`,
        image,
        "sh",
        "-c",
        "find /work -mindepth 1 -delete && tar -xf - -C /work",
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    tar.stdout.pipe(docker.stdin);
    tar.on("error", reject);
    docker.on("error", reject);
    docker.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

try {
  if ((await copyTree()) !== 0) throw new Error("copying the tree into the volume failed");
  console.log(
    `test:cli: ${String(files.length)} files copied; installing and running in ${pin.image}:${pin.tag}-${pin.variant ?? ""}`,
  );
  const script = [
    "corepack enable pnpm >/dev/null",
    "(pnpm install --frozen-lockfile --reporter=append-only > /tmp/install.log 2>&1 || { tail -n 40 /tmp/install.log; exit 1; })",
    `exec pnpm exec vitest run --project cli ${extra.join(" ")}`,
  ].join(" && ");
  const run = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "-v",
      `${TREE}:/work`,
      "-v",
      `${STORE}:/store`,
      "-w",
      "/work",
      "-e",
      "CI=true",
      "-e",
      "COREPACK_HOME=/store/corepack",
      "-e",
      "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
      "-e",
      "npm_config_store_dir=/store/pnpm",
      image,
      "sh",
      "-c",
      script,
    ],
    { stdio: "inherit" },
  );
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
