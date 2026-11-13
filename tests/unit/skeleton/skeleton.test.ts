import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { importGraph, relative } from "./import-graph.ts";

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

  it("operator authority over OpenBao is not reachable from the public API", () => {
    // OpenBaoAdmin lives behind the subpath `@mykey/openbao/admin`; the package
    // root must not re-export it, and no source file of apps/api may import it.
    const index = readFileSync(join(root, "packages/openbao/src/index.ts"), "utf8");
    expect(index).toMatch(/from "\.\/client\.ts"/);
    expect(index).not.toMatch(/from\s+["'][^"']*admin/);

    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(c|m)?(t|j)sx?$/.test(entry.name)) sources.push(path);
      }
    };
    walk(join(root, "apps/api"));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/@mykey\/openbao\/admin|openbao\/src\/admin/);
    }
  });

  it("apps/api has no import path to operator authority (Run 3.2)", () => {
    const reached = [...importGraph("apps/api/src/server.ts")].map(relative);
    // Control: the walk follows workspace packages.
    expect(reached).toContain("packages/contracts/src/routes.ts");
    expect(reached).toContain("packages/audit/src/append.ts");
    const forbidden = reached.filter(
      (file) =>
        file.startsWith("packages/auth/src/operator/") ||
        file === "packages/openbao/src/admin.ts" ||
        file.startsWith("apps/ops/"),
    );
    expect(forbidden).toEqual([]);
  });

  it("apps/api has no import path to the provisioner's or the operator's OpenBao reach (Run 3.8)", () => {
    const reached = [...importGraph("apps/api/src/server.ts")].map(relative);
    expect(reached).toContain("packages/operations/src/gate.ts");
    const forbidden = reached.filter(
      (file) =>
        file === "packages/openbao/src/provisioner.ts" ||
        file === "packages/openbao/src/admin.ts" ||
        file === "packages/operations/src/operator.ts" ||
        file === "packages/operations/src/provisioning/organization.ts",
    );
    expect(forbidden).toEqual([]);
  });

  it("apps/provisioner has no import path to /admin, @mykey/auth or apps/ops (Run 3.8)", () => {
    const reached = [...importGraph("apps/provisioner/src/main.ts")].map(relative);
    // Control: it reaches its own client and the job worker.
    expect(reached).toContain("packages/openbao/src/provisioner.ts");
    expect(reached).toContain("packages/operations/src/provisioning/environment.ts");
    const forbidden = reached.filter(
      (file) =>
        file === "packages/openbao/src/admin.ts" ||
        file === "packages/operations/src/provisioning/organization.ts" ||
        file.startsWith("packages/auth/") ||
        file.startsWith("apps/ops/") ||
        file.startsWith("apps/api/"),
    );
    expect(forbidden).toEqual([]);
  });

  it("spec documents are untouched", () => {
    const docs = readdirSync(join(root, "docs")).filter((f) => /^doc_\d\d_.*\.md$/.test(f));
    const numbers = docs.map((f) => f.slice(4, 6)).sort();
    expect(numbers).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]);
  });
});
