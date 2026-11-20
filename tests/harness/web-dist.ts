// A small dist directory as apps/web/build.ts writes it (Run 7.1): an index,
// one script, one stylesheet and the manifest. For the suites about the
// shell's serving; the browser project uses the real build (web.ts).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURE_DIST: Record<string, { text: string; contentType: string }> = {
  "index.html": {
    text: '<!doctype html><html><head><link rel="stylesheet" href="/assets/app-AAAA1111.css"></head><body><div id="app"></div><script type="module" src="/assets/app-BBBB2222.js"></script></body></html>',
    contentType: "text/html; charset=utf-8",
  },
  "assets/app-BBBB2222.js": {
    text: "document.title = 'fixture';",
    contentType: "text/javascript; charset=utf-8",
  },
  "assets/app-AAAA1111.css": {
    text: "body { margin: 0 }",
    contentType: "text/css; charset=utf-8",
  },
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Writes the fixture into a new temporary directory and answers its path; the
 * caller removes it. `change` runs after the manifest was computed and before
 * anything is written: a file changed there no longer matches its digest.
 */
export function writeFixtureDist(
  change: (files: typeof FIXTURE_DIST, manifest: { path: string }[]) => void = () => undefined,
): string {
  const directory = mkdtempSync(join(tmpdir(), "mykey-web-dist-"));
  mkdirSync(join(directory, "assets"));
  const files = structuredClone(FIXTURE_DIST);
  const manifest = Object.entries(files).map(([path, file]) => ({
    path,
    sha256: sha256(file.text),
    contentType: file.contentType,
  }));
  change(files, manifest);
  for (const [path, file] of Object.entries(files)) writeFileSync(join(directory, path), file.text);
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({ build: "fixture00000", files: manifest }),
  );
  return directory;
}
