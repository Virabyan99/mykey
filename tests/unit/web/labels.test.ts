// Run 7.1 Task B (FR-1.96, Doc 04 §11.2): status is never colour alone. Every
// state the contract can send has a word and a shape.
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_STATES,
  INDEX_STATES,
  OPERATION_STATES,
  ORGANIZATION_STATES,
  RESOURCE_STATES,
} from "@mykey/contracts";
import { STATE_LABELS, stateLabel } from "@mykey/web";

const KINDS = {
  resource: RESOURCE_STATES,
  index: INDEX_STATES,
  credential: CREDENTIAL_STATES,
  operation: OPERATION_STATES,
  organization: ORGANIZATION_STATES,
} as const;

describe("state labels", () => {
  for (const [kind, states] of Object.entries(KINDS)) {
    it.each([...states])(`${kind} state %s has a word and a shape`, (state) => {
      const label = stateLabel(kind as keyof typeof KINDS, state);
      expect(label.text.length).toBeGreaterThan(2);
      expect(["dot", "ring", "square", "triangle", "cross", "dash"]).toContain(label.shape);
      expect(["ok", "wait", "warn", "off"]).toContain(label.tone);
    });

    it(`${kind} has no label for a state the contract does not have`, () => {
      expect(Object.keys(STATE_LABELS[kind as keyof typeof KINDS]).sort()).toEqual(
        [...states].sort(),
      );
    });
  }

  it("a state the page does not know is shown as unknown, never as fine", () => {
    const label = stateLabel("resource", "something_new");
    expect(label.text).toBe("unknown (something_new)");
    expect(label.tone).toBe("warn");
  });

  it("uncertain is never worded as failed, and partial never as done", () => {
    expect(stateLabel("operation", "uncertain").text).toMatch(/uncertain/i);
    expect(stateLabel("operation", "uncertain").text).not.toMatch(/fail/i);
    expect(stateLabel("operation", "partial").text).toMatch(/partial/i);
    expect(stateLabel("operation", "partial").tone).not.toBe("ok");
    expect(stateLabel("operation", "accepted").tone).toBe("wait");
  });
});
