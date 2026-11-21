// A request from one part of the frame to a screen (Run 9.0): "open the new
// project form" from the sidebar, "open the palette" from the top bar. It is
// a word in memory, taken once by the screen that answers it; nothing is
// kept beyond the page's life and nothing of the owner's data travels here.
export type Intent = "new-project";

let pending: Intent | null = null;
const listeners = new Set<() => void>();

export function ask(intent: Intent): void {
  pending = intent;
  for (const listener of listeners) listener();
}

/** The intent if it is this one, taken (asked again only by a new `ask`). */
export function take(intent: Intent): boolean {
  if (pending !== intent) return false;
  pending = null;
  return true;
}

export function onIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
