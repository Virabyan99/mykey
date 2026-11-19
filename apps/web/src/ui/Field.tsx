// A labelled input (FR-1.96): the label is tied to the control, a hint and
// an error are tied to it by id, and a field that holds a secret is never
// remembered by the browser's form history.
import { useId, type InputHTMLAttributes, type Ref } from "react";

export function Field(
  props: {
    label: string;
    hint?: string;
    /** The field's own error, shown under it and announced. */
    error?: string | null;
    inputRef?: Ref<HTMLInputElement>;
  } & Omit<InputHTMLAttributes<HTMLInputElement>, "id">,
) {
  const { label, hint, error, inputRef, ...input } = props;
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [
    hint === undefined ? null : hintId,
    error === undefined || error === null ? null : errorId,
  ].filter((part) => part !== null);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        {...input}
        id={id}
        ref={inputRef}
        aria-describedby={described.length === 0 ? undefined : described.join(" ")}
        aria-invalid={error === undefined || error === null ? undefined : true}
      />
      {hint === undefined ? null : (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
      {error === undefined || error === null ? null : (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The attributes of a field for a code from an authenticator app. */
export const CODE_INPUT = {
  type: "text",
  inputMode: "numeric",
  autoComplete: "one-time-code",
  autoCapitalize: "off",
  spellCheck: false,
  maxLength: 64,
  required: true,
} as const;
