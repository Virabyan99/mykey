// The actions of one row (D-70): a button that opens a native popover menu.
// Arrow keys move between the items, Home and End go to the ends, Escape
// closes and gives the focus back to the button. A row with no action shows
// no menu at all, so it offers no button. The menu itself lives at the end of
// the document (a portal): the row's text stays the row's.
import { useId, useRef, type KeyboardEvent, type ToggleEvent } from "react";
import { createPortal } from "react-dom";
import { navigate } from "../router.tsx";
import { Icon } from "./icons.tsx";

export type MenuItem =
  | { label: string; to: string; danger?: boolean }
  | { label: string; onSelect: () => void; danger?: boolean };

export function Menu(props: {
  /** The button's accessible name, e.g. "Actions for API_KEY". */
  label: string;
  items: readonly MenuItem[];
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  if (props.items.length === 0) return null;

  const entries = (): HTMLElement[] =>
    Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const onToggle = (event: ToggleEvent<HTMLDivElement>): void => {
    if (event.newState === "open") entries()[0]?.focus();
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (index: number): void => {
      event.preventDefault();
      all[(index + all.length) % all.length]?.focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(all.length - 1);
  };

  const choose = (item: MenuItem): void => {
    list.current?.hidePopover();
    if ("to" in item) navigate(item.to);
    else item.onSelect();
  };

  return (
    <>
      <button
        type="button"
        className="quiet small"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={props.label}
        title={props.label}
      >
        <Icon name="ellipsis" />
      </button>
      {createPortal(
        <div
          ref={list}
          id={id}
          popover="auto"
          className="menu"
          role="menu"
          aria-label={props.label}
          onToggle={onToggle}
          onKeyDown={onKey}
        >
          {props.items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={item.danger === true ? "danger-text" : undefined}
              onClick={() => {
                choose(item);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
