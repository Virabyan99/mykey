// What one screen has to tell the next, kept in the page's memory only and
// gone with a reload: why the sign-in screen is showing, that a reset has
// just handed over to enrolment, and the signal that makes every holder of
// a secret forget.
import { useSyncExternalStore } from "react";

export type Notice =
  /** The server ended the session, or no longer accepts it. */
  | "session_ended"
  | "signed_out"
  /** A reset link set a new password: sign in with it. */
  | "password_reset";

interface Flow {
  notice: Notice | null;
  /**
   * A reset link of kind `mfa` was completed in this page: its session can
   * enrol and nothing else, and the server does not show it as a session.
   */
  enrolAfterReset: boolean;
}

let flow: Flow = { notice: null, enrolAfterReset: false };
const listeners = new Set<() => void>();

export function setFlow(change: Partial<Flow>): void {
  flow = { ...flow, ...change };
  for (const listener of listeners) listener();
}

export function useFlow(): Flow {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => flow,
  );
}

const forgetters = new Set<() => void>();

/** Called by every holder of a secret (use-ephemeral.ts). */
export function onForget(listener: () => void): () => void {
  forgetters.add(listener);
  return () => forgetters.delete(listener);
}

/** Sign-out, or a session the server ended: every held secret goes now. */
export function forgetSecrets(): void {
  for (const listener of forgetters) listener();
}
