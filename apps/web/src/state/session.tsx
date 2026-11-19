// Who the page is, as the server says. The page never decides this itself:
// it asks, and asks again whenever an answer says the session changed.
import { useQuery } from "@tanstack/react-query";
import { getSession, type SessionView } from "../api/auth.ts";
import { failureOf, need } from "../api/client.ts";
import { SESSION_KEY } from "../api/query.ts";
import type { Failure } from "../errors/explain.ts";

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
