// The one holder of everything secret the page shows (P-138, D-60). The rules
// are in ephemeral.ts; this hook gives them the clock, the tab's visibility,
// the address and the sign-out signal. A value held here is in this
// component's memory and nowhere else: not in the query cache, not in a
// store, not in the address, not in the history entry.
import { useCallback, useEffect, useReducer } from "react";
import { onNavigate } from "../router.tsx";
import { EMPTY_HOLD, EPHEMERAL_TTL_MS, hold, type Held, type HoldEvent } from "./ephemeral.ts";
import { onForget } from "./flow.ts";

export function useEphemeral<T>(
  ttlMs: number = EPHEMERAL_TTL_MS,
  options: { clearOnHide?: boolean } = {},
): readonly [value: T | null, set: (value: T) => void, clear: () => void] {
  const clearOnHide = options.clearOnHide ?? true;
  const [state, dispatch] = useReducer(
    (current: Held<T>, event: HoldEvent<T>) => hold(current, event, { ttlMs, clearOnHide }),
    EMPTY_HOLD as Held<T>,
  );

  const { expiresAt } = state;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setTimeout(
      () => {
        // A timer may fire a moment early: the time that counts is the one that was set.
        dispatch({ type: "tick", now: Math.max(Date.now(), expiresAt) });
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [expiresAt]);

  useEffect(() => {
    const hidden = (): void => {
      if (document.visibilityState === "hidden") dispatch({ type: "hidden" });
    };
    document.addEventListener("visibilitychange", hidden);
    const offNavigate = onNavigate(() => {
      dispatch({ type: "navigated" });
    });
    const offForget = onForget(() => {
      dispatch({ type: "signed_out" });
    });
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      offNavigate();
      offForget();
    };
  }, []);

  const set = useCallback((value: T): void => {
    dispatch({ type: "set", value, now: Date.now() });
  }, []);
  const clear = useCallback((): void => {
    dispatch({ type: "clear" });
  }, []);
  return [state.value, set, clear];
}
