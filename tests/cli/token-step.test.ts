// Run 10.1 (F-9.2-1, D-76): the token step of consumer-local.md §8, typed into
// an interactive shell in a pseudo-terminal, as a person pastes it. The step is
// one command that reads first: nothing pasted is shown, a paste of several
// lines is swallowed and refused, and nothing can fail before the read, so a
// paste never reaches the outer shell. The control reproduces Run 9.2's leak
// with the old step, so the test is known to see one.
//
// The token is assembled at run time and never leaves this process except on
// the terminal's input.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { terminal, type Terminal } from "./pty.ts";

const RUNBOOK = resolve(import.meta.dirname, "../../docs/runbooks/consumer-local.md");
const LEAK_CHECK = resolve(import.meta.dirname, "../../scripts/consumer-leak-check.sh");

/** The `sh` block number `index` under the heading "## <n>. …" of consumer-local.md. */
function blockOf(section: number, index = 0): string {
  const text = readFileSync(RUNBOOK, "utf8").replaceAll("\r\n", "\n");
  const start = text.indexOf(`\n## ${String(section)}. `);
  if (start === -1) throw new Error(`consumer-local.md has no section ${String(section)}`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ");
  const body = next === -1 ? rest : rest.slice(0, next);
  const block = [...body.matchAll(/```sh\n([\s\S]*?)\n```/g)][index]?.[1];
  if (block === undefined)
    throw new Error(`section ${String(section)} has no sh block ${String(index)}`);
  return block;
}

const TOKEN_STEP = blockOf(8);

/** A value of two lines, as a PEM key has; its later line holds no `=`. */
const FIRST_LINE = `first-${randomBytes(6).toString("hex")}`;
const SECOND_LINE = `second-${randomBytes(6).toString("hex")}`;

/** Runs a names-only command (`sh -c '…'`) with one secret of two lines; answers what it printed. */
function namesOnly(command: string): string {
  const script = /^sh -c '(.*)'$/s.exec(command)?.[1];
  if (script === undefined) throw new Error("not an sh -c command");
  const result = spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MULTI_LINE: `${FIRST_LINE}\n${SECOND_LINE}` },
  });
  if (result.status !== 0) throw new Error(`the command failed: ${result.stderr}`);
  return result.stdout;
}
/** Run 9.2's middle block, before Run 10.1. */
const OLD_STEP =
  '( umask 077; mkdir -p "$HOME/.config/mykey"; cat > "$HOME/.config/mykey/machine-token" )';

const BASH = ["bash", "--norc", "--noprofile", "--noediting", "-i"];
const SH = ["sh", "-i"];

const token = (): string => `hvs.${randomBytes(18).toString("base64url")}`;

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "mykey-token-step-"));
}

function open(shell: string[], home: string): Terminal {
  return terminal(shell, {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PS1: "READY> ",
    TERM: "dumb",
    HISTFILE: "/dev/null",
    LANG: "C",
  });
}

const tokenFile = (home: string): string => join(home, ".config", "mykey", "machine-token");

