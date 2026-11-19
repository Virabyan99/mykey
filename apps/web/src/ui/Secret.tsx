// How a secret is put on the screen while its holder has it (P-138): as
// text the owner can read and select, with an explicit copy button. Copying
// is the owner's decision, and the page says where the copy goes.
import { useId, useState } from "react";

/** Copies on a press, never by itself. */
export function CopyButton(props: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(props.text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <span className="copy">
      <button
        type="button"
        onClick={() => {
          void copy();
        }}
      >
        {props.label}
      </button>
      <span role="status">
        {state === "copied"
          ? "Copied. The clipboard is outside MyKey: other programs can read it, and MyKey cannot take it back."
          : state === "failed"
            ? "The browser did not allow copying. Select the text instead."
            : ""}
      </span>
    </span>
  );
}

/** One secret line with its label. */
export function SecretLine(props: {
  label: string;
  text: string;
  shown?: string;
  /** A value of any length and of several lines, shown as it is. */
  wide?: boolean;
}) {
  const id = useId();
  return (
    <div className="secret-line">
      <label htmlFor={id}>{props.label}</label>
      <output id={id} className={props.wide === true ? "secret value" : "secret"}>
        {props.shown ?? props.text}
      </output>
    </div>
  );
}

/** Recovery codes, shown once. */
export function RecoveryCodes(props: { codes: readonly string[]; onSaved: () => void }) {
  return (
    <section className="panel">
      <h2>Recovery codes</h2>
      <p>
        Each code signs you in once when you do not have your authenticator. They are shown now and
        never again: write them down or put them in a password manager, then confirm.
      </p>
      <ol className="codes" aria-label="Recovery codes">
        {props.codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <div className="actions">
        <CopyButton text={props.codes.join("\n")} label="Copy all ten" />
        <button type="button" onClick={props.onSaved}>
          I saved them
        </button>
      </div>
    </section>
  );
}
