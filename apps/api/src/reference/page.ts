// The API reference page (Run 5.9, P-101, D-45): one HTML document that needs
// nothing else. Scalar's standalone build (copied to apps/api/assets by
// `pnpm run reference:asset`) is inlined, the served OpenAPI document travels
// as a JSON data block, and a second inline script starts Scalar on it with
// request execution, the client, telemetry, default fonts, developer tools and
// any proxy switched off. The policy allows exactly those two scripts (by
// hash) and no request of any kind.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OpenApiDocument } from "./document.ts";

export const DEFAULT_ASSET_DIRECTORY = resolve(import.meta.dirname, "../../assets");

export interface ScalarAsset {
  script: string;
  package: string;
  version: string;
}

export interface ReferencePage {
  html: Uint8Array;
  csp: string;
}

/** The asset files, or null when either is missing or unreadable. */
export function loadScalarAsset(directory: string): ScalarAsset | null {
  try {
    const script = readFileSync(join(directory, "scalar.js"), "utf8");
    const note = JSON.parse(readFileSync(join(directory, "scalar.json"), "utf8")) as {
      package?: unknown;
      version?: unknown;
    };
    if (typeof note.package !== "string" || typeof note.version !== "string") return null;
    if (script.length === 0) return null;
    return { script, package: note.package, version: note.version };
  } catch {
    return null;
  }
}

/**
 * Inside a script element, `</script` ends it and `<!--` with `<script` changes
 * how the parser looks for the end. Each `<` that starts one of them becomes
 * `\x3C`: in the build these occur only inside string, template and regular
 * expression literals, where `\x3C` is the same character.
 */
export const escapeScript = (text: string): string => text.replace(/<(?=!--|\/?script)/gi, "\\x3C");

/** JSON for a data block: `<` never appears, so nothing in it can end the element. */
const dataBlock = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * Before Scalar's code, in the same script: the zod bundled in Scalar probes
 * `Function("")` once to choose a compiled parser, which the policy refuses
 * (no 'unsafe-eval') and reports as a violation. `jitless` (zod's global
 * configuration, read from globalThis) skips the probe; nothing else changes.
 */
const PRELUDE = "globalThis.__zod_globalConfig = { jitless: true };";

// Option names of @scalar/types 0.27.0 (the configuration of @scalar/api-reference 1.77.0).
const START = `(() => {
  "use strict";
  const content = JSON.parse(document.getElementById("openapi-document").textContent);
  Scalar.createApiReference("#app", {
    content,
    hideClientButton: true,
    hideTestRequestButton: true,
    documentDownloadType: "none",
    isEditable: false,
    telemetry: false,
    withDefaultFonts: false,
    showDeveloperTools: "never",
    showToolbar: "never",
    persistAuth: false,
    mcp: { disabled: true },
  });
})();`;

const hashOf = (script: string): string =>
  `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function buildReferencePage(asset: ScalarAsset, document: OpenApiDocument): ReferencePage {
  const scripts = [escapeScript(`${PRELUDE}\n${asset.script}`), escapeScript(START)];
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${escapeAttribute(`${asset.package} ${asset.version}`)}">`,
    "<title>MyKey API reference</title>",
    "</head>",
    "<body>",
    '<div id="app"></div>',
    `<script type="application/json" id="openapi-document">${dataBlock(document)}</script>`,
    ...scripts.map((script) => `<script>${script}</script>`),
    "</body>",
    "</html>",
    "",
  ].join("\n");
  const csp = [
    "default-src 'none'",
    `script-src ${scripts.map(hashOf).join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return { html: new TextEncoder().encode(html), csp };
}
