// Run 3.1 Task C: one envelope builder; the message comes from one table keyed
// by code, never from an exception.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES, errorResponse } from "@mykey/api";
import { ERROR_CODES, ERROR_CODE_NAMES, errorEnvelopeSchema } from "@mykey/contracts";

const REQUEST_ID = "6f1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f";

describe("errorResponse", () => {
  it.each(ERROR_CODE_NAMES.map((code) => [code]))(
    "%s: its status, the envelope, its fixed message, no-store",
    async (code) => {
      const response = errorResponse(code, REQUEST_ID);
      expect(response.status).toBe(ERROR_CODES[code].status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      const body = errorEnvelopeSchema.parse(await response.json());
      expect(body.error).toEqual({ code, message: ERROR_MESSAGES[code], requestId: REQUEST_ID });
    },
  );

  it("every message is a sentence of its own, not a template", () => {
    for (const code of ERROR_CODE_NAMES) {
      expect(ERROR_MESSAGES[code], code).toMatch(/^[A-Z][^{}$]*\.$/);
    }
  });
});

describe("the production entry", () => {
  it("server.ts never sets the test-only dependencies", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../apps/api/src/server.ts"),
      "utf8",
    );
    // AppDeps.test (test routes, stubs, clock) is set by the harness only.
    expect(source).not.toMatch(/\btest\s*:/);
    expect(source).not.toMatch(/deps\.test|\.test\s*=/);
    // Nor does it ever start the auth routes without throttling (Run 3.2).
    expect(source).not.toMatch(/allowUnthrottled/);
  });
});
