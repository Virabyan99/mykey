// A command line run under a pseudo-terminal, for the tests of project `cli`.
// Linux: util-linux `script`. macOS: Python's pty module, because BSD `script`
// needs its own stdin to be a terminal and refuses the test's socket
// ("tcgetattr/ioctl: Operation not supported on socket", matrix run
// 43856083484). MYKEY_TEST_PTY=python takes the macOS path on Linux too.
import { spawn } from "node:child_process";

/**
 * Python's pty.spawn: the command as the session leader of a new
 * pseudo-terminal, the test's stdin copied to it; exits with its status.
 */
const PTY_SPAWN = [
  "import os, pty, sys",
  "status = pty.spawn(sys.argv[1:])",
  "sys.exit(os.waitstatus_to_exitcode(status))",
].join("\n");

export function underTerminal(command: string[]): [string, string[]] {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  if (process.platform === "darwin" || process.env.MYKEY_TEST_PTY === "python") {
    return ["python3", ["-c", PTY_SPAWN, ...command]];
  }
  // `exec`: no shell stays between the terminal and the command (a waiting sh
  // would die of the terminal's SIGINT itself).
  return ["script", ["-qec", `exec ${command.map(quote).join(" ")}`, "/dev/null"]];
}

export interface Terminal {
  /** Everything the terminal showed so far. */
  readonly screen: () => string;
  /** Types text, as a person or a paste would. */
  readonly type: (text: string) => void;
  /**
   * Waits until the screen, from offset `from` on, matches; answers the offset
   * just after the match. Fails with the screen's tail.
   */
  readonly waitFor: (pattern: RegExp, options?: { from?: number; ms?: number }) => Promise<number>;
  /** Types `exit`, closes the input and waits for the end. */
  readonly close: () => Promise<number | null>;
}

/** An interactive shell in a pseudo-terminal, started with `env` only. */
export function terminal(shell: string[], env: NodeJS.ProcessEnv): Terminal {
  const [command, args] = underTerminal(shell);
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const add = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  const ended = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      resolve(code);
    });
  });
  return {
    screen: () => output,
    type: (text) => {
      child.stdin.write(text);
    },
    waitFor: async (pattern, options = {}) => {
      const from = options.from ?? 0;
      const deadline = Date.now() + (options.ms ?? 10_000);
      for (;;) {
        const found = pattern.exec(output.slice(from));
        if (found !== null) return from + found.index + found[0].length;
        if (Date.now() > deadline) {
          child.kill("SIGKILL");
          throw new Error(
            `the terminal never showed ${String(pattern)}; it showed: ${output.slice(-600)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    close: async () => {
      child.stdin.write("exit\n");
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const code = await ended;
      clearTimeout(timer);
      return code;
    },
  };
}
