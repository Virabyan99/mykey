// Run 9.3 (P-164): the runner image's build context, as consumer-deploy.md
// steps 1 to 3 make it: the CLI release's three files from GitHub (public),
// each checked against SHA256SUMS, and the official Node archive install.sh
// pins (install.sh checks it against its own sum during the build).
//
//   node tools/agent-runner/prepare.ts     writes tools/agent-runner/mykey-release/
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_RELEASE = "cli-v0.1.2";
const FILES = ["install.sh", "mykey-cli-0.1.2.tgz", "SHA256SUMS"] as const;
const BASE = `https://github.com/Virabyan99/mykey/releases/download/${CLI_RELEASE}`;

export const RELEASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "mykey-release");

async function download(url: string): Promise<Buffer> {
  const answer = await fetch(url, { redirect: "follow" });
  if (!answer.ok) throw new Error(`prepare: ${url} answered HTTP ${String(answer.status)}`);
  return Buffer.from(await answer.arrayBuffer());
}

/** Writes the context once; a second run checks the files it finds against SHA256SUMS. */
export async function prepareRelease(): Promise<string> {
  mkdirSync(RELEASE_DIR, { recursive: true });
  for (const file of FILES) {
    const path = join(RELEASE_DIR, file);
    if (!existsSync(path)) writeFileSync(path, await download(`${BASE}/${file}`));
  }
  const sums = readFileSync(join(RELEASE_DIR, "SHA256SUMS"), "utf8");
  for (const line of sums.split("\n").filter((entry) => entry.trim() !== "")) {
    const [sum, name] = line.trim().split(/\s+\*?/);
    if (sum === undefined || name === undefined) throw new Error(`prepare: bad line ${line}`);
    const actual = createHash("sha256")
      .update(readFileSync(join(RELEASE_DIR, name)))
      .digest("hex");
    if (actual !== sum) throw new Error(`prepare: ${name} does not match SHA256SUMS`);
  }
  const version = /^NODE_VERSION='([^']+)'$/m.exec(
    readFileSync(join(RELEASE_DIR, "install.sh"), "utf8"),
  )?.[1];
  if (version === undefined) throw new Error("prepare: install.sh names no NODE_VERSION");
  const archive = `node-v${version}-linux-x64.tar.gz`;
  if (!existsSync(join(RELEASE_DIR, archive))) {
    writeFileSync(
      join(RELEASE_DIR, archive),
      await download(`https://nodejs.org/dist/v${version}/${archive}`),
    );
  }
  return RELEASE_DIR;
}

if (import.meta.main) {
  console.log(`agent-runner: build context at ${await prepareRelease()}`);
}
