// Run 11.2 (P-185): the shape of the two presented secrets. Both are
// `<prefix>.<credential id>.<43 base64url characters>` (32 random bytes), so a
// client, the pipeline and the scanners tell the kinds apart without a lookup.
// The secrets here are assembled at run time and belong to no credential.
import {
  AUTOMATION_SECRET_PREFIX,
  RUNTIME_SECRET_PREFIX,
  parsePresentedSecret,
} from "@mykey/contracts";
import { describe, expect, it } from "vitest";

const id = "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f";
const secret = "A".repeat(20) + "-_" + "b".repeat(21);

describe("parsePresentedSecret (P-185)", () => {
  it("accepts mkrc.<uuid>.<43> and mkac.<uuid>.<43>", () => {
    expect(RUNTIME_SECRET_PREFIX).toBe("mkrc");
    expect(AUTOMATION_SECRET_PREFIX).toBe("mkac");
    expect(secret).toHaveLength(43);
    expect(parsePresentedSecret(`mkrc.${id}.${secret}`)).toEqual({ prefix: "mkrc", id, secret });
    expect(parsePresentedSecret(`mkac.${id}.${secret}`)).toEqual({ prefix: "mkac", id, secret });
  });

  it("refuses everything else", () => {
    const refused = [
      "",
      `mkrc.${id}.${secret.slice(1)}`, // 42 characters
      `mkrc.${id}.${secret}A`, // 44
      `mkrc.${id.toUpperCase()}.${secret}`,
      `mkxx.${id}.${secret}`,
      `MKRC.${id}.${secret}`,
      `mkrc.${id}.${secret}\n`,
      ` mkrc.${id}.${secret}`,
      `mkrc.${id}.${secret.slice(0, 42)}+`,
      `mkrc.${id}`,
      `mkrc..${secret}`,
      `mkrc.${id}.${secret}.more`,
      // The shape of an OpenBao service token: never one of ours.
      "s." + "x".repeat(24),
      "hvs." + "x".repeat(90),
    ];
    for (const text of refused) expect(parsePresentedSecret(text), JSON.stringify(text)).toBeNull();
  });

  it("a presented secret fits the bearer limit and the CLI's token shape", () => {
    const text = `mkrc.${id}.${secret}`;
    expect(text).toHaveLength(85);
    expect(/^[A-Za-z0-9._-]+$/.test(text)).toBe(true);
  });
});
