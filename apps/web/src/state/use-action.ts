// One change sent to the server, and what the screen may say about it
// (P-140). The screen shows the server's answer and nothing before it: no
// optimistic result. The idempotency key belongs to the decision: the same
// request sent again after no usable answer carries the same key, so the
// server answers what it already did; a different request, or a request
// after a definite answer, gets a new one.
import { useCallback, useRef, useState } from "react";
import type { CallResult } from "../api/client.ts";
import type { Failure } from "../errors/explain.ts";
import { useSessionControl } from "./session.tsx";

/** No usable answer, a failure of the service, or a request not finished: whether the change happened is open. */
const open = (failure: Failure): boolean => failure.kind !== "api" || failure.status >= 500;

const operationOf = (body: unknown): string | null => {
  const id = (body as { operationId?: unknown } | null)?.operationId;
  return typeof id === "string" ? id : null;
};

export interface Action {
  busy: boolean;
  failure: Failure | null;
  /**
   * Sends one change. `print` describes the request (route and input, never
   * a secret value): the key is kept while it stays the same.
   */
  run: <T>(
    print: string,
    send: (key: string) => Promise<CallResult<T>>,
    /**
     * A 202 means the server has not finished. By default that is shown as
     * "not finished yet" and the caller gets no success. A screen that prints
     * the state the answer carries takes the 202 itself.
     */
    options?: { unfinished: "caller" },
  ) => Promise<CallResult<T>>;
  /** Forgets the failure shown (the form was changed or closed). */
  clear: () => void;
}

export function useAction(): Action {
  const control = useSessionControl();
  const key = useRef<{ print: string; key: string } | null>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const run = useCallback(
    async <T>(
      print: string,
      send: (key: string) => Promise<CallResult<T>>,
      options?: { unfinished: "caller" },
    ): Promise<CallResult<T>> => {
      if (running.current) return { ok: false, failure: { kind: "transport", status: null } };
      running.current = true;
      setBusy(true);
      if (key.current?.print !== print) key.current = { print, key: crypto.randomUUID() };
      const result = await send(key.current.key);
      running.current = false;
      setBusy(false);
      if (result.ok && result.status === 202 && options?.unfinished !== "caller") {
        // Not done: the key stays, so the same request sent again is answered, not done twice.
        const unfinished: Failure = {
          kind: "unfinished",
          requestId: result.requestId,
          operationId: operationOf(result.body),
        };
        setFailure(unfinished);
        return { ok: false, failure: unfinished };
      }
      if (result.ok) {
        key.current = null;
        setFailure(null);
        return result;
      }
      if (!open(result.failure)) key.current = null;
      // An ended session: the page forgets everything and shows the sign-in screen.
      if (!control.lost(result.failure)) setFailure(result.failure);
      return result;
    },
    [control],
  );
  const clear = useCallback(() => {
    setFailure(null);
  }, []);
  return { busy, failure, run, clear };
}

export const isCode = (failure: Failure | null, code: string): boolean =>
  failure?.kind === "api" && failure.code === code;
