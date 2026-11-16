// Bundles the CLI into one file, apps/cli/dist/secrets.mjs (P-96): ESM for the
// pinned Node, no minification, no source map, a shebang, the version from
// package.json compiled in. The result imports only `node:` modules.
// Run: node apps/cli/build.ts
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
  version: string;
};
const node = readFileSync(join(root, ".node-version"), "utf8").trim().replace(/^v/, "");
const outfile = join(here, "dist", "secrets.mjs");

await build({
  entryPoints: [join(here, "src", "bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${node}`,
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  banner: { js: "#!/usr/bin/env node" },
  define: { __MYKEY_CLI_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.log(`built ${outfile.replaceAll("\\", "/").slice(root.length + 1)} (secrets ${version})`);
