// A reset link is `/reset#t=<token>&k=<kind>` (P-137). The fragment never
// reaches a server. Before the page renders anything, the fragment is taken
// out of the address bar and out of this history entry; the token then lives
// in memory until the reset screen takes it into its forgetting holder.

export interface ResetLink {
  token: string;
  kind: "password" | "mfa";
}

let captured: ResetLink | null = null;

/** Called first in main.tsx. */
export function captureResetLink(): void {
  if (window.location.pathname !== "/reset" || window.location.hash === "") return;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  window.history.replaceState(null, "", "/reset");
  const token = fragment.get("t");
  const kind = fragment.get("k");
  if (
    token !== null &&
    /^[A-Za-z0-9_-]{43}$/.test(token) &&
    (kind === "password" || kind === "mfa")
  ) {
    captured = { token, kind };
  }
}

/** The captured link, once. */
export function takeResetLink(): ResetLink | null {
  const taken = captured;
  captured = null;
  return taken;
}
