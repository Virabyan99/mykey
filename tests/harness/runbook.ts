// Rehearsing a runbook (Run 5.8, P-100, PO-20). A runbook's shell blocks that
// follow `<!-- rehearsed -->` (or `: stdin`, `: provided`, `: background`) are
// read in document order and run on a target as a user would run them in one
// terminal session: each block runs in `sh -e`, and what it exported and the
// directory it ended in carry over to the next (a session file in the
// target's HOME). Modes:
//   run         the block runs as written
//   stdin       the block runs with the test's input on stdin (a token is
//               pasted there, so it is in no argument and no history)
//   provided    not run: the harness does what the owner would (put files in
//               place, set the variables), see `provide`
//   background  the block starts something that keeps running (an
//               application in the foreground of its terminal): it runs
//               detached, and `stopBackground` is the Ctrl-C
// Targets: a container (`docker exec` as its user) or the host's Linux shell
// (WSL's Ubuntu on Windows, `sh` elsewhere) with a HOME of its own.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type BlockMode = "run" | "stdin" | "provided" | "background";

export interface RunbookBlock {
  file: string;
  heading: string;
  mode: BlockMode;
  script: string;
}

export interface BlockResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MARKER = /^\s*<!--\s*rehearsed(?::\s*(stdin|provided|background))?\s*-->\s*$/;
const HEADING = /^#{2,3}\s+(.*\S)\s*$/;
const FENCE_OPEN = /^(\s*)```sh\s*$/;

/** The rehearsed blocks of a Markdown file, in document order, with the heading each is under. */
export function rehearsedBlocks(markdownPath: string): RunbookBlock[] {
  const lines = readFileSync(markdownPath, "utf8").split(/\r?\n/);
  const blocks: RunbookBlock[] = [];
  let heading = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const title = HEADING.exec(line);
    if (title?.[1] !== undefined) heading = title[1];
    const marker = MARKER.exec(line);
    if (marker === null) continue;
    let at = index + 1;
    while (at < lines.length && (lines[at] ?? "").trim() === "") at += 1;
    const open = FENCE_OPEN.exec(lines[at] ?? "");
    if (open === null)
      throw new Error(`${markdownPath}:${String(index + 1)}: no sh block follows the marker`);
    const indent = open[1] ?? "";
    const body: string[] = [];
    for (at += 1; at < lines.length; at += 1) {
      const text = lines[at] ?? "";
      if (text.trim() === "```") break;
      body.push(text.startsWith(indent) ? text.slice(indent.length) : text);
    }
    if (at >= lines.length) throw new Error(`${markdownPath}:${String(index + 1)}: unclosed block`);
    blocks.push({
      file: markdownPath,
      heading,
      mode: (marker[1] as BlockMode | undefined) ?? "run",
      script: `${body.join("\n")}\n`,
    });
    index = at;
  }
  return blocks;
}

export type Target =
  { kind: "container"; name: string; user: string; home: string } | { kind: "host"; home: string };

const SESSION = ".rehearsal-session";

/** The block inside the session: what earlier blocks exported and where they ended. */
function wrapped(block: string, capture: boolean): string {
  return [
    `if [ -f "$HOME/${SESSION}" ]; then . "$HOME/${SESSION}"; fi`,
    block,
    ...(capture
      ? [
          `export -p > "$HOME/${SESSION}.new"`,
          `printf "cd '%s'\\n" "$PWD" >> "$HOME/${SESSION}.new"`,
          `mv "$HOME/${SESSION}.new" "$HOME/${SESSION}"`,
        ]
      : []),
    "",
  ].join("\n");
}

/** A Windows path as WSL sees it (C:\x\y → /mnt/c/x/y). */
export function wslPath(path: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (match?.[1] === undefined) return path.replaceAll("\\", "/");
  return `/mnt/${match[1].toLowerCase()}/${(match[2] ?? "").replaceAll("\\", "/")}`;
}

