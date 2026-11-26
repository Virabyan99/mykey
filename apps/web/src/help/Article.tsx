// One article of the help centre (Run 9.0 Task F): its title, summary and
// blocks, the screens it names as links, related articles and the way back.
// Blocks are structured data rendered as elements: no Markdown library and
// no markup from text. Four blocks are made from the catalogue itself, so
// the help says what the page says.
import { ERROR_CODES, webPath, type ErrorCode } from "@mykey/contracts";
import { useEffect } from "react";
import { GLOSSARY } from "../copy/glossary.ts";
import { KIND_NAMES, STATES } from "../copy/states.ts";
import { explain, type Failure } from "../errors/explain.ts";
import { STATE_LABELS, type StateKind } from "../labels.ts";
import { Link } from "../router.tsx";
import { useScope, type Scope } from "../state/scope.tsx";
import { Callout, PageHeader } from "../ui/PageHeader.tsx";
import { StateBadge } from "../ui/StateBadge.tsx";
import { articleOf, CLI_EXIT_CODES, type Block, type ScreenId } from "./articles.ts";
import { KnownLimits } from "./KnownLimits.tsx";

const ORG_SCREENS = new Set<ScreenId>(["overview", "activity", "audit", "automation"]);
const ENV_SCREENS = new Set<ScreenId>([
  "secrets",
  "import",
  "credentials",
  "operations",
  "connect",
]);

/** The address of a screen an article names, from the scope the owner is in; null when it needs more. */
export function screenPath(scope: Scope, screen: ScreenId): string | null {
  if (screen === "account" || screen === "help") return webPath(screen);
  const org =
    scope.organization ?? (scope.organizations.length === 1 ? scope.organizations[0] : undefined);
  if (org === undefined) return null;
  if (ORG_SCREENS.has(screen)) return webPath(screen, { org: org.id });
  const project = scope.project;
  if (screen === "project")
    return project === null ? null : webPath("project", { org: org.id, project: project.id });
  const env = scope.environment;
  if (ENV_SCREENS.has(screen) && project !== null && env !== null) {
    return webPath(screen, { org: org.id, project: project.id, env: env.id });
  }
  return null;
}

function ScreenLink(props: { screen: ScreenId; text: string }) {
  const scope = useScope();
  const path = screenPath(scope, props.screen);
  if (path !== null) {
    return (
      <p>
        <Link to={path}>{props.text}</Link>
      </p>
    );
  }
  const org = scope.organization ?? scope.organizations[0];
  return (
    <p className="muted">
      {props.text.replace(/^Go to /, "")} is a screen of an environment: open one from{" "}
      {org === undefined ? "Home" : <Link to={webPath("overview", { org: org.id })}>Home</Link>}{" "}
      first.
    </p>
  );
}

