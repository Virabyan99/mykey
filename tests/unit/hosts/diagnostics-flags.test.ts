// Run 6.1 Task C (P-109, FR-1.80): no diagnostic surface that can dump a
// process's memory. The images' entrypoints and the compose files carry none
// of Node's inspector, heap-snapshot, report or profiler flags, and every
// service of the host's compose file runs with core dumps off.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FORBIDDEN =
  /--inspect|--heapsnapshot-signal|--heap-prof|--cpu-prof|--report-on-fatalerror|--report-uncaught-exception|--report-on-signal|NODE_OPTIONS/;

const DOCKERFILES = readdirSync(join(ROOT, "apps"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("apps", entry.name, "Dockerfile"))
  .filter((path) => {
    try {
      readFileSync(join(ROOT, path));
      return true;
    } catch {
      return false;
    }
  });

const COMPOSE = ["infra/compose/host.compose.yml", "infra/compose/dev.compose.yml"];

/** The services of a compose file: name → its block of lines. */
function services(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "services:");
  const blocks = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const header = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (header !== null) {
      if (name !== null) blocks.set(name, body.join("\n"));
      name = header[1] ?? null;
      body = [];
    } else if (name !== null) {
      body.push(line);
    }
  }
  if (name !== null) blocks.set(name, body.join("\n"));
  return blocks;
}

describe("diagnostic flags (P-109)", () => {
  it("the images of the API, the provisioner and ops have entrypoints without diagnostic flags", () => {
    expect(DOCKERFILES).toContain(join("apps", "api", "Dockerfile"));
    expect(DOCKERFILES).toContain(join("apps", "provisioner", "Dockerfile"));
    for (const path of DOCKERFILES) {
      const text = readFileSync(join(ROOT, path), "utf8");
      expect(text, path).toMatch(/ENTRYPOINT/);
      expect(FORBIDDEN.exec(text)?.[0] ?? null, path).toBeNull();
    }
  });

  it("no compose file sets a diagnostic flag", () => {
    for (const path of COMPOSE) {
      const text = readFileSync(join(ROOT, path), "utf8");
      expect(FORBIDDEN.exec(text)?.[0] ?? null, path).toBeNull();
    }
  });

  it("every service of the host's compose file runs with ulimits core 0", () => {
    const blocks = services(readFileSync(join(ROOT, "infra/compose/host.compose.yml"), "utf8"));
    expect([...blocks.keys()]).toEqual(
      expect.arrayContaining(["postgres", "api", "openbao", "provisioner", "edge"]),
    );
    const without = [...blocks.entries()]
      .filter(([, block]) => !/\n {4}ulimits:\n {6}core: 0(\n|$)/.test(`\n${block}`))
      .map(([name]) => name);
    expect(without).toEqual([]);
  });

  it("control: the search finds a flag where one is written", () => {
    expect(FORBIDDEN.test('ENTRYPOINT ["node", "--inspect=0.0.0.0", "x.ts"]')).toBe(true);
    const blocks = services("services:\n  a:\n    image: x\n  b:\n    ulimits:\n      core: 0\n");
    expect([...blocks.keys()]).toEqual(["a", "b"]);
  });
});
