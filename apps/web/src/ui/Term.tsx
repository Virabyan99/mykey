// What a word means, one focus away (FR-1.96, P-159). Two forms:
// - `Term`, a word in a sentence: a button that opens a popover with the
//   definition and a link to the article that explains it;
// - `Tip`, the meaning of a state badge: a tooltip that opens on focus and on
//   hover and closes on Escape. It is text only and adds no button, so a row
//   that offers no action still has no button.
// Both are native popovers in the top layer, placed beside what opened them.
// The popover lives at the end of the document (a portal), so the text of the
// row or the heading it explains stays the text it was.
import { webPath } from "@mykey/contracts";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "../router.tsx";

export function Term(props: {
  /** The word as it stands in the sentence. */
  children: ReactNode;
  /** The definition, from copy/glossary.ts. */
  definition: string;
  /** The article that explains it. */
  article: string;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={button} type="button" className="term" popoverTarget={id}>
        {props.children}
      </button>
      {createPortal(
        <div id={id} popover="auto" className="pop" role="note">
          <p>{props.definition}</p>
          <p>
            <Link to={webPath("help-article", { article: props.article })}>Read more</Link>
          </p>
        </div>,
        document.body,
      )}
    </>
  );
}

const HIDE_AFTER_MS = 150;

/** A badge or a word whose meaning shows on focus and on hover. */
export function Tip(props: { children: ReactNode; tip: ReactNode }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (): void => {
    cancel();
    const element = tip.current;
    if (element === null || element.matches(":popover-open")) return;
    if (anchor.current === null) element.showPopover();
    else element.showPopover({ source: anchor.current });
  };
  const hide = (): void => {
    cancel();
    const element = tip.current;
    if (element?.matches(":popover-open") === true) element.hidePopover();
  };
  const hideSoon = (): void => {
    cancel();
    timer.current = setTimeout(hide, HIDE_AFTER_MS);
  };

  // Escape closes it wherever the focus is: a tooltip opened by the pointer has no focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      cancel();
    };
  }, []);

  return (
    <>
      <span
        ref={anchor}
        className="tip-anchor"
        tabIndex={0}
        aria-describedby={id}
        onFocus={show}
        onBlur={hide}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
      >
        {props.children}
      </span>
      {createPortal(
        <div
          ref={tip}
          id={id}
          popover="manual"
          role="tooltip"
          className="pop"
          onMouseEnter={cancel}
          onMouseLeave={hideSoon}
        >
          {props.tip}
        </div>,
        document.body,
      )}
    </>
  );
}
