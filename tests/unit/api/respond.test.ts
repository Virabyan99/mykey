// Run 3.1 Task C: one envelope builder; the message comes from one table keyed
// by code, never from an exception.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES, checkDetails, errorResponse } from "@mykey/api";
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

// Run 4.1 Task B: the operation id and the allowlisted details of an error.
describe("errorResponse with an operation id and details", () => {
  const OPERATION_ID = "7a1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f";

  it("the operation id appears in the envelope", async () => {
    const response = errorResponse("outcome_unknown", REQUEST_ID, undefined, {
      operationId: OPERATION_ID,
    });
    const body = errorEnvelopeSchema.parse(await response.json());
    expect(body.error.operationId).toBe(OPERATION_ID);
    expect(body.error.details).toBeUndefined();
  });

  it("version_conflict details pass their schema", async () => {
    const details = { currentVersion: 3, currentStateTag: "abc", state: "live" };
    const response = errorResponse("version_conflict", REQUEST_ID, undefined, { details });
    const body = errorEnvelopeSchema.parse(await response.json());
    expect(body.error.details).toEqual(details);
  });

  it("a detail key outside the allowlist is dropped", async () => {
    const response = errorResponse("capacity_exceeded", REQUEST_ID, undefined, {
      details: { limit: "bytes", value: "leak" },
    });
    const body = errorEnvelopeSchema.parse(await response.json());
    expect(body.error.details).toEqual({ limit: "bytes" });
  });

  it("details that do not match their schema are dropped, and checkDetails says so", async () => {
    const response = errorResponse("version_conflict", REQUEST_ID, undefined, {
      details: { currentVersion: "3" },
    });
    const body = errorEnvelopeSchema.parse(await response.json());
    expect(body.error.details).toBeUndefined();
    expect(checkDetails("version_conflict", { currentVersion: "3" }).valid).toBe(false);
  });

  it("details on a code that takes none are dropped", async () => {
    const response = errorResponse("busy", REQUEST_ID, undefined, { details: { limit: "names" } });
    const body = errorEnvelopeSchema.parse(await response.json());
    expect(body.error.details).toBeUndefined();
    expect(checkDetails("busy", { limit: "names" }).valid).toBe(false);
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
