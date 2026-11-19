// How the page follows an accepted operation (P-140): after 1 s, 2 s, 4 s,
// then every 5 s, for at most two minutes. Then it stops and a "check again"
// button stays. A state the server will not change by itself stops it at once.

const TOTAL_MS = 120_000;

function schedule(): readonly number[] {
  const delays = [1000, 2000, 4000];
  let total = 7000;
  while (total + 5000 <= TOTAL_MS) {
    delays.push(5000);
    total += 5000;
  }
  return Object.freeze(delays);
}

export const POLL_DELAYS_MS: readonly number[] = schedule();

/** For the page, only work the server is still doing is unfinished. */
export const isTerminal = (state: string): boolean => state !== "accepted" && state !== "executing";

/** The wait before poll number `attempt` (from 0), or null: stop. */
export function nextPollDelay(attempt: number, state: string): number | null {
  if (isTerminal(state)) return null;
  return POLL_DELAYS_MS[attempt] ?? null;
}
