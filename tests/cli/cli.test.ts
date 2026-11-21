import {
  CLI_NAME,
  MACHINE_TOKEN_VARIABLE,
  SUPPORTED_TARGETS,
  currentTarget,
  isSupportedTarget,
} from "@mykey/cli";
import { readFileSync } from "node:fs";
import { API_MAJOR } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import { CLI_BUNDLE, runCli } from "../harness/cli.ts";
import { startCliServer } from "./server.ts";

describe("cli identity and targets", () => {
  it("is named secrets and reads SECRETS_MACHINE_TOKEN (D-08)", () => {
    expect(CLI_NAME).toBe("secrets");
    expect(MACHINE_TOKEN_VARIABLE).toBe("SECRETS_MACHINE_TOKEN");
  });

  it("supports exactly the four Stage 1 targets", () => {
    expect([...SUPPORTED_TARGETS].sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]);
    expect(isSupportedTarget("win32-x64")).toBe(false);
    expect(isSupportedTarget("linux-arm64")).toBe(true);
  });

  it("names the machine it runs on, and the CI matrix runner is the target it claims", () => {
    const target = currentTarget();
    expect(target).toBe(`${process.platform}-${process.arch}`);
    const expected = process.env.MYKEY_EXPECT_TARGET;
    if (expected !== undefined && expected !== "") {
      expect(target).toBe(expected);
      expect(isSupportedTarget(target)).toBe(true);
    }
  });
});

describe("the executable (Run 5.5)", () => {
  it("--version prints the CLI version and the API major and makes no request", async () => {
    const server = await startCliServer();
    try {
      const result = await runCli(["--version"], {
        env: { SECRETS_API_URL: server.url, SECRETS_CA_FILE: server.caPath },
      });
      const { version } = JSON.parse(readFileSync("apps/cli/package.json", "utf8")) as {
        version: string;
      };
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(
        new RegExp(
          `^secrets ${version.replaceAll(".", "\\.")} \\(API major ${String(API_MAJOR)}; ${process.platform}-${process.arch}; node \\d+\\.\\d+\\.\\d+\\)\\n$`,
        ),
      );
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("the bundle imports node: modules only", () => {
    if (process.env.MYKEY_CLI_BIN !== undefined && process.env.MYKEY_CLI_BIN !== "") return;
    const text = readFileSync(CLI_BUNDLE, "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const specifiers = [
      ...text.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm),
      ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
  });
});
