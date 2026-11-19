// The words and shapes of every state the contract can send (FR-1.96,
// Doc 04 §11.2). A state is shown by its word and a shape; colour only
// repeats what they say. A state this page does not know is shown as unknown.
import type {
  CREDENTIAL_STATES,
  INDEX_STATES,
  OPERATION_STATES,
  ORGANIZATION_STATES,
  RESOURCE_STATES,
} from "@mykey/contracts";

export type Shape = "dot" | "ring" | "square" | "triangle" | "cross" | "dash";
export type Tone = "ok" | "wait" | "warn" | "off";
export interface StateLabel {
  text: string;
  shape: Shape;
  tone: Tone;
}

const label = (text: string, shape: Shape, tone: Tone): StateLabel => ({ text, shape, tone });

export const STATE_LABELS = {
  resource: {
    pending: label("pending", "ring", "wait"),
    active: label("active", "dot", "ok"),
    revoking: label("revoking", "ring", "wait"),
    archived: label("archived", "dash", "off"),
    needs_review: label("needs review", "triangle", "warn"),
  } satisfies Record<(typeof RESOURCE_STATES)[number], StateLabel>,
  index: {
    live: label("live", "dot", "ok"),
    deleted: label("deleted", "dash", "off"),
    needs_review: label("needs review", "triangle", "warn"),
  } satisfies Record<(typeof INDEX_STATES)[number], StateLabel>,
  credential: {
    issuing: label("issuing", "ring", "wait"),
    active: label("active", "dot", "ok"),
    revoking: label("revoking", "ring", "wait"),
    revoked: label("revoked", "cross", "off"),
    expired: label("expired", "dash", "off"),
    needs_review: label("needs review", "triangle", "warn"),
  } satisfies Record<(typeof CREDENTIAL_STATES)[number], StateLabel>,
  operation: {
    accepted: label("accepted", "ring", "wait"),
    executing: label("executing", "ring", "wait"),
    awaiting_input: label("awaiting input", "square", "warn"),
    uncertain: label("uncertain", "triangle", "warn"),
    succeeded: label("succeeded", "dot", "ok"),
    partial: label("partial", "square", "warn"),
    rejected: label("rejected", "cross", "off"),
  } satisfies Record<(typeof OPERATION_STATES)[number], StateLabel>,
  organization: {
    provisioning: label("provisioning", "ring", "wait"),
    active: label("active", "dot", "ok"),
    failed: label("failed", "cross", "warn"),
    needs_review: label("needs review", "triangle", "warn"),
  } satisfies Record<(typeof ORGANIZATION_STATES)[number], StateLabel>,
} as const;

export type StateKind = keyof typeof STATE_LABELS;

export function stateLabel(kind: StateKind, state: string): StateLabel {
  const known = (STATE_LABELS[kind] as Record<string, StateLabel | undefined>)[state];
  return known ?? label(`unknown (${state})`, "triangle", "warn");
}
