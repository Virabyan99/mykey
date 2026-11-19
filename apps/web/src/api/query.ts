// The page's cache (P-138): metadata only, in memory only. No persister, no
// retry (a refusal is shown, an uncertain outcome is never sent again), no
// refetch behind the owner's back. Every key but the session's starts with
// the user's id and the organization's, so one account's rows are never read
// for another.
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { failureOf } from "./client.ts";

export const SESSION_KEY = ["session"] as const;

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.queryKey[0] === SESSION_KEY[0]) return;
        const failure = failureOf(error);
        // The session ended or lost a step: ask the server what it is now.
        if (
          failure.kind === "api" &&
          (failure.code === "unauthenticated" || failure.code === "mfa_incomplete")
        ) {
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

/** Drops everything but the session's own entry: at sign-out and when the account changes. */
export function forgetData(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
}
