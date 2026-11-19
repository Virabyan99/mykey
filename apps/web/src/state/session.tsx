// Who the page is, as the server says. The page never decides this itself:
// it asks, and asks again whenever an answer says the session changed.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { getSession, type SessionView } from "../api/auth.ts";
import { failureOf, need } from "../api/client.ts";
import { SESSION_KEY, dropSession } from "../api/query.ts";
import type { Failure } from "../errors/explain.ts";
import type { Notice } from "./flow.ts";

export type SessionState =
  | { status: "loading" }
  | { status: "error"; failure: Failure; reload: () => void }
  /** No cookie the server accepts. */
  | { status: "none" }
  /** The password only: no workspace yet. */
  | { status: "partial"; session: SessionView }
  | { status: "complete"; session: SessionView };

export function useSession(): SessionState {
  const query = useQuery({
    queryKey: SESSION_KEY,
    queryFn: () => need(getSession()),
    staleTime: Infinity,
  });
  if (query.isPending) return { status: "loading" };
  if (query.isError) {
    return {
      status: "error",
      failure: failureOf(query.error),
      reload: () => void query.refetch(),
    };
  }
  if (query.data === null) return { status: "none" };
  return {
    status: query.data.phase === "mfa_complete" ? "complete" : "partial",
    session: query.data,
  };
}

export interface SessionControl {
  /** Asks the server what the session is now (after every step of signing in). */
  refresh: () => Promise<void>;
  /** The session is over: forget everything and show the sign-in screen with this notice. */
  drop: (notice: Notice) => void;
  /** True when this failure means the session is over; the page has then dropped it. */
  lost: (failure: Failure) => boolean;
}

export function useSessionControl(): SessionControl {
  const client = useQueryClient();
  return useMemo(
    () => ({
      refresh: () => client.invalidateQueries({ queryKey: SESSION_KEY }),
      drop: (notice) => {
        dropSession(client, notice);
      },
      lost: (failure) => {
        if (failure.kind !== "api" || failure.code !== "unauthenticated") return false;
        dropSession(client, "session_ended");
        return true;
      },
    }),
    [client],
  );
}
