// Run 5.5 Task A (P-96, FR-1.79, FR-1.51): runtime settings that would switch
// off verification or inject code are refused before anything else happens,
// and so is every platform outside the four targets.
import { CliError, refuseUnsafeRuntime } from "@mykey/cli";
import { describe, expect, it } from "vitest";

const SAFE = {
  env: { HOME: "/home/u", PATH: "/usr/bin" } as NodeJS.ProcessEnv,
  execArgv: [] as string[],
  platform: "linux",
  arch: "x64",
  glibc: "2.36" as string | undefined,
};

function refused(input: Partial<typeof SAFE>): void {
  try {
    refuseUnsafeRuntime({ ...SAFE, ...input });
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).category).toBe("unsupported");
    return;
  }
  throw new Error("accepted");
}

describe("refuseUnsafeRuntime", () => {
  it("refuses each unsafe setting on its own", () => {
    refused({ env: { ...SAFE.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
    refused({ env: { ...SAFE.env, NODE_OPTIONS: "--max-old-space-size=64" } });
    refused({ env: { ...SAFE.env, NODE_OPTIONS: "" } });
    refused({ env: { ...SAFE.env, NODE_USE_ENV_PROXY: "1" } });
    for (const flag of [
      "--require=./x.cjs",
      "--import=./x.mjs",
      "--loader=./x.mjs",
      "--experimental-loader=./x.mjs",
      "--inspect",
      "--inspect-brk=0",
      "--insecure-http-parser",
      "-r",
    ]) {
      refused({ execArgv: [flag] });
    }
  });

  it("refuses every platform outside the four targets", () => {
    refused({ platform: "win32", glibc: undefined });
    refused({ platform: "linux", glibc: undefined });
    refused({ platform: "linux", arch: "riscv64" });
    refused({ platform: "darwin", arch: "ppc64", glibc: undefined });
    refused({ platform: "freebsd", glibc: undefined });
  });

  it("passes NODE_EXTRA_CA_CERTS alone and the four targets", () => {
    const passes = (input: Partial<typeof SAFE>): boolean => {
      refuseUnsafeRuntime({ ...SAFE, ...input });
      return true;
    };
    expect(passes({ env: { ...SAFE.env, NODE_EXTRA_CA_CERTS: "/ca.pem" } })).toBe(true);
    expect(passes({ env: { ...SAFE.env, NODE_TLS_REJECT_UNAUTHORIZED: "1" } })).toBe(true);
    for (const [platform, arch, glibc] of [
      ["linux", "x64", "2.31"],
      ["linux", "arm64", "2.36"],
      ["darwin", "x64", undefined],
      ["darwin", "arm64", undefined],
    ] as const) {
      expect(passes({ platform, arch, glibc })).toBe(true);
    }
  });
});
