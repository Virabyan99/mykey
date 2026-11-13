// Run 3.9 Task A (P-59): list cursors are signed with the cursor-mac ring and
// bound to their route and scope; anything else does not read.
import { describe, expect, it } from "vitest";
import { readCursor, signCursor } from "@mykey/api";

const ring = {
  current: "k2",
  keys: { k1: new Uint8Array(32).fill(7), k2: new Uint8Array(32).fill(9) },
};
const where = { routeId: "projects.list", scope: "org-a", filter: "" };
const cursor = { ...where, lastKey: "0b6c1f7e-0000-4000-8000-000000000001", generation: "12" };

function flip(text: string, index: number): string {
  // Cursors are ASCII (base64url and a dot).
  return `${text.slice(0, index)}${text[index] === "A" ? "B" : "A"}${text.slice(index + 1)}`;
}

describe("list cursors", () => {
  it("round trip", () => {
    expect(readCursor(ring, signCursor(ring, cursor), where)).toEqual({
      lastKey: cursor.lastKey,
      generation: "12",
    });
  });

  it("a changed byte in the payload or the MAC does not read", () => {
    const text = signCursor(ring, cursor);
    const dot = text.indexOf(".");
    expect(readCursor(ring, flip(text, 3), where)).toBeNull();
    expect(readCursor(ring, flip(text, dot + 3), where)).toBeNull();
    expect(readCursor(ring, `${text}x`, where)).toBeNull();
    expect(readCursor(ring, "not-a-cursor", where)).toBeNull();
    expect(readCursor(ring, "", where)).toBeNull();
  });

  it("a cursor of projects.list given to environments.list, or of another scope, does not read", () => {
    const text = signCursor(ring, cursor);
    expect(readCursor(ring, text, { ...where, routeId: "environments.list" })).toBeNull();
    expect(readCursor(ring, text, { ...where, scope: "org-b" })).toBeNull();
    expect(readCursor(ring, text, { ...where, filter: "x" })).toBeNull();
  });

  it("a cursor signed with a retired key still reads while the key is in the ring", () => {
    const old = signCursor({ current: "k1", keys: ring.keys }, cursor);
    expect(readCursor(ring, old, where)).not.toBeNull();
    expect(readCursor({ current: "k2", keys: { k2: ring.keys.k2 } }, old, where)).toBeNull();
  });
});
