// The organization's timeline (FR-1.92, P-108): the product's events from
// activity.list, newest first. The server serves events and never groups
// them; this page puts the events of one operation on one line, in the order
// they happened, beside the operation's state as it is now. A target is
// shown by its current name. The words are the server's: an outcome that is
// not known stays "not known".
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { LIMITS, type ActivityListBody } from "@mykey/contracts";
import { useState } from "react";
import { call, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { useScope } from "../state/scope.tsx";
import { isCode } from "../state/use-action.ts";
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
import { Time } from "../ui/Time.tsx";
import { LIST_CHANGED } from "./secrets.tsx";

type Item = ActivityListBody["items"][number];

/** The audit log's outcomes, as words. `intent` is the row written before a change is sent. */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  success: "succeeded",
  failure: "failed",
  denied: "denied",
  intent: "started",
  unknown: "not known",
};
export const outcomeWord = (outcome: string): string => OUTCOME_WORDS[outcome] ?? outcome;

interface Group {
  key: string;
  operation: Item["operation"];
  /** Newest first, as served. */
  events: Item[];
}

/** The events of one operation together, at the place of its newest event. */
export function groupByOperation(items: readonly Item[]): Group[] {
  const groups: Group[] = [];
  const byOperation = new Map<string, Group>();
  for (const item of items) {
    const id = item.operation?.id ?? item.operationId;
    if (id === null) {
      groups.push({ key: item.id, operation: null, events: [item] });
      continue;
    }
    let group = byOperation.get(id);
    if (group === undefined) {
      group = { key: id, operation: item.operation, events: [] };
      byOperation.set(id, group);
      groups.push(group);
    }
    group.events.push(item);
  }
  return groups;
}

const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];

export function Actor(props: { actor: Item["actor"]; userId: string }) {
  const { kind, id } = props.actor;
  if (id === null) return <>{kind}</>;
  return (
    <>
      {kind} <code>{id}</code>
      {kind === "user" && id === props.userId ? " (you)" : ""}
    </>
  );
}

function Target(props: { item: Item }) {
  const { target, targetName } = props.item;
  if (target === null) return <span className="muted">none</span>;
  if (targetName !== null) {
    return (
      <>
        {target.kind} {targetName}
      </>
    );
  }
  return (
    <>
      {target.kind}
      {target.id === null ? null : (
        <>
          {" "}
          <code>{target.id}</code>
        </>
      )}
    </>
  );
}

function Row(props: { group: Group; userId: string }) {
  const { group, userId } = props;
  const newest = group.events[0];
  const oldest = group.events.at(-1);
  if (newest === undefined || oldest === undefined) return null;
  const inOrder = [...group.events].reverse();
  const requests = unique(group.events.map((event) => event.requestId)).filter(
    (id): id is string => id !== null,
  );
  return (
    <tr>
      <td>
        <Time at={newest.occurredAt} />
      </td>
      <td>
        {unique(inOrder.map((event) => event.action)).map((action) => (
          <div key={action}>
            <code>{action}</code>
          </div>
        ))}
      </td>
      <td>
        <Actor actor={oldest.actor} userId={userId} />
      </td>
      <td>
        <Target item={newest} />
      </td>
      <td>{inOrder.map((event) => outcomeWord(event.outcome)).join(", then ")}</td>
      <td>
        {group.operation === null ? (
          <span className="muted">none</span>
        ) : (
          <>
            <StateBadge kind="operation" state={group.operation.state} />{" "}
            <code>{group.operation.id}</code>
          </>
        )}
      </td>
      <td>
        {requests.length === 0 ? (
          <span className="muted">none</span>
        ) : (
          requests.map((id) => (
            <div key={id}>
              <code>{id}</code>
            </div>
          ))
        )}
      </td>
    </tr>
  );
}

function Timeline(props: { org: string; userId: string; project: string; environment: string }) {
  const { org, userId, project, environment } = props;
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const queryKey = [userId, org, "activity", project, environment];
  const list = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      need(
        call("activity.list", {
          params: { org },
          query: {
            limit: LIMITS.listing.defaultLimit,
            projectId: project === "" ? undefined : project,
            environmentId: environment === "" ? undefined : environment,
            cursor: pageParam ?? undefined,
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
  const more = async (): Promise<void> => {
    setNotice(null);
    const result = await list.fetchNextPage();
    if (result.isFetchNextPageError && isCode(failureOf(result.error), "listing_changed")) {
      await client.resetQueries({ queryKey });
      setNotice(LIST_CHANGED);
    }
  };

  if (list.isPending) return <Loading what="the activity" />;
  if (list.data === undefined) {
    return (
      <ErrorPanel
        failure={failureOf(list.error)}
        action="read the activity of this organization"
        onReload={() => void list.refetch()}
      />
    );
  }
  const items = list.data.pages.flatMap((page) => page.items);
  const groups = groupByOperation(items);
  const anchor = list.data.pages[0]?.anchor ?? null;
  return (
    <>
      <p className="hint">
        The last 30 days of the audit log, as of <Time at={anchor} />. Events of one operation are
        on one line; its state is the one it has now.
      </p>
      {notice === null ? null : <p role="status">{notice}</p>}
      {groups.length === 0 ? (
        <p>No event is recorded here in the last 30 days.</p>
      ) : (
        <div className="scroll">
          <table aria-label="Activity">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Action</th>
                <th scope="col">Actor</th>
                <th scope="col">Target</th>
                <th scope="col">Outcome</th>
                <th scope="col">Operation now</th>
                <th scope="col">Request id</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Row key={group.key} group={group} userId={userId} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.isFetchNextPageError && !isCode(failureOf(list.error), "listing_changed") ? (
        <ErrorPanel failure={failureOf(list.error)} action="read more of the activity" />
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

export function Activity() {
  const { organization, projects, userId } = useScope();
  const [project, setProject] = useState("");
  const [environment, setEnvironment] = useState("");
  const org = organization?.id ?? "";
  const environments = useQuery({
    queryKey: [userId, org, "environments-of", project],
    queryFn: () =>
      need(
        call("environments.list", {
          params: { org, project },
          query: { limit: LIMITS.listing.maxLimit },
        }),
      ),
    enabled: org !== "" && project !== "",
  });
  if (organization === null) return null;
  return (
    <>
      <h1>Activity</h1>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="field">
          <label htmlFor="activity-project">Project</label>
          <select
            id="activity-project"
            value={project}
            onChange={(event) => {
              setProject(event.target.value);
              setEnvironment("");
            }}
          >
            <option value="">All projects</option>
            {(projects?.items ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="activity-environment">Environment</label>
          <select
            id="activity-environment"
            value={environment}
            disabled={project === ""}
            onChange={(event) => {
              setEnvironment(event.target.value);
            }}
          >
            <option value="">All environments{project === "" ? " (choose a project)" : ""}</option>
            {(environments.data?.environments ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </form>
      <Timeline org={org} userId={userId} project={project} environment={environment} />
    </>
  );
}
