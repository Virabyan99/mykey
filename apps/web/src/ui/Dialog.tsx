// The confirmation of an action that ends or reopens something (FR-1.17,
// FR-1.96). Its text is fixed and names the thing; the action's button works
// only after the thing's name was typed exactly. A native modal dialog: the
// browser keeps the focus inside it and gives it back on close. It is closed
// in a layout effect: that runs while the dialog is still in the document,
// and a dialog removed while open gives the focus to nobody.
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Field } from "./Field.tsx";

export function ConfirmDialog(props: {
  title: string;
  /** The name that must be typed. */
  name: string;
  /** The action's button, e.g. "Archive". */
  confirm: string;
  busy: boolean;
  /** True while what the dialog must show first is still being read. */
  blocked?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** The fixed text, the facts, and a failure when there is one. */
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [typed, setTyped] = useState("");

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    return () => {
      if (element?.open === true) element.close();
    };
  }, []);

  const ready = typed === props.name && !props.busy && props.blocked !== true;
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ready) props.onConfirm();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id={title}>{props.title}</h2>
      {props.children}
      <form method="dialog" onSubmit={submit}>
        <Field
          label="Type the name to confirm"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          hint={`The name is: ${props.name}`}
        />
        <div className="actions">
          <button type="submit" className="danger" disabled={!ready}>
            {props.confirm}
          </button>
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
