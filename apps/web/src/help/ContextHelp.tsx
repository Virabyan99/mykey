// "?" in the top bar (Run 9.0 Task F): the help for the page the owner is on,
// in a side panel. It shows the page's "How this works", the summary of its
// article and three related ones, and links to the article itself. It holds
// only catalogue text: nothing of the owner's data is in it.
import { webPath } from "@mykey/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { pageCopy } from "../copy/pages.ts";
import { Link, onNavigate } from "../router.tsx";
import { Icon } from "../ui/icons.tsx";
import { articleOf } from "./articles.ts";

function Panel(props: { route: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { onClose } = props;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    return () => {
      if (element?.open === true) element.close();
    };
  }, []);
  useEffect(() => onNavigate(onClose), [onClose]);
  const page = pageCopy(props.route);
  const article = articleOf(page.help);
  return (
    <dialog
      ref={dialog}
      className="side-panel"
      aria-labelledby="context-help-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="page-title-row">
        <h2 id="context-help-title" className="title">
          Help: {page.title}
        </h2>
        <button type="button" className="quiet" aria-label="Close the help" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <p>{page.summary}</p>
      {page.how.length === 0 ? null : (
        <>
          <h3>How this works</h3>
          <ul>
            {page.how.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </>
      )}
      {article === undefined ? null : (
        <>
          <h3>{article.title}</h3>
          <p>{article.summary}</p>
          <p>
            <Link to={webPath("help-article", { article: article.id })}>Read the article</Link>
          </p>
          {article.related.length === 0 ? null : (
            <>
              <h3>Related</h3>
              <ul>
                {article.related.slice(0, 3).map((id) => {
                  const other = articleOf(id);
                  return other === undefined ? null : (
                    <li key={id}>
                      <Link to={webPath("help-article", { article: id })}>{other.title}</Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
      <p>
        <Link to={webPath("help")}>Help centre</Link>
      </p>
    </dialog>
  );
}

export function ContextHelp(props: { route: string }) {
  const [open, setOpen] = useState(false);
  const close = (): void => {
    setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        aria-label="Help for this page"
        title="Help for this page"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon name="help" />
        <span aria-hidden="true">?</span>
      </button>
      {open ? <Panel route={props.route} onClose={close} /> : null}
    </>
  );
}
