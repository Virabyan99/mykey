import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectPinnedVersions,
  composeImageProblems,
  consistencyProblems,
  digestProblems,
  forbiddenComponents,
  listFiles,
  loadLock,
  missingRequiredKeys,
  unpinnedVersions,
  verifyPins,
  versionLineProblems,
  workflowActionProblems,
  type DependenciesLock,
} from "../../../scripts/pins-verify.ts";

const root = resolve(import.meta.dirname, "../../..");
const lock = loadLock(root);

function clone(): DependenciesLock {
  return structuredClone(lock);
}

const DIGEST_NOT_IN_LOCK = `sha256:${"0".repeat(64)}`;
const SHA_NOT_IN_LOCK = "0".repeat(40);

describe("dependency pins", () => {
  it("lock file has every required key", () => {
    expect(missingRequiredKeys(lock)).toEqual([]);

    const broken = clone();
    delete broken.images.openbao;
    delete broken.npm["better-auth"];
    delete broken.actions["actions/checkout"];
    expect(missingRequiredKeys(broken)).toEqual([
      "images.openbao",
      "npm.better-auth",
      "actions.actions/checkout",
    ]);
  });

  it("no pre-release version is pinned", () => {
    const entries = collectPinnedVersions(root, lock);
    expect(entries.length).toBeGreaterThan(40);
    expect(unpinnedVersions(entries)).toEqual([]);

    const bad = [
      "1.2.3-rc.1",
      "7.1.0-beta",
      "2.0.0-next.3",
      "1.0.0-canary",
      "^1.2.3",
      "~1.2.3",
      "*",
    ];
    const flagged = unpinnedVersions([
      ...bad.map((version) => ({ where: "x", kind: "npm" as const, version })),
      { where: "x", kind: "npm", version: "latest" },
      { where: "x", kind: "npm", version: "1.2" },
      { where: "img", kind: "image", version: "latest" },
      { where: "img", kind: "image", version: "18" },
      { where: "ok", kind: "npm", version: "1.2.3" },
      { where: "ok", kind: "image", version: "18.6" },
      { where: "ok", kind: "image", version: "v8.30.1" },
      { where: "ok", kind: "workspace", version: "catalog:" },
      { where: "ok", kind: "workspace", version: "workspace:*" },
      { where: "bad-ws", kind: "workspace", version: "^3.0.0" },
    ]);
    expect(flagged).toHaveLength(bad.length + 5);
    expect(flagged.some((line) => line.startsWith("ok"))).toBe(false);
  });

  it("PostgreSQL is major 18, OpenBao 2.7.x, Traefik 3.7.x, better-auth 1.7.x", () => {
    expect(versionLineProblems(lock)).toEqual([]);

    const wrong = clone();
    wrong.images.postgres!.tag = "19.0";
    wrong.images.openbao!.tag = "2.8.0";
    wrong.images.traefik!.tag = "3.8.1";
    wrong.npm["better-auth"]!.version = "1.8.0";
    expect(versionLineProblems(wrong)).toHaveLength(4);
  });

  it("every image digest is sha256 with 64 hex characters and every action sha is 40 hex", () => {
    expect(digestProblems(lock)).toEqual([]);

    const wrong = clone();
    wrong.images.restic!.digest = "sha256:abc";
    wrong.actions["actions/checkout"]!.sha = "v7";
    wrong.python["python-dotenv"]!.sha256 = "nope";
    expect(digestProblems(wrong)).toHaveLength(3);
  });

  it("every image reference in infra/compose uses a digest present in the lock", () => {
    for (const file of listFiles(join(root, "infra/compose"), /\.ya?ml$/)) {
      expect(composeImageProblems(readFileSync(file, "utf8"), lock, file)).toEqual([]);
    }

    const good = `services:\n  pg:\n    image: ${lock.images.postgres!.image}@${lock.images.postgres!.digest}\n`;
    expect(composeImageProblems(good, lock, "good.yml")).toEqual([]);
    const tagOnly = "services:\n  pg:\n    image: postgres:18.6\n";
    expect(composeImageProblems(tagOnly, lock, "tag.yml")).toHaveLength(1);
    const unknown = `services:\n  pg:\n    image: postgres@${DIGEST_NOT_IN_LOCK}\n`;
    expect(composeImageProblems(unknown, lock, "unknown.yml")).toHaveLength(1);
    const variable = "services:\n  pg:\n    image: ${PG_IMAGE}\n";
    expect(composeImageProblems(variable, lock, "var.yml")).toHaveLength(1);
  });

  it("every uses: in .github/workflows is a SHA present in the lock", () => {
    for (const file of listFiles(join(root, ".github/workflows"), /\.ya?ml$/)) {
      expect(workflowActionProblems(readFileSync(file, "utf8"), lock, file)).toEqual([]);
    }

    const sha = lock.actions["actions/checkout"]!.sha;
    expect(
      workflowActionProblems(`- uses: actions/checkout@${sha} # v7\n`, lock, "ok.yml"),
    ).toEqual([]);
    expect(workflowActionProblems("- uses: actions/checkout@v7\n", lock, "tag.yml")).toHaveLength(
      1,
    );
    expect(
      workflowActionProblems(`- uses: actions/checkout@${SHA_NOT_IN_LOCK}\n`, lock, "sha.yml"),
    ).toHaveLength(1);
    expect(
      workflowActionProblems(`- uses: someone/else@${SHA_NOT_IN_LOCK}\n`, lock, "other.yml"),
    ).toHaveLength(1);
    expect(workflowActionProblems("- uses: docker://alpine:3\n", lock, "docker.yml")).toHaveLength(
      1,
    );
  });

  it("forbidden components are absent", () => {
    expect(forbiddenComponents(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"))).toEqual([]);
    expect(
      forbiddenComponents(
        "  ioredis@5.0.0:\n  bullmq@5.1.0:\n  '@modelcontextprotocol/sdk@1.0.0':\n",
      ),
    ).toEqual(["redis", "ioredis", "bullmq", "@modelcontextprotocol/"]);
    expect(forbiddenComponents("  '@temporalio/client@1.0.0':\n")).toEqual(["temporalio"]);
    // Installed packages are the two-space keys. A package that only names a
    // forbidden one as an optional peer has not installed it.
    expect(
      forbiddenComponents(
        [
          "  drizzle-orm@0.45.4:",
          "    peerDependencies:",
          "      '@upstash/redis': '>=1.34.7'",
          "    peerDependenciesMeta:",
          "      '@upstash/redis':",
          "        optional: true",
          "",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(forbiddenComponents("  '@upstash/redis@1.34.7':\n")).toEqual(["redis"]);
    expect(forbiddenComponents("  redis@4.6.0(some-peer@1.0.0):\n")).toEqual(["redis"]);
  });

  it("lock, catalog, package.json files and .node-version agree", () => {
    expect(consistencyProblems(root, lock)).toEqual([]);

    const drift = clone();
    drift.node.version = "24.0.0";
    drift.npm.typescript!.version = "5.0.0";
    drift.npm.zod!.version = "3.0.0";
    const problems = consistencyProblems(root, drift);
    expect(problems.some((p) => p.includes(".node-version"))).toBe(true);
    expect(problems.some((p) => p.includes("typescript"))).toBe(true);
    expect(problems.some((p) => p.includes("zod"))).toBe(true);
  });

  it("the whole repository verifies", () => {
    expect(verifyPins(root)).toEqual([]);
  });
});
