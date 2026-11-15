// Run 5.5 Task A (P-96, FR-1.79): where the CLI finds its API URL, which URLs
// it refuses, and how it picks the environment.
import { CliError, parseArgs, resolveApiUrl, selectorOf } from "@mykey/cli";
import { describe, expect, it } from "vitest";

const UID = 1000;
const PROJECT = "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f";
const FILE = "/home/u/.config/mykey/config.json";

type Read = (path: string) => { text: string; mode: number; uid: number } | null;
const noFile: Read = () => null;
const fileWith =
  (text: string, mode = 0o100600, uid = UID, at = FILE): Read =>
  (path) =>
    path === at ? { text, mode, uid } : null;

function refused(run: () => unknown, category: string): CliError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).category).toBe(category);
    return error as CliError;
  }
  throw new Error("accepted");
}

describe("resolveApiUrl", () => {
  it("takes SECRETS_API_URL over the file", () => {
    const read = fileWith(JSON.stringify({ apiUrl: "https://file.example" }));
    const url = resolveApiUrl(
      { HOME: "/home/u", SECRETS_API_URL: "https://env.example" },
      read,
      UID,
    );
    expect(url.href).toBe("https://env.example/");
    expect(resolveApiUrl({ HOME: "/home/u" }, read, UID).href).toBe("https://file.example/");
  });

  it("reads the file under XDG_CONFIG_HOME when it is set", () => {
    const read = fileWith(
      JSON.stringify({ apiUrl: "https://xdg.example" }),
      0o100600,
      UID,
      "/x/mykey/config.json",
    );
    expect(resolveApiUrl({ HOME: "/home/u", XDG_CONFIG_HOME: "/x" }, read, UID).host).toBe(
      "xdg.example",
    );
  });

  it("refuses a URL that is not plain https", () => {
    for (const value of [
      "http://api.example",
      "https://user:pw4711x@api.example",
      "https://user@api.example",
      "https://api.example/#x",
      "https://api.example/#",
      "https://api.example/?a=1",
      "https://api.example/?",
      "https://api.example/prefix",
      "ftp://api.example",
      "not a url",
    ]) {
      const error = refused(
        () => resolveApiUrl({ HOME: "/home/u", SECRETS_API_URL: value }, noFile, UID),
        "unsupported",
      );
      expect(error.message.includes("pw4711x")).toBe(false);
    }
  });

  it("refuses a file with another key, writable by group or others, or owned by another user", () => {
    const env = { HOME: "/home/u" };
    const good = JSON.stringify({ apiUrl: "https://api.example" });
    const secret = ["abc", "defghijklmnop"].join("");
    for (const read of [
      fileWith(JSON.stringify({ apiUrl: "https://api.example", token: secret })),
      fileWith(good, 0o100620),
      fileWith(good, 0o100602),
      fileWith(good, 0o100600, UID + 1),
      fileWith("{"),
      fileWith(JSON.stringify(["https://api.example"])),
      fileWith(JSON.stringify({ apiUrl: 7 })),
    ]) {
      const error = refused(() => resolveApiUrl(env, read, UID), "unsupported");
      expect(error.message.includes(secret)).toBe(false);
    }
    expect(resolveApiUrl(env, fileWith(good, 0o100644), UID).host).toBe("api.example");
  });

  it("refuses when nothing is configured", () => {
    refused(() => resolveApiUrl({ HOME: "/home/u" }, noFile, UID), "unsupported");
    refused(() => resolveApiUrl({}, noFile, UID), "unsupported");
    refused(() => resolveApiUrl({ SECRETS_API_URL: "" }, noFile, UID), "unsupported");
  });
});

describe("selectorOf", () => {
  it("a flag wins over the variable", () => {
    const env = {
      SECRETS_PROJECT: "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e70",
      SECRETS_ENVIRONMENT: "prod",
    };
    expect(selectorOf(parseArgs(["keys", "--project", PROJECT, "--env", "dev"]), env)).toEqual({
      project: PROJECT,
      env: "dev",
    });
    expect(selectorOf(parseArgs(["keys"]), env)).toEqual({
      project: "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e70",
      env: "prod",
    });
  });

  it("refuses a missing or malformed selector as a usage error", () => {
    refused(() => selectorOf(parseArgs(["keys", "--env", "dev"]), {}), "usage");
    refused(() => selectorOf(parseArgs(["keys", "--project", PROJECT]), {}), "usage");
    refused(() => selectorOf(parseArgs(["keys", "--project", "x", "--env", "dev"]), {}), "usage");
    refused(
      () => selectorOf(parseArgs(["keys", "--project", PROJECT, "--env", "../dev"]), {}),
      "usage",
    );
    refused(
      () => selectorOf(parseArgs(["keys", "--project", PROJECT, "--env", "Dev"]), {}),
      "usage",
    );
  });
});
