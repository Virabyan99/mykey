import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

const WORKSPACES: readonly (readonly [dir: string, name: string])[] = [
  ["apps/api", "@mykey/api"],
  ["apps/provisioner", "@mykey/provisioner"],
  ["apps/web", "@mykey/web"],
  ["apps/cli", "@mykey/cli"],
  ["apps/ops", "@mykey/ops"],
  ["packages/contracts", "@mykey/contracts"],
  ["packages/db", "@mykey/db"],
  ["packages/auth", "@mykey/auth"],
  ["packages/openbao", "@mykey/openbao"],
  ["packages/operations", "@mykey/operations"],
  ["packages/audit", "@mykey/audit"],
  ["workers/probe", "@mykey/probe"],
];

interface Manifest {
  name?: string;
  private?: boolean;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest;
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

describe("repository skeleton", () => {
  it("every Doc 06 §2 workspace exists with the expected package name", () => {
    expect(WORKSPACES).toHaveLength(12);
    for (const [dir, name] of WORKSPACES) {
      expect(existsSync(join(root, dir, "package.json")), `${dir}/package.json`).toBe(true);
      const manifest = readManifest(dir);
      expect(manifest.name, dir).toBe(name);
      expect(manifest.private, dir).toBe(true);
      expect(manifest.type, dir).toBe("module");
    }
  });

  it("infra and test folders exist", () => {
    for (const sub of ["compose", "hosts", "traefik", "openbao", "backup", "recovery", "release"]) {
      expect(isDirectory(join(root, "infra", sub)), `infra/${sub}`).toBe(true);
    }
    for (const sub of ["unit", "integration", "browser", "cli", "fault", "restore"]) {
      expect(isDirectory(join(root, "tests", sub)), `tests/${sub}`).toBe(true);
    }
  });

  it("operator code is not reachable from the public API", () => {
    const manifest = readManifest("apps/api");
    for (const field of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      expect(Object.keys(field ?? {})).not.toContain("@mykey/ops");
    }
  });

  it("spec documents are untouched", () => {
    const docs = readdirSync(join(root, "docs")).filter((f) => /^doc_\d\d_.*\.md$/.test(f));
    const numbers = docs.map((f) => f.slice(4, 6)).sort();
    expect(numbers).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]);
  });
});