function States() {
  return (
    <>
      {(Object.keys(STATE_LABELS) as StateKind[]).map((kind) => (
        <section key={kind} aria-label={KIND_NAMES[kind]}>
          <h3>{KIND_NAMES[kind]}</h3>
          <dl>
            {Object.keys(STATE_LABELS[kind]).map((state) => {
              const copy = (STATES[kind] as Record<string, { meaning: string; next: string }>)[
                state
              ];
              return (
                <div key={state}>
                  <dt>
                    <StateBadge kind={kind} state={state} />
                  </dt>
                  <dd>
                    {copy?.meaning} {copy?.next}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </>
  );
}

const ACTION = "do what you asked";

/** Every message of the error table, A to Z, each with an anchor the error panels link to. */
export function errorEntries(): { anchor: string; title: string; text: string; next: string }[] {
  const failures: [string, Failure][] = [
    ["error-transport", { kind: "transport", status: null }],
    ["error-unfinished", { kind: "unfinished", requestId: null, operationId: null }],
    ...(Object.keys(ERROR_CODES) as ErrorCode[]).map((code): [string, Failure] => [
      `error-${code}`,
      {
        kind: "api",
        status: ERROR_CODES[code].status,
        code,
        message: "",
        requestId: null,
        operationId: null,
        details: null,
        retryAfterSeconds: null,
      },
    ]),
  ];
  return failures
    .map(([anchor, failure]) => {
      const explained = explain(failure, { action: ACTION });
      return { anchor, title: explained.title, text: explained.text, next: explained.next };
    })
    .sort((a, b) => a.title.localeCompare(b.title, "en"));
}

function Errors() {
  return (
    <dl aria-label="Error messages">
      {errorEntries().map((entry) => (
        <div key={entry.anchor}>
          <dt id={entry.anchor}>{entry.title}</dt>
          <dd>
            {entry.text} <strong>{entry.next}</strong>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Glossary() {
  const entries = Object.values(GLOSSARY).sort((a, b) => a.term.localeCompare(b.term, "en"));
  return (
    <dl aria-label="Glossary">
      {entries.map((entry) => (
        <div key={entry.term}>
          <dt>{entry.term}</dt>
          <dd>
            {entry.definition}{" "}
            <Link to={webPath("help-article", { article: entry.article })}>Read more</Link>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ExitCodes() {
  return (
    <div className="scroll">
      <table aria-label="CLI exit codes">
        <thead>
          <tr>
            <th scope="col">Exit code</th>
            <th scope="col">Category</th>
            <th scope="col">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {CLI_EXIT_CODES.map((row) => (
            <tr key={row.code}>
              <th scope="row">{row.code}</th>
              <td>
                <code>{row.category}</code>
              </td>
              <td>{row.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BlockView(props: { block: Block }) {
  const { block } = props;
  if (block.kind === "p") return <p>{block.text}</p>;
  if (block.kind === "steps") {
    return (
      <ol>
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
    );
  }
  if (block.kind === "list") {
    return (
      <ul>
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  if (block.kind === "callout") {
    return (
      <Callout tone={block.tone ?? "info"}>
        <p>{block.text}</p>
      </Callout>
    );
  }
  if (block.kind === "code") {
    return (
      <div className="code-block">
        <pre>
          <code>{block.text}</code>
        </pre>
      </div>
    );
  }
  if (block.kind === "screen") return <ScreenLink screen={block.screen} text={block.text} />;
  if (block.kind === "external") {
    return (
      <p>
        <a href={block.href}>{block.text}</a>
      </p>
    );
  }
  if (block.what === "states") return <States />;
  if (block.what === "errors") return <Errors />;
  if (block.what === "glossary") return <Glossary />;
  if (block.what === "known-limits") return <KnownLimits />;
  return <ExitCodes />;
}

export function ArticlePage(props: { id: string }) {
  const article = articleOf(props.id);
  // An anchor in the address (an error panel's "Learn more") is scrolled to once the entry is there.
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (anchor !== "") document.getElementById(anchor)?.scrollIntoView();
  }, [props.id]);

  if (article === undefined) {
    return (
      <>
        <h1>No such article</h1>
        <p>The help centre has no article at this address.</p>
        <p>
          <Link to={webPath("help")}>Back to help</Link>
        </p>
      </>
    );
  }
  return (
    <article className="article" aria-labelledby="article-title">
      <PageHeader
        page={{ title: article.title, summary: article.summary, how: [], help: article.id }}
        title={<span id="article-title">{article.title}</span>}
      />
      {article.blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
      {article.related.length === 0 ? null : (
        <section aria-labelledby="related">
          <h2 id="related">Related</h2>
          <ul className="articles">
            {article.related.map((id) => {
              const other = articleOf(id);
              return other === undefined ? null : (
                <li key={id}>
                  <Link to={webPath("help-article", { article: id })}>{other.title}</Link>
                  <p>{other.summary}</p>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <p>
        <Link to={webPath("help")}>Back to help</Link>
      </p>
    </article>
  );
}
