// How every refusal and every missing answer is shown (FR-1.93): the text of
// the one table in explain.ts, the ids to quote, and at most the actions the
// caller passes. Never the server's message, never a stack.
import { matchWebRoute, webPath } from "@mykey/contracts";
import type { ReactNode } from "react";
import { Link, usePath } from "../router.tsx";
import { explain, type Failure } from "./explain.ts";

/**
 * Where an answer that names an operation leads (P-140): to the operations of
 * the environment the screen is in, where the operation's state can be read.
 * A link and nothing more: nothing here sends a change again.
 */
function OperationsLink() {
  const params = matchWebRoute(usePath())?.params;
  const { org, project, env } = params ?? {};
  if (org === undefined || project === undefined || env === undefined) return null;
  return (
    <Link to={webPath("operations", { org, project, env })}>Operations of this environment</Link>
  );
}

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
        {operationId === null ? null : <OperationsLink />}
        {props.children}
      </div>
    </section>
  );
}
