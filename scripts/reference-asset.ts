// The asset of the API reference (Run 5.9, P-101): the standalone browser build
// of the pinned @scalar/api-reference (a development dependency of apps/api),
// copied to apps/api/assets/ with a note of its version. The API inlines it at
// start; nothing else of the package reaches the image (apps/api/Dockerfile).
// The directory is ignored by Git.
// Run: pnpm run reference:asset   (or node scripts/reference-asset.ts [target directory])
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const PACKAGE = "@scalar/api-reference";
export const DEFAULT_ASSET_DIRECTORY = resolve(import.meta.dirname, "../apps/api/assets");

/** The package's directory as apps/api resolves it (its `exports` hide package.json). */
function packageDirectory(): string {
  const require = createRequire(resolve(import.meta.dirname, "../apps/api/package.json"));
  let directory = dirname(require.resolve(PACKAGE));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name?: string;
      };
      if (manifest.name === PACKAGE) return directory;
    } catch {
      // not the package root yet
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`reference-asset: ${PACKAGE} not found`);
    directory = parent;
  }
}

export function copyReferenceAsset(target: string = DEFAULT_ASSET_DIRECTORY): {
  version: string;
} {
  const source = packageDirectory();
  const { version } = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
    version: string;
  };
  mkdirSync(target, { recursive: true });
  copyFileSync(join(source, "dist/browser/standalone.js"), join(target, "scalar.js"));
  writeFileSync(
    join(target, "scalar.json"),
    `${JSON.stringify({ package: PACKAGE, version }, null, 2)}\n`,
  );
  return { version };
}

if (import.meta.main) {
  const target = process.argv[2] === undefined ? DEFAULT_ASSET_DIRECTORY : resolve(process.argv[2]);
  const { version } = copyReferenceAsset(target);
  console.log(`reference-asset: ${PACKAGE} ${version} → ${target}`);
}
