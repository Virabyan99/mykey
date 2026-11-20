// Session 7 gate: a host script never signals a container through Docker's
// kill call. Docker marks a container it signalled as stopped by hand, and
// the host's `unless-stopped` policy then starts it neither after an exit nor
// at boot: staging's OpenBao stayed down after a reboot, because the nightly
// audit rotation had sent its SIGHUP that way. The behaviour itself is proven
// with a real container in tests/integration/archive/rotation.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("signals to a container on a host", () => {
  it("no host file and no operator script calls docker kill", () => {
    const sources = [
      ...files(join(ROOT, "infra", "hosts")),
      ...files(join(ROOT, "infra", "compose")),
      join(ROOT, "scripts", "host.ts"),
      ...files(join(ROOT, "apps", "ops", "src")),
    ];
    expect(sources.length).toBeGreaterThan(20);
    const calls = sources.filter((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .some((line) => !/^\s*(#|\/\/|\*)/.test(line) && /docker\s+(compose\s+)?kill\b/.test(line)),
    );
    expect(calls.map((path) => path.slice(ROOT.length + 1).replaceAll("\\", "/"))).toEqual([]);
  });
});
