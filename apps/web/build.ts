// Builds the owner workspace into apps/web/dist (P-134, D-59): one script and
// one stylesheet named by their content, an index that names them, and a
// manifest with the sha256 of each file. The API reads the manifest at start
// and serves nothing that is not in it. No source map, no inline script, no
// external reference of any kind.
// Run: node apps/web/build.ts   (MYKEY_BUILD names the build; "dev" without it)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/** The largest script the build accepts (Run 9.0 Task H). */
export const MAX_SCRIPT_BYTES = 1_200_000;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export interface WebBuild {
  directory: string;
  build: string;
  files: { path: string; sha256: string; contentType: string }[];
}

const indexHtml = (script: string, style: string): string =>
  [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    "<title>MyKey</title>",
    // No request for an icon: the page asks for its script and its stylesheet only.
    '<link rel="icon" href="data:,">',
    `<link rel="stylesheet" href="/${style}">`,
    `<script type="module" src="/${script}"></script>`,
    "</head>",
    "<body>",
    '<div id="root"></div>',
    "<noscript>The MyKey workspace needs JavaScript. The CLI and the API work without it.</noscript>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

export async function buildWeb(
  options: { directory?: string; build?: string } = {},
): Promise<WebBuild> {
  const directory = options.directory ?? join(here, "dist");
  // An image built without MYKEY_BUILD passes an empty value: that is "dev" too.
  const named = options.build ?? process.env.MYKEY_BUILD ?? "";
  const buildName = named === "" ? "dev" : named;
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  const result = await build({
    entryPoints: [join(here, "src", "main.tsx")],
    outdir: directory,
    entryNames: "assets/app-[hash]",
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: false,
    jsx: "automatic",
    // The licences of what is bundled stay in the file.
    legalComments: "eof",
    define: { "process.env.NODE_ENV": '"production"' },
    // Run 8.0 (FR-1.102): docs/runbooks/known-limits.md is bundled as text for the Help screen.
    loader: { ".md": "text" },
    metafile: true,
    logLevel: "warning",
  });

  const outputs = Object.keys(result.metafile.outputs).map((output) =>
    relative(directory, resolve(process.cwd(), output)).replaceAll("\\", "/"),
  );
  const script = outputs.filter((path) => path.endsWith(".js"));
  const style = outputs.filter((path) => path.endsWith(".css"));
  if (script.length !== 1 || style.length !== 1 || outputs.length !== 2) {
    throw new Error(`web build: expected one script and one stylesheet, got ${outputs.join(", ")}`);
  }
  // Run 9.0 Task H: the script stays under 1.2 MB (875 kB before Session 9's redesign).
  const scriptBytes = readFileSync(join(directory, ...(script[0] ?? "").split("/"))).length;
  if (scriptBytes > MAX_SCRIPT_BYTES) {
    throw new Error(
      `web build: the script is ${String(scriptBytes)} bytes, above ${String(MAX_SCRIPT_BYTES)}`,
    );
  }
  writeFileSync(join(directory, "index.html"), indexHtml(script[0] ?? "", style[0] ?? ""));

  const files = ["index.html", ...outputs].map((path) => {
    const extension = path.slice(path.lastIndexOf("."));
    const contentType = CONTENT_TYPES[extension];
    if (contentType === undefined) throw new Error(`web build: no content type for ${path}`);
    const bytes = readFileSync(join(directory, ...path.split("/")));
    return { path, sha256: createHash("sha256").update(bytes).digest("hex"), contentType };
  });
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify({ build: buildName, files }, null, 2)}\n`,
  );
  return { directory, build: buildName, files };
}

if (import.meta.main) {
  const built = await buildWeb();
  for (const file of built.files) {
    const size = readFileSync(join(built.directory, ...file.path.split("/"))).length;
    console.log(`${file.path}  ${String(size)} bytes`);
  }
  console.log(`built the workspace (${built.build})`);
}
