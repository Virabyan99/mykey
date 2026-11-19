// Run 6.2 Task C (P-110): OpenBao's file audit device rotated while requests
// arrive loses no record. A writer sends 400 audited reads, each of a path
// named by its own id, while infra/hosts/checks/bao-audit-rotate.sh runs
// twice. Afterwards every id has exactly one request entry and one response
// entry across the rotated files and the live file; each rotated file ends in
// a complete line; the live file is a new inode. Control first: the same count
// without rotation.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  baoFetch,
  execInService,
  mountKvV2,
  startStack,
  stopStack,
  type Stack,
} from "../../harness/stack.ts";

const SCRIPT = resolve(import.meta.dirname, "../../../infra/hosts/checks/bao-audit-rotate.sh");
const MOUNT = "kv-rotation";

let stack: Stack;
let container: string;

beforeAll(async () => {
  stack = await startStack();
  await mountKvV2(stack, "", MOUNT);
  container = (
    await new Promise<string>((done, fail) => {
      const child = spawn("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${stack.project}`,
        "--filter",
        "label=com.docker.compose.service=openbao",
      ]);
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("error", fail);
      child.on("close", () => {
        done(out);
      });
    })
  ).trim();
}, 600_000);

afterAll(async () => {
  await stopStack(stack.project);
});

function rotate(rotatedDir: string): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn("sh", [SCRIPT], {
      env: {
        ...process.env,
        MSYS_NO_PATHCONV: "1",
        MYKEY_BAO_CONTAINER: container,
        MYKEY_BAO_ROTATED_DIR: rotatedDir.replaceAll("\\", "/"),
      },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) => {
      done({ code, out });
    });
  });
}

/** 400 reads of distinct missing paths, eight at a time; the ids. */
async function writer(count: number, during?: () => Promise<void>): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  let next = 0;
  const work = async () => {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      const answer = await baoFetch(stack, `/v1/${MOUNT}/data/${id ?? ""}`, {});
      await answer.arrayBuffer();
    }
  };
  await Promise.all([...Array.from({ length: 8 }, work), during?.() ?? Promise.resolve()]);
  return ids;
}

/** Request and response entries per id across the given texts. */
function entriesById(texts: readonly string[], ids: readonly string[]): Map<string, string[]> {
  const wanted = new Set(ids);
  const found = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const entry = JSON.parse(line) as { type?: string; request?: { path?: string } };
      const id = entry.request?.path?.split("/").at(-1) ?? "";
      if (wanted.has(id)) found.get(id)?.push(entry.type ?? "");
    }
  }
  return found;
}

const liveText = () => execInService(stack, "openbao", ["cat", "/openbao/audit/audit.log"]);
const inode = async () =>
  (await execInService(stack, "openbao", ["stat", "-c", "%i", "/openbao/audit/audit.log"])).trim();

describe("rotating OpenBao's audit file (P-110)", () => {
  it("control: without rotation, every id has one request and one response entry", async () => {
    const ids = await writer(400);
    const found = entriesById([await liveText()], ids);
    for (const [id, types] of found) expect(types.sort(), id).toEqual(["request", "response"]);
  });

  it("rotated twice under load: every entry exactly once, complete files, a new live inode", async () => {
    const rotatedDir = mkdtempSync(join(tmpdir(), "mykey-bao-rotated-"));
    const before = await inode();
    const runs: { code: number | null; out: string }[] = [];
    const ids = await writer(400, async () => {
      await new Promise((done) => setTimeout(done, 300));
      runs.push(await rotate(rotatedDir));
      runs.push(await rotate(rotatedDir));
    });
    for (const run of runs) expect(run.code, run.out).toBe(0);
    const files = readdirSync(rotatedDir).filter((name) => /^audit-\d{8}T\d{6}Z\.log$/.test(name));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const texts = files.map((name) => readFileSync(join(rotatedDir, name), "utf8"));
    for (const text of texts) {
      expect(text.endsWith("\n")).toBe(true);
      const last = text.trimEnd().split("\n").at(-1) ?? "";
      expect(() => JSON.parse(last) as unknown).not.toThrow();
    }
    const found = entriesById([...texts, await liveText()], ids);
    for (const [id, types] of found) expect(types.sort(), id).toEqual(["request", "response"]);
    expect(await inode()).not.toBe(before);
    // Nothing renamed is left in the container.
    const left = await execInService(stack, "openbao", ["sh", "-c", "ls /openbao/audit"]);
    expect(left.trim().split(/\s+/)).toEqual(["audit.log"]);
  });
});
