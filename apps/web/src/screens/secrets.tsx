// The secrets of one environment (FR-1.21): names, never values. The list is
// the server's index, a page at a time, in the server's order; a prefix
// narrows it by name only. A list that changed between two pages is not
// stitched together: it is read again from its first page, and the page says so.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { webPath } from "@mykey/contracts";
import { useRef, useState, type SyntheticEvent } from "react";
import { call, callSecret, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { Link } from "../router.tsx";
import { useScope } from "../state/scope.tsx";
import { isCode, useAction } from "../state/use-action.ts";
import { AreaField, Field } from "../ui/Field.tsx";
import { EnvironmentNotice } from "../ui/Resource.tsx";
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
import { Time } from "../ui/Time.tsx";
import {
  SECRET_NAME_RULE,
  SECRET_VALUE_RULE,
  prefixProblem,
  secretNameProblem,
  secretValueProblem,
  versionOf,
} from "./secret-rules.ts";

/** The environment of the address: the parameters of every route below it. */
type At = Readonly<Record<"org" | "project" | "env", string>>;

export const LIST_CHANGED =
  "The list changed while it was being read. It was read again from the start.";

function NewSecret(props: { at: At; onCreated: (text: string) => void; onCancel: () => void }) {
  const { at } = props;
  const action = useAction();
  const name = useRef<HTMLInputElement>(null);
  const value = useRef<HTMLTextAreaElement>(null);
  const [problems, setProblems] = useState<{ name: string | null; value: string | null }>({
    name: null,
    value: null,
  });

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (name.current === null || value.current === null) return;
    const given = name.current.value.trim();
    const text = value.current.value;
    const found = { name: secretNameProblem(given), value: secretValueProblem(text) };
    setProblems(found);
    if (found.name !== null || found.value !== null) {
      action.clear();
      return;
    }
    // The key belongs to the place and the name, never to the value.
    const result = await action.run(`secrets.create ${at.env} ${given}`, (key) =>
      callSecret("secrets.create", {
        params: at,
        body: { name: given, value: text },
        idempotencyKey: key,
      }),
    );
    if (result.ok) {
      const version = versionOf(result.body.result);
      props.onCreated(
        version === null
          ? `${given} is created.`
          : `${given} is created at version ${String(version)}.`,
      );
      return;
    }
    // The server names no field: both rules are shown where they apply.
    if (isCode(result.failure, "validation_failed")) {
      setProblems({ name: SECRET_NAME_RULE, value: SECRET_VALUE_RULE });
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label="New secret"
      autoComplete="off"
      noValidate
    >
      <Field
        label="Name"
        hint={SECRET_NAME_RULE}
        error={problems.name}
        inputRef={name}
        type="text"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={256}
      />
      <AreaField label="Value" hint={SECRET_VALUE_RULE} error={problems.value} areaRef={value} />
      {action.failure === null ? null : (
        <ErrorPanel failure={action.failure} action="create the secret" />
      )}
      <div className="actions">
        <button type="submit" disabled={action.busy || action.held}>
          Create secret
        </button>
        <button type="button" onClick={props.onCancel} disabled={action.busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Search(props: { prefix: string; onSearch: (prefix: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const given = input.current?.value.trim() ?? "";
    const found = given === "" ? null : prefixProblem(given);
    setProblem(found);
    if (found === null) props.onSearch(given);
  };
  return (
    <form className="search" role="search" onSubmit={submit} noValidate>
      <Field
        label="Name starts with"
        error={problem}
        inputRef={input}
        type="text"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={256}
        defaultValue={props.prefix}
      />
      <div className="actions">
        <button type="submit">Search</button>
        {props.prefix === "" ? null : (
          <button
            type="button"
            onClick={() => {
              if (input.current !== null) input.current.value = "";
              setProblem(null);
              props.onSearch("");
            }}
          >
            Show all
          </button>
        )}
      </div>
    </form>
  );
}

function Names(props: { at: At; userId: string; prefix: string }) {
  const { at, userId, prefix } = props;
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const queryKey = [userId, at.org, "secrets", at.project, at.env, prefix];
  const list = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      need(
        call("secrets.list", {
          params: at,
          query: {
            prefix: prefix === "" ? undefined : prefix,
            cursor: pageParam ?? undefined,
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });

  const fromTheStart = (): Promise<void> => client.resetQueries({ queryKey });
  const more = async (): Promise<void> => {
    setNotice(null);
    const result = await list.fetchNextPage();
    if (result.isFetchNextPageError && isCode(failureOf(result.error), "listing_changed")) {
      await fromTheStart();
      setNotice(LIST_CHANGED);
    }
  };

  if (list.isPending) return <Loading what="the names" />;
  if (list.data === undefined) {
    return (
      <ErrorPanel
        failure={failureOf(list.error)}
        action="read the names"
        onReload={() => void list.refetch()}
      />
    );
  }
  const rows = list.data.pages.flatMap((page) => page.secrets);
  const pageFailed =
    list.isFetchNextPageError && !isCode(failureOf(list.error), "listing_changed")
      ? failureOf(list.error)
      : null;
  return (
    <>
      {notice === null ? null : <p role="status">{notice}</p>}
      {rows.length === 0 ? (
        <p>
          {prefix === "" ? (
            "This environment has no secret yet."
          ) : (
            <>
              No name here starts with <code>{prefix}</code>.
            </>
          )}
        </p>
      ) : (
        <div className="scroll">
          <table aria-label="Secrets">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">State</th>
                <th scope="col">Version</th>
                <th scope="col">Last change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <th scope="row">
                    <Link to={webPath("secret", { ...at, name: row.name })}>{row.name}</Link>
                  </th>
                  <td>
                    <StateBadge kind="index" state={row.state} />
                  </td>
                  <td>{row.version ?? <span className="muted">none</span>}</td>
                  <td>
                    <Time at={row.changedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pageFailed === null ? null : (
        <ErrorPanel
          failure={pageFailed}
          action="read the next names"
          onReload={() => void fromTheStart()}
        />
      )}
      {list.hasNextPage ? (
        <div className="actions">
          <button type="button" onClick={() => void more()} disabled={list.isFetchingNextPage}>
            More
          </button>
          <span className="muted">
            {rows.length} names shown, in the server&apos;s order. There are more.
          </span>
        </div>
      ) : rows.length === 0 ? null : (
        <p className="muted">
          {rows.length === 1
            ? "1 name. That is all."
            : `${String(rows.length)} names. That is all.`}
        </p>
      )}
    </>
  );
}

export function Secrets() {
  const { organization, project, environment, userId } = useScope();
  const client = useQueryClient();
  const [prefix, setPrefix] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (organization === null || project === null || environment === null) return null;
  const at: At = { org: organization.id, project: project.id, env: environment.id };
  // Only what the state allows is offered; the server decides either way.
  const writable = environment.state === "active";
  const readable = environment.state !== "needs_review" && environment.state !== "pending";

  return (
    <>
      <h1>Secrets</h1>
      <p className="hint">
        {project.name} / {environment.name}. Names and versions only: a value is read from the
        secret store when you press Reveal on a secret&apos;s page, and at no other time.
      </p>
      <EnvironmentNotice state={environment.state} reason={environment.reviewReason} />
      {creating ? (
        <NewSecret
          at={at}
          onCancel={() => {
            setCreating(false);
          }}
          onCreated={(text) => {
            setCreating(false);
            setNotice(text);
            void client.invalidateQueries({ queryKey: [userId, at.org] });
          }}
        />
      ) : writable ? (
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setCreating(true);
            }}
          >
            New secret
          </button>
        </div>
      ) : null}
      {notice === null ? null : <p role="status">{notice}</p>}
      {readable ? (
        <>
          <Search prefix={prefix} onSearch={setPrefix} />
          <Names key={prefix} at={at} userId={userId} prefix={prefix} />
        </>
      ) : null}
    </>
  );
}
