// Run 5.5 Task A (P-96, Doc 04 §7): the CLI's exit codes, the HTTP half of
// the category table, and the one line on stderr.
import { CliError, EXIT, categoryOf, formatError } from "@mykey/cli";
import { describe, expect, it } from "vitest";

describe("the error model", () => {
  it("has exactly the eight exit codes of Doc 04 §7", () => {
    expect(EXIT).toEqual({
      usage: 64,
      malformed: 65,
      unavailable: 69,
      export_target: 73,
      capacity: 75,
      incompatible: 76,
      denied: 77,
      unsupported: 78,
    });
    expect(Object.isFrozen(EXIT)).toBe(true);
  });

  it("maps an HTTP answer to a category", () => {
    const cases: [number, string | null, string][] = [
      [401, "unauthenticated", "denied"],
      [403, "action_denied", "denied"],
      [404, "not_found", "denied"],
      [409, "environment_changed", "unavailable"],
      [409, "key_under_review", "unavailable"],
      [429, "rate_limited", "capacity"],
      [503, "busy", "capacity"],
      [503, "dependency_unavailable", "unavailable"],
      [503, "backend_sealed", "unavailable"],
      [503, "backend_inconsistent", "unavailable"],
      [503, "quarantined", "unavailable"],
      [507, "capacity_exceeded", "capacity"],
      [500, null, "unavailable"],
      [502, null, "unavailable"],
      [418, null, "unavailable"],
      [400, "forbidden_selector", "incompatible"],
      [401, null, "denied"],
    ];
    for (const [status, code, category] of cases) {
      expect(categoryOf(status, code), `${String(status)} ${String(code)}`).toBe(category);
    }
  });

  it("prints one line: none for a local error, both values for a server error", () => {
    const local = new CliError("usage", "no machine token");
    expect(formatError(local)).toBe(
      "secrets: usage: no machine token (code: none, requestId: none)",
    );
    const server = new CliError("denied", "the API refused the token", {
      code: "unauthenticated",
      requestId: "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e70",
    });
    const line = formatError(server);
    expect(line).toBe(
      "secrets: denied: the API refused the token (code: unauthenticated, requestId: 0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e70)",
    );
    expect(line.includes("\n")).toBe(false);
    expect(new CliError("usage", "two\nlines").message.includes("\n")).toBe(false);
  });
});
