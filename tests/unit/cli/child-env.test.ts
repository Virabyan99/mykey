// Run 5.6 Task A (FR-1.48, D-43): the child's environment, and the check that
// it fits the platform before anything is started.
import { createHash } from "node:crypto";
import { CliError, buildChildEnv, checkSize } from "@mykey/cli";
import { describe, expect, it } from "vitest";

const digest = (value: string | undefined): string =>
  createHash("sha256")
    .update(value ?? "", "utf8")
    .digest("hex");

function category(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return (error as CliError).category;
  }
  return "none";
}

const PARENT = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  SECRETS_MACHINE_TOKEN: "s.synthetic",
  SECRETS_API_URL: "https://api.example",
  SECRETS_PROJECT: "p",
  SECRETS_ENVIRONMENT: "dev",
  SECRETS_TOKEN_FILE: "/run/token",
  SECRETS_ANYTHING: "x",
};

describe("buildChildEnv", () => {
  it("drops every SECRETS_ variable, keeps the others and adds the set", () => {
    const env = buildChildEnv(PARENT, [{ name: "DATABASE_URL", value: "synthetic-db" }], false);
    expect(Object.keys(env).sort()).toEqual(["DATABASE_URL", "HOME", "PATH"]);
    expect(digest(env.DATABASE_URL)).toBe(digest("synthetic-db"));
  });

  it("a collision is a usage error; with override the secret wins", () => {
    const entries = [{ name: "HOME", value: "synthetic-home" }];
    expect(category(() => buildChildEnv(PARENT, entries, false))).toBe("usage");
    expect(digest(buildChildEnv(PARENT, entries, true).HOME)).toBe(digest("synthetic-home"));
  });

  it("a name the contract reserves is refused in both modes", () => {
    const entries = [{ name: "SECRETS_MACHINE_TOKEN", value: "synthetic" }];
    expect(category(() => buildChildEnv(PARENT, entries, false))).toBe("malformed");
    expect(category(() => buildChildEnv(PARENT, entries, true))).toBe("malformed");
  });

  it("a value with a NUL cannot reach an environment", () => {
    expect(category(() => buildChildEnv({}, [{ name: "A", value: "x\u0000y" }], false))).toBe(
      "malformed",
    );
  });
});

describe("checkSize", () => {
  const ARG_MAX = 2 * 1024 * 1024;

  it("one string of 200 KiB is too large on Linux, not on macOS", () => {
    const env = { BIG: "x".repeat(200 * 1024) };
    expect(
      category(() => {
        checkSize(env, "node", [], "linux", ARG_MAX);
      }),
    ).toBe("capacity");
    expect(
      category(() => {
        checkSize(env, "node", [], "darwin", ARG_MAX);
      }),
    ).toBe("none");
  });

  it("a total above three quarters of ARG_MAX is too large on both", () => {
    const env: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) env[`V${String(index)}`] = "x".repeat(100 * 1024);
    for (const platform of ["linux", "darwin"]) {
      expect(
        category(() => {
          checkSize(env, "node", [], platform, ARG_MAX);
        }),
        platform,
      ).toBe("capacity");
    }
    expect(
      category(() => {
        checkSize({ A: "x" }, "node", ["a"], "linux", ARG_MAX);
      }),
    ).toBe("none");
  });
});
