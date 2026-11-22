// The page's addresses are the paths of WEB_ROUTES (the API serves the shell
// on exactly those). An address holds ids and a secret's name, never a value,
// a token or a code. No router library: the History API and one subscription.
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/** Told of every change of address: a link, `navigate`, back and forward. */
export const onNavigate = subscribe;

/** The path of the address bar; a component that reads it renders again when it changes. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return;
  if (options.replace === true) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

export function Link(props: {
  to: string;
  current?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
    // A new tab or window is the browser's business.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(props.to);
  };
  return (
    <a
      href={props.to}
      onClick={follow}
      className={props.className}
      aria-current={props.current === true ? "page" : undefined}
    >
      {props.children}
    </a>
  );
}
