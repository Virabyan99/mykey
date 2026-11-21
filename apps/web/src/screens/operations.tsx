// The operations of one environment (FR-1.92, P-140): every change the
// server took, newest first, in the server's own seven states. The page
// follows work the server is still doing and nothing else. An operation
// whose outcome is not known is shown as that: never as failed, never with a
// button that sends the change again. Settling it is an operator's work on
// the host; this screen can only look.
import { EmptyState, PageHeader, ScopeIds, ThreeViews } from "../ui/PageHeader.tsx";
import { PAGES } from "../copy/pages.ts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { LIMITS, webPath, type ErrorCode, type OperationsListBody } from "@mykey/contracts";
import { useId, useState } from "react";
import { call, failureOf, need } from "../api/client.ts";
import { isTerminal } from "../api/poll.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import { explain, type Failure } from "../errors/explain.ts";
import { Link } from "../router.tsx";
import { useScope } from "../state/scope.tsx";
import { isCode } from "../state/use-action.ts";
import { useFollow } from "../state/use-follow.ts";
import { EnvironmentNotice, FollowNote } from "../ui/Resource.tsx";
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
import { Time } from "../ui/Time.tsx";
import { versionOf } from "./secret-rules.ts";
import type { At } from "./secret-value.tsx";
import { LIST_CHANGED } from "./secrets.tsx";

type Operation = OperationsListBody["operations"][number];

/** The error table's entry for a code the server recorded with an operation. */
function codeText(code: string, operationId: string) {
  const failure: Failure = {
    kind: "api",
    status: 0,
    code: code as ErrorCode,
    message: "",
    requestId: null,
    operationId,
    details: null,
    retryAfterSeconds: null,
  };
  return explain(failure, { action: "do this" });
}

/** What a state means, in one sentence per state. The uncertain one is the error table's. */
function StateText(props: {
  at: At;
  row: Operation;
  state: string;
  result?: Record<string, unknown> | undefined;
}) {
  const { row, state } = props;
  if (state === "accepted") return <p>The server has taken the request and has not started it.</p>;
  if (state === "executing") return <p>The server is working on it.</p>;
  if (state === "awaiting_input") {
    return (
      <p>
        The server stopped before the end of the import&apos;s file and waits for the file. What was
        written so far stays written.{" "}
        {row.mine ? (
          <Link to={webPath("import", props.at)}>Resume on the import screen</Link>
        ) : (
          "Only the member who started the import can resume it."
        )}
      </p>
    );
  }
  if (state === "uncertain") {
    const unknown = codeText("outcome_unknown", row.operationId);
    return (
      <>
        <p>{unknown.text}</p>
        <p className="review">{unknown.next}</p>
      </>
    );
  }
  if (state === "partial") {
    return (
      <p>
        Some entries of the import were written and some were not. Importing the same file again
        writes what is still missing; the preview shows what that is.
      </p>
    );
  }
  if (state === "rejected") {
    if (row.errorCode === null) return <p>The server refused it. Nothing was changed.</p>;
    const refused = codeText(row.errorCode, row.operationId);
    return (
      <p>
        {refused.title}. {refused.text}
      </p>
    );
  }
  const version = props.result === undefined ? null : versionOf(props.result);
  return <p>Done{version === null ? "" : `, as version ${String(version)}`}.</p>;
}

