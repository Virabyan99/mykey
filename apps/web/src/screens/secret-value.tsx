// The one place a secret's value is shown (FR-1.22, P-138, D-60). A value is
// read only when the owner presses a Reveal button, for the current version
// or for one of the history; it is held by the forgetting holder of the
// secret's page and nowhere else, so at most one value is on the screen, and
// it is gone after 30 seconds, when the tab is hidden, on a change of address
// and at sign-out.
import { useEffect, useState } from "react";
import { callSecret } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { EPHEMERAL_TTL_MS } from "../state/ephemeral.ts";
import { useSessionControl } from "../state/session.tsx";
import { useEphemeral } from "../state/use-ephemeral.ts";
import { CopyButton, SecretLine } from "../ui/Secret.tsx";

/** The environment of the address: the parameters of every route below it. */
export type At = Readonly<Record<"org" | "project" | "env", string>>;

/** What is held: the value, the version it is, and when it will be forgotten. */
interface Shown {
  value: string;
  version: number;
  until: number;
}

export interface Revealer {
  shown: Shown | null;
  busy: boolean;
  failure: Failure | null;
  /** The last answer came while the tab was hidden, and was dropped. */
  missed: boolean;
  /** Reads the current version, or the one named. */
  reveal: (version?: number) => void;
  hide: () => void;
}

export function useReveal(at: At, name: string): Revealer {
  const control = useSessionControl();
  const [shown, show, hide] = useEphemeral<Shown>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [missed, setMissed] = useState(false);

  const read = async (version: number | undefined): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setMissed(false);
    const result = await callSecret("secrets.reveal", {
      params: { ...at, name },
      body: version === undefined ? {} : { version },
    });
    setBusy(false);
    if (!result.ok) {
      if (!control.lost(result.failure)) setFailure(result.failure);
      return;
    }
    // A value that arrives while nobody can be looking is not kept.
    if (document.visibilityState === "hidden") {
      setMissed(true);
      return;
    }
    show({
      value: result.body.value,
      version: result.body.version,
      until: Date.now() + EPHEMERAL_TTL_MS,
    });
  };
  return {
    shown,
    busy,
    failure,
    missed,
    reveal: (version) => void read(version),
    hide,
  };
}

/** The time, once a second, while something counts down. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}

export function ValuePanel(props: {
  revealer: Revealer;
  /** The secret has a live current version: its Reveal is offered here. */
  live: boolean;
}) {
  const { shown, busy, failure, missed, reveal, hide } = props.revealer;
  const now = useNow(shown !== null);

  if (shown === null) {
    return (
      <section>
        <h2>Value</h2>
        {props.live ? (
          <p>
            The value is hidden. Reveal reads it from the secret store, records that you did, and
            shows it here for {String(EPHEMERAL_TTL_MS / 1000)} seconds.
          </p>
        ) : (
          <p>
            This secret is deleted: it has no current value. A version of the history that is still
            kept can be revealed from its row.
          </p>
        )}
        {missed ? (
          <p role="status">
            The value arrived while this tab was hidden, and it was not kept. Reveal it again.
          </p>
        ) : null}
        {failure === null ? null : <ErrorPanel failure={failure} action="reveal the value" />}
        {props.live ? (
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                reveal();
              }}
              disabled={busy}
            >
              Reveal
            </button>
          </div>
        ) : null}
      </section>
    );
  }
  // The clock of the countdown may be a second old; it is never older than the reveal.
  const left = Math.ceil((shown.until - Math.max(now, shown.until - EPHEMERAL_TTL_MS)) / 1000);
  return (
    <section>
      <h2>Value</h2>
      <SecretLine label="Value" text={shown.value} wide />
      {shown.value === "" ? <p className="hint">This value is empty.</p> : null}
      <p>
        Version {shown.version}. Hidden again in {Math.max(0, left)} s, or as soon as you leave this
        page or this tab.
      </p>
      <div className="actions">
        <CopyButton text={shown.value} label="Copy value" />
        <button type="button" onClick={hide}>
          Hide now
        </button>
      </div>
    </section>
  );
}
