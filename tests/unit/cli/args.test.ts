// Run 5.5 Task A (P-96, FR-1.46): the CLI's argument grammar. A token can never
// arrive as an argument, and no error text quotes what was typed.
import { CliError, parseArgs } from "@mykey/cli";
import { describe, expect, it } from "vitest";

const PROJECT = "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f";

function usage(argv: string[]): CliError {
  try {
    parseArgs(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).category).toBe("usage");
    return error as CliError;
  }
  throw new Error(`parseArgs accepted ${String(argv.length)} arguments`);
}

describe("parseArgs", () => {
  it("keys, with selectors as flags, and with --token-stdin", () => {
    expect(parseArgs(["keys", "--project", PROJECT, "--env", "dev"])).toEqual({
      command: { name: "keys", tokenStdin: false },
      project: PROJECT,
      env: "dev",
    });
    expect(parseArgs(["keys", `--project=${PROJECT}`, "--env=dev", "--token-stdin"])).toEqual({
      command: { name: "keys", tokenStdin: true },
      project: PROJECT,
      env: "dev",
    });
    expect(parseArgs(["keys"])).toEqual({
      command: { name: "keys", tokenStdin: false },
      project: null,
      env: null,
    });
  });

  it("run keeps everything after -- untouched", () => {
    expect(parseArgs(["run", "--env", "dev", "--", "sh", "-c", "echo $X"])).toEqual({
      command: { name: "run", override: false, command: "sh", args: ["-c", "echo $X"] },
      project: null,
      env: "dev",
    });
    expect(parseArgs(["run", "--override", "--", "node", "--project", "x", "--", "y"])).toEqual({
      command: {
        name: "run",
        override: true,
        command: "node",
        args: ["--project", "x", "--", "y"],
      },
      project: null,
      env: null,
    });
  });

  it("export needs --output; --version stands alone", () => {
    expect(parseArgs(["export", "--output", "out.env", "--token-stdin"])).toEqual({
      command: { name: "export", output: "out.env", tokenStdin: true },
      project: null,
      env: null,
    });
    expect(parseArgs(["--version"])).toEqual({
      command: { name: "version" },
      project: null,
      env: null,
    });
  });

  it("refuses what the grammar does not allow, each as a usage error", () => {
    for (const argv of [
      [],
      ["list"],
      ["keys", "--verbose"],
      ["keys", "extra"],
      ["keys", "--project"],
      ["keys", "--project", PROJECT, "--project", PROJECT],
      ["keys", "--override"],
      ["run", "node"],
      ["run", "--"],
      ["run", "--token-stdin", "--", "node"],
      ["export"],
      ["export", "--output"],
      ["export", "--output", ""],
      ["--version", "keys"],
      ["keys", "--version"],
      ["keys", "-p", PROJECT],
    ]) {
      usage(argv);
    }
  });

  it("refuses a token given as a flag or an argument, and never repeats it", () => {
    const value = ["tok", "en", "-", "abcdefghijklmnop"].join("");
    for (const argv of [
      ["keys", "--token", value],
      ["keys", `--token=${value}`],
      ["keys", `--machine-token=${value}`],
      ["keys", value],
      ["run", `--token=${value}`, "--", "node"],
      [value],
    ]) {
      const error = usage(argv);
      expect(error.message.includes(value)).toBe(false);
    }
  });
});
