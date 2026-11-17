// Run 6.9 Task A (P-127): buildRelease with a recorded shell. It refuses a
// dirty tree, a commit that origin does not hold, an image that still carries
// npm, npx or corepack, and a failing scan; it scans the archives it lists and
// takes the base digests from the lock, so two builds of a commit agree.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRelease, type BuildIo } from "../../../infra/release/build.ts";

const COMMIT = "c96b83d0123456789abcdef0123456789abcdef0";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeIo(over: Partial<Record<string, { code: number; stdout: string }>> = {}): {
  io: BuildIo;
  ran: string[];
} {
  const ran: string[] = [];
  const io: BuildIo = {
    root: process.cwd(),
    now: () => new Date("2026-11-18T12:00:00.000Z"),
    run: (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      ran.push(line);
      for (const [prefix, answer] of Object.entries(over)) {
        if (answer !== undefined && line.startsWith(prefix)) return Promise.resolve(answer);
      }
      if (line === "git status --porcelain") return Promise.resolve({ code: 0, stdout: "" });
      if (line === "git rev-parse HEAD") return Promise.resolve({ code: 0, stdout: `${COMMIT}\n` });
      if (line.startsWith("git branch -r --contains")) {
        return Promise.resolve({ code: 0, stdout: "  origin/session-6\n" });
      }
      if (line.startsWith("docker image inspect")) {
        const name = /mykey-([a-z]+):/.exec(line)?.[1] ?? "x";
        return Promise.resolve({
          code: 0,
          stdout: `sha256:${({ api: "a", provisioner: "b", ops: "c" } as Record<string, string>)[name]!.repeat(64)}\n`,
        });
      }
      if (line.startsWith("docker save")) {
        const out = args[args.indexOf("-o") + 1]!;
        writeFileSync(out, `archive of ${args[1] ?? ""}`);
      }
      return Promise.resolve({ code: 0, stdout: "" });
    },
  };
  return { io, ran };
}

const outDir = () => {
  const d = mkdtempSync(join(tmpdir(), "mykey-host-build-"));
  dirs.push(d);
  return d;
};

describe("buildRelease (P-127)", () => {
  it("refuses a dirty tree", async () => {
    const { io } = fakeIo({
      "git status --porcelain": { code: 0, stdout: " M scripts/host.ts\n" },
    });
    await expect(buildRelease({ version: "0.6.0", outDir: outDir() }, io)).rejects.toThrow(
      /working tree is not clean/,
    );
  });

  it("refuses a commit that origin does not hold", async () => {
    const { io } = fakeIo({ "git branch -r --contains": { code: 0, stdout: "" } });
    await expect(buildRelease({ version: "0.6.0", outDir: outDir() }, io)).rejects.toThrow(
      /not on origin/,
    );
  });

  it("refuses an image that still holds npm, npx or corepack", async () => {
    const { io } = fakeIo({
      "docker run --rm --entrypoint ls mykey-ops:0.6.0": {
        code: 0,
        stdout: "/usr/local/bin/npm\n",
      },
    });
    await expect(buildRelease({ version: "0.6.0", outDir: outDir() }, io)).rejects.toThrow(
      /ops image holds \/usr\/local\/bin\/npm/,
    );
  });

  it("refuses a failing scan and writes no release.json", async () => {
    const dir = outDir();
    const { io } = fakeIo({ "node scripts/ci-scan.ts dependencies": { code: 1, stdout: "" } });
    await expect(buildRelease({ version: "0.6.0", outDir: dir }, io)).rejects.toThrow(
      /scan dependencies failed/,
    );
    expect(() => readFileSync(join(dir, "release.json"))).toThrow();
  });

  it("builds each image with its build id, scans the archives it lists, writes release.json and SHA256SUMS", async () => {
    const dir = outDir();
    const { io, ran } = fakeIo();
    const release = await buildRelease({ version: "0.6.0", outDir: dir }, io);
    for (const name of ["api", "provisioner", "ops"]) {
      expect(ran).toContain(
        `docker build --platform linux/amd64 -q -f apps/${name}/Dockerfile --build-arg MYKEY_BUILD=${COMMIT.slice(0, 12)} -t mykey-${name}:0.6.0 .`,
      );
    }
    expect(ran).toContain(`node scripts/ci-scan.ts images --archives ${dir}`);
    expect(ran.findIndex((l) => l.startsWith("node scripts/ci-scan.ts images"))).toBeGreaterThan(
      ran.findIndex((l) => l.startsWith("docker save")),
    );
    expect(release.images.map((i) => [i.name, i.archive])).toEqual([
      ["api", "api.tar"],
      ["provisioner", "provisioner.tar"],
      ["ops", "ops.tar"],
    ]);
    expect(release.migrations.last).toBe("0018_incarnation");
    expect(JSON.parse(readFileSync(join(dir, "release.json"), "utf8"))).toEqual(release);
    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
    for (const file of ["api.tar", "provisioner.tar", "ops.tar", "release.json"]) {
      expect(sums).toMatch(new RegExp(`^[0-9a-f]{64}  ${file}$`, "m"));
    }
  });

  it("two builds of one commit list the same base digests, taken from the lock", async () => {
    const a = await buildRelease({ version: "0.6.0", outDir: outDir() }, fakeIo().io);
    const b = await buildRelease({ version: "0.6.0", outDir: outDir() }, fakeIo().io);
    expect(a.baseDigests).toEqual(b.baseDigests);
    const lock = JSON.parse(readFileSync("infra/dependencies.lock.json", "utf8")) as {
      images: Record<string, { digest: string }>;
    };
    expect(a.baseDigests.node).toBe(lock.images.node!.digest);
  });
});
