// Run 7.1 Task B (P-136, P-140, FR-1.93): one table explains every error code
// of the contract — what happened, the safe next step, the ids. An uncertain
// outcome is never an invitation to send the change again.
import { describe, expect, it } from "vitest";
import { ERROR_CODE_NAMES, type ErrorCode } from "@mykey/contracts";
import { explain, type Failure } from "@mykey/web";

const REQUEST = "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01";
const OPERATION = "0b3a3c1e-9f01-4f43-9a51-6f1c2a1e1d7b";

const api = (code: ErrorCode, extra: Partial<Extract<Failure, { kind: "api" }>> = {}): Failure => ({
  kind: "api",
  status: 400,
  code,
  message: "server text",
  requestId: REQUEST,
  operationId: null,
  details: null,
  retryAfterSeconds: null,
  ...extra,
});

const context = { action: "save the secret" };
const AGAIN = /\bretry\b|try again|send (it|the change) again|resubmit/i;

describe("explain", () => {
  it.each(ERROR_CODE_NAMES)("%s has a title, a text and a next step", (code) => {
    const explained = explain(api(code), context);
    expect(explained.title.length).toBeGreaterThan(3);
    expect(explained.text.length).toBeGreaterThan(10);
    expect(explained.next.length).toBeGreaterThan(5);
    // Never the bare code as the whole explanation.
    expect(explained.title).not.toBe(code);
    expect(explained.text).not.toBe(code);
  });

  it.each(["outcome_unknown", "backend_inconsistent", "key_under_review"] as const)(
    "%s never invites sending the change again",
    (code) => {
      const explained = explain(api(code, { operationId: OPERATION }), context);
      expect(`${explained.title} ${explained.text} ${explained.next}`).not.toMatch(AGAIN);
    },
  );

  it("outcome_unknown says the outcome is not known and points at the operation", () => {
    const explained = explain(api("outcome_unknown", { operationId: OPERATION }), context);
    expect(explained.text).toMatch(/not known|unknown/i);
    expect(explained.next).toMatch(/operation/i);
    expect(explained.ids).toEqual({ requestId: REQUEST, operationId: OPERATION });
  });

  it("rate_limited names the seconds of retry-after, and says so when there are none", () => {
    expect(explain(api("rate_limited", { retryAfterSeconds: 37 }), context).next).toContain(
      "37 seconds",
    );
    expect(explain(api("rate_limited", { retryAfterSeconds: 1 }), context).next).toContain(
      "1 second",
    );
    expect(explain(api("rate_limited"), context).next).toMatch(/minute/);
  });

  it("the ids of the answer are passed through", () => {
    expect(explain(api("version_conflict"), context).ids).toEqual({
      requestId: REQUEST,
      operationId: null,
    });
  });

  it("a transport failure never claims the change failed or succeeded", () => {
    for (const status of [null, 502, 200]) {
      const explained = explain({ kind: "transport", status }, context);
      const all = `${explained.title} ${explained.text} ${explained.next}`;
      expect(all).not.toMatch(/\bfailed\b|was not (saved|made|done)|succeeded|was saved/i);
      expect(all).not.toMatch(AGAIN);
      expect(explained.text).toMatch(/not known|cannot tell|unknown/i);
      expect(explained.ids).toEqual({ requestId: null, operationId: null });
    }
  });

  it("the action is named in the title of a refusal", () => {
    expect(explain(api("action_denied"), context).text).toContain("save the secret");
  });

  it("no explanation holds a code in angle brackets, a stack or the server's message", () => {
    for (const code of ERROR_CODE_NAMES) {
      const explained = explain(api(code, { message: "SERVER-TEXT-MARKER" }), context);
      expect(JSON.stringify(explained)).not.toContain("SERVER-TEXT-MARKER");
    }
  });
});
