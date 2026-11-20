// Run 8.1 Task B Step 4 (P-145): candidate.json is written from the release
// directory and the repository at the release's commit, never typed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCandidate, recordDeploy } from "../../../scripts/release-candidate.ts";

const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
const digest = (c: string): string => `sha256:${c.repeat(64)}`;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function releaseDir(commit: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mykey-candidate-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "release.json"),
    JSON.stringify({
      format: "mykey-host-release/1",
      version: "0.8.0",
      commit,
      builtAt: "2026-11-20T18:00:00.000Z",
      images: [
        { name: "api", imageId: digest("a"), archive: "api.tar", archiveSha256: "1".repeat(64) },
        {
          name: "provisioner",
          imageId: digest("b"),
          archive: "provisioner.tar",
          archiveSha256: "2".repeat(64),
        },
        { name: "ops", imageId: digest("c"), archive: "ops.tar", archiveSha256: "3".repeat(64) },
      ],
      baseDigests: { node: digest("d") },
      migrations: { last: "0018_incarnation" },
      scans: { secrets: "pass", dependencies: "pass", images: "pass" },
    }),
  );
  return dir;
}

describe("candidate.json (P-145)", () => {
  it("every field of P-145 is present, and a release whose commit is not an ancestor of HEAD is refused", () => {
    const candidate = buildCandidate({ releaseDir: releaseDir(head), cli: "cli-v0.1.2" });
    expect(candidate.hostRelease).toBe("host-v0.8.0");
    expect(candidate.cliRelease).toBe("cli-v0.1.2");
    expect(candidate.sourceCommit).toBe(head);
    expect(candidate.releaseJsonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.images.map((image) => image.name)).toEqual(["api", "provisioner", "ops"]);
    expect(candidate.lockfiles["pnpm-lock.yaml"]).toBe(
      sha256(execFileSync("git", ["show", `${head}:pnpm-lock.yaml`])),
    );
    expect(candidate.lockfiles["infra/dependencies.lock.json"]).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(candidate.upstreamImages)).toEqual(
      expect.arrayContaining(["postgres", "openbao", "traefik", "restic", "node"]),
    );
    for (const value of Object.values(candidate.upstreamImages)) {
      expect(value).toMatch(/^[a-z0-9./-]+:[^@]+@sha256:[0-9a-f]{64}$/);
    }
    expect(candidate.lastMigration).toBe("0018_incarnation");
    expect(candidate.hostFilesCommit).toBe(
      git("log", "-1", "--format=%H", head, "--", "infra/hosts"),
    );
    expect(candidate.tooling).toEqual([]);
    expect(candidate.deploys).toEqual({});

    expect(() =>
      buildCandidate({ releaseDir: releaseDir("0".repeat(40)), cli: "cli-v0.1.2" }),
    ).toThrow(/not an ancestor/);
  });

  it("refuses a CLI release that is not a cli-v tag", () => {
    expect(() => buildCandidate({ releaseDir: releaseDir(head), cli: "0.1.2" })).toThrow(/cli-v/);
  });

  it("a deploy adds its time and gate epoch for its host, once", () => {
    const candidate = buildCandidate({ releaseDir: releaseDir(head), cli: "cli-v0.1.2" });
    const after = recordDeploy(candidate, "staging", "2026-11-20T19:00:00.000Z", 7);
    expect(after.deploys.staging).toEqual({ at: "2026-11-20T19:00:00.000Z", gateEpoch: 7 });
    expect(() => recordDeploy(after, "staging", "2026-11-20T19:05:00.000Z", 8)).toThrow(/already/);
    expect(() => recordDeploy(after, "drill", "2026-11-20T19:05:00.000Z", 1)).toThrow(/host/);
  });
});
