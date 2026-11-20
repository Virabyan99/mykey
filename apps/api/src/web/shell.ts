// The owner workspace's shell (Session 7, P-134, P-141, D-59). `apps/web/build.ts`
// writes three files and a manifest; the API reads them once at start and
// answers from memory: the index on the paths of WEB_ROUTES, an asset by its
// manifest name. A path of a request is never joined to a directory. The shell
// is public and holds no data; it passes the gate and the source limit like
// every request, and registers no route (app.ts answers it where the terminal
// 404 would be).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { matchWebRoute } from "@mykey/contracts";
import { z } from "zod";

export const DEFAULT_WEB_DIRECTORY = resolve(import.meta.dirname, "../../../web/dist");

export interface WebShell {
  index: Uint8Array;
  /** By manifest path (`assets/app-<hash>.js`); the index is not among them. */
  files: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }>;
  build: string;
}

/**
 * P-141. Scripts and styles of this origin only; no frame, no object, no
 * referrer. The only image is the index's empty icon (a data: address); the
 * stylesheet loads no font (Run 8.0).
 */
export const SHELL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
});

/** A manifest path: `index.html` or one file directly under `assets/`. */
const MANIFEST_PATH = /^(index\.html|assets\/[A-Za-z0-9._-]+)$/;
const CONTENT_TYPES = new Set([
  "text/html; charset=utf-8",
  "text/javascript; charset=utf-8",
  "text/css; charset=utf-8",
]);

const manifestSchema = z.strictObject({
  build: z.string().min(1).max(64),
  files: z
    .array(
      z.strictObject({
        path: z.string().regex(MANIFEST_PATH),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        contentType: z.string().refine((value) => CONTENT_TYPES.has(value)),
      }),
    )
    .min(1)
    .max(32),
});

/**
 * The built workspace, or null when the directory, the manifest, the index or
 * a file is missing, or a file's bytes are not the manifest's.
 */
export function loadWebShell(directory: string): WebShell | null {
  try {
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
    );
    let index: Uint8Array | null = null;
    const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
    for (const entry of manifest.files) {
      if (entry.path.includes("..")) return null;
      const bytes = readFileSync(join(directory, ...entry.path.split("/")));
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return null;
      if (entry.path === "index.html") index = new Uint8Array(bytes);
      else files.set(entry.path, { bytes: new Uint8Array(bytes), contentType: entry.contentType });
    }
    if (index === null) return null;
    return { index, files, build: manifest.build };
  } catch {
    return null;
  }
}

const ASSET = /^\/assets\/([A-Za-z0-9._-]+)$/;

const answerOf = (bytes: Uint8Array, contentType: string): Response =>
  new Response(bytes.slice().buffer, {
    status: 200,
    headers: { ...SHELL_HEADERS, "content-type": contentType, "cache-control": "no-store" },
  });

export type ShellAnswer =
  | { kind: "index" | "asset"; response: Response }
  /** A path of the shell, and no shell was loaded. */
  | { kind: "unavailable" }
  /** Not the shell's to answer: the caller's 404 stands. */
  | null;

/**
 * The path the shell matches: the request's path as it came, never decoded,
 * as the page's router reads `location.pathname` (Run 8.0). A percent-encoded
 * form of a page path is therefore not a page, for the API and for the page.
 */
export function shellPathOf(url: string): string {
  return new URL(url).pathname;
}

/** What the shell answers to `method path`. Only GET; only the path table and the manifest. */
export function shellAnswer(method: string, path: string, shell: WebShell | null): ShellAnswer {
  if (method !== "GET") return null;
  const asset = ASSET.exec(path);
  if (asset !== null) {
    if (shell === null) return { kind: "unavailable" };
    const file = shell.files.get(`assets/${asset[1] ?? ""}`);
    if (file === undefined) return null;
    return { kind: "asset", response: answerOf(file.bytes, file.contentType) };
  }
  if (matchWebRoute(path) === null) return null;
  if (shell === null) return { kind: "unavailable" };
  return { kind: "index", response: answerOf(shell.index, "text/html; charset=utf-8") };
}
