// One secret (FR-1.20 to FR-1.29, P-138). The page shows what the index says
// about the name, its history, and no value until the owner presses Reveal
// (secret-value.tsx). Every change names the version the page last read: an
// edit the version its form was opened on, a delete, undelete or restore the
// version shown. When the secret changed meanwhile the server refuses, and
// the page offers to read it again or to cancel, and no way to save over it.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { checkSecretName, webPath, type SecretsListBody } from "@mykey/contracts";
import { useRef, useState, type SyntheticEvent } from "react";
import { call, callSecret, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { PAGES } from "../copy/pages.ts";
import { PageHeader, ScopeIds } from "../ui/PageHeader.tsx";
import { Link } from "../router.tsx";
import { useScope } from "../state/scope.tsx";
import { isCode, useAction } from "../state/use-action.ts";
import { AreaField } from "../ui/Field.tsx";
import { EnvironmentNotice } from "../ui/Resource.tsx";
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
import { Time } from "../ui/Time.tsx";
import { ChangeDialog, History, type Change, type Expected } from "./secret-history.tsx";
import { SECRET_VALUE_RULE, secretValueProblem, versionOf } from "./secret-rules.ts";
import { ValuePanel, useReveal, type At } from "./secret-value.tsx";

type Row = SecretsListBody["secrets"][number];

function EditForm(props: {
  at: At;
  name: string;
  opened: Expected;
  onSaved: (text: string) => void;
  onConflict: (failure: Failure) => void;
  onCancel: () => void;
}) {
  const { at, name, opened } = props;
  const action = useAction();
  const value = useRef<HTMLTextAreaElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (value.current === null) return;
    const text = value.current.value;
    const found = secretValueProblem(text);
    setProblem(found);
    if (found !== null) {
      action.clear();
      return;
    }
    const result = await action.run(
      `secrets.update ${at.env} ${name} ${String(opened.version)} ${opened.stateTag}`,
      (key) =>
        callSecret("secrets.update", {
          params: { ...at, name },
          body: {
            value: text,
            expectedVersion: opened.version,
            expectedStateTag: opened.stateTag,
          },
          idempotencyKey: key,
        }),
    );
    if (result.ok) {
      const version = versionOf(result.body.result);
      props.onSaved(version === null ? "Saved." : `Saved as version ${String(version)}.`);
      return;
    }
    // The form and what was typed in it go: the stale change cannot be sent again.
    if (isCode(result.failure, "version_conflict")) props.onConflict(result.failure);
    else if (isCode(result.failure, "validation_failed")) setProblem(SECRET_VALUE_RULE);
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label="Edit value"
      autoComplete="off"
      noValidate
    >
      <p>
        This form was opened on version {opened.version}. If the secret changes before you save,
        nothing is saved and nothing is overwritten.
      </p>
      <AreaField label="New value" hint={SECRET_VALUE_RULE} error={problem} areaRef={value} />
      {action.failure === null ? null : (
        <ErrorPanel failure={action.failure} action="save the new value" />
      )}
      <div className="actions">
        <button type="submit" disabled={action.busy || action.held}>
          Save
        </button>
        <button type="button" onClick={props.onCancel} disabled={action.busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type Doing =
  | { mode: "idle" }
  | { mode: "edit"; opened: Expected }
  | { mode: "change"; change: Change; expected: Expected }
  /** A stale change: the page offers to read again or to cancel. `edit` reopens the form after. */
  | { mode: "conflict"; failure: Failure; edit: boolean };

const IDLE: Doing = { mode: "idle" };

function Found(props: {
  at: At;
  userId: string;
  row: Row;
  /** The environment is active. */
  writable: boolean;
  reload: () => Promise<Row | null>;
  changed: () => Promise<void>;
}) {
  const { at, row, writable } = props;
  const revealer = useReveal(at, row.name);
  const [doing, setDoing] = useState<Doing>(IDLE);
  const [notice, setNotice] = useState<string | null>(null);
  const review = row.state === "needs_review";
  const live = row.state === "live" && row.version !== null;
  const expected: Expected | null =
    row.version === null ? null : { version: row.version, stateTag: row.stateTag };

  const edit = (from: Row): void => {
    if (from.state !== "live" || from.version === null) {
      setDoing(IDLE);
      return;
    }
    setNotice(null);
    setDoing({ mode: "edit", opened: { version: from.version, stateTag: from.stateTag } });
  };
  const start = (change: Change): void => {
    if (expected === null) return;
    setNotice(null);
    setDoing({ mode: "change", change, expected });
  };

  return (
    <>
      <dl className="facts">
        <dt>State</dt>
        <dd>
          <StateBadge kind="index" state={row.state} />
        </dd>
        <dt>Current version</dt>
        <dd>{row.version ?? <span className="muted">none</span>}</dd>
        <dt>Last change</dt>
        <dd>
          <Time at={row.changedAt} />
        </dd>
      </dl>
      {review ? (
        <p className="review">
          An earlier change to this secret has an outcome that is not known, so it is closed: no
          value can be read and nothing can be changed. An operator settles this from the host
          (runbook reconciliation.md). Nothing here can.
        </p>
      ) : null}
      {notice === null ? null : <p role="status">{notice}</p>}
      {review ? null : <ValuePanel revealer={revealer} live={live} />}

      {doing.mode === "edit" ? (
        <EditForm
          key={`${String(doing.opened.version)} ${doing.opened.stateTag}`}
          at={at}
          name={row.name}
          opened={doing.opened}
          onSaved={(text) => {
            setDoing(IDLE);
            setNotice(text);
            void props.changed();
          }}
          onConflict={(failure) => {
            setDoing({ mode: "conflict", failure, edit: true });
          }}
          onCancel={() => {
            setDoing(IDLE);
          }}
        />
      ) : null}
      {doing.mode === "change" ? (
        <ChangeDialog
          at={at}
          name={row.name}
          change={doing.change}
          expected={doing.expected}
          refresh={props.changed}
          onDone={(text) => {
            setDoing(IDLE);
            setNotice(text);
          }}
          onConflict={(failure) => {
            setDoing({ mode: "conflict", failure, edit: false });
          }}
          onCancel={() => {
            setDoing(IDLE);
          }}
        />
      ) : null}
      {doing.mode === "conflict" ? (
        <ErrorPanel
          failure={doing.failure}
          action="change the secret"
          onReload={() => {
            const reopen = doing.edit;
            void props.changed();
            void props.reload().then((fresh) => {
              if (reopen && fresh !== null) edit(fresh);
              else setDoing(IDLE);
            });
          }}
        >
          <button
            type="button"
            onClick={() => {
              setDoing(IDLE);
              void props.changed();
            }}
          >
            Cancel
          </button>
        </ErrorPanel>
      ) : null}
      {doing.mode === "idle" && writable && !review && expected !== null ? (
        <div className="actions">
          {live ? (
            <>
              <button
                type="button"
                onClick={() => {
                  edit(row);
                }}
              >
                Edit value
              </button>
              <button
                type="button"
                onClick={() => {
                  start({ kind: "delete" });
                }}
              >
                Delete
              </button>
            </>
          ) : null}
          {row.state === "deleted" ? (
            <button
              type="button"
              onClick={() => {
                start({ kind: "undelete" });
              }}
            >
              Undelete
            </button>
          ) : null}
        </div>
      ) : null}

      <History
        at={at}
        name={row.name}
        userId={props.userId}
        writable={writable && !review && doing.mode === "idle"}
        readable={!review}
        revealer={revealer}
        onRestore={(source) => {
          start({ kind: "restore", source });
        }}
      />
    </>
  );
}

export function Secret(props: { name: string }) {
  const { name } = props;
  const { organization, project, environment, userId } = useScope();
  const client = useQueryClient();
  const org = organization?.id ?? "";
  const projectId = project?.id ?? "";
  const env = environment?.id ?? "";
  const named = checkSecretName(name).ok;
  const readable =
    environment !== null && environment.state !== "needs_review" && environment.state !== "pending";
  // The index's row of this name: a name sorts first among the names it is a prefix of.
  const query = useQuery({
    queryKey: [userId, org, "secret", projectId, env, name],
    enabled: named && readable,
    queryFn: async (): Promise<Row | null> => {
      const body = await need(
        call("secrets.list", {
          params: { org, project: projectId, env },
          query: { prefix: name, limit: 1 },
        }),
      );
      const first = body.secrets[0];
      return first?.name === name ? first : null;
    },
  });
  if (organization === null || project === null || environment === null) return null;
  const at: At = { org, project: projectId, env };
  const list = <Link to={webPath("secrets", at)}>All secrets of this environment</Link>;

  return (
    <>
      <PageHeader
        page={PAGES.secret}
        title={name}
        meta={
          <>
            <ScopeIds project={project} environment={environment} />
            {list}
          </>
        }
      />
      <EnvironmentNotice state={environment.state} reason={environment.reviewReason} />
      {!readable ? null : !named ? (
        <p>There is no secret with this name in this environment.</p>
      ) : query.isPending ? (
        <Loading what="the secret" />
      ) : query.isError ? (
        <ErrorPanel
          failure={failureOf(query.error)}
          action="read the secret"
          onReload={() => void query.refetch()}
        />
      ) : query.data === null ? (
        <p>There is no secret with this name in this environment.</p>
      ) : (
        <Found
          key={`${env} ${name}`}
          at={at}
          userId={userId}
          row={query.data}
          writable={environment.state === "active"}
          reload={async () => (await query.refetch()).data ?? null}
          changed={() => client.invalidateQueries({ queryKey: [userId, org] })}
        />
      )}
    </>
  );
}