/** Types the step and waits for its own prompt (not the echo of the typed line). */
async function startStep(t: Terminal): Promise<number> {
  const ready = await t.waitFor(/READY> /);
  t.type(`${TOKEN_STEP}\n`);
  // The typed line is echoed whole first; its tail is `echo "Token stored."'`.
  const echoed = await t.waitFor(/Token stored\."'\r?\n/, { from: ready });
  const prompt = await t.waitFor(/press Enter: (?!")/, { from: echoed });
  // The read turns the echo off just after it prints its prompt.
  await sleep(300);
  return prompt;
}

/** The exit status of the last command, asked of the outer shell. */
async function status(t: Terminal, from: number): Promise<number> {
  const ready = await t.waitFor(/READY> /, { from, ms: 15_000 });
  t.type('echo "rc=$?"\n');
  const end = await t.waitFor(/rc=\d+/, { from: ready });
  const found = /rc=(\d+)/.exec(t.screen().slice(ready, end));
  return Number(found?.[1]);
}

/** What the outer shell holds in the variables a paste would have set. */
async function variables(t: Terminal, from: number, names: string[]): Promise<string> {
  const ready = await t.waitFor(/READY> /, { from });
  t.type(`echo "${names.map((name) => `[$${name}]`).join("")}=end"\n`);
  // The answer's line, not the echo of the typed one (which holds `$`).
  const end = await t.waitFor(/\n\[[^$\r\n]*\]=end/, { from: ready });
  const line = t.screen().slice(ready, end);
  return line.slice(line.lastIndexOf("\n") + 1);
}

const STORED = /Token stored\.\r?\n/;
const REFUSED = /revoke it\.\r?\n/;

describe("the token step in a terminal", () => {
  it("a token and Enter: the file holds the token and a line end, mode 0600, its directory 0700; the terminal never showed the token; 'Token stored.'; exit 0", async () => {
    const home = freshHome();
    const t = open(BASH, home);
    const value = token();
    const prompt = await startStep(t);
    t.type(`${value}\n`);
    const done = await t.waitFor(STORED, { from: prompt });
    expect(await status(t, done)).toBe(0);
    await t.close();
    expect(readFileSync(tokenFile(home), "utf8")).toBe(`${value}\n`);
    expect(statSync(tokenFile(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config", "mykey")).mode & 0o777).toBe(0o700);
    expect(t.screen()).not.toContain(value);
  }, 30_000);

  it("a paste of three NAME=value lines: nothing is stored, exit 1, no line was shown, and the outer shell received none of them", async () => {
    for (const shell of [BASH, SH]) {
      const home = freshHome();
      const t = open(shell, home);
      const mark = randomBytes(6).toString("hex");
      const prompt = await startStep(t);
      t.type(`A=one${mark}\nB=two${mark}\nC=three${mark}\n`);
      const done = await t.waitFor(REFUSED, { from: prompt });
      expect(await status(t, done), shell[0]).toBe(1);
      expect(await variables(t, done, ["A", "B", "C"]), shell[0]).toContain("[][][]=end");
      await t.close();
      expect(existsSync(tokenFile(home)), shell[0]).toBe(false);
      expect(t.screen(), shell[0]).not.toContain(mark);
    }
  }, 60_000);

  it("a token, Enter, and a second Enter: stored", async () => {
    const home = freshHome();
    const t = open(BASH, home);
    const value = token();
    const prompt = await startStep(t);
    t.type(`${value}\n\n`);
    const done = await t.waitFor(STORED, { from: prompt });
    expect(await status(t, done)).toBe(0);
    await t.close();
    expect(readFileSync(tokenFile(home), "utf8")).toBe(`${value}\n`);
  }, 30_000);

  it("an existing file of mode 0644 is rewritten in place: the same inode, mode 0600 after", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".config", "mykey"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile(home), "old\n", { mode: 0o644 });
    const inode = statSync(tokenFile(home)).ino;
    const t = open(BASH, home);
    const value = token();
    const prompt = await startStep(t);
    t.type(`${value}\n`);
    const done = await t.waitFor(STORED, { from: prompt });
    expect(await status(t, done)).toBe(0);
    await t.close();
    expect(statSync(tokenFile(home)).ino).toBe(inode);
    expect(statSync(tokenFile(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenFile(home), "utf8")).toBe(`${value}\n`);
  }, 30_000);

  it("a directory that cannot be made: exit is not 0, no 'Token stored.', and the outer shell received nothing", async () => {
    const home = freshHome();
    // A file where the directory must go: mkdir fails, also for root.
    writeFileSync(join(home, ".config"), "");
    const t = open(BASH, home);
    const value = token();
    const prompt = await startStep(t);
    t.type(`${value}\n`);
    const code = await status(t, prompt);
    await t.close();
    expect(code).not.toBe(0);
    expect(STORED.test(t.screen().slice(prompt))).toBe(false);
    expect(t.screen()).not.toContain(value);
  }, 30_000);

  it("Ctrl-C at the prompt: nothing is stored and the terminal echoes again", async () => {
    const home = freshHome();
    const t = open(BASH, home);
    const prompt = await startStep(t);
    t.type("\u0003");
    const ready = await t.waitFor(/READY> /, { from: prompt });
    t.type("stty -a; echo stty-done\n");
    const end = await t.waitFor(/stty-done\r?\n/, { from: ready });
    const settings = t.screen().slice(ready, end);
    await t.close();
    expect(settings).toMatch(/(^|\s)echo(\s|;|$)/m);
    expect(settings).not.toMatch(/(^|\s)-echo(\s|;|$)/m);
    expect(existsSync(tokenFile(home))).toBe(false);
  }, 30_000);

  it("the outer shell is sh: a token and Enter are stored, and the terminal never showed it", async () => {
    const home = freshHome();
    const t = open(SH, home);
    const value = token();
    const prompt = await startStep(t);
    t.type(`${value}\n`);
    const done = await t.waitFor(STORED, { from: prompt });
    expect(await status(t, done)).toBe(0);
    await t.close();
    expect(readFileSync(tokenFile(home), "utf8")).toBe(`${value}\n`);
    expect(t.screen()).not.toContain(value);
  }, 30_000);

  it('consumer-leak-check.sh given a pasted three-line block at its value prompt takes none of it as a value, says "one value, not a file", and the outer shell receives nothing', async () => {
    const home = freshHome();
    const t = open(BASH, home);
    const mark = randomBytes(6).toString("hex");
    const ready = await t.waitFor(/READY> /);
    t.type(`bash ${LEAK_CHECK}\n`);
    const prompt = await t.waitFor(/needle 1: /, { from: ready });
    await sleep(300);
    t.type(`A=one${mark}\nB=two${mark}\nC=three${mark}\n`);
    const refused = await t.waitFor(/one value, not a file/, { from: prompt });
    const again = await t.waitFor(/needle 1: /, { from: refused });
    await sleep(300);
    // An empty line ends: no needle was taken, so nothing is searched.
    t.type("\n");
    const code = await status(t, again);
    expect(code).toBe(64);
    expect(await variables(t, again, ["A", "B", "C"])).toContain("[][][]=end");
    await t.close();
    expect(t.screen()).not.toContain(mark);
  }, 30_000);

  it("the names-only command with a two-line value prints the name and neither line", () => {
    const names = (blockOf(9, 1).split("-- ")[1] ?? "").trim();
    expect(names).toMatch(/^sh -c '/);
    const printed = namesOnly(names);
    expect(printed).toContain("MULTI_LINE");
    expect(printed).not.toContain(FIRST_LINE);
    expect(printed).not.toContain(SECOND_LINE);
  });

  it("control: today's env | cut form prints the second line", () => {
    const printed = namesOnly(`sh -c 'env | cut -d= -f1 | sort'`);
    expect(printed).toContain(SECOND_LINE);
  });

  it("control: with the old block and stty -echo before it, a failing middle block sends the paste to the outer shell", async () => {
    const home = freshHome();
    writeFileSync(join(home, ".config"), "");
    const t = open(BASH, home);
    const value = token();
    const first = await t.waitFor(/READY> /);
    t.type("stty -echo\n");
    const second = await t.waitFor(/READY> /, { from: first });
    t.type(`${OLD_STEP}\n`);
    const third = await t.waitFor(/READY> /, { from: second });
    t.type(`${value}\n`);
    await t.waitFor(/READY> /, { from: third });
    t.type("stty echo\n");
    await t.close();
    // The outer shell ran the token as a command, and said so with the token.
    expect(t.screen()).toContain(value);
  }, 30_000);
});
