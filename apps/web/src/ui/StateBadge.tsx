// A state as a word and a shape (FR-1.96): colour repeats them and carries
// nothing by itself.
import { stateLabel, type Shape, type StateKind } from "../labels.ts";

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
  return (
    <span className={`badge tone-${label.tone}`}>
      <span aria-hidden="true">{GLYPH[label.shape]}</span> {label.text}
    </span>
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
