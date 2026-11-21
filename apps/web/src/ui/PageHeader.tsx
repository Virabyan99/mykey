// The page contract (D-70, P-159): every screen opens with its title, one
// sentence of what it is for, "How this works", its primary action on the
// right and a link to its help article. The text comes from the catalogue
// (copy/pages.ts); a screen passes it, it does not write it.
import { webPath } from "@mykey/contracts";
import { useId, type ReactNode } from "react";
import { Link } from "../router.tsx";
import { IdLine } from "./IdChip.tsx";
import { Icon } from "./icons.tsx";

export interface PageText {
  title: string;
  summary: string;
  how: readonly string[];
  help: string;
}

export function PageHeader(props: {
  page: PageText;
  /** A title of the screen's own: a project's or a secret's name. */
  title?: ReactNode;
  /** The primary action, and at most one secondary. */
  actions?: ReactNode;
  /** Ids and facts under the summary. */
  meta?: ReactNode;
}) {
  const summary = useId();
  return (
    <header className="page-header">
      <div className="page-title-row">
        <div className="title">
          <h1 aria-describedby={summary}>{props.title ?? props.page.title}</h1>
          <p className="summary" id={summary}>
            {props.page.summary}
          </p>
          {props.meta === undefined ? null : <div className="page-ids">{props.meta}</div>}
        </div>
        {props.actions === undefined ? null : <div className="page-actions">{props.actions}</div>}
      </div>
      {props.page.how.length === 0 ? null : (
        <details className="how">
          <summary>How this works</summary>
          <ul>
            {props.page.how.map((point) => (
              <li key={point}>{point}</li>
            ))}
            <li>
              <Link to={webPath("help-article", { article: props.page.help })}>
                Read the help for this page
              </Link>
            </li>
          </ul>
        </details>
      )}
    </header>
  );
}

/** A list with nothing in it says what it would hold and offers the first step. */
export function EmptyState(props: {
  title: string;
  text: string;
  /** The first step: a button or a link. */
  action?: ReactNode;
  /** An article that explains the subject. */
  learn?: string;
}) {
  return (
    <section className="empty" aria-label={props.title}>
      <Icon name="circleDashed" large />
      <h2>{props.title}</h2>
      <p>{props.text}</p>
      {props.action === undefined ? null : <div className="actions">{props.action}</div>}
      {props.learn === undefined ? null : (
        <Link to={webPath("help-article", { article: props.learn })}>Learn how</Link>
      )}
    </section>
  );
}

/** A note beside the content: information, or a warning to read before acting. */
export function Callout(props: { tone?: "info" | "warning"; title?: string; children: ReactNode }) {
  const warning = props.tone === "warning";
  return (
    <aside className={warning ? "callout warning" : "callout"} aria-label={props.title}>
      <Icon name={warning ? "triangleAlert" : "info"} />
      <div>
        {props.title === undefined ? null : (
          <p>
            <strong>{props.title}</strong>
          </p>
        )}
        {props.children}
      </div>
    </aside>
  );
}

/** A key of the keyboard, as text. */
export function Kbd(props: { children: string }) {
  return <kbd>{props.children}</kbd>;
}

/** The ids of the project and the environment a screen is in, each copyable. */
export function ScopeIds(props: {
  project: { id: string };
  environment?: { id: string } | null;
  /** False: the ids as text only (the breadcrumbs above copy them). */
  copy?: boolean;
}) {
  const copy = props.copy !== false;
  return (
    <>
      <IdLine of="project" id={props.project.id} copy={copy} />
      {props.environment === undefined || props.environment === null ? null : (
        <IdLine of="environment" id={props.environment.id} copy={copy} />
      )}
    </>
  );
}

/** Activity, Audit and Operations, told apart in one line each (the same callout on all three). */
export function ThreeViews() {
  return (
    <Callout title="Activity, Audit and Operations">
      <ul>
        <li>Activity: what people and machines did, in plain words.</li>
        <li>Audit: every recorded event and its outcome, for checking.</li>
        <li>Operations: changes the service carried out for one environment, and their state.</li>
      </ul>
    </Callout>
  );
}
