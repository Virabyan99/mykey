// The headers of an export (Run 4.9, P-79): a digest of the exact body, a
// safe file name, and the loader warnings as base64url JSON, truncated above
// 8 KiB.
import { exportHeaders, safeFileName } from "@mykey/api";
import { describe, expect, it } from "vitest";

const decode = (header: string | undefined): unknown =>
  JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"));

describe("exportHeaders", () => {
  it("the digest of a fixed input; the fixed headers", () => {
    const headers = exportHeaders("dev", Buffer.from("A=1\n", "utf8"), []);
    expect(headers["content-digest"]).toBe(
      "sha-256=:kdaj1V6f6nkRxTevrmYHx3+ovA86dsN14QSsWoz6hNs=:",
    );
    expect(headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(headers["content-disposition"]).toBe('attachment; filename="mykey-dev.env"');
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(decode(headers["mykey-export-warnings"])).toEqual([]);
  });

  it("a name with spaces, quotes and a line break gives a safe file name", () => {
    expect(safeFileName('My "Prod"\nEnv')).toBe("my--prod--env");
    expect(safeFileName("ÄÖÜ")).toBe("---");
    expect(safeFileName("")).toBe("environment");
    expect(safeFileName("x".repeat(100))).toHaveLength(63);
    const disposition = exportHeaders('a"b\r\nc', new Uint8Array(), [])["content-disposition"];
    expect(disposition).toBe('attachment; filename="mykey-a-b--c.env"');
  });

  it("warnings are listed by name; 300 warnings give the truncated form under 8 KiB", () => {
    const one = exportHeaders("dev", new Uint8Array(), [
      { name: "A", loader: "nextjs", kind: "expansion" },
    ]);
    expect(decode(one["mykey-export-warnings"])).toEqual([
      { name: "A", loader: "nextjs", kind: "expansion" },
    ]);
    const many = Array.from({ length: 300 }, (_, index) => ({
      name: `NAME_${String(index).padStart(40, "0")}`,
      loader: "nextjs",
      kind: "escape",
    }));
    const header = exportHeaders("dev", new Uint8Array(), many)["mykey-export-warnings"] ?? "";
    expect(header.length).toBeLessThanOrEqual(8192);
    expect(decode(header)).toEqual({ truncated: true, count: 300 });
  });
});
