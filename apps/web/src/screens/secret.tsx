// One secret (FR-1.20 to FR-1.23, P-138). The page shows what the index says
// about the name and no value. A value is read only when the owner presses
// Reveal; it is held by the forgetting holder of this component and nowhere
// else, and it is gone after 30 seconds, when the tab is hidden, on a change
// of address and at sign-out. An edit names the version the form was opened
// on: when the secret changed meanwhile, the server refuses and the page
// offers to read it again or to cancel, and no way to save over it.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { checkSecretName, webPath, type SecretsListBody } from "@mykey/contracts";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { call, callSecret, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { Link } from "../router.tsx";
import { EPHEMERAL_TTL_MS } from "../state/ephemeral.ts";
import { useScope } from "../state/scope.tsx";
import { useSessionControl } from "../state/session.tsx";
import { isCode, useAction } from "../state/use-action.ts";
import { useEphemeral } from "../state/use-ephemeral.ts";
import { AreaField } from "../ui/Field.tsx";
import { EnvironmentNotice } from "../ui/Resource.tsx";
import { CopyButton, SecretLine } from "../ui/Secret.tsx";
import { Loading, StateBadge } from "../ui/StateBadge.tsx";
import { Time } from "../ui/Time.tsx";
import { SECRET_VALUE_RULE, secretValueProblem, versionOf } from "./secret-rules.ts";

type Row = SecretsListBody["secrets"][number];

/** The environment of the address: the parameters of every route below it. */
type At = Readonly<Record<"org" | "project" | "env", string>>;

/** What Reveal holds: the value, the version it is, and when it will be forgotten. */
interface Shown {
  value: string;
  version: number;
  until: number;
}

/** The time, once a second, while something counts down. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [active]);
  return now;
}

function Reveal(props: { at: At; name: string }) {
  const control = useSessionControl();
  const [shown, show, hide] = useEphemeral<Shown>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [missed, setMissed] = useState(false);
  const now = useNow(shown !== null);

  const reveal = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setMissed(false);
    const result = await callSecret("secrets.reveal", {
      params: { ...props.at, name: props.name },
      body: {},
    });
    setBusy(false);
    if (!result.ok) {
      if (!control.lost(result.failure)) setFailure(result.failure);
      return;
    }
    // A value that arrives while nobody can be looking is not kept.
    if (document.visibilityState === "hidden") {
      setMissed(true);
      return;
    }
    show({
      value: result.body.value,
      version: result.body.version,
      until: Date.now() + EPHEMERAL_TTL_MS,
    });
  };

  if (shown === null) {
    return (
      <section>
        <h2>Value</h2>
        <p>
          The value is hidden. Reveal reads it from the secret store, records that you did, and
          shows it here for {String(EPHEMERAL_TTL_MS / 1000)} seconds.
        </p>
        {missed ? (
          <p role="status">
            The value arrived while this tab was hidden, and it was not kept. Reveal it again.
          </p>
        ) : null}
        {failure === null ? null : <ErrorPanel failure={failure} action="reveal the value" />}
        <div className="actions">
          <button type="button" onClick={() => void reveal()} disabled={busy}>
            Reveal
          </button>
        </div>
      </section>
    );
  }
  // The clock of the countdown may be a second old; it is never older than the reveal.
  const left = Math.ceil((shown.until - Math.max(now, shown.until - EPHEMERAL_TTL_MS)) / 1000);
  return (
    <section>
      <h2>Value</h2>
      <SecretLine label="Value" text={shown.value} wide />
      {shown.value === "" ? <p className="hint">This value is empty.</p> : null}
      <p>
        Version {shown.version}. Hidden again in {Math.max(0, left)} s, or as soon as you leave this
        page or this tab.
      </p>
      <div className="actions">
        <CopyButton text={shown.value} label="Copy value" />
        <button type="button" onClick={hide}>
          Hide now
        </button>
      </div>
    </section>
  );
}

/** The version and tag a form was opened on: what the save will say it expects. */
interface Opened {
  version: number;
  stateTag: string;
}

function EditForm(props: {
  at: At;
  name: string;
  opened: Opened;
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
        <button type="submit" disabled={action.busy}>
          Save
        </button>
        <button type="button" onClick={props.onCancel} disabled={action.busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type Editing =
  { mode: "closed" } | { mode: "open"; opened: Opened } | { mode: "conflict"; failure: Failure };

function Found(props: {
  at: At;
  row: Row;
  writable: boolean;
  reload: () => Promise<Row | null>;
  changed: () => void;
}) {
  const { at, row, writable } = props;
  const [editing, setEditing] = useState<Editing>({ mode: "closed" });
  const [notice, setNotice] = useState<string | null>(null);
  const live = row.state === "live" && row.version !== null;

  const open = (from: Row): void => {
    if (from.state !== "live" || from.version === null) {
      setEditing({ mode: "closed" });
      return;
    }
    setNotice(null);
    setEditing({ mode: "open", opened: { version: from.version, stateTag: from.stateTag } });
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
      {row.state === "needs_review" ? (
        <p className="review">
          An earlier change to this secret has an outcome that is not known, so it is closed. An
          operator settles this from the host (runbook reconciliation.md). Nothing here can.
        </p>
      ) : null}
      {row.state === "deleted" ? (
        <p>This secret is deleted. It has no current value to reveal or to edit.</p>
      ) : null}
      {notice === null ? null : <p role="status">{notice}</p>}
      {live ? <Reveal at={at} name={row.name} /> : null}
      {editing.mode === "open" ? (
        <EditForm
          key={`${String(editing.opened.version)} ${editing.opened.stateTag}`}
          at={at}
          name={row.name}
          opened={editing.opened}
          onSaved={(text) => {
            setEditing({ mode: "closed" });
            setNotice(text);
            props.changed();
          }}
          onConflict={(failure) => {
            setEditing({ mode: "conflict", failure });
          }}
          onCancel={() => {
            setEditing({ mode: "closed" });
          }}
        />
      ) : null}
      {editing.mode === "conflict" ? (
        <ErrorPanel
          failure={editing.failure}
          action="save the new value"
          onReload={() => {
            void props.reload().then((fresh) => {
              if (fresh === null) setEditing({ mode: "closed" });
              else open(fresh);
            });
          }}
        >
          <button
            type="button"
            onClick={() => {
              setEditing({ mode: "closed" });
              props.changed();
            }}
          >
            Cancel
          </button>
        </ErrorPanel>
      ) : null}
      {editing.mode === "closed" && live && writable ? (
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              open(row);
            }}
          >
            Edit value
          </button>
        </div>
      ) : null}
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
      <h1>{name}</h1>
      <p className="hint">
        Secret of {project.name} / {environment.name}. {list}
      </p>
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
          row={query.data}
          writable={environment.state === "active"}
          reload={async () => (await query.refetch()).data ?? null}
          changed={() => {
            void client.invalidateQueries({ queryKey: [userId, org] });
          }}
        />
      )}
    </>
  );
}
