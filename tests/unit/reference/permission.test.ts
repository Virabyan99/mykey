// Run 5.9 (PO-10, "Node permission behavior"): the API image runs
// `node --permission --allow-fs-read=/app …` and reads the reference's asset
// at start. Under the permission model, a grant that covers the asset loads
// it; a grant that does not is a refused read, which loadScalarAsset answers
// with null (the route then answers 503), never a crash of the process.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyReferenceAsset } from "../../../scripts/reference-asset.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const PAGE = pathToFileURL(join(REPO, "apps/api/src/reference/page.ts")).href;
let assets: string;

beforeAll(() => {
  assets = mkdtempSync(join(tmpdir(), "mykey-asset-"));
  copyReferenceAsset(assets);
});

afterAll(() => {
  rmSync(assets, { recursive: true, force: true });
});

/** loadScalarAsset in a child Node under the permission model, with these read grants. */
function loadUnder(grants: string[]): { status: number | null; stdout: string; stderr: string } {
  const program = `const { loadScalarAsset } = await import(${JSON.stringify(PAGE)});
const asset = loadScalarAsset(${JSON.stringify(assets)});
console.log(asset === null ? "null" : "loaded " + asset.version + " " + String(asset.script.length));`;
  const result = spawnSync(
    process.execPath,
    [
      "--permission",
      ...grants.map((grant) => `--allow-fs-read=${grant}`),
      "--input-type=module",
      "--eval",
      program,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

describe("the reference asset under Node's permission model", () => {
  it("a grant that covers the asset loads it", () => {
    const result = loadUnder([join(REPO, "*"), join(assets, "*")]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^loaded 1\.77\.0 \d{7,}$/);
  });

  it("a grant that does not is a refused read: null, and the process goes on", () => {
    const result = loadUnder([join(REPO, "*")]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("null");
  });
});
