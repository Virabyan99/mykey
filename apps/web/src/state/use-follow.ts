// Following something the server is still working on (P-140): the page asks
// again after 1 s, 2 s, 4 s, then every 5 s, for at most two minutes, and
// then stops. What it shows in between is always the last answer, never a
// guess. With nothing to wait for it asks nothing (Review focus 5).
import { useEffect, useRef, useState } from "react";
import { POLL_DELAYS_MS } from "../api/poll.ts";

export interface Follow {
  /** The two minutes are over and the server is still working: the owner may ask again. */
  stopped: boolean;
  again: () => void;
}

export function useFollow(waiting: boolean, ask: () => void): Follow {
  const [attempt, setAttempt] = useState(0);
  const asker = useRef(ask);
  useEffect(() => {
    asker.current = ask;
  });
  // What is being waited for is done: the next wait starts its schedule from the beginning.
  useEffect(() => {
    if (!waiting) setAttempt(0);
  }, [waiting]);

  const delay = waiting ? (POLL_DELAYS_MS[attempt] ?? null) : null;
  useEffect(() => {
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      asker.current();
      setAttempt((count) => count + 1);
    }, delay);
    return () => {
      window.clearTimeout(timer);
    };
  }, [delay, attempt]);

  return {
    stopped: waiting && delay === null,
    again: () => {
      asker.current();
      setAttempt(0);
    },
  };
}

/** States of a project or an environment that the server leaves by itself. */
export const isMoving = (state: string): boolean => state === "pending" || state === "revoking";
