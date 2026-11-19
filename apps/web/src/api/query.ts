// The page's cache (P-138): metadata only, in memory only. No persister, no
// retry (a refusal is shown, an uncertain outcome is never sent again), no
// refetch behind the owner's back. Every key but the session's starts with
// the user's id and the organization's, so one account's rows are never read
// for another.
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { forgetSecrets, setFlow, type Notice } from "../state/flow.ts";
import { failureOf } from "./client.ts";

export const SESSION_KEY = ["session"] as const;

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.queryKey[0] === SESSION_KEY[0]) return;
        const failure = failureOf(error);
        if (failure.kind !== "api") return;
        // The server no longer accepts the session: nothing of it stays in the page.
        if (failure.code === "unauthenticated") dropSession(client, "session_ended");
        // The session lost a step (its password was changed elsewhere): ask what it is now.
        if (failure.code === "mfa_incomplete") {
          void client.invalidateQueries({ queryKey: SESSION_KEY });
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        networkMode: "always",
      },
      mutations: { retry: false, networkMode: "always" },
    },
  });
  return client;
}

/**
 * The session is over, by the owner or by the server (P-137): every held
 * secret is forgotten, every cached row is dropped, and the sign-in screen
 * says why it is there.
 */
export function dropSession(client: QueryClient, notice: Notice): void {
  forgetSecrets();
  setFlow({ notice, enrolAfterReset: false });
  client.setQueryData(SESSION_KEY, null);
  forgetData(client);
}

/** Drops everything but the session's own entry: at sign-out and when the account changes. */
export function forgetData(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
}
