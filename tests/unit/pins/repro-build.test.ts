import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashBuild } from "../../../scripts/repro-build.ts";

const created: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mykey-repro-test-"));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const base = {
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "infra/dependencies.lock.json": "{}\n",
  "packages/a/dist/index.js": "export {};\n",
  "packages/b/dist/deep/x.js": "export const x = 1;\n",
  "packages/a/src/index.ts": "export {};\n",
  "node_modules/pkg/dist/skip.js": "ignored\n",
};

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hashBuild", () => {
  it("is the same for two trees with identical build output, whatever the creation order", () => {
    const reversed = Object.fromEntries(Object.entries(base).reverse());
    expect(hashBuild(tree(base))).toBe(hashBuild(tree(reversed)));
    expect(hashBuild(tree(base))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a built file changes", () => {
    const changed = { ...base, "packages/b/dist/deep/x.js": "export const x = 2;\n" };
    expect(hashBuild(tree(changed))).not.toBe(hashBuild(tree(base)));
  });

  it("changes when a built file is added or moved", () => {
    const added = { ...base, "packages/b/dist/y.js": "" };
    expect(hashBuild(tree(added))).not.toBe(hashBuild(tree(base)));
  });

  it("changes when either lock file changes", () => {
    const lock = { ...base, "pnpm-lock.yaml": "lockfileVersion: '9.1'\n" };
    const pins = { ...base, "infra/dependencies.lock.json": '{"a":1}\n' };
    expect(hashBuild(tree(lock))).not.toBe(hashBuild(tree(base)));
    expect(hashBuild(tree(pins))).not.toBe(hashBuild(tree(base)));
  });

  it("ignores sources and node_modules", () => {
    const noise = {
      ...base,
      "packages/a/src/index.ts": "export const changed = true;\n",
      "node_modules/pkg/dist/skip.js": "different\n",
    };
    expect(hashBuild(tree(noise))).toBe(hashBuild(tree(base)));
  });
});
