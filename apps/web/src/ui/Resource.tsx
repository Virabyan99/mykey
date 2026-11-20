// What the resource screens share: the note of a state the server does not
// leave by itself, the notice of an environment that is not active, and the
// form that names a project or an environment.
import { LIMITS, checkEnvironmentName, checkProjectName } from "@mykey/contracts";
import { useRef, useState, type SyntheticEvent } from "react";
import { ErrorPanel } from "../errors/ErrorPanel.tsx";
import type { Failure } from "../errors/explain.ts";
import type { Follow } from "../state/use-follow.ts";
import { Field } from "./Field.tsx";
import { StateBadge } from "./StateBadge.tsx";

export const PROJECT_NAME_RULE = `A project name is ${String(LIMITS.project.nameMinCodePoints)} to ${String(LIMITS.project.nameMaxCodePoints)} characters, not only spaces and without control characters.`;
export const ENVIRONMENT_NAME_RULE = `An environment name is 1 to ${String(LIMITS.environment.nameMaxLength)} characters: lower-case letters, digits and hyphens, starting with a letter.`;

export const projectNameProblem = (name: string): string | null =>
  checkProjectName(name).ok ? null : PROJECT_NAME_RULE;
export const environmentNameProblem = (name: string): string | null =>
  checkEnvironmentName(name).ok ? null : ENVIRONMENT_NAME_RULE;

/** The server's reason for a review, and who settles it. Never a guess of the page. */
export function ReviewNote(props: { state: string; reason: string | null }) {
  if (props.state !== "needs_review") return null;
  return (
    <p className="review">
      {props.reason === null ? (
        "The server gave no reason. "
      ) : (
        <>
          Reason given by the server: <code>{props.reason}</code>.{" "}
        </>
      )}
      An operator settles this from the host (runbook reconciliation.md). Nothing here can.
    </p>
  );
}

const ENVIRONMENT_NOTICES: Readonly<Record<string, string>> = {
  pending:
    "This environment is pending: the server is still preparing it. Nothing can be written until the server says active.",
  revoking:
    "This environment is being archived: its credentials are being revoked. Nothing can be written.",
  archived:
    "This environment is archived. Its secrets and their history can still be read. Nothing can be written until it is reactivated on the project's page.",
  needs_review:
    "This environment is under review. Nothing can be read or written until an operator settles it (runbook reconciliation.md).",
};

/** Above every screen of an environment that is not active: what that means here. */
export function EnvironmentNotice(props: { state: string; reason: string | null }) {
  const text = ENVIRONMENT_NOTICES[props.state];
  if (props.state === "active") return null;
  return (
    <section className="panel">
      <p>
        <StateBadge kind="resource" state={props.state} />
      </p>
      <p>{text ?? "This environment is in a state this page does not know. Nothing is offered."}</p>
      <ReviewNote state={props.state} reason={props.reason} />
    </section>
  );
}

/** Shown while the page follows a state the server will leave by itself. */
export function FollowNote(props: { waiting: boolean; follow: Follow }) {
  if (!props.waiting) return null;
  return (
    <p className="hint" role="status">
      {props.follow.stopped ? (
        <>
          The server is still working. This page stopped asking after two minutes.{" "}
          <button type="button" onClick={props.follow.again}>
            Check again
          </button>
        </>
      ) : (
        "The server is still working. This page asks again by itself; a state changes here only when the server says so."
      )}
    </p>
  );
}

/** One name, checked by the contract's own rule before it is sent and explained the same way after. */
export function NameForm(props: {
  label: string;
  initial?: string;
  submit: string;
  rule: string;
  problem: (name: string) => string | null;
  /** What the name must be unique in, e.g. "this project". */
  within: string;
  busy: boolean;
  failure: Failure | null;
  /** Completes "… to {action}". */
  action: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const name = input.current?.value ?? "";
    const found = props.problem(name);
    setProblem(found);
    if (found === null && !props.busy) props.onSubmit(name);
  };
  const refused = props.failure?.kind === "api" ? props.failure.code : null;
  const fieldError =
    problem ??
    (refused === "validation_failed"
      ? props.rule
      : refused === "already_exists"
        ? `This name is already used in ${props.within}.`
        : null);
  return (
    <form method="post" className="panel" onSubmit={submit}>
      <Field
        label={props.label}
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={256}
        required
        defaultValue={props.initial}
        inputRef={input}
        hint={props.rule}
        error={fieldError}
      />
      <div className="actions">
        <button type="submit" disabled={props.busy}>
          {props.submit}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {props.failure === null || fieldError !== null ? null : (
        <ErrorPanel failure={props.failure} action={props.action} />
      )}
    </form>
  );
}
