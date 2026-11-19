// An action that ends or replaces something asks twice (FR-1.96): the first
// press shows what will happen, the second does it. Nothing is sent before
// the second press.
import { useState } from "react";

export function ConfirmButton(props: {
  label: string;
  /** What the second button says, e.g. "Yes, end every session". */
  confirm: string;
  /** What will happen, in one sentence. */
  warning: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => {
          setAsking(true);
        }}
      >
        {props.label}
      </button>
    );
  }
  return (
    <div className="confirm" role="group" aria-label={props.label}>
      <p>{props.warning}</p>
      <div className="actions">
        <button
          type="button"
          className="danger"
          disabled={props.disabled}
          onClick={() => {
            setAsking(false);
            props.onConfirm();
          }}
        >
          {props.confirm}
        </button>
        <button
          type="button"
          onClick={() => {
            setAsking(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
