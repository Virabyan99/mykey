// A state as a word and a shape (FR-1.96): colour repeats them and carries
// nothing by itself. Its meaning and next step (copy/states.ts) open on focus
// and on hover (Run 9.0, P-159).
import { stateCopy } from "../copy/states.ts";
import { stateLabel, type Shape, type StateKind } from "../labels.ts";
import { Tip } from "./Term.tsx";

const GLYPH: Readonly<Record<Shape, string>> = {
  dot: "●",
  ring: "○",
  square: "■",
  triangle: "▲",
  cross: "✕",
  dash: "–",
};

export function StateBadge(props: { kind: StateKind; state: string }) {
  const label = stateLabel(props.kind, props.state);
  const meaning = stateCopy(props.kind, props.state);
  return (
    <Tip
      tip={
        <>
          <p>
            <strong>{label.text}</strong>: {meaning.meaning}
          </p>
          <p>{meaning.next}</p>
        </>
      }
    >
      <span className={`badge tone-${label.tone}`}>
        <span aria-hidden="true">{GLYPH[label.shape]}</span> {label.text}
      </span>
    </Tip>
  );
}

/** Something is being read. Announced politely; never shown as a result. */
export function Loading(props: { what: string }) {
  return (
    <p className="loading" role="status">
      Loading {props.what}…
    </p>
  );
}
