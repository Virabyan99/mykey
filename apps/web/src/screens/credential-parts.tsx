// What the two screens that issue a long-lived secret share (Session 11,
// Run 11.6; P-138, D-60): the panel that shows it once, and the reading of a
// list of networks. The secret is in the forgetting holder of the screen
// that asked for it and nowhere else. The page checks how many networks were
// named, never what a network is: the service decides that (D-80's cut).
import { useId, type ReactNode } from "react";
import { CopyButton, SecretLine } from "../ui/Secret.tsx";
import { useNow } from "./secret-value.tsx";

/** As long as a token: it has to be carried to where it is kept. */
export const ONCE_TTL_MS = 120_000;
export const DAY_SECONDS = 86_400;

export interface Once {
  secret: string;
  name: string;
  until: number;
}

export function OncePanel(props: {
  /** The panel's name, e.g. "The secret, shown once". */
  title: string;
  /** The label of the line that holds it. */
  label: string;
  /** The copy button's text. */
  copy: string;
  shown: Once;
  onHide: () => void;
  /** What it is, and where it goes. */
  children: ReactNode;
}) {
  const { shown } = props;
  const title = useId();
  const now = useNow(true);
  // The clock of the countdown may be a second old; it is never older than the issue.
  const left = Math.ceil((shown.until - Math.max(now, shown.until - ONCE_TTL_MS)) / 1000);
  return (
    <section className="panel" aria-labelledby={title}>
      <h2 id={title}>{props.title}</h2>
      <SecretLine label={props.label} text={shown.secret} />
      {props.children}
      <p>Hidden in {Math.max(0, left)} s, or as soon as you leave this page or this tab.</p>
      <div className="actions">
        <CopyButton text={shown.secret} label={props.copy} />
        <button type="button" onClick={props.onHide}>
          Hide now
        </button>
      </div>
    </section>
  );
}

/** The networks of a text area: one per line, as typed, without empty lines. */
export const networksOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Said under the field when the service refused the request's values. */
export const NETWORK_REFUSED =
  "The service refused a network or another value of this form. A network is written as an address and a prefix, such as 203.0.113.0/24: no bit may be set after the prefix, and the prefix is longer than 0.";

export const NETWORKS_HINT =
  "One per line, in CIDR form, such as 203.0.113.0/24: the addresses its requests come from, as the service sees them.";

/** A whole number of days from 1 to `max`, or null. */
export function daysOf(text: string, max: number): number | null {
  const days = /^[0-9]{1,3}$/.test(text.trim()) ? Number(text.trim()) : 0;
  return days >= 1 && days <= max ? days : null;
}
