// The audit view (FR-1.58, P-107): an owner's tool, a plain table over
// audit.list. Every filter of the route is a field of the form, and the
// request holds exactly what the form says. The server checks the filters;
// a filter it refuses is shown as its refusal. A cursor belongs to the
// filters it was made with: when the server says the listing changed, the
// page reads it again from the start and says so.
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { LIMITS, type AuditListBody } from "@mykey/contracts";
import { useState, type SyntheticEvent } from "react";
import { call, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { useScope } from "../state/scope.tsx";
import { isCode } from "../state/use-action.ts";
import { Field } from "../ui/Field.tsx";
import { Loading } from "../ui/StateBadge.tsx";
import { Time } from "../ui/Time.tsx";
import { Actor, outcomeWord } from "./activity.tsx";
import { LIST_CHANGED } from "./secrets.tsx";

type Item = AuditListBody["items"][number];

const FIELDS = [
  "from",
  "to",
  "action",
  "outcome",
  "actorKind",
  "actorId",
  "projectId",
  "environmentId",
  "operationId",
  "requestId",
] as const;
type FieldName = (typeof FIELDS)[number];
type Filters = Readonly<Record<FieldName, string>>;

const EMPTY: Filters = Object.freeze(
  Object.fromEntries(FIELDS.map((name) => [name, ""])) as Record<FieldName, string>,
);

const OUTCOMES = ["success", "denied", "failure", "intent", "unknown"] as const;
const ACTOR_KINDS = ["user", "machine", "operator", "system", "anonymous"] as const;

/** The form as the route's query: a day is the whole UTC day, an empty field is no filter. */
function queryOf(filters: Filters): Record<string, string | undefined> {
  const text = (name: FieldName): string | undefined =>
    filters[name].trim() === "" ? undefined : filters[name].trim();
  return {
    from: filters.from === "" ? undefined : `${filters.from}T00:00:00.000Z`,
    to: filters.to === "" ? undefined : `${filters.to}T23:59:59.999Z`,
    action: text("action"),
    outcome: text("outcome"),
    actorKind: text("actorKind"),
    actorId: text("actorId"),
    projectId: text("projectId"),
    environmentId: text("environmentId"),
    operationId: text("operationId"),
    requestId: text("requestId"),
  };
}

function Details(props: { details: Item["details"] }) {
  const entries = Object.entries(props.details);
  if (entries.length === 0) return <span className="muted">none</span>;
  return (
    <>
      {entries.map(([key, value]) => (
        <div key={key}>
          {key}: <code>{String(value)}</code>
        </div>
      ))}
    </>
  );
}

function Events(props: { org: string; userId: string; filters: Filters }) {
  const { org, userId, filters } = props;
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const queryKey = [userId, org, "audit", filters];
  const list = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      need(
        call("audit.list", {
          params: { org },
          query: {
            limit: LIMITS.listing.defaultLimit,
            ...queryOf(filters),
            cursor: pageParam ?? undefined,
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    // A refused filter is the answer; asking again would not change it.
    retry: false,
  });
  const more = async (): Promise<void> => {
    setNotice(null);
    const result = await list.fetchNextPage();
    if (result.isFetchNextPageError && isCode(failureOf(result.error), "listing_changed")) {
      await client.resetQueries({ queryKey });
      setNotice(LIST_CHANGED);
    }
  };

  if (list.isPending) return <Loading what="the audit events" />;
  if (list.data === undefined) {
    return (
      <ErrorPanel
        failure={failureOf(list.error)}
        action="read the audit log of this organization"
        onReload={() => void list.refetch()}
      />
    );
  }
  const items = list.data.pages.flatMap((page) => page.items);
  const anchor = list.data.pages[0]?.anchor ?? null;
  return (
    <>
      <p role="status">
        {items.length} {items.length === 1 ? "event" : "events"} shown
        {list.hasNextPage ? ", and more follow" : ""}. No event after <Time at={anchor} /> is in
        this listing.
      </p>
      {notice === null ? null : <p role="status">{notice}</p>}
      {items.length === 0 ? null : (
        <div className="scroll">
          <table aria-label="Audit events">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Action</th>
                <th scope="col">Actor</th>
                <th scope="col">Source</th>
                <th scope="col">Target</th>
                <th scope="col">Outcome</th>
                <th scope="col">Request id</th>
                <th scope="col">Operation id</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Time at={item.occurredAt} />
                  </td>
                  <td>
                    <code>{item.action}</code>
                  </td>
                  <td>
                    <Actor actor={item.actor} userId={userId} />
                  </td>
                  <td>{item.source ?? <span className="muted">none</span>}</td>
                  <td>
                    {item.target === null ? (
                      <span className="muted">none</span>
                    ) : (
                      <>
                        {item.target.kind}
                        {item.target.id === null ? null : (
                          <>
                            {" "}
                            <code>{item.target.id}</code>
                          </>
                        )}
                      </>
                    )}
                  </td>
                  <td>{outcomeWord(item.outcome)}</td>
                  <td>{item.requestId === null ? null : <code>{item.requestId}</code>}</td>
                  <td>{item.operationId === null ? null : <code>{item.operationId}</code>}</td>
                  <td>
                    <Details details={item.details} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.isFetchNextPageError && !isCode(failureOf(list.error), "listing_changed") ? (
        <ErrorPanel failure={failureOf(list.error)} action="read more audit events" />
      ) : null}
      {list.hasNextPage ? (
        <div className="actions">
          <button type="button" onClick={() => void more()} disabled={list.isFetchingNextPage}>
            More
          </button>
        </div>
      ) : null}
    </>
  );
}

export function Audit() {
  const { organization, projects, userId } = useScope();
  const [form, setForm] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  if (organization === null) return null;
  const set = (name: FieldName, value: string): void => {
    setForm((current) => ({ ...current, [name]: value }));
  };
  const text = (name: FieldName, label: string, hint?: string) => (
    <Field
      label={label}
      value={form[name]}
      onChange={(event) => {
        set(name, event.target.value);
      }}
      autoComplete="off"
      spellCheck={false}
      {...(hint === undefined ? {} : { hint })}
    />
  );
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setApplied(form);
  };
  return (
    <>
      <h1>Audit</h1>
      <p className="hint">
        The audit log of this organization and of its members&apos; accounts, newest first. Without
        a window it shows the last 30 days; a window may be at most 92 days.
      </p>
      <form className="filters" onSubmit={submit} noValidate>
        <Field
          label="From (UTC day)"
          type="date"
          value={form.from}
          onChange={(event) => {
            set("from", event.target.value);
          }}
        />
        <Field
          label="To (UTC day)"
          type="date"
          value={form.to}
          onChange={(event) => {
            set("to", event.target.value);
          }}
        />
        {text("action", "Action", "For example secret.reveal or access.denied.")}
        <div className="field">
          <label htmlFor="audit-outcome">Outcome</label>
          <select
            id="audit-outcome"
            value={form.outcome}
            onChange={(event) => {
              set("outcome", event.target.value);
            }}
          >
            <option value="">Any outcome</option>
            {OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {outcomeWord(outcome)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-actor-kind">Actor kind</label>
          <select
            id="audit-actor-kind"
            value={form.actorKind}
            onChange={(event) => {
              set("actorKind", event.target.value);
            }}
          >
            <option value="">Any actor</option>
            {ACTOR_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </div>
        {text("actorId", "Actor id")}
        <div className="field">
          <label htmlFor="audit-project">Project</label>
          <select
            id="audit-project"
            value={form.projectId}
            onChange={(event) => {
              set("projectId", event.target.value);
            }}
          >
            <option value="">Any project</option>
            {(projects?.items ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        {text("environmentId", "Environment id")}
        {text("operationId", "Operation id")}
        {text("requestId", "Request id")}
        <div className="actions">
          <button type="submit">Apply filters</button>
          <button
            type="button"
            onClick={() => {
              setForm(EMPTY);
              setApplied(EMPTY);
            }}
          >
            Clear filters
          </button>
        </div>
      </form>
      <Events org={organization.id} userId={userId} filters={applied} />
    </>
  );
}
