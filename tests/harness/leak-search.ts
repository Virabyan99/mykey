// Where a token must not be (Run 5.8, Review focus 5). Every search counts the
// bytes of given needles and returns a count only; a search inside a target
// gets the needles on stdin, never on a command line. Each search is meant to
// be run once with a control: a marker planted the same way must be found.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { runScript, type Target } from "./runbook.ts";

const needleInput = (needles: string[]): string => {
  if (
    needles.length === 0 ||
    needles.some((needle) => needle.length < 8 || needle.includes("\n"))
  ) {
    throw new Error("needles must be one line each, of 8 bytes or more");
  }
  return needles.join("\n");
};

async function countOnTarget(target: Target, collect: string, needles: string[]): Promise<number> {
  const script = [
    "set +e",
    "out=$(mktemp)",
    `{ ${collect}; } > "$out" 2>/dev/null`,
    // `-f -` reads the patterns from the open stdin: WSL's interop pipe cannot
    // be opened again as /dev/stdin (EACCES). grep exits 0 (found), 1 (none),
    // 2 (error); an error is never a count.
    'n=$(grep -c -F -f - "$out"); status=$?',
    'rm -f "$out"',
    'if [ "$status" -gt 1 ]; then echo "grep failed: $status" >&2; exit 2; fi',
    'echo "count=${n:-0}"',
    "",
  ].join("\n");
  const result = await runScript(target, script, { stdin: needleInput(needles) });
  const count = /count=(\d+)/.exec(result.stdout)?.[1];
  if (result.code !== 0 || count === undefined)
    throw new Error(`search on ${JSON.stringify(target)} failed: ${result.stderr}`);
  return Number(count);
}

const HISTORY = [".ash_history", ".bash_history", ".zsh_history", ".sh_history"];

/** Lines of the shell history files of HOME and of /root that hold a needle. */
export function historyCount(target: Target, needles: string[]): Promise<number> {
  const files = [
    ...HISTORY.map((name) => `"$HOME/${name}"`),
    ...HISTORY.map((name) => `/root/${name}`),
  ];
  return countOnTarget(
    target,
    `for f in ${files.join(" ")}; do if [ -r "$f" ]; then cat "$f"; echo; fi; done`,
    needles,
  );
}

/** Argument lists (/proc/<pid>/cmdline) of every process the target can see that hold a needle. */
export function argumentCount(target: Target, needles: string[]): Promise<number> {
  return countOnTarget(
    target,
    "for d in /proc/[0-9]*; do tr '\\000' ' ' < \"$d/cmdline\"; echo; done",
    needles,
  );
}

/** Occurrences of any needle in a stream, across chunk borders. */
async function streamCount(stream: NodeJS.ReadableStream, needles: Buffer[]): Promise<number> {
  const keep = Math.max(...needles.map((needle) => needle.length)) - 1;
  let tail = Buffer.alloc(0);
  let found = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const window = Buffer.concat([tail, chunk]);
    for (const needle of needles) {
      for (let at = window.indexOf(needle); at !== -1; at = window.indexOf(needle, at + 1)) {
        // A match wholly inside the kept tail was counted with the previous chunk.
        if (at + needle.length > tail.length) found += 1;
      }
    }
    tail = window.subarray(Math.max(0, window.length - keep));
  }
  return found;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Occurrences of any needle in every file of `docker save <image>`, layers decompressed. */
export async function imageCount(image: string, needles: string[]): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), "mykey-image-search-"));
  try {
    const archive = join(scratch, "image.tar");
    const saved = spawnSync("docker", ["save", "-o", archive, image], { encoding: "utf8" });
    if (saved.status !== 0) throw new Error(`docker save ${image}: ${saved.stderr}`);
    const tree = join(scratch, "tree");
    mkdirSync(tree);
    const unpacked = spawnSync("tar", ["-xf", "image.tar", "-C", "tree"], {
      cwd: scratch,
      encoding: "utf8",
    });
    if (unpacked.status !== 0) throw new Error(`tar -xf: ${unpacked.stderr}`);
    const bytes = needles.map((needle) => Buffer.from(needle, "utf8"));
    let found = 0;
    for (const file of walk(tree)) {
      const head = Buffer.alloc(4);
      const fd = openSync(file, "r");
      try {
        readSync(fd, head, 0, 4, 0);
      } finally {
        closeSync(fd);
      }
      if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) {
        throw new Error(`${image}: a zstd layer; the search cannot read it`);
      }
      const gzip = head[0] === 0x1f && head[1] === 0x8b;
      const stream = gzip ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
      found += await streamCount(stream, bytes);
    }
    return found;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Occurrences of any needle in `docker history --no-trunc <image>`. */
export function historyOfImageCount(image: string, needles: string[]): number {
  const shown = spawnSync("docker", ["history", "--no-trunc", image], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (shown.status !== 0) throw new Error(`docker history ${image}: ${shown.stderr}`);
  return textCount(shown.stdout, needles);
}

/** Occurrences of any needle in the working tree (every file Git would see, nothing ignored). */
export function treeCount(needles: string[]): number {
  const listed = spawnSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error("git ls-files failed");
  const bytes = needles.map((needle) => Buffer.from(needle, "utf8"));
  let found = 0;
  for (const file of listed.stdout.split("\0").filter((name) => name !== "")) {
    let content: Buffer;
    try {
      content = readFileSync(file);
    } catch {
      continue;
    }
    for (const needle of bytes) {
      for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + 1))
        found += 1;
    }
  }
  return found;
}

export function textCount(text: string, needles: string[]): number {
  let found = 0;
  for (const needle of needles) {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) found += 1;
  }
  return found;
}
