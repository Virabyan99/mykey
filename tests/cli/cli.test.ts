import {
  CLI_NAME,
  MACHINE_TOKEN_VARIABLE,
  SUPPORTED_TARGETS,
  currentTarget,
  isSupportedTarget,
} from "@mykey/cli";
import { describe, expect, it } from "vitest";

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
