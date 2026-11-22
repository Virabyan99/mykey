// A secret's history and the three changes that are not an edit (FR-1.26 to
// FR-1.29). The history is the server's: who wrote a version is shown as the
// server gives it, and a version nobody of the product wrote says "unknown",
// never a guess and never a blank. Delete, undelete and restore sit behind
// the typed confirmation and name the version and tag the page last read.
import { ACTIONS } from "../copy/actions.ts";
import { useQuery } from "@tanstack/react-query";
import { LIMITS, type SecretsHistoryBody } from "@mykey/contracts";
import { useState } from "react";
import { call, failureOf, need } from "../api/client.ts";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import { isCode, useAction } from "../state/use-action.ts";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { Loading } from "../ui/StateBadge.tsx";
import { Time } from "../ui/Time.tsx";
import { versionOf } from "./secret-rules.ts";
import type { At, Revealer } from "./secret-value.tsx";

type Version = SecretsHistoryBody["versions"][number];
type Actor = Version["written"]["actor"];

const WRITTEN: Readonly<Record<string, string>> = {
  create: "created",
  update: "updated",
  // The server records that a version is a restore, not which version it copied.
  restore: "restored from an earlier version",
};

function By(props: { actor: Actor; userId: string }) {
  const { kind, id } = props.actor;
  if (kind === "unknown") return <>unknown</>;
  if (id === null) return <>{kind}</>;
  return (
    <>
      {kind} <code>{id}</code>
      {kind === "user" && id === props.userId ? " (you)" : ""}
    </>
  );
}

function stateOf(entry: Version): string {
  const parts = [entry.current ? "current" : "earlier"];
  if (entry.destroyed) parts.push("destroyed");
  else if (entry.deleted) parts.push("deleted");
  return parts.join(", ");
}

export function History(props: {
  at: At;
  name: string;
  userId: string;
  /** Restore may be offered: the environment is active and the key is not under review. */
  writable: boolean;
  /** A value may be read: the key is not under review. */
  readable: boolean;
  revealer: Revealer;
  onRestore: (source: number) => void;
}) {
  const { at, name, userId } = props;
  const history = useQuery({
    queryKey: [userId, at.org, "history", at.project, at.env, name],
    queryFn: () => need(call("secrets.history", { params: { ...at, name } })),
  });

  return (
    <section id="history" aria-labelledby="history-title">
      <h2 id="history-title">History</h2>
      {history.isPending ? (
        <Loading what="the history" />
      ) : history.isError ? (
        <ErrorPanel
          failure={failureOf(history.error)}
          action="read the history"
          onReload={() => void history.refetch()}
        />
      ) : (
        <>
          <p className="hint">
            Newest first. The secret store keeps the last {LIMITS.secret.versionsKept} versions; an
            older one cannot be read or restored.
          </p>
          <div className="scroll">
            <table aria-label="Versions">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Written</th>
                  <th scope="col">Action</th>
                  <th scope="col">By</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.data.versions.map((entry) => {
                  const kept = !entry.deleted && !entry.destroyed;
                  return (
                    <tr key={entry.version}>
                      <th scope="row">{entry.version}</th>
                      <td>
                        <Time at={entry.createdAt} />
                      </td>
                      <td>
                        {entry.written.action === null ? "unknown" : WRITTEN[entry.written.action]}
                      </td>
                      <td>
                        <By actor={entry.written.actor} userId={userId} />
                      </td>
                      <td>
                        {stateOf(entry)}
                        {entry.lastChange === null ? null : (
                          <span className="muted">
                            {" "}
                            ({entry.lastChange.action === "delete" ? "deleted" : "undeleted"}{" "}
                            <Time at={entry.lastChange.occurredAt} /> by{" "}
                            <By actor={entry.lastChange.actor} userId={userId} />)
                          </span>
                        )}
                      </td>
                      <td>
                        {kept && !entry.current && props.readable ? (
                          <button
                            type="button"
                            disabled={props.revealer.busy}
                            onClick={() => {
                              props.revealer.reveal(entry.version);
                            }}
                          >
                            Reveal version {entry.version}
                          </button>
                        ) : null}{" "}
                        {kept && !entry.current && props.writable ? (
                          <button
                            type="button"
                            onClick={() => {
                              props.onRestore(entry.version);
                            }}
                          >
                            Restore version {entry.version}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export type Change =
  { kind: "delete" } | { kind: "undelete" } | { kind: "restore"; source: number };

/** The version and tag the page last read: what a change says it expects. */
export interface Expected {
  version: number;
  stateTag: string;
}

const ROUTE = {
  delete: "secrets.delete",
  undelete: "secrets.undelete",
  restore: "secrets.restore",
} as const;

export function ChangeDialog(props: {
  at: At;
  name: string;
  change: Change;
  expected: Expected;
  /** Reads the secret again; the dialog stays until that is done. */
  refresh: () => Promise<void>;
  onDone: (notice: string) => void;
  onConflict: (failure: Failure) => void;
  onCancel: () => void;
}) {
  const { at, name, change, expected } = props;
  const action = useAction();
  const [settling, setSettling] = useState(false);
  const source = change.kind === "restore" ? change.source : null;

  const send = async (): Promise<void> => {
    const route = ROUTE[change.kind];
    const print = [route, at.env, name, expected.version, expected.stateTag, source ?? ""].join(
      " ",
    );
    const result = await action.run(print, (key) =>
      call(route, {
        params: { ...at, name },
        body: {
          expectedVersion: expected.version,
          expectedStateTag: expected.stateTag,
          confirmed: true,
          ...(source === null ? {} : { sourceVersion: source }),
        },
        idempotencyKey: key,
      }),
    );
    if (!result.ok) {
      if (isCode(result.failure, "version_conflict")) props.onConflict(result.failure);
      return;
    }
    setSettling(true);
    await props.refresh();
    const version = versionOf(result.body.result) ?? expected.version;
    if (change.kind === "delete") {
      props.onDone(`${name} is deleted. Version ${String(version)} can be undeleted.`);
    } else if (change.kind === "undelete") {
      props.onDone(`${name} is live again at version ${String(version)}.`);
    } else {
      props.onDone(`Version ${String(change.source)} was restored as version ${String(version)}.`);
    }
  };

  const title =
    change.kind === "delete"
      ? `Delete ${name}`
      : change.kind === "undelete"
        ? `Undelete ${name}`
        : `Restore version ${String(change.source)} of ${name}`;
  const confirm =
    change.kind === "delete" ? "Delete" : change.kind === "undelete" ? "Undelete" : "Restore";
  return (
    <ConfirmDialog
      title={title}
      name={name}
      confirm={confirm}
      busy={action.busy || action.held || settling}
      onConfirm={() => void send()}
      onCancel={props.onCancel}
    >
      <p>
        {change.kind === "delete"
          ? ACTIONS.deleteSecret(expected.version)
          : change.kind === "undelete"
            ? ACTIONS.undeleteSecret(expected.version)
            : ACTIONS.restoreVersion(change.source, expected.version)}
      </p>
      {action.failure === null ? null : (
        <ErrorPanel failure={action.failure} action={`${confirm.toLowerCase()} the secret`} />
      )}
    </ConfirmDialog>
  );
}
