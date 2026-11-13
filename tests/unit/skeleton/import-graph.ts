// The static import graph of a workspace entry file (Run 3.2): every source
// file reachable through relative imports and `@mykey/*` imports (resolved by
// the packages' `exports`). Used to prove that a public process cannot reach
// operator or provisioner code.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

interface Workspace {
  dir: string;
  exports: Record<string, string>;
}

function workspaces(): Map<string, Workspace> {
  const found = new Map<string, Workspace>();
  for (const group of ["apps", "packages", "workers"]) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, group, entry.name);
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: string;
        exports?: Record<string, string> | string;
      };
      if (manifest.name === undefined) continue;
      const exports =
        typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
      found.set(manifest.name, { dir, exports });
    }
  }
  return found;
}

const SPECIFIERS = [
  /\bimport\s+(?:type\s+)?[^'";]*?\sfrom\s*["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^'";]*?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
];

function specifiers(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIERS)
    for (const match of text.matchAll(pattern)) found.add(match[1]!);
  return [...found];
}

/** Every repository file reachable from `entry` (absolute paths). */
export function importGraph(entry: string): Set<string> {
  const packages = workspaces();
  const seen = new Set<string>();
  const queue = [resolve(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier));
        continue;
      }
      const match = /^(@mykey\/[^/]+)(\/.*)?$/.exec(specifier);
      if (match === null) continue;
      const workspace = packages.get(match[1]!);
      if (workspace === undefined) continue;
      const target = workspace.exports[`.${match[2] ?? ""}`];
      if (target !== undefined) queue.push(resolve(workspace.dir, target));
    }
  }
  return seen;
}

/** Repository-relative, forward-slash form of a path. */
export function relative(path: string): string {
  return path.slice(root.length + 1).replaceAll("\\", "/");
}