/** One operation, asked from the server and followed while the server works (P-140). */
function Details(props: { at: At; userId: string; row: Operation; onClose: () => void }) {
  const { at, userId, row } = props;
  const title = useId();
  const client = useQueryClient();
  const queryKey = [userId, at.org, "operation", row.operationId];
  const operation = useQuery({
    queryKey,
    queryFn: () => need(call("operations.get", { params: { operation: row.operationId } })),
  });
  const waiting = operation.data !== undefined && !isTerminal(operation.data.state);
  const follow = useFollow(waiting, () => {
    void client.invalidateQueries({ queryKey: [userId, at.org] });
  });
  return (
    <section className="panel" aria-labelledby={title}>
      <h2 id={title}>Operation details</h2>
      {operation.isPending ? <Loading what="the operation" /> : null}
      {operation.isError ? (
        <ErrorPanel
          failure={failureOf(operation.error)}
          action="read the operation"
          onReload={() => void operation.refetch()}
        />
      ) : null}
      {operation.data === undefined ? null : (
        <>
          <p>
            <StateBadge kind="operation" state={operation.data.state} /> <code>{row.action}</code>
            {row.name === null ? null : (
              <>
                {" "}
                on <code>{row.name}</code>
              </>
            )}
          </p>
          <StateText
            at={at}
            row={row}
            state={operation.data.state}
            result={operation.data.result}
          />
          <FollowNote waiting={waiting} follow={follow} />
          <dl className="ids">
            <dt>Operation id</dt>
            <dd>
              <code>{row.operationId}</code>
            </dd>
            <dt>Started</dt>
            <dd>
              <Time at={row.createdAt} /> by {row.mine ? "you" : "another member"}
            </dd>
            <dt>Ended</dt>
            <dd>
              <Time at={row.completedAt} none="not ended" />
            </dd>
            <dt>The server keeps this record until</dt>
            <dd>
              <Time at={operation.data.replayExpiresAt} none="it has an end" />
            </dd>
          </dl>
        </>
      )}
      <div className="actions">
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

function List(props: { at: At; userId: string }) {
  const { at, userId } = props;
  const client = useQueryClient();
  const [opened, setOpened] = useState<Operation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryKey = [userId, at.org, "operations", at.project, at.env];
  const list = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      need(
        call("operations.list", {
          params: at,
          query: { limit: LIMITS.listing.defaultLimit, cursor: pageParam ?? undefined },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = list.data?.pages.flatMap((page) => page.operations) ?? [];
  // Only work the server is still doing is followed: the other states do not move by themselves.
  const waiting = rows.some((row) => !isTerminal(row.state));
  const follow = useFollow(waiting, () => {
    void client.invalidateQueries({ queryKey: [userId, at.org] });
  });

  const more = async (): Promise<void> => {
    setNotice(null);
    const result = await list.fetchNextPage();
    if (result.isFetchNextPageError && isCode(failureOf(result.error), "listing_changed")) {
      await client.resetQueries({ queryKey });
      setNotice(LIST_CHANGED);
    }
  };

  if (list.isPending) return <Loading what="the operations" />;
  if (list.data === undefined) {
    return (
      <ErrorPanel
        failure={failureOf(list.error)}
        action="read the operations"
        onReload={() => void list.refetch()}
      />
    );
  }
  // The row as the list has it now: the panel's facts follow the list.
  const current =
    opened === null ? null : (rows.find((row) => row.operationId === opened.operationId) ?? opened);
  return (
    <>
      <FollowNote waiting={waiting} follow={follow} />
      {notice === null ? null : <p role="status">{notice}</p>}
      {current === null ? null : (
        <Details
          key={current.operationId}
          at={at}
          userId={userId}
          row={current}
          onClose={() => {
            setOpened(null);
          }}
        />
      )}
      {rows.length === 0 ? (
        <EmptyState
          title="No operations"
          text="No operation is recorded for this environment. Changes that take longer, or whose end was not seen, are listed here."
          action={<Link to={webPath("secrets", props.at)}>Go to Secrets</Link>}
          learn="activity-audit-operations"
        />
      ) : (
        <div className="scroll">
          <table aria-label="Operations">
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Action</th>
                <th scope="col">Name</th>
                <th scope="col">State</th>
                <th scope="col">By</th>
                <th scope="col">Operation id</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.operationId}>
                  <td>
                    <Time at={row.createdAt} />
                  </td>
                  <td>
                    <code>{row.action}</code>
                  </td>
                  <td>{row.name ?? <span className="muted">none</span>}</td>
                  <td>
                    <StateBadge kind="operation" state={row.state} />
                    {row.state === "uncertain" || row.state === "awaiting_input" ? (
                      <StateText at={at} row={row} state={row.state} />
                    ) : null}
                  </td>
                  <td>{row.mine ? "you" : "another member"}</td>
                  <th scope="row">
                    <code>{row.operationId}</code>
                  </th>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        setOpened(row);
                      }}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.isFetchNextPageError && !isCode(failureOf(list.error), "listing_changed") ? (
        <ErrorPanel failure={failureOf(list.error)} action="read more operations" />
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

export function Operations() {
  const { organization, project, environment, userId } = useScope();
  if (organization === null || project === null || environment === null) return null;
  const at: At = { org: organization.id, project: project.id, env: environment.id };
  return (
    <>
      <PageHeader
        page={PAGES.operations}
        meta={
          <>
            <ScopeIds project={project} environment={environment} />
            <span className="muted">
              {organization.role === "owner" || organization.role === "admin"
                ? "Every member's operations."
                : "Your own operations."}
            </span>
          </>
        }
      />
      <ThreeViews />
      <EnvironmentNotice state={environment.state} reason={environment.reviewReason} />
      <List at={at} userId={userId} />
    </>
  );
}
