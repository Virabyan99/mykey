// Run 5.7 Task B (FR-1.51, AC-1.37): the CLI under test names the target it
// runs on, and an installed launcher runs the installer's pinned Node, not the
// runner's. `--version` prints "secrets <v> (API major <n>; <target>; node <v>)".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli } from "../harness/cli.ts";

const lock = JSON.parse(readFileSync("infra/dependencies.lock.json", "utf8")) as {
  node: { version: string };
};

describe("the platform the CLI runs on", () => {
  it("--version names the target, and it is the one the runner claims", async () => {
    const result = await runCli(["--version"]);
    expect(result.code, result.stderr).toBe(0);
    const match = /^secrets \S+ \(API major \d+; (\S+); node (\S+)\)\n$/.exec(result.stdout);
    expect(match).not.toBeNull();
    const [, target] = match ?? [];
    expect(target).toBe(`${process.platform}-${process.arch}`);
    const expected = process.env.MYKEY_EXPECT_TARGET;
    if (expected !== undefined && expected !== "") expect(target).toBe(expected);
  });

  it("an installed launcher runs the pinned Node", async () => {
    const result = await runCli(["--version"]);
    const node = /; node (\S+)\)/.exec(result.stdout)?.[1];
    const bin = process.env.MYKEY_CLI_BIN;
    if (bin !== undefined && bin !== "") {
      expect(node).toBe(lock.node.version);
    } else {
      // The bundle is run by this process's own Node.
      expect(node).toBe(process.versions.node);
    }
  });
});
