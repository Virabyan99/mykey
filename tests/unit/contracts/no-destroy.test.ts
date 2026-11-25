// FR-1.32 (Run 4.4): the product has no interface that destroys a version or
// a key's history. The routes cannot name one, and the runtime client has no
// method for one; the runtime policy's denial of kv/destroy and of metadata
// deletion is proven against real OpenBao by the authority matrix
// (tests/integration/openbao/authority.test.ts, cells kv.destroy and
// kv.delete_metadata).
import { ROUTES } from "@mykey/contracts";
import { OpenBaoClient } from "@mykey/openbao";
import { describe, expect, it } from "vitest";

describe("no destruction interface (FR-1.32)", () => {
  it("no route destroys, purges or deletes metadata", () => {
    // Session 11: `machine.metadata` reads each name's version and times from the
    // index. It carries the word and is the one exception, by id, and only as a
    // GET that takes no body and no query: a read cannot destroy.
    const reads = ROUTES.filter((route) => route.id === "machine.metadata");
    expect(reads.map((route) => [route.method, route.request.body, route.request.query])).toEqual([
      ["GET", undefined, undefined],
    ]);
    const offending = ROUTES.filter(
      (route) =>
        route.id !== "machine.metadata" &&
        /destroy|purge|metadata|erase|wipe/i.test(`${route.id} ${route.path}`),
    ).map((route) => route.id);
    expect(offending).toEqual([]);
    // Control: the soft delete is there.
    expect(ROUTES.some((route) => route.id === "secrets.delete")).toBe(true);
  });

  it("the runtime client has no destroy or metadata-delete method", () => {
    const methods = Object.getOwnPropertyNames(OpenBaoClient.prototype);
    expect(methods.filter((name) => /destroy|deleteMetadata|purge/i.test(name))).toEqual([]);
    // Control: the methods the protocol uses are there.
    expect(methods).toEqual(expect.arrayContaining(["kvWrite", "kvSoftDelete", "kvUndelete"]));
  });
});
