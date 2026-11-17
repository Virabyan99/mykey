// Run 6.5 Task B: the pair fixture's scratch OpenBao. A Raft snapshot of the
// stack's OpenBao, restored into the scratch with snapshot-force, holds what
// the stack held when it was taken, and nothing written after.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baoFetch, mountKvV2, scratchBao, startStack, type Stack } from "../../harness/stack.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ overrides: ["scratch-bao.override.yml"] });
  await mountKvV2(stack, "", "scratchkv");
}, 600_000);

afterAll(async () => {
  await stack.stop();
}, 300_000);

const write = (path: string, value: string) =>
  baoFetch(stack, `/v1/scratchkv/data/${path}`, { method: "POST", body: { data: { value } } });

describe("the scratch OpenBao", () => {
  it("restores a snapshot of the stack's OpenBao twice in a row", async () => {
    const scratch = await scratchBao(stack);
    for (const round of [1, 2]) {
      const before = randomBytes(8).toString("hex");
      expect((await write(`before-${String(round)}`, before)).status).toBe(200);
      const snapshot = await baoFetch(stack, "/v1/sys/storage/raft/snapshot");
      expect(snapshot.status).toBe(200);
      const bytes = new Uint8Array(await snapshot.arrayBuffer());
      expect((await write(`after-${String(round)}`, "later")).status).toBe(200);
      await scratch.restore(bytes);
      const read = await baoFetch(scratch.stack, `/v1/scratchkv/data/before-${String(round)}`);
      expect(read.status, `round ${String(round)}`).toBe(200);
      expect(((await read.json()) as { data: { data: { value: string } } }).data.data.value).toBe(
        before,
      );
      const later = await baoFetch(scratch.stack, `/v1/scratchkv/data/after-${String(round)}`);
      expect(later.status).toBe(404);
    }
  }, 600_000);
});
