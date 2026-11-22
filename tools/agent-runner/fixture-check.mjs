// Run 9.3 (P-164): the agent runner's fixed child. The CLI starts it with the
// environment's complete set; it checks that every expected name is present
// and that the SHA-256 of its value equals the digest baked into the image
// (/fixture/digests.json, made at seeding time: digests only, never a value).
// It prints nothing, whatever happens, and exits 0 or 1.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

let ok;
try {
  const expected = JSON.parse(readFileSync("/fixture/digests.json", "utf8"));
  ok =
    Array.isArray(expected) &&
    expected.length > 0 &&
    expected.every((entry) => {
      const value = process.env[entry.name];
      return (
        typeof value === "string" &&
        createHash("sha256").update(value, "utf8").digest("hex") === entry.sha256
      );
    });
} catch {
  ok = false;
}
process.exitCode = ok ? 0 : 1;