const WSL = ["-d", "Ubuntu", "-e"];
const HOST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Runs a shell script on a target; input on stdin; nothing of it on a command line but the script. */
export function runScript(
  target: Target,
  script: string,
  opts: { stdin?: string; detach?: boolean; timeoutMs?: number } = {},
): Promise<BlockResult> {
  let program: string;
  let args: string[];
  let scratch: string | undefined;
  if (target.kind === "container") {
    program = "docker";
    args = [
      "exec",
      ...(opts.detach === true ? ["-d"] : ["-i"]),
      "-u",
      target.user,
      "-e",
      `HOME=${target.home}`,
      "-w",
      target.home,
      target.name,
      "sh",
      "-e",
      "-c",
      opts.detach === true ? `exec >>"$HOME/.rehearsal-background.log" 2>&1\n${script}` : script,
    ];
  } else {
    // The script goes through a file: wsl.exe re-parses a command line.
    scratch = mkdtempSync(join(tmpdir(), "mykey-runbook-"));
    const file = join(scratch, "block.sh");
    writeFileSync(file, script);
    const env = ["env", "-i", `HOME=${target.home}`, `PATH=${HOST_PATH}`, "LANG=C.UTF-8"];
    if (process.platform === "win32") {
      program = "wsl.exe";
      args = [...WSL, ...env, "sh", "-e", wslPath(file)];
    } else {
      program = env[0] ?? "env";
      args = [...env.slice(1), "sh", "-e", file];
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 900_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Runs one rehearsed block on a target, in the session (provided blocks are the caller's). */
export function runBlock(
  target: Target,
  block: RunbookBlock,
  opts: { stdin?: string } = {},
): Promise<BlockResult> {
  if (block.mode === "provided") throw new Error(`${block.heading}: a provided block is not run`);
  if (block.mode === "stdin" && opts.stdin === undefined) {
    throw new Error(`${block.heading}: a stdin block needs its input`);
  }
  if (block.mode !== "stdin" && opts.stdin !== undefined) {
    throw new Error(`${block.heading}: only a stdin block takes input`);
  }
  return runScript(target, wrapped(block.script, block.mode !== "background"), {
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    detach: block.mode === "background",
  });
}

/** Adds exported variables to the target's session, as the owner typing `export` would. */
export async function provideVariables(
  target: Target,
  values: Record<string, string>,
): Promise<void> {
  const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
  const lines = Object.entries(values).map(([name, value]) => `export ${name}=${quote(value)}`);
  const result = await runScript(target, `touch "$HOME/${SESSION}"\ncat >> "$HOME/${SESSION}"\n`, {
    stdin: `${lines.join("\n")}\n`,
  });
  if (result.code !== 0) throw new Error(`provideVariables: ${result.stderr}`);
}

/** Ctrl-C for the running background block: SIGINT to the CLI process, then wait for it to end. */
export async function stopBackground(target: Target, timeoutMs = 30_000): Promise<void> {
  const script = [
    "pids=''",
    "for dir in /proc/[0-9]*; do",
    '  args=$(tr "\\000" " " < "$dir/cmdline" 2>/dev/null || true)',
    '  case "$args" in *secrets.mjs\\ run\\ *) pids="$pids ${dir#/proc/}" ;; esac',
    "done",
    'if [ -z "$pids" ]; then exit 0; fi',
    "kill -INT $pids",
    `deadline=$(( $(date +%s) + ${String(Math.ceil(timeoutMs / 1000))} ))`,
    "for pid in $pids; do",
    '  while [ -d "/proc/$pid" ]; do',
    '    if [ "$(date +%s)" -gt "$deadline" ]; then echo "still running: $pid" >&2; exit 1; fi',
    "    sleep 0.2",
    "  done",
    "done",
    "",
  ].join("\n");
  const result = await runScript(target, script);
  if (result.code !== 0) throw new Error(`stopBackground: ${result.stderr}`);
}

/** A file on the workstation, put at `dest` on the target, owned by the target's user. */
export function placeFile(target: Target, source: string, dest: string): void {
  if (target.kind === "container") {
    const copied = spawnSync("docker", ["cp", source, `${target.name}:${dest}`], {
      encoding: "utf8",
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
    if (copied.status !== 0) throw new Error(`docker cp ${basename(source)}: ${copied.stderr}`);
    const owned = spawnSync(
      "docker",
      ["exec", "-u", "0", target.name, "chown", "-R", `${target.user}:${target.user}`, dest],
      { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
    );
    if (owned.status !== 0) throw new Error(`chown ${dest}: ${owned.stderr}`);
    return;
  }
  const from = process.platform === "win32" ? wslPath(source) : source;
  const command =
    process.platform === "win32"
      ? ["wsl.exe", [...WSL, "cp", "-R", from, dest]]
      : ["cp", ["-R", from, dest]];
  const copied = spawnSync(command[0] as string, command[1] as string[], { encoding: "utf8" });
  if (copied.status !== 0) throw new Error(`cp ${basename(source)}: ${copied.stderr}`);
}

/** A new, empty HOME on the host's Linux shell (mode 0700). */
export function freshHostHome(): Target {
  const made =
    process.platform === "win32"
      ? spawnSync("wsl.exe", [...WSL, "mktemp", "-d", "/tmp/mykey-rehearsal-XXXXXX"], {
          encoding: "utf8",
        })
      : spawnSync("mktemp", ["-d", join(tmpdir(), "mykey-rehearsal-XXXXXX")], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`mktemp: ${made.stderr}`);
  return { kind: "host", home: made.stdout.trim() };
}

export function removeHostHome(target: Target): void {
  if (target.kind !== "host" || !/\/mykey-rehearsal-[A-Za-z0-9]{6}$/.test(target.home)) return;
  if (process.platform === "win32") spawnSync("wsl.exe", [...WSL, "rm", "-rf", target.home]);
  else rmSync(target.home, { recursive: true, force: true });
}
