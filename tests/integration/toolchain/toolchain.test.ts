import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLock } from "../../../scripts/pins-verify.ts";

const lock = loadLock(resolve(import.meta.dirname, "../../.."));

const VERSION_COMMANDS: Record<string, { args: string[]; pattern: (tag: string) => RegExp }> = {
  postgres: {
    args: ["postgres", "--version"],
    pattern: (tag) => new RegExp(`^postgres \\(PostgreSQL\\) ${escape(tag)}\\b`, "m"),
  },
  openbao: {
    args: ["version"],
    pattern: (tag) => new RegExp(`^OpenBao v${escape(tag)}\\b`, "m"),
  },
  traefik: {
    args: ["version"],
    pattern: (tag) => new RegExp(`^Version:\\s+${escape(tag)}$`, "m"),
  },
  restic: {
    args: ["version"],
    pattern: (tag) => new RegExp(`^restic ${escape(tag)}\\b`, "m"),
  },
};

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("pinned toolchain images", () => {
  it("docker daemon is reachable", () => {
    expect(docker(["info", "--format", "{{.ServerVersion}}"]).trim()).toMatch(/^\d+\.\d+/);
  });

  it.each(Object.keys(VERSION_COMMANDS))(
    "%s image at the pinned digest reports the pinned version",
    (key) => {
      const pin = lock.images[key];
      const command = VERSION_COMMANDS[key];
      expect(pin, `${key} is in the lock`).toBeDefined();
      const output = docker(["run", "--rm", `${pin!.image}@${pin!.digest}`, ...command!.args]);
      expect(output).toMatch(command!.pattern(pin!.tag));
    },
    300_000,
  );
});
