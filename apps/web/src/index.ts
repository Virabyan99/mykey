// The workspace's modules that need no browser: the unit tests read them
// here. The application itself starts in main.tsx and is built by build.ts.
export { explain, type Explanation, type Failure } from "./errors/explain.ts";
export {
  STATE_LABELS,
  stateLabel,
  type Shape,
  type StateKind,
  type StateLabel,
  type Tone,
} from "./labels.ts";
export { POLL_DELAYS_MS, isTerminal, nextPollDelay } from "./api/poll.ts";
export {
  EMPTY_HOLD,
  EPHEMERAL_TTL_MS,
  hold,
  type Held,
  type HoldEvent,
  type HoldRules,
} from "./state/ephemeral.ts";
