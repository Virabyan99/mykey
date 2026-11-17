// Run 6.9 Task A (P-127): our three images carry no package manager. The
// node base image ships npm, npx and corepack; each final stage removes them
// (buildRelease then proves it on the built image with `--entrypoint ls`).
// Each runs as 1000:1000; compose and ops-run.sh add a read-only root.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TOOLS = [
  "/usr/local/bin/npm",
  "/usr/local/bin/npx",
  "/usr/local/bin/corepack",
  "/usr/local/lib/node_modules/npm",
  "/usr/local/lib/node_modules/corepack",
];

function finalStage(name: string): string {
  const text = readFileSync(`apps/${name}/Dockerfile`, "utf8");
  return text.slice(text.lastIndexOf("\nFROM "));
}

describe("our images (P-127)", () => {
  for (const name of ["api", "provisioner", "ops"]) {
    it(`${name}: the final stage removes npm, npx and corepack and runs as 1000:1000`, () => {
      const stage = finalStage(name);
      const removal = /RUN rm -rf ([^\n]+)/.exec(stage)?.[1] ?? "";
      for (const tool of TOOLS) expect(removal.split(/\s+/), tool).toContain(tool);
      expect(stage).toMatch(/\nUSER 1000:1000\n/);
      expect(stage.indexOf("RUN rm -rf")).toBeLessThan(stage.indexOf("USER 1000:1000"));
    });
  }

  it("compose runs api and provisioner read-only; ops-run.sh runs ops read-only as 1000:1000", () => {
    const compose = readFileSync("infra/compose/host.compose.yml", "utf8");
    expect(compose).toMatch(/x-hardening: &hardening\n {2}read_only: true/);
    for (const service of ["api", "provisioner"]) {
      expect(compose).toMatch(new RegExp(`\\n  ${service}:\\n    <<: \\*hardening\\n`));
    }
    const run = readFileSync("infra/hosts/ops-run.sh", "utf8");
    expect(run).toMatch(/--read-only/);
    expect(run).toMatch(/--user 1000:1000/);
  });
});
