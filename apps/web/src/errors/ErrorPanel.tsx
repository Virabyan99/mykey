// How every refusal and every missing answer is shown (FR-1.93): the text of
// the one table in explain.ts, the ids to quote, and at most the actions the
// caller passes. Never the server's message, never a stack.
import type { ReactNode } from "react";
import { explain, type Failure } from "./explain.ts";

export function ErrorPanel(props: {
  failure: Failure;
  /** Completes "… to {action}", e.g. "save the secret". */
  action: string;
  /** Reads the current state again. Never sends a change again. */
  onReload?: () => void;
  children?: ReactNode;
}) {
  const explained = explain(props.failure, { action: props.action });
  const { requestId, operationId } = explained.ids;
  return (
    <section className="panel panel-error" role="alert">
      <h2>{explained.title}</h2>
      <p>{explained.text}</p>
      <p className="next">{explained.next}</p>
      {requestId === null && operationId === null ? null : (
        <dl className="ids">
          {requestId === null ? null : (
            <>
              <dt>Request id</dt>
              <dd>
                <code>{requestId}</code>
              </dd>
            </>
          )}
          {operationId === null ? null : (
            <>
              <dt>Operation id</dt>
              <dd>
                <code>{operationId}</code>
              </dd>
            </>
          )}
        </dl>
      )}
      <div className="actions">
        {props.onReload === undefined ? null : (
          <button type="button" onClick={props.onReload}>
            Reload
          </button>
        )}
        {props.children}
      </div>
    </section>
  );
}
