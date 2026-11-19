// Run 7.1 Task A (P-134, P-141): the workspace's shell as the API serves it.
// The files are read once into memory; an answer comes from that map and from
// the table of client paths, never from a path of the request on disk.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHELL_HEADERS, loadWebShell, shellAnswer, type WebShell } from "@mykey/api";
import { WEB_ROUTES } from "@mykey/contracts";
import { FIXTURE_DIST as FILES, writeFixtureDist as writeDist } from "../../harness/web-dist.ts";

const directories: string[] = [];
let shell: WebShell;

beforeAll(() => {
  const directory = writeDist();
  directories.push(directory);
  const loaded = loadWebShell(directory);
  if (loaded === null) throw new Error("the fixture dist did not load");
  shell = loaded;
});

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const EXAMPLE: Record<string, string> = {
  org: "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01",
  project: "0b3a3c1e-9f01-4f43-9a51-6f1c2a1e1d7b",
  env: "1d7b6f1c-2a1e-4f43-9a51-9f010b3a3c1e",
  name: "DATABASE_URL",
};
const concrete = (pattern: string): string =>
  pattern.replace(/:([a-z]+)/g, (_all, name: string) => EXAMPLE[name] ?? "x");

describe("loadWebShell", () => {
  it("reads the manifest's files into memory", () => {
    expect(shell.build).toBe("fixture00000");
    expect([...shell.files.keys()].sort()).toEqual([
      "assets/app-AAAA1111.css",
      "assets/app-BBBB2222.js",
    ]);
    expect(Buffer.from(shell.index).toString("utf8")).toBe(FILES["index.html"]!.text);
  });

  it("answers null for a directory that does not exist", () => {
    expect(loadWebShell(join(tmpdir(), "mykey-web-dist-absent"))).toBeNull();
  });

  it("answers null when a file's bytes are not the manifest's", () => {
    const directory = writeDist((files) => {
      files["assets/app-BBBB2222.js"]!.text = "document.title = 'changed';";
    });
    directories.push(directory);
    // The manifest was computed before the change.
    expect(loadWebShell(directory)).toBeNull();
  });

  it("answers null when the manifest names a path outside the directory", () => {
    const directory = writeDist((_files, manifest) => {
      manifest.push({ path: "../package.json" });
    });
    directories.push(directory);
    expect(loadWebShell(directory)).toBeNull();
  });

  it("answers null without an index", () => {
    const directory = writeDist((_files, manifest) => {
      manifest.splice(
        manifest.findIndex((entry) => entry.path === "index.html"),
        1,
      );
    });
    directories.push(directory);
    expect(loadWebShell(directory)).toBeNull();
  });
});

describe("shellAnswer", () => {
  it.each(WEB_ROUTES.map((route) => [route.id, concrete(route.pattern)]))(
    "GET of screen %s answers the index with the shell's headers",
    async (_id, path) => {
      const answer = shellAnswer("GET", path, shell);
      expect(answer?.kind).toBe("index");
      if (answer?.kind !== "index") return;
      expect(answer.response.status).toBe(200);
      expect(answer.response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      for (const [name, value] of Object.entries(SHELL_HEADERS)) {
        expect(answer.response.headers.get(name), name).toBe(value);
      }
      expect(await answer.response.text()).toBe(FILES["index.html"]!.text);
    },
  );

  it("an asset of the manifest answers its bytes and its content type", async () => {
    const answer = shellAnswer("GET", "/assets/app-BBBB2222.js", shell);
    expect(answer?.kind).toBe("asset");
    if (answer?.kind !== "asset") return;
    expect(answer.response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(answer.response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await answer.response.text()).toBe(FILES["assets/app-BBBB2222.js"]!.text);
    const css = shellAnswer("GET", "/assets/app-AAAA1111.css", shell);
    expect(css?.kind === "asset" && css.response.headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
  });

  it.each([
    "/assets/unknown.js",
    "/assets/../package.json",
    "/assets/%2e%2e/package.json",
    "/assets/..%2fpackage.json",
    "/assets/",
    "/assets",
    "/assets/app-BBBB2222.js/",
    "/assets/sub/app-BBBB2222.js",
    "/index.html",
    "/manifest.json",
    "/metrics",
    "/debug",
    "/status",
    "/dashboard/",
    "/v1/anything",
    "/favicon.ico",
  ])("%s is not the shell's to answer", (path) => {
    expect(shellAnswer("GET", path, shell)).toBeNull();
  });

  it("only GET is answered", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(shellAnswer(method, "/", shell), method).toBeNull();
      expect(shellAnswer(method, "/assets/app-BBBB2222.js", shell), method).toBeNull();
    }
  });

  it("without a loaded shell its paths are unavailable, and every other path is still not its own", () => {
    expect(shellAnswer("GET", "/", null)).toEqual({ kind: "unavailable" });
    expect(shellAnswer("GET", "/sign-in", null)).toEqual({ kind: "unavailable" });
    expect(shellAnswer("GET", "/assets/app-BBBB2222.js", null)).toEqual({ kind: "unavailable" });
    expect(shellAnswer("GET", "/metrics", null)).toBeNull();
    expect(shellAnswer("POST", "/", null)).toBeNull();
  });

  it("the policy allows this origin's scripts and styles and nothing else", () => {
    const policy = SHELL_HEADERS["content-security-policy"];
    expect(policy).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(policy).not.toMatch(/unsafe|https?:|\*/);
    expect(SHELL_HEADERS["referrer-policy"]).toBe("no-referrer");
    expect(SHELL_HEADERS["x-frame-options"]).toBe("DENY");
  });
});
