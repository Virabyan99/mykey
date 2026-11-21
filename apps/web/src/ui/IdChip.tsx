// An id on the page (the walkthrough's finding b, P-160): the start of it to
// read, the whole of it as text for a screen reader and a search, and a
// button that copies exactly that id and nothing else. A value or a token
// never passes through here: the only thing this copies is the id it was
// given, which is metadata of the address and of the server's lists.
import { useEffect, useState } from "react";
import { Icon } from "./icons.tsx";

/** The workspace's ids are UUIDs; nothing else is offered to this button. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function IdChip(props: {
  /** What the id is of, e.g. "project": the button says "Copy project id". */
  of: string;
  id: string;
  /** The whole id visible, not only its start. */
  full?: boolean;
}) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (said === "") return;
    const timer = setTimeout(() => {
      setSaid("");
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [said]);
  if (!ID.test(props.id)) return null;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.id);
      setSaid("Copied");
    } catch {
      setSaid("Not copied: select the id and copy it by hand");
    }
  };
  return (
    <span className="id-chip">
      {props.full === true ? (
        <span>{props.id}</span>
      ) : (
        <>
          <span aria-hidden="true">{props.id.slice(0, 8)}</span>
          <span className="visually-hidden">{props.id}</span>
        </>
      )}
      <button
        type="button"
        aria-label={`Copy ${props.of} id`}
        title={`Copy the ${props.of} id`}
        onClick={() => {
          void copy();
        }}
      >
        <Icon name={said === "Copied" ? "check" : "copy"} />
      </button>
      <span role="status" className="visually-hidden">
        {said}
      </span>
    </span>
  );
}

/** The whole id, named, with its copy button: for a page's header. */
export function IdLine(props: { of: string; id: string }) {
  const named = `${(props.of[0] ?? "").toUpperCase()}${props.of.slice(1)} id`;
  return (
    <span className="id-line">
      <span className="muted">{named}</span> <IdChip of={props.of} id={props.id} full />
    </span>
  );
}
