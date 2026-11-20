// The step-up dialog (FR-1.07): some actions need a code from the last ten
// minutes, and the server says so with 403 fresh_verification_required. The
// dialog only proves the owner is here. It never sends the refused action
// again: the owner does, with the same button as before.
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { stepUp } from "../api/auth.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { CODE_INPUT, Field } from "./Field.tsx";

export function StepUp(props: {
  open: boolean;
  /** What the code is for, e.g. "change the password". */
  action: string;
  onDone: (confirmed: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const code = useRef<HTMLInputElement>(null);
  const title = useId();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (props.open && !element.open) {
      setRefused(false);
      setFailure(null);
      element.showModal();
    }
    if (!props.open && element.open) element.close();
  }, [props.open]);

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const input = code.current;
    if (input === null || busy) return;
    setBusy(true);
    const result = await stepUp(input.value.trim());
    input.value = "";
    setBusy(false);
    if (result.ok) {
      props.onDone(true);
      return;
    }
    // A wrong, a used and an expired code are one answer.
    if (result.failure.kind === "api" && result.failure.code === "unauthenticated") {
      setRefused(true);
      setFailure(null);
      input.focus();
      return;
    }
    setRefused(false);
    setFailure(result.failure);
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        props.onDone(false);
      }}
    >
      <h2 id={title}>Confirm with your authenticator</h2>
      <p>
        To {props.action}, enter a new code from your authenticator app. A recovery code does not
        work here.
      </p>
      <form
        method="dialog"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Field
          label="Code from your authenticator app"
          inputRef={code}
          {...CODE_INPUT}
          error={
            refused ? "That code was not accepted. A code works once: use the next one." : null
          }
        />
        {failure === null ? null : <ErrorPanel failure={failure} action={props.action} />}
        <div className="actions">
          <button type="submit" disabled={busy}>
            Confirm
          </button>
          <button
            type="button"
            onClick={() => {
              props.onDone(false);
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
