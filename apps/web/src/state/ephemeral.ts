// The rules of the one holder of everything secret the page shows (P-138):
// a revealed value, a one-time token, a TOTP key, recovery codes, a reset
// token. A pure function, so the rules can be read and tested whole. The
// hook around it is use-ephemeral.ts.

export const EPHEMERAL_TTL_MS = 30_000;

export interface Held<T> {
  value: T | null;
  /** Epoch milliseconds, or null when nothing is held. */
  expiresAt: number | null;
}

export const EMPTY_HOLD: Held<never> = Object.freeze({ value: null, expiresAt: null });

export type HoldEvent<T> =
  | { type: "set"; value: T; now: number }
  | { type: "tick"; now: number }
  /** The tab is no longer visible. */
  | { type: "hidden" }
  /** The address changed, by a link or by back and forward. */
  | { type: "navigated" }
  | { type: "signed_out" }
  | { type: "clear" };

export interface HoldRules {
  ttlMs: number;
  /**
   * False only where the owner has to leave the tab to use the value: the
   * TOTP key goes into an authenticator, recovery codes into a safe place.
   */
  clearOnHide: boolean;
}

export function hold<T>(state: Held<T>, event: HoldEvent<T>, rules: HoldRules): Held<T> {
  if (event.type === "set") return { value: event.value, expiresAt: event.now + rules.ttlMs };
  if (state.expiresAt === null) return state;
  if (event.type === "tick") return event.now >= state.expiresAt ? EMPTY_HOLD : state;
  if (event.type === "hidden") return rules.clearOnHide ? EMPTY_HOLD : state;
  return EMPTY_HOLD;
}
