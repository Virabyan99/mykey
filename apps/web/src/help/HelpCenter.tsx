// The help centre (Run 9.0 Task F, FR-1.97): a search field, the popular
// questions, every article by category, and the operator's runbooks by name.
// The search runs in this page's memory over the bundled articles; the query
// is not sent, not stored and not put in the address.
import { webPath } from "@mykey/contracts";
import { useId, useState } from "react";
import { PAGES } from "../copy/pages.ts";
import { Link } from "../router.tsx";
import { Icon } from "../ui/icons.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { ARTICLES, CATEGORIES, OPERATOR_RUNBOOKS, type Article } from "./articles.ts";
import { searchHelp } from "./search.ts";

function Entry(props: { article: Article }) {
  return (
    <li>
      <Link to={webPath("help-article", { article: props.article.id })}>{props.article.title}</Link>
      <p>{props.article.summary}</p>
    </li>
  );
}

const SHOWN = 8;

export function HelpCenter() {
  const field = useId();
  const [query, setQuery] = useState("");
  const asked = query.trim() !== "";
  const hits = asked ? searchHelp(query).slice(0, SHOWN) : [];
  return (
    <>
      <PageHeader page={PAGES.help} />
      <div className="help-search field" role="search">
        <label htmlFor={field}>Search the help</label>
        <input
          id={field}
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="For example: project id, lost phone, rotate a token"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      {asked ? (
        <section aria-labelledby="results">
          <h2 id="results">Results</h2>
          <p className="visually-hidden" role="status">
            {hits.length === 0 ? "No article found" : `${String(hits.length)} articles found`}
          </p>
          {hits.length === 0 ? (
            <p>No article answers that. Try other words, or look through the categories below.</p>
          ) : (
            <ul className="results" aria-label="Results">
              {hits.map((hit) => (
                <Entry key={hit.article.id} article={hit.article} />
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <section aria-labelledby="popular">
        <h2 id="popular">Popular questions</h2>
        <ul className="articles">
          {ARTICLES.filter((article) => article.popular === true).map((article) => (
            <Entry key={article.id} article={article} />
          ))}
        </ul>
      </section>
      {CATEGORIES.map((category) => (
        <section key={category.id} aria-labelledby={`category-${category.id}`}>
          <h2 id={`category-${category.id}`}>{category.title}</h2>
          <ul className="articles">
            {ARTICLES.filter((article) => article.category === category.id).map((article) => (
              <Entry key={article.id} article={article} />
            ))}
          </ul>
        </section>
      ))}
      <section aria-labelledby="for-the-operator">
        <h2 id="for-the-operator">
          <Icon name="terminal" /> For the operator
        </h2>
        <p>
          These are runbooks in the repository, under <code>docs/runbooks/</code>. They are not
          pages of the workspace.
        </p>
        <ul>
          {OPERATOR_RUNBOOKS.map((runbook) => (
            <li key={runbook.file}>
              <code>{runbook.file}</code>: {runbook.what}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
