// Run 9.0: the candidate and the manifest of a session live in that session's
// evidence folder. Session 8's stay as they were; Session 9 passes --session 9.
import { describe, expect, it } from "vitest";
import { evidenceSession } from "../../../scripts/release-candidate.ts";

describe("--session", () => {
  it("is Session 8's folder by default, and the given session's with --session", () => {
    expect(evidenceSession([])).toBe("docs/evidence/session-8");
    expect(evidenceSession(["--release", "x", "--session", "9"])).toBe("docs/evidence/session-9");
  });

  it("refuses anything but a session number", () => {
    expect(() => evidenceSession(["--session"])).toThrow(/--session/);
    expect(() => evidenceSession(["--session", "../8"])).toThrow(/--session/);
    expect(() => evidenceSession(["--session", "9a"])).toThrow(/--session/);
  });
});
